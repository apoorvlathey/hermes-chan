import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

import { Avatar } from './Avatar'
import {
  answerPrompt,
  findSession,
  focusedKey,
  openSessionRef,
  reconnectBot,
  openSetup,
  send,
  setNewChatBot,
  stop,
  useStore,
  type Bot,
  type Draft,
  type Item,
  type Prompt,
  type ToolInfo
} from './store'
import { BotDayDivider, BotTime, localDay } from './botChat'
import { CodeBlock } from './CodeBlock'
import { hermes } from './bridge'
import { ModelPicker } from './ModelPicker'
import { clock } from './time'
import { splitRefs } from './transcript'
import { BackToBotChat, WorkstreamsToggle } from './Workstreams'

const GREETINGS = [
  'What are we getting into?',
  'Ready when you are.',
  'Got something for me?',
  'Fresh page. What’s up?',
  'Let’s make something happen.'
]

/** `conduit://session/<id>?profile=x` (session deep links some clients emit), `hermes://session/<id>`, and our own
 *  `hermes-session://<id>` (rewritten `@session:<id>` mentions). */
const SESSION_LINK = /^(?:conduit|hermes):\/\/session\/([^?#/]+)(?:\?([^#]*))?|^hermes-session:\/\/([^?#/]+)/

function parseSessionLink(href?: string): { id: string; profile?: string } | null {
  const m = href ? SESSION_LINK.exec(href) : null
  if (!m) return null
  const id = decodeURIComponent(m[1] ?? m[3]!)
  const profile = m[2] ? new URLSearchParams(m[2]).get('profile') ?? undefined : undefined
  return { id, profile }
}

/** Turn bare `@session:<id>` mentions into links, outside code. A mention that only repeats a session
 *  link already in the message is dropped (agents often write "[Open W10](conduit://…) @session:…"). */
function linkMentions(text: string): string {
  if (!text.includes('@session:')) return text
  const linked = new Set([...text.matchAll(/(?:conduit|hermes):\/\/session\/([^?#/)\s]+)/g)].map(m => decodeURIComponent(m[1]!)))
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(/[ \t]*@session:([A-Za-z0-9_-]+)/g, (whole, id: string) =>
            linked.has(id) ? '' : `${whole.slice(0, whole.indexOf('@'))}[@session:${id}](hermes-session://${id})`
          )
    )
    .join('')
}

const urlTransform = (url: string) => (SESSION_LINK.test(url) ? url : defaultUrlTransform(url))

function SessionChip({ id, profile, botId, children }: { id: string; profile?: string; botId: string; children: React.ReactNode }) {
  const known = useStore(s => (s.sessions ? findSession(id) : undefined))
  const label = typeof children === 'string' && children.startsWith('@session:') ? known?.title || 'Open session' : children
  return (
    <button className="session-link" onClick={() => openSessionRef(id, profile, botId)} title={known?.title || id}>
      <span aria-hidden>💬</span>
      {label}
    </button>
  )
}

// Highlight only fences that name their language (no guessing on plain blocks); unknown names stay plain.
const REHYPE: NonNullable<Parameters<typeof ReactMarkdown>[0]['rehypePlugins']> = [[rehypeHighlight, { detect: false }]]

const Markdown = memo(function Markdown({ text, botId }: { text: string; botId: string }) {
  const source = useMemo(() => linkMentions(text), [text])
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={REHYPE}
        urlTransform={urlTransform}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ href, children }) => {
            const ref = parseSessionLink(href)
            if (ref) {
              return (
                <SessionChip id={ref.id} profile={ref.profile} botId={botId}>
                  {children}
                </SessionChip>
              )
            }
            return (
              <a
                href={href}
                onClick={e => {
                  e.preventDefault()
                  if (href) window.hermes.openExternal(href)
                }}
              >
                {children}
              </a>
            )
          }
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
})

function ToolGroup({ tools, live }: { tools: ToolInfo[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  const running = tools.filter(t => !t.done)
  const current = running[running.length - 1] ?? tools[tools.length - 1]!
  const emojis = [...new Set(tools.map(t => t.emoji).filter(Boolean))].slice(0, 4)
  return (
    <div className={`tools ${open ? 'open' : ''}`}>
      <button className="tools-pill" onClick={() => setOpen(o => !o)}>
        <span className="tools-emojis">{emojis.length ? emojis.join('') : '🔧'}</span>
        {running.length && live ? (
          <span className="tools-label">
            {current.label}
            <span className="ellipsis" />
          </span>
        ) : (
          <span className="tools-label">
            Used {tools.length} tool{tools.length === 1 ? '' : 's'}
          </span>
        )}
        <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <ul className="tools-list">
          {tools.map((t, i) => (
            <li key={i} className={t.done ? '' : 'pending'}>
              <span className="tool-emoji">{t.emoji ?? '•'}</span>
              <span className="tool-name">{t.label}</span>
              {t.preview && <span className="tool-preview">{t.preview}</span>}
              {t.duration !== undefined && <span className="tool-dur">{t.duration.toFixed(1)}s</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

type Block = { kind: 'item'; item: Item } | { kind: 'tools'; id: string; tools: ToolInfo[]; ts?: number }

function toBlocks(items: Item[]): Block[] {
  const out: Block[] = []
  for (const item of items) {
    if (item.kind === 'tool') {
      const last = out[out.length - 1]
      if (last?.kind === 'tools') last.tools.push(item.tool)
      else out.push({ kind: 'tools', id: item.id, tools: [item.tool], ts: item.ts })
    } else out.push({ kind: 'item', item })
  }
  return out
}

/** Placeholder conversation while a chat loads: messenger bubbles for a Bot Chat, the document
 *  layout (your bubble, then the bot's paragraphs) for a regular chat. Widths are fixed so it
 *  doesn't jump around between renders. */
const BUBBLE_SKELETON: { side: 'bot' | 'user'; width: number; lines: number[] }[] = [
  { side: 'bot', width: 420, lines: [100, 86, 58] },
  { side: 'user', width: 240, lines: [100] },
  { side: 'bot', width: 360, lines: [100, 64] },
  { side: 'user', width: 300, lines: [100, 46] },
  { side: 'bot', width: 460, lines: [100, 94, 88, 40] }
]
const DOC_SKELETON: { side: 'bot' | 'user'; lines: number[]; tool?: boolean }[] = [
  { side: 'user', lines: [100, 54] },
  { side: 'bot', tool: true, lines: [100, 97, 92, 60] },
  { side: 'bot', lines: [100, 88, 34] },
  { side: 'user', lines: [100] },
  { side: 'bot', lines: [100, 95, 72] }
]

function ChatSkeleton({ bubbles }: { bubbles: boolean }) {
  const rows = bubbles ? BUBBLE_SKELETON : DOC_SKELETON
  return (
    <div className={`chat-skeleton ${bubbles ? 'bubbles' : 'doc'}`} role="status" aria-label="Loading conversation">
      {rows.map((r, i) => (
        <div
          key={i}
          className={`sk-msg ${r.side}`}
          style={{
            animationDelay: `${i * 70}ms`,
            ...('width' in r && bubbles ? { width: `min(${r.width}px, 80%)` } : {})
          }}
        >
          {'tool' in r && r.tool && <div className="sk-tool shimmer-box" />}
          {r.lines.map((w, j) => (
            <div key={j} className="sk-line shimmer-box" style={{ width: `${w}%` }} />
          ))}
          {bubbles && <div className="sk-time shimmer-box" />}
        </div>
      ))}
    </div>
  )
}

function Message({ item, bot, bubbles = false }: { item: Item; bot: Bot; bubbles?: boolean }) {
  if (item.kind === 'user') {
    return (
      <div className="msg user" title={bubbles ? undefined : clock(item.ts)}>
        {item.images?.length || item.imagePaths?.length ? (
          <div className="sent-images">
            {item.images?.map((src, i) => <img key={i} src={src} alt="" />)}
            {item.imagePaths?.map(p => <GatewayImage key={p} botId={bot.id} path={p} />)}
          </div>
        ) : null}
        {item.files?.length ? (
          <div className="sent-files">
            {item.files.map(name => (
              <span key={name} className="ref-chip">
                <span aria-hidden>{FILE_ICON(name)}</span>
                {name}
              </span>
            ))}
          </div>
        ) : null}
        {item.text.trim() ? (
          <div className="bubble">
            <span className="bubble-text">
              {splitRefs(item.text).map((part, i) =>
                part.kind === 'text' ? part.text : <RefChip key={i} type={part.type} value={part.value} />
              )}
            </span>
            {bubbles && <BotTime ts={item.ts} />}
          </div>
        ) : bubbles ? (
          <BotTime ts={item.ts} />
        ) : null}
      </div>
    )
  }
  if (item.kind === 'note') {
    return <div className={`note ${item.tone ?? ''}`}>{item.text}</div>
  }
  if (item.kind === 'assistant') {
    return (
      <div
        className={`msg bot ${item.streaming ? 'streaming' : ''} ${item.report ? 'report' : ''}`}
        title={bubbles ? undefined : clock(item.ts)}
        style={{ ['--bot' as string]: bot.color }}
      >
        {item.report && (
          <div className="report-head">
            <span className="report-icon" aria-hidden>
              ⏰
            </span>
            <span className="report-name">{item.report}</span>
            {!bubbles && item.ts ? <span className="report-time">{clock(item.ts)}</span> : null}
          </div>
        )}
        <Markdown text={item.text} botId={bot.id} />
        {bubbles && !item.streaming && <BotTime ts={item.ts} />}
      </div>
    )
  }
  return null
}

/** Images stored on a gateway, fetched once per path and cached for the session. */
const imageCache = new Map<string, Promise<string>>()

function GatewayImage({ botId, path }: { botId: string; path: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const key = `${botId}:${path}`
    let p = imageCache.get(key)
    if (!p) {
      p = hermes.readDataUrl(botId, path)
      imageCache.set(key, p)
      p.catch(() => imageCache.delete(key))
    }
    let live = true
    p.then(d => live && setSrc(d)).catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [botId, path])
  const name = path.split('/').pop() ?? 'image'
  if (failed) {
    return (
      <span className="ref-chip" title={path}>
        <span aria-hidden>🖼️</span>
        {name.replace(/^dashboard_\d{8}_\d{6}_[0-9a-f]+_/, '')}
      </span>
    )
  }
  return src ? <img src={src} alt={name} title={name} /> : <span className="img-loading shimmer-box" title={name} />
}

const REF_ICON: Record<string, string> = { url: '🌐', file: '📄', folder: '📁', image: '🖼️', tool: '🔧', terminal: '⌨️' }

function RefChip({ type, value }: { type: string; value: string }) {
  const label =
    type === 'url' ? value.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') : value.split('/').filter(Boolean).pop() || value
  const isUrl = type === 'url' && /^https?:\/\//.test(value)
  return (
    <span
      className={`ref-chip ${isUrl ? 'link' : ''}`}
      title={value}
      onClick={isUrl ? () => window.hermes.openExternal(value) : undefined}
    >
      <span aria-hidden>{REF_ICON[type] ?? '📎'}</span>
      {label}
    </span>
  )
}

function Typing({ bot, status }: { bot: Bot; status?: string }) {
  return (
    <div className="typing" style={{ ['--bot' as string]: bot.color }}>
      <span className="typing-dots">
        <i />
        <i />
        <i />
      </span>
      <span className="typing-text">{status || `${bot.name} is thinking`}</span>
    </div>
  )
}

function PromptCard({ prompt, bot }: { prompt: Prompt; bot: Bot }) {
  const [answer, setAnswer] = useState('')
  if (prompt.kind === 'approval') {
    const choices = prompt.choices?.length ? prompt.choices : ['once', 'session', 'always', 'deny']
    const label: Record<string, string> = { once: 'Allow once', session: 'Allow for this chat', always: 'Always allow', deny: 'Deny' }
    return (
      <div className="prompt-card" style={{ ['--bot' as string]: bot.color }}>
        <div className="prompt-head">✋ {bot.name} wants to run something</div>
        {prompt.description && <div className="prompt-desc">{prompt.description}</div>}
        {prompt.command && <pre className="prompt-cmd">{prompt.command}</pre>}
        <div className="prompt-actions">
          {choices.map(c => (
            <button key={c} className={c === 'deny' ? 'ghost' : c === 'once' ? 'primary' : ''} onClick={() => void answerPrompt(prompt, c)}>
              {label[c] ?? c}
            </button>
          ))}
        </div>
      </div>
    )
  }
  const questions = prompt.questions ?? [{ qid: 'q', question: prompt.question ?? '', choices: prompt.choices }]
  const q = questions[0]!
  const submit = (value: string) => {
    if (!value.trim()) return
    void answerPrompt(prompt, prompt.questions ? { [q.qid]: value } : value)
  }
  return (
    <div className="prompt-card" style={{ ['--bot' as string]: bot.color }}>
      <div className="prompt-head">💭 {bot.name} has a question</div>
      <div className="prompt-desc">{q.question}</div>
      {q.choices?.length ? (
        <div className="prompt-actions">
          {q.choices.map(c => (
            <button key={c} onClick={() => submit(c)}>
              {c}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="prompt-form"
        onSubmit={e => {
          e.preventDefault()
          submit(answer)
        }}
      >
        <input autoFocus value={answer} onChange={e => setAnswer(e.target.value)} placeholder="Type an answer" />
        <button className="primary" type="submit">
          Reply
        </button>
      </form>
    </div>
  )
}

const MAX_ATTACH_BYTES = 25 * 1024 * 1024
const GATEWAY_IMAGE = /^image\/(png|jpe?g|gif|webp|bmp)$/
const FILES_EVENT = 'hermeschan:files'

/** Hand files to the composer from anywhere (drop target, paste). */
export const offerFiles = (files: File[]) => window.dispatchEvent(new CustomEvent(FILES_EVENT, { detail: files }))

const readDataUrl = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(f)
  })

const prettySize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`)

const FILE_ICON = (name: string) => {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'pdf') return '📕'
  if (['csv', 'xlsx', 'xls', 'numbers'].includes(ext)) return '📊'
  if (['zip', 'tar', 'gz', '7z'].includes(ext)) return '🗜️'
  if (['mp3', 'wav', 'm4a', 'ogg'].includes(ext)) return '🎵'
  if (['mp4', 'mov', 'webm'].includes(ext)) return '🎬'
  if (['ts', 'tsx', 'js', 'py', 'rs', 'go', 'sol', 'json', 'sh', 'md', 'yaml', 'yml', 'toml'].includes(ext)) return '🧾'
  return '📄'
}

function Composer({ bot, running, disabled }: { bot: Bot; running: boolean; disabled: boolean }) {
  const [text, setText] = useState('')
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [error, setError] = useState<string | null>(null)
  const [hop, setHop] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const view = useStore(s => s.view)

  useEffect(() => {
    ref.current?.focus()
  }, [view])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])

  const addFiles = async (files: File[]) => {
    setError(null)
    const tooBig = files.filter(f => f.size > MAX_ATTACH_BYTES)
    if (tooBig.length) setError(`${tooBig.map(f => f.name).join(', ')} ${tooBig.length === 1 ? 'is' : 'are'} over 25 MB`)
    const ok = files.filter(f => f.size <= MAX_ATTACH_BYTES)
    const next = await Promise.all(
      ok.map(async (f, i): Promise<Draft> => {
        const isImage = GATEWAY_IMAGE.test(f.type)
        const ext = f.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
        // Pasted screenshots arrive as "image.png"; give them a friendlier, unique name.
        const name = isImage && /^image\.\w+$/.test(f.name) ? `pasted-${Date.now()}-${i}.${ext}` : f.name || `file-${Date.now()}`
        return { id: `${Date.now()}-${i}-${name}`, kind: isImage ? 'image' : 'file', name, mime: f.type || 'application/octet-stream', size: f.size, dataUrl: await readDataUrl(f) }
      })
    )
    setDrafts(d => [...d, ...next])
    ref.current?.focus()
  }

  useEffect(() => {
    const on = (e: Event) => void addFiles((e as CustomEvent<File[]>).detail)
    window.addEventListener(FILES_EVENT, on)
    return () => window.removeEventListener(FILES_EVENT, on)
  }, [])

  const canSend = (!!text.trim() || drafts.length > 0) && !disabled

  const submit = () => {
    if (!canSend) return
    void send(text, drafts)
    setText('')
    setDrafts([])
    setError(null)
    setHop(h => h + 1)
  }

  return (
    <div className="composer-wrap">
      {error && (
        <div className="composer-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      <div className={`composer ${drafts.length ? 'has-drafts' : ''}`} style={{ ['--bot' as string]: bot.color }}>
        {drafts.length > 0 && (
          <div className="drafts">
            {drafts.map(d => (
              <div key={d.id} className={`draft ${d.kind}`} title={`${d.name} · ${prettySize(d.size)}`}>
                {d.kind === 'image' ? (
                  <img src={d.dataUrl} alt={d.name} />
                ) : (
                  <>
                    <span className="draft-icon">{FILE_ICON(d.name)}</span>
                    <span className="draft-meta">
                      <span className="draft-name">{d.name}</span>
                      <span className="draft-size">{prettySize(d.size)}</span>
                    </span>
                  </>
                )}
                <button className="draft-x" onClick={() => setDrafts(ds => ds.filter(x => x.id !== d.id))} aria-label={`Remove ${d.name}`}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-row">
        <button className="attach" onClick={() => picker.current?.click()} title="Attach images or files" aria-label="Attach">
          📎
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={e => {
            const files = [...(e.target.files ?? [])]
            e.target.value = ''
            if (files.length) void addFiles(files)
          }}
        />
        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder={disabled ? `${bot.name} is offline…` : `Message ${bot.name}`}
          onChange={e => setText(e.target.value)}
          onPaste={e => {
            const files = [...e.clipboardData.files]
            if (!files.length) return
            // A screenshot / copied file: attach it rather than pasting its name as text.
            e.preventDefault()
            void addFiles(files)
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {running && !canSend ? (
          <button className="send stop" onClick={() => void stop()} title="Stop">
            ■
          </button>
        ) : (
          <button key={hop} className={`send ${canSend ? 'ready' : ''} ${hop ? 'hop' : ''}`} onClick={submit} title="Send  ↵">
            ↑
          </button>
        )}
        </div>
      </div>
      <div className="composer-hint">
        {running ? 'Messages you send now steer the current turn.' : '↵ send · ⇧↵ new line · paste or drop images and files'}
      </div>
    </div>
  )
}

/** Shown above the composer while the bot's connection is down, with a one-click Reconnect. */
function OfflineBanner({ bot }: { bot: Bot }) {
  const st = useStore(s => s.statuses[bot.id])
  const working = st?.state === 'connecting'
  const where = useStore(s => {
    const t = s.config?.bots.find(b => b.id === bot.id)?.transport
    return t?.kind === 'ssh' ? t.host : 'this Mac'
  })
  return (
    <div className={`offline-banner ${working ? 'working' : ''}`} role="status">
      <span className="offline-dot" />
      <span className="offline-text">
        <b>{working ? `Connecting to ${bot.name}…` : `${bot.name} is offline`}</b>
        <span className="offline-detail">
          {st?.detail && st.detail !== 'Reconnecting…' ? st.detail : working ? where : `Can't reach ${where}. It keeps retrying on its own.`}
        </span>
      </span>
      <button className="offline-link" onClick={openSetup} title="Check or change how this bot connects">
        Edit bots
      </button>
      <button className="offline-btn" onClick={() => void reconnectBot(bot.id)} disabled={working}>
        {working ? <span className="session-spinner" /> : '↻'} {working ? 'Connecting' : 'Reconnect'}
      </button>
    </div>
  )
}

function NewChatPicker({ botId }: { botId: string }) {
  const config = useStore(s => s.config)
  const bots = useStore(s => s.bots)
  return (
    <div className="picker">
      {config?.bots.map(b => {
        const bot = bots[b.id]
        if (!bot) return null
        return (
          <button key={b.id} className={`picker-chip ${b.id === botId ? 'on' : ''}`} onClick={() => setNewChatBot(b.id)} style={{ ['--bot' as string]: bot.color }}>
            <Avatar bot={bot} size={22} />
            {bot.name}
          </button>
        )
      })}
    </div>
  )
}

export function Chat() {
  const view = useStore(s => s.view)!
  const key = useStore(s => focusedKey(s))
  const thread = useStore(s => (key ? s.threads[key] : undefined))
  const botId = view.kind === 'session' ? thread?.botId : view.botId
  const bot = useStore(s => (botId ? s.bots[botId] : undefined))
  const status = useStore(s => (botId ? s.statuses[botId]?.state : undefined))
  const prompts = useStore(s => s.prompts.filter(p => p.botId === botId && (!thread?.liveId || p.sessionId === thread.liveId || !p.sessionId)))
  const greeting = useMemo(() => GREETINGS[Math.floor(Math.random() * GREETINGS.length)], [key])

  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  const blocks = useMemo(() => toBlocks(thread?.items ?? []), [thread?.items])
  // The chat-app layout is for a bot's forever Bot Chat only; sessions keep the document layout.
  const bubbles = view.kind === 'bot' || !!thread?.isBotChat

  useLayoutEffect(() => {
    stick.current = true
  }, [key])

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [blocks, thread?.thinking, prompts.length, key])

  if (!bot) return <div className="boot">Waking the bots…</div>

  const isNew = view.kind === 'new' || (thread && !thread.liveId && thread.items.length === 0 && !thread.loading)
  const title = view.kind === 'bot' ? bot.name : thread?.title || (view.kind === 'new' ? 'New chat' : 'Untitled chat')
  const subtitle = view.kind === 'bot' ? 'Bot Chat' : bot.name
  const lastIsStreaming = (() => {
    const last = thread?.items[thread.items.length - 1]
    return last?.kind === 'assistant' && last.streaming
  })()

  return (
    <div
      className={`chat ${dragging ? 'dragging' : ''}`}
      style={{ ['--bot' as string]: bot.color }}
      onDragEnter={e => {
        if (e.dataTransfer.types.includes('Files')) {
          dragDepth.current++
          setDragging(true)
        }
      }}
      onDragOver={e => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (!dragDepth.current) setDragging(false)
      }}
      onDrop={e => {
        e.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        const files = [...e.dataTransfer.files]
        if (files.length) offerFiles(files)
      }}
    >
      {dragging && (
        <div className="drop-zone">
          <div className="drop-card">
            <span className="drop-emoji">📥</span>
            Drop to send to {bot.name}
          </div>
        </div>
      )}
      <header className="chat-head">
        <BackToBotChat />
        <Avatar bot={bot} size={28} />
        <div className="chat-titles">
          <div className="chat-title">{title}</div>
          <div className="chat-sub">{subtitle}</div>
        </div>
        <ModelPicker threadKey={key} bot={bot} />
        <WorkstreamsToggle />
      </header>

      <div
        className="scroller"
        ref={scroller}
        onScroll={e => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className={`thread ${bubbles ? 'bot-bubbles' : ''}`}>
          {thread?.loading && <ChatSkeleton bubbles={bubbles} />}
          {thread?.error && <div className="note error">{thread.error}</div>}

          {isNew && (
            <div className="hello">
              <Avatar bot={bot} size={84} className="wiggle" />
              <h2>{view.kind === 'bot' ? `Say hi to ${bot.name}` : greeting}</h2>
              {bot.description && <p>{bot.description}</p>}
              {view.kind === 'new' && <NewChatPicker botId={bot.id} />}
            </div>
          )}

          {(() => {
            // Bot Chats: a divider wherever the local calendar day changes (undated rows don't break a day).
            let lastDay: string | null = null
            return blocks.map((b, i) => {
              const ts = b.kind === 'tools' ? b.ts : b.item.ts
              const day = bubbles ? localDay(ts) : null
              const divider = day && day !== lastDay ? <BotDayDivider key={`day-${day}-${i}`} ts={ts!} /> : null
              if (day) lastDay = day
              const node =
                b.kind === 'tools' ? (
                  <ToolGroup key={b.id} tools={b.tools} live={!!thread?.running && i === blocks.length - 1} />
                ) : (
                  <Message key={b.item.id} item={b.item} bot={bot} bubbles={bubbles} />
                )
              return divider ? [divider, node] : node
            })
          })()}

          {thread?.running && !lastIsStreaming && <Typing bot={bot} status={thread.status} />}

          {prompts.map(p => (
            <PromptCard key={p.key} prompt={p} bot={bot} />
          ))}
        </div>
      </div>

      {status && status !== 'ready' && <OfflineBanner bot={bot} />}
      <Composer bot={bot} running={!!thread?.running} disabled={status !== 'ready'} />
    </div>
  )
}
