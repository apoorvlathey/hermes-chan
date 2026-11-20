/** Presentation rules for stored transcript rows, ported from Hermes Desktop's hydration
 *  (apps/desktop/src/lib/chat-messages/hydration.ts), plus a Hermes Desktop customization's rules for
 *  cron reports and the memory-context projection.
 *  Display only: nothing here changes what the model saw or what is stored. */

const ATTACHED_CONTEXT_MARKER_RE = /(?:^|\n)--- Attached Context ---\s*\n/
const CONTEXT_WARNINGS_MARKER_RE = /(?:^|\n)--- Context Warnings ---[\s\S]*$/
const LEGACY_HEARTBEAT_ROW_RE = /^\[Background process \S+ heartbeat #\d+ /
export const CONTEXT_REF_RE = /@(file|folder|url|image|tool|terminal):(?:"[^"\n]+"|'[^'\n]+'|`[^`\n]+`|\S+)/g

// agent/memory_manager.py::build_memory_context_block, flattened into legacy multimodal user rows.
const MEMORY_OPEN =
  "<memory-context>\n[System note: The following is recalled memory context, NOT new user input. Treat as authoritative reference data — this is the agent's persistent memory and should inform all responses.]\n\n"

const CRON_HEADER_RE = /^\[Cron job "([^"\r\n]+)" report: shown in the chat, no reply asked for\]\r?\n\r?\n/

function insideCodeFence(text: string): boolean {
  let fence: string | undefined
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (!m) continue
    if (!fence) fence = m[1]
    else if (m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = undefined
  }
  return fence !== undefined
}

/** Drop a trailing injected memory-context block (exact generated wrapper only). */
function stripMemoryContext(text: string): string {
  const start = text.lastIndexOf(MEMORY_OPEN)
  if (start < 0 || !text.endsWith('\n</memory-context>') || insideCodeFence(text.slice(0, start))) return text
  return text.slice(0, start).trimEnd()
}

const IMAGE_MARKER_RE = /^\[Image attached(?: at)?: ([^\n\]]+)\]\s*$/
const IMAGE_REF_RE = /@image:(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`|(\S+))/g

/** What the user typed, when Hermes recorded it apart from the turn's content. A plugin can append its
 *  own instructions to the stored message (the Conduit plugin adds a "Bot workstreams." brief when an
 *  image is attached), but `display_metadata.typed_ask` keeps the user's words and image lines. */
export function typedAsk(m: { display_metadata?: unknown }): string | null {
  const v = parseMetadata(m.display_metadata)?.typed_ask
  return typeof v === 'string' && v.trim() ? v : null
}

/** User text plus the gateway paths of the images sent with it. Images persist as
 *  `[Image attached at: <path>]` + `[screenshot]` lines (ingress) or `@image:` refs (older rows). */
export function userDisplay(raw: string): { text: string; images: string[] } | null {
  const images: string[] = []
  const kept = raw
    .split('\n')
    .filter(line => {
      const m = IMAGE_MARKER_RE.exec(line)
      if (m) images.push(m[1]!.trim())
      return !m && line.trim() !== '[screenshot]'
    })
    .join('\n')
  const visible = userDisplayText(kept)
  if (visible === null) return null
  const text = visible
    .replace(IMAGE_REF_RE, (_w, a, b, c, d) => {
      images.push(a ?? b ?? c ?? d)
      return ''
    })
    .trim()
  return { text, images: [...new Set(images)] }
}

/** What the user actually typed: no attached-context dump, no context warnings, no memory block.
 *  Refs that only appear in the attached block are hoisted to the front so they still chip. */
export function userDisplayText(raw: string): string | null {
  if (LEGACY_HEARTBEAT_ROW_RE.test(raw.trim())) return null
  const text = stripMemoryContext(raw)
  const marker = text.match(ATTACHED_CONTEXT_MARKER_RE)
  if (!marker || marker.index === undefined) return text.replace(CONTEXT_WARNINGS_MARKER_RE, '').trim()

  const visible = text.slice(0, marker.index).replace(CONTEXT_WARNINGS_MARKER_RE, '').trim()
  const attached = text.slice(marker.index + marker[0].length)
  const refs = [...new Set([...attached.matchAll(CONTEXT_REF_RE)].map(m => m[0]))]
  const missing = refs.filter(r => !visible.includes(r))
  return [missing.join('\n'), visible].filter(Boolean).join('\n\n') || visible
}

export function parseMetadata(meta: unknown): Record<string, any> | null {
  let v = meta
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  return v && typeof v === 'object' ? (v as Record<string, any>) : null
}

function isCronIdentity(identity: unknown): boolean {
  if (typeof identity !== 'string') return false
  try {
    const v: unknown = JSON.parse(identity)
    return Array.isArray(v) && v.length === 3 && v[0] === 'cron' && v.every(p => typeof p === 'string' && p.length > 0)
  } catch {
    return false
  }
}

/** A scheduled-job report delivered into the chat. Stored as a `user` row for the model, but it's the
 *  bot talking, so it renders as a bot message. Requires producer proof, never just the header text. */
export function cronReport(m: { role: string; display_kind?: string | null; display_metadata?: unknown }, text: string) {
  if (m.role !== 'user' || m.display_kind !== 'internal_notification' || !text) return null
  const meta = parseMetadata(m.display_metadata)
  const notes = meta?.completion_note
  const ownerCron = Array.isArray(notes) && notes.length > 0 && notes.every(isCronIdentity)
  if (meta?.conduit_cron_report !== true && !ownerCron) return null
  const header = CRON_HEADER_RE.exec(text)
  return header ? { jobName: header[1]!, text: text.slice(header[0].length) } : null
}

const CRON_OUTPUT_RE = /^\[Cronjob "((?:[^"\r\n]|"(?! output))+)" output[^\]\r\n]*\]\r?\n?/

/** A scheduled job's raw output handed to the bot to review (it then writes its own summary). Stored as
 *  an internal-notification `user` row headed `[Cronjob "<job>" output — scheduled job, not the user. …]`. */
export function cronOutput(m: { role: string; display_kind?: string | null }, text: string) {
  if (m.role !== 'user' || (m.display_kind && m.display_kind !== 'internal_notification')) return null
  const header = CRON_OUTPUT_RE.exec(text.trimStart())
  if (!header) return null
  const body = text.trimStart().slice(header[0].length).trim()
  return { jobName: header[1]!, text: body, failed: /^⚠️\s*Cron\b[^\n]*\bfailed\b/i.test(body) }
}

/** "[bot:default] Email checks (5min) and hourly discovery" → "Email checks (5min) and hourly discovery" */
export const humanJobName = (name: string) => name.replace(/^\[bot:[^\]]*\]\s*/, '').trim() || name

/** Split user text into plain runs and context refs (`@url:`…), for chips. */
export function splitRefs(text: string): ({ kind: 'text'; text: string } | { kind: 'ref'; type: string; value: string })[] {
  const out: ({ kind: 'text'; text: string } | { kind: 'ref'; type: string; value: string })[] = []
  let last = 0
  for (const m of text.matchAll(CONTEXT_REF_RE)) {
    if (m.index! > last) out.push({ kind: 'text', text: text.slice(last, m.index) })
    const raw = m[0].slice(m[1]!.length + 2)
    out.push({ kind: 'ref', type: m[1]!, value: raw.replace(/^["'`]|["'`]$/g, '') })
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

// ─── coordinator handoffs (Conduit plugin workstreams) ─────────────────────────────────────────

export interface Handoff {
  /** The coordinating bot ("Operator"). */
  from: string
  /** 'brief': the task that opened the workstream; 'follow-up': a later "passes on" message. */
  type: 'brief' | 'follow-up'
  /** What the coordinator asked, as written. */
  text: string
  /** The user's own words the coordinator was answering, when it quoted them. */
  quote?: string
}

const OOB_RE = /^\s*\[OUT-OF-BAND USER MESSAGE[^\]\n]*\]\n?([\s\S]*?)\n?\[\/OUT-OF-BAND USER MESSAGE\]\s*$/
const BRIEF_RE = /^You're working on a task for (.+?), who coordinates the user's work/
const FOLLOW_RE = /^(.+?), who coordinates this work, passes on:\n/
const QUOTE_RE = /\n*The user's message that .+? is answering now[^\n]*\n«([\s\S]*?)»\s*/

/** A steer row's text without its out-of-band wrapper. */
export function unwrapSteer(raw: string): string {
  return OOB_RE.exec(raw)?.[1] ?? raw
}

/** A message the Conduit plugin wrote into a workstream on the coordinator's behalf, or null.
 *  The plugin's own instructions to the worker (how to report, which tools) are left out. */
export function handoff(raw: string): Handoff | null {
  const text = unwrapSteer(raw).trim()
  const cleanQuote = (q?: string) => {
    if (!q) return undefined
    const shown = userDisplay(q)
    return shown?.text.trim() || undefined
  }
  const brief = BRIEF_RE.exec(text)
  if (brief) {
    const at = text.indexOf('\n\nTask:\n')
    const task = at >= 0 ? text.slice(at + 8).trim() : ''
    return { from: brief[1]!, type: 'brief', text: task, quote: cleanQuote(QUOTE_RE.exec(at >= 0 ? text.slice(0, at) : text)?.[1]) }
  }
  const follow = FOLLOW_RE.exec(text)
  if (follow) {
    const body = text.slice(follow[0].length)
    const q = QUOTE_RE.exec(body)
    return { from: follow[1]!, type: 'follow-up', text: (q ? body.slice(0, q.index) : body).trim(), quote: cleanQuote(q?.[1]) }
  }
  return null
}

// ─── quote replies ──────────────────────────────────────────────────────────────────────────────

/** The reply pointer Hermes' own gateway puts on a Telegram/Discord reply (gateway/run_inbound.py
 *  `_prepend_inbound_reply_context`), so the model reads a HermesChan reply the way it already knows:
 *  `[Replying to your previous message: "<quoted>"]` (the bot's message) or `[Replying to: "<quoted>"]`. */
const REPLY_RE = /^\[Replying to( your previous message)?: "([\s\S]*?)"\]\r?\n\r?\n/

export interface ReplyQuote {
  text: string
  /** The quoted message was the bot's. */
  own: boolean
}

export function withReply(quote: ReplyQuote, text: string): string {
  return `[Replying to${quote.own ? ' your previous message' : ''}: "${quote.text}"]\n\n${text}`
}

/** Split a stored user message into its reply pointer (if any) and the user's words. */
export function splitReply(text: string): { reply?: ReplyQuote; text: string } {
  const m = REPLY_RE.exec(text)
  if (!m) return { text }
  return { reply: { own: !!m[1], text: m[2]! }, text: text.slice(m[0].length) }
}

/** Hermes's notice that background work finished: a subagent from `delegate_task` (async), or one or more
 *  background processes. It reaches the bot as a `user` row (display_kind `async_delegation_complete` /
 *  `process_complete`) carrying the whole report for the model, with a short title for people in
 *  `display_metadata.display_text`. */
export interface BackgroundDone {
  variant: 'subagent' | 'process'
  /** "Subagent task completed", "2 background processes finished". */
  label: string
  /** The subagent's task, when there is one. */
  subject?: string
  /** What came back: the subagent's result (markdown), or the processes' exits. */
  body: string
  /** The body is terminal output, not markdown. */
  plain?: boolean
  failed: boolean
}

const DELEG_HEAD_RE = /^\[ASYNC DELEGATION (?:BATCH )?(?:COMPLETE|TASK FAILED)\b[^\]\n]*\]/
const PROCESS_HEAD_RE = /^\[IMPORTANT: (?:\d+ )?[Bb]ackground process/

export function backgroundDone(m: { role: string; display_kind?: string | null; display_metadata?: unknown }, raw: string): BackgroundDone | null {
  const kind = m.display_kind
  const isDeleg = kind === 'async_delegation_complete' || (!kind && DELEG_HEAD_RE.test(raw))
  const isProc = kind === 'process_complete' || (!kind && PROCESS_HEAD_RE.test(raw) && raw.includes('exit code'))
  if (m.role !== 'user' || (!isDeleg && !isProc)) return null
  const title = String(parseMetadata(m.display_metadata)?.display_text ?? '').trim()
  const cut = title.indexOf(': ')
  const head = cut > 0 ? title.slice(0, cut) : title
  let subject = cut > 0 ? title.slice(cut + 2).trim() : ''

  if (isProc) {
    const codes = [...raw.matchAll(/\(exit code (-?\d+)\)/g)].map(x => Number(x[1]))
    const body = raw
      .replace(/^\[IMPORTANT: \d+ background process results arrived[^\]]*\]\s*/, '')
      .replace(/\[IMPORTANT: Background process (\S+) ([^\n]*?)\.?\n/g, (_m, id: string, what: string) => `● ${id} ${what}\n`)
      .replace(/\n\]\s*(?=\n|$)/g, '\n')
      .replace(/^\[INTERNAL NOTIFICATION[^\]]*\]\s*$/gm, '')
      .trim()
    const n = Math.max(1, codes.length)
    return {
      variant: 'process',
      label: sentence(head) || (n === 1 ? 'Background process finished' : `${n} background processes finished`),
      body,
      plain: true,
      failed: codes.some(c => c !== 0)
    }
  }

  // A subagent. Single runs carry the result after `--- RESULT ---`; batches give each task a
  // `--- ✓ TASK i/n: <goal> (status=…) ---` header followed by its result.
  const failedRun = /^\[ASYNC DELEGATION TASK FAILED/.test(raw) || /^Status: (?!completed|success)/m.test(raw)
  let body = ''
  const single = raw.split(/^--- RESULT ---\s*$/m)
  const error = raw.split(/^--- ERROR ---\s*$/m)
  if (single.length > 1) body = single[1]
  else if (error.length > 1) body = error[1]
  else {
    const tasks = [...raw.matchAll(/^--- ([✓✗⚠]) TASK (\d+)\/(\d+)(?::\s*([\s\S]*?))?\s+\(status=([^)]*)\) ---\s*$/gm)]
    if (tasks.length === 1) body = raw.slice(tasks[0].index! + tasks[0][0].length)
    else if (tasks.length > 1)
      body = tasks
        .map((t, i) => {
          const end = i + 1 < tasks.length ? tasks[i + 1].index! : raw.length
          const goal = (t[4] ?? '').replace(/\s+/g, ' ').trim()
          return `**${t[1]} Task ${t[2]}/${t[3]}**${goal ? ` · ${clip(goal, 140)}` : ''}\n\n${tidyResult(raw.slice(t.index! + t[0].length, end))}`
        })
        .join('\n\n')
  }
  if (!subject) subject = /^Original goal: (.*)$/m.exec(raw)?.[1]?.trim() ?? /^Task: (.*)$/m.exec(raw)?.[1]?.trim() ?? ''
  const label = sentence(head) || (failedRun ? 'Subagent task failed' : 'Subagent task completed')
  return {
    variant: 'subagent',
    label,
    subject: subject || undefined,
    // Nothing recognisable: the report minus its model-facing heading and intro.
    body: tidyResult(body || raw.replace(DELEG_HEAD_RE, '').replace(/^\s*[^\n]+\n/, '')),
    failed: failedRun || /failed|interrupted|timed out|cancelled|stalled|issues|incomplete|unknown/i.test(head)
  }
}

/** "Subagent Task Completed" → "Subagent task completed". */
const sentence = (s: string) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : '')
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** A result as markdown: JSON gets a code fence, and the model-facing trailers go. */
function tidyResult(text: string): string {
  const t = text
    .replace(/^Full live transcript \(complete tool\/assistant trace\):.*$/gm, '')
    .replace(/^Task index \d+ transcript.*$/gm, '')
    .replace(/^\[INTERNAL NOTIFICATION[^\]]*\]\s*$/gm, '')
    .trim()
  if (!/^[[{]/.test(t)) return t
  // A JSON answer, maybe with lines after it: fence the JSON, keep the rest as written.
  const close = t[0] === '{' ? '}' : ']'
  for (let end = t.lastIndexOf(close); end > 0; end = t.lastIndexOf(close, end - 1)) {
    try {
      const json = JSON.stringify(JSON.parse(t.slice(0, end + 1)), null, 2)
      const rest = t.slice(end + 1).trim()
      return '```json\n' + json + '\n```' + (rest ? `\n\n${rest}` : '')
    } catch {
      /* try an earlier closing bracket */
    }
  }
  return t
}

// ─── Kanban task updates ────────────────────────────────────────────────────────────────────────

export interface KanbanUpdate {
  taskId: string
  board: string
  assignee: string
  /** done | blocked | crashed | gave_up | other */
  event: string
  /** "Done", "Worker crashed, will retry", … */
  label: string
  title?: string
  /** The result, block reason or failure output, as Hermes wrote it (often cut short). */
  detail?: string
}

// "✔ [default] @default Kanban t_500b301e done — ETH.sh GH-73: …" (the gateway's batched notifier)
const KB_LINE_RE = /^\S{0,3}\s*\[([^\]\n]+)\]\s+@(\S+)\s+Kanban\s+(t_[\w-]+)\s+(.+)$/
// "[kanban] Task t_16536654 crashed (worker exited); dispatcher will retry." (one task, to the bot)
const KB_NOTICE_RE = /^\[kanban\] Task (t_[\w-]+) (.+?)\.?\s*$/
const KB_RESTATED_RE = /^\[STILL IN PROGRESS[^\]\n]*\]\s*$/

function kanbanEvent(text: string): Pick<KanbanUpdate, 'event' | 'label' | 'title' | 'detail'> {
  const t = text.trim()
  let m: RegExpExecArray | null
  if ((m = /^(?:done|completed)(?:\s+[—–-]\s+(.+))?$/i.exec(t))) return { event: 'done', label: 'Done', title: m[1]?.trim() }
  if ((m = /^blocked(?::\s*([\s\S]+)|;\s*needs attention)?$/i.exec(t))) return { event: 'blocked', label: 'Blocked', detail: m[1]?.trim() }
  if (/crashed/i.test(t)) return { event: 'crashed', label: /retry/i.test(t) ? 'Worker crashed, will retry' : 'Worker crashed' }
  if (/gave up/i.test(t)) return { event: 'gave_up', label: 'Gave up after repeated failures' }
  return { event: 'other', label: t.charAt(0).toUpperCase() + t.slice(1) }
}

/** Hermes's Kanban status updates in a chat: a batch of notifier lines, or a single `[kanban] Task …`
 *  notice to the bot. Both are stored as `user` rows; they're Hermes reporting, not you. */
export function kanbanUpdates(m: { role: string; display_kind?: string | null }, raw: string): KanbanUpdate[] | null {
  if (m.role !== 'user' || (m.display_kind && m.display_kind !== 'internal_notification')) return null
  const lines = raw.replace(/\r/g, '').split('\n')
  while (lines.length && (!lines[0]!.trim() || KB_RESTATED_RE.test(lines[0]!))) lines.shift()
  if (!lines.length) return null

  const notice = KB_NOTICE_RE.exec(lines[0]!)
  if (notice) {
    const field = (name: string) => lines.find(l => l.startsWith(`${name}: `))?.slice(name.length + 2).trim()
    const ev = kanbanEvent(notice[2]!)
    return [{ taskId: notice[1]!, board: field('Board') ?? '', assignee: (field('Assignee') ?? '').replace(/^@/, ''), ...ev, title: field('Title') ?? ev.title, detail: field('Result') ?? ev.detail }]
  }

  const out: KanbanUpdate[] = []
  for (const line of lines) {
    const hit = KB_LINE_RE.exec(line.trim())
    if (hit) {
      out.push({ taskId: hit[3]!, board: hit[1]!, assignee: hit[2]!, ...kanbanEvent(hit[4]!) })
    } else if (line.trim()) {
      // A continuation line: the previous update's result or failure output.
      const last = out[out.length - 1]
      if (!last) return null
      last.detail = last.detail ? `${last.detail}\n${line.trim()}` : line.trim()
    }
  }
  if (!out.length) return null
  // Crash lines carry no title; borrow it from another line about the same task.
  for (const u of out) u.title ??= out.find(o => o.taskId === u.taskId && o.title)?.title
  return out
}
