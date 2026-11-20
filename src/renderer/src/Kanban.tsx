/** The Kanban board of a bot's host: Hermes's task board (the one its agents claim and work through),
 *  read-only. Columns follow Hermes's workflow; a task opens in a panel on the right. */
import { useEffect, useMemo, useRef, useState } from 'react'

import type { KanbanBoard, KanbanCard, KanbanTaskDetail } from '../../shared/types'
import { hermes } from './bridge'
import { Markdown } from './Chat'
import { clearKanbanFocus, hostKey, kanbanHosts, loadKanbanBoards, openKanban, profileNamer, useStore } from './store'

const POLL_MS = 15_000
const DONE_SHOWN = 25

export const STATUS: Record<string, string> = {
  triage: 'Triage',
  todo: 'To do',
  scheduled: 'Scheduled',
  ready: 'Ready',
  running: 'Running',
  blocked: 'Blocked',
  review: 'Review',
  done: 'Done',
  archived: 'Archived'
}

const BLOCK: Record<string, string> = {
  needs_input: 'Needs your input',
  capability: 'Missing a capability',
  transient: 'Will retry',
  dependency: 'Waiting on another task'
}

const label = (status: string) => STATUS[status] ?? status.charAt(0).toUpperCase() + status.slice(1)

/** "4m", "3h", "2d" */
function span(seconds: number): string {
  const s = Math.max(0, seconds)
  if (s < 60) return '<1m'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

const now = () => Date.now() / 1000

/** The board picked on each host, kept while the app runs (leaving the board and coming back keeps it). */
const pickedBoards: Record<string, string> = {}

export function Kanban() {
  const botId = useStore(s => (s.view?.kind === 'kanban' ? s.view.botId : ''))
  const host = useStore(s => kanbanHosts(s).find(h => h.key === hostKey(botId, s)))
  const hosts = useStore(s => kanbanHosts(s))
  const online = useStore(s => s.statuses[botId]?.state === 'ready')
  const boards = useStore(s => s.kanbanBoards[hostKey(botId, s)])
  const [picked, setPickedState] = useState<Record<string, string>>(() => ({ ...pickedBoards }))
  const setPicked = (f: (p: Record<string, string>) => Record<string, string>) =>
    setPickedState(p => {
      const next = f(p)
      Object.assign(pickedBoards, next)
      return next
    })
  const slug = picked[hostKey(botId)] ?? boards?.find(b => b.current)?.slug ?? boards?.[0]?.slug
  const board = boards?.find(b => b.slug === slug)

  const [data, setData] = useState<{ key: string; board: KanbanBoard; at: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const focus = useStore(s => s.kanbanFocus)
  const who = useStore(s => profileNamer(botId, s))
  const [refreshing, setRefreshing] = useState(false)
  const key = `${botId}/${slug ?? ''}`
  const live = useRef(key)
  live.current = key

  /** The board, and with `withBoards` the board list too: in parallel when the board is already
   *  known, since each read is a round trip to the host. */
  const load = async (withBoards = true) => {
    if (!botId || !online) return
    setRefreshing(true)
    try {
      const listing = withBoards || !slug ? loadKanbanBoards(botId) : null
      const s = slug ?? (await listing)?.find(b => b.current)?.slug ?? (await listing)?.[0]?.slug
      if (!s) {
        await listing
        return
      }
      const k = `${botId}/${s}`
      const [b] = await Promise.all([hermes.kanbanBoard(botId, s), listing])
      if (live.current !== k && live.current !== `${botId}/`) return
      setData({ key: k, board: b, at: Date.now() })
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRefreshing(false)
    }
  }

  // Load on open, on host/board change, every few seconds while open, and when the window regains focus.
  useEffect(() => {
    setSelected(null)
    setError(null)
    void load()
    const t = setInterval(() => void load(false), POLL_MS)
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', onFocus)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, slug, online])

  // Opened from a Kanban update in a chat: switch to its board and open the task.
  useEffect(() => {
    if (!focus || !boards) return
    if (boards.some(b => b.slug === focus.board) && focus.board !== slug) {
      setPicked(p => ({ ...p, [hostKey(botId)]: focus.board }))
      return // the board switch re-runs this
    }
    setSelected(focus.taskId)
    clearKanbanFocus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, boards, slug])

  // Re-render each minute so ages stay true.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (selected) setSelected(null)
      else if (filter) setFilter('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, filter])

  const shown = data?.key === key ? data.board : null
  const cards = useMemo(() => shown?.columns.flatMap(c => c.cards) ?? [], [shown])
  const q = filter.trim().toLowerCase()
  const columns = useMemo(
    () =>
      (shown?.columns ?? []).map(c => ({
        status: c.status,
        cards: q ? c.cards.filter(t => `${t.title} ${t.id} ${t.assignee} ${who(t.assignee)} ${t.summary}`.toLowerCase().includes(q)) : c.cards
      })),
    [shown, q, who]
  )
  // Who a task is for only tells you something when the board has more than one assignee.
  const showWho = new Set(cards.map(c => c.assignee)).size > 1
  const open = cards.filter(c => c.status !== 'done').length
  const running = cards.filter(c => c.status === 'running').length
  const attention = cards.filter(c => c.status === 'blocked' || c.status === 'triage').length
  const loading = !shown && !error

  const sub = [
    board && (boards!.length > 1 ? null : board.name),
    host?.label,
    shown && `${open} open${running ? ` · ${running} running` : ''}${attention ? ` · ${attention} need${attention === 1 ? 's' : ''} attention` : ''}`
  ].filter(Boolean)

  return (
    <div className="kanban">
      <header className="chat-head kanban-head">
        <span className="kanban-mark" aria-hidden>
          <BoardIcon />
        </span>
        <div className="chat-titles">
          <div className="chat-title">Kanban</div>
          <div className="chat-sub">
            {sub.join(' · ') || ' '}
            {/* Old data must never pass for live: say when the board stopped updating. */}
            {shown && data && (!online || error) && (
              <span className="kanban-stale" title={error ?? undefined}>
                · {online ? 'Couldn’t refresh' : 'Offline'}, showing the board from {updated(data.at)}
              </span>
            )}
          </div>
        </div>
        <div className="kanban-tools">
          <label className="kanban-filter">
            <span aria-hidden>⌕</span>
            <input placeholder="Filter tasks" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter tasks" />
          </label>
          {boards && boards.length > 1 && (
            <Select
              value={slug ?? ''}
              onChange={v => setPicked(p => ({ ...p, [hostKey(botId)]: v }))}
              options={boards.map(b => ({ value: b.slug, label: `${b.name}${b.current ? ' (active)' : ''}` }))}
              title="Board"
            />
          )}
          {hosts.length > 1 && (
            <Select
              value={host?.key ?? ''}
              onChange={v => {
                const h = hosts.find(x => x.key === v)
                if (h) openKanban(h.botId)
              }}
              options={hosts.map(h => ({ value: h.key, label: h.label, title: h.bots.join(', ') }))}
              title="Where the board lives. Bots on the same machine share its boards."
            />
          )}
          <button className={`kanban-refresh ${refreshing ? 'spinning' : ''}`} onClick={() => void load()} disabled={!online} title={data ? `Updated ${updated(data.at)}. Refresh` : 'Refresh'} aria-label="Refresh">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M13.2 6.2A5.5 5.5 0 0 0 3 5M2.8 9.8A5.5 5.5 0 0 0 13 11" />
              <path d="M3 2.2V5h2.8M13 13.8V11h-2.8" />
            </svg>
          </button>
        </div>
      </header>

      <div className="kanban-body">
        {!online && !shown ? (
          <Empty title={`${host?.label ?? 'This bot'} is offline`} body="The board loads once the bot reconnects." />
        ) : error && !shown ? (
          <Empty title="Couldn’t load the board" body={error} onRetry={() => void load()} />
        ) : loading ? (
          <BoardSkeleton />
        ) : shown && cards.length === 0 ? (
          <Empty title="No tasks yet" body="When your bots break work into Kanban tasks, they show up here." />
        ) : q && columns.every(c => c.cards.length === 0) ? (
          <Empty title={`No tasks match “${filter.trim()}”`} body="Filtering looks at titles, IDs, assignees and summaries." action="Clear filter" onRetry={() => setFilter('')} />
        ) : (
          <div className="kanban-cols" onClick={e => e.target === e.currentTarget && setSelected(null)}>
            {columns.map(c =>
              c.cards.length ? (
                <Column key={c.status} status={c.status} cards={c.cards} total={shown!.columns.find(x => x.status === c.status)!.cards.length} filtered={!!q} selected={selected} onSelect={setSelected} serverNow={shown!.now} who={showWho ? who : null} />
              ) : (
                <div key={c.status} className="kb-rail" title={`${label(c.status)}: no tasks${q ? ' match' : ''}`}>
                  <StatusIcon status={c.status} />
                  <span>{label(c.status)}</span>
                </div>
              )
            )}
          </div>
        )}
        {selected && slug && (
          <TaskPanel
            key={selected}
            botId={botId}
            board={slug}
            taskId={selected}
            card={cards.find(c => c.id === selected)}
            who={who}
            version={data?.at ?? 0}
            onSelect={setSelected}
            onClose={() => setSelected(null)}
            onChanged={() => void load()}
            known={new Set(cards.map(c => c.id))}
          />
        )}
      </div>
    </div>
  )
}

function updated(at: number): string {
  const s = (Date.now() - at) / 1000
  return s < 10 ? 'just now' : `${span(s)} ago`
}

function Select({ value, onChange, options, title }: { value: string; onChange: (v: string) => void; options: { value: string; label: string; title?: string }[]; title: string }) {
  return (
    <span className="kanban-select" title={title}>
      <select value={value} onChange={e => onChange(e.target.value)} aria-label={title}>
        {options.map(o => (
          <option key={o.value} value={o.value} title={o.title}>
            {o.label}
          </option>
        ))}
      </select>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M2.5 4 5 6.5 7.5 4" />
      </svg>
    </span>
  )
}

function Column(props: { status: string; cards: KanbanCard[]; total: number; filtered: boolean; selected: string | null; onSelect: (id: string) => void; serverNow: number; who: ((profile: string) => string) | null }) {
  const { status, cards, total, filtered, selected, onSelect, serverNow, who } = props
  const [all, setAll] = useState(false)
  const capped = status === 'done' && !all && cards.length > DONE_SHOWN
  const list = capped ? cards.slice(0, DONE_SHOWN) : cards
  // The server's clock, carried forward: ages stay right even when this Mac's clock is off.
  const skew = serverNow ? now() - serverNow : 0
  return (
    <section className={`kb-col s-${status}`} aria-label={label(status)}>
      <h3 className="kb-col-head">
        <StatusIcon status={status} />
        <span>{label(status)}</span>
        <span className="kb-count">{filtered && cards.length !== total ? `${cards.length} of ${total}` : cards.length}</span>
      </h3>
      <div className="kb-cards">
        {list.map(c => (
          <Card key={c.id} card={c} selected={selected === c.id} onSelect={onSelect} skew={skew} who={who} />
        ))}
        {capped && (
          <button className="kb-more" onClick={() => setAll(true)}>
            Show {cards.length - DONE_SHOWN} older
          </button>
        )}
      </div>
    </section>
  )
}

function Card({ card: c, selected, onSelect, skew, who }: { card: KanbanCard; selected: boolean; onSelect: (id: string) => void; skew: number; who: ((profile: string) => string) | null }) {
  const t = now() - skew
  const age =
    c.status === 'done' && c.completedAt
      ? `${span(t - c.completedAt)} ago`
      : c.status === 'running' && c.runStartedAt
        ? `for ${span(t - c.runStartedAt)}`
        : c.createdAt
          ? `${span(t - c.createdAt)} ago`
          : ''
  const note =
    c.status === 'blocked'
      ? BLOCK[c.blockKind] ?? 'Blocked'
      : c.status === 'todo' && c.parents > 0
        ? `Depends on ${c.parents} task${c.parents === 1 ? '' : 's'}`
        : null
  return (
    <button className={`kb-card ${selected ? 'selected' : ''}`} onClick={() => onSelect(c.id)} aria-pressed={selected}>
      <span className="kb-card-title">{c.title || 'Untitled task'}</span>
      {note && <span className={`kb-note ${c.status === 'blocked' ? 'bad' : ''}`}>{note}</span>}
      {c.summary && (c.status === 'done' || c.status === 'review') && <span className="kb-summary">{c.summary}</span>}
      <span className="kb-meta">
        {who && <span className="kb-who">{c.assignee ? who(c.assignee) : 'Unassigned'}</span>}
        {age && <span>{age}</span>}
        <span className="kb-icons">
          {c.warnings && (
            <span className={`kb-warn ${c.warnings.severity === 'warning' ? '' : 'bad'}`} title={`${c.warnings.count} health warning${c.warnings.count === 1 ? '' : 's'}`}>
              <Icon d="M8 2.2 14 13H2L8 2.2ZM8 6.4v3M8 11.2v.1" />
              {c.warnings.count}
            </span>
          )}
          {c.comments > 0 && (
            <span title={`${c.comments} comment${c.comments === 1 ? '' : 's'}`}>
              <Icon d="M2.5 3.5h11v7H7l-3 2.5v-2.5H2.5z" />
              {c.comments}
            </span>
          )}
        </span>
      </span>
    </button>
  )
}

function TaskPanel(props: {
  botId: string
  board: string
  taskId: string
  card?: KanbanCard
  /** Profile → bot name. */
  who: (profile: string) => string
  version: number
  known: Set<string>
  onSelect: (id: string) => void
  onClose: () => void
  /** The task changed here (a reply, an unblock): refresh the board. */
  onChanged: () => void
}) {
  const { botId, board, taskId, card, who, version, known, onSelect, onClose, onChanged } = props
  const [detail, setDetail] = useState<KanbanTaskDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mine, setMine] = useState(0)

  // Refetch alongside the board, so an open task stays as current as its card.
  useEffect(() => {
    let live = true
    hermes
      .kanbanTask(botId, board, taskId)
      .then(d => live && (setDetail(d), setError(null)))
      .catch(err => live && setError((err as Error).message))
    return () => {
      live = false
    }
  }, [botId, board, taskId, version, mine])

  const c = { ...detail?.card, ...card } as KanbanCard | undefined
  const status = c?.status ?? ''
  const t = now()

  return (
    <aside className="kb-panel" aria-label="Task">
      <div className="kb-panel-head">
        <span className={`kb-panel-status s-${status}`}>
          {status && <StatusIcon status={status} />}
          {status ? label(status) : 'Loading…'}
          {status === 'blocked' && c?.blockKind && BLOCK[c.blockKind] && <span className="kb-panel-why">· {BLOCK[c.blockKind]}</span>}
        </span>
        <button className="kb-close" onClick={onClose} title="Close (Esc)" aria-label="Close task">
          <Icon d="M4 4l8 8M12 4l-8 8" size={14} />
        </button>
      </div>

      <div className="kb-panel-scroll">
        <h2 className="kb-panel-title">{c?.title || (error ? 'Couldn’t load this task' : ' ')}</h2>
        {c && (
          <div className="kb-facts">
            <span className="kb-id">{c.id}</span>
            <span>{c.assignee ? who(c.assignee) : 'Unassigned'}</span>
            {c.createdAt > 0 && <span>Created {span(t - c.createdAt)} ago{detail?.createdBy ? ` by ${who(detail.createdBy)}` : ''}</span>}
            {status === 'done' && c.completedAt > 0 && <span>Done {span(t - c.completedAt)} ago</span>}
            {status === 'running' && c.runStartedAt > 0 && <span>Running for {span(t - c.runStartedAt)}</span>}
            {c.priority !== 0 && <span>Priority {c.priority}</span>}
          </div>
        )}
        {error && !detail && <p className="kb-error">{error}</p>}
        {!detail && !error && <div className="kb-panel-loading shimmer-box" />}

        {detail && (
          <>
            {detail.diagnostics.length > 0 && (
              <ul className="kb-diags">
                {detail.diagnostics.map((d, i) => (
                  <Diagnostic key={i} {...d} />
                ))}
              </ul>
            )}

            {detail.summary && (
              <Section title="Latest summary">
                <Markdown text={detail.summary} botId={botId} />
              </Section>
            )}
            {detail.result && detail.result !== detail.summary && (
              <Section title="Result">
                <Markdown text={detail.result} botId={botId} />
              </Section>
            )}
            {detail.lastError && (status === 'blocked' || status === 'triage') && (
              <Section title="Last error">
                <pre className="kb-pre bad">{detail.lastError}</pre>
              </Section>
            )}
            <Section title="Description">{detail.body ? <Markdown text={detail.body} botId={botId} /> : <p className="kb-none">No description.</p>}</Section>

            {detail.parents.length > 0 && (
              <Section title={`Depends on · ${detail.parents.filter(x => x.status === 'done').length} of ${detail.parents.length} done`}>
                <Links items={detail.parents} known={known} onSelect={onSelect} />
              </Section>
            )}
            {detail.children.length > 0 && (
              <Section title={`Unblocks · ${detail.children.length}`}>
                <Links items={detail.children} known={known} onSelect={onSelect} />
              </Section>
            )}

            {detail.comments.length > 0 && (
              <Section title={`Comments · ${detail.comments.length}`}>
                <ol className="kb-comments">
                  {detail.comments.map((m, i) => (
                    <Comment key={i} author={m.author === 'user' ? 'user' : who(m.author)} ago={m.at > 0 ? `${span(t - m.at)} ago` : ''} body={m.body} botId={botId} />
                  ))}
                </ol>
              </Section>
            )}

            {detail.runs.length > 0 && (
              <Section title={`Runs · ${detail.runs.length}`}>
                <ol className="kb-runs">
                  {[...detail.runs].reverse().map(r => {
                    const ended = r.endedAt || (r.status === 'running' ? t : 0)
                    const outcome = r.outcome || r.status
                    const bad = /fail|error|crash|timeout|killed|block/i.test(outcome)
                    const tone = r.status === 'running' ? 'live' : bad ? 'bad' : /done|complet|review/i.test(outcome) ? 'ok' : ''
                    return (
                      <li key={r.id} className={`tone-${tone || 'plain'}`}>
                        <div className="kb-run-head">
                          <span className="kb-run-dot" aria-hidden />
                          <span className={`kb-run-outcome ${bad ? 'bad' : ''}`}>{outcome.replace(/_/g, ' ')}</span>
                          {r.profile && <span>{who(r.profile)}</span>}
                          {ended > 0 && r.startedAt > 0 && <span>{span(ended - r.startedAt)}</span>}
                          {r.startedAt > 0 && <span className="kb-run-when">{span(t - r.startedAt)} ago</span>}
                        </div>
                        {(r.error || r.summary) && <p className={`kb-run-text ${r.error ? 'bad' : ''}`}>{r.error || r.summary}</p>}
                      </li>
                    )
                  })}
                </ol>
              </Section>
            )}
          </>
        )}
      </div>
      {status && status !== 'done' && status !== 'archived' && (
        <Reply
          key={taskId}
          status={status}
          onSend={async (text, unblock) => {
            await hermes.kanbanReply(botId, board, taskId, text, unblock)
            setMine(n => n + 1)
            onChanged()
          }}
        />
      )}
    </aside>
  )
}

/** Answer the task from the panel. A blocked task gets "Reply & unblock" (your comment, then Hermes's
 *  unblock, so a fresh worker starts with your answer); a running one's worker reads new comments as
 *  it goes; anything else just gets the comment. */
function Reply({ status, onSend }: { status: string; onSend: (text: string, unblock: boolean) => Promise<void> }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'reply' | 'comment' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const blocked = status === 'blocked'
  const ready = !!text.trim() && !busy
  const primary = blocked ? 'Reply & unblock' : status === 'running' ? 'Send to worker' : 'Comment'

  const send = async (unblock: boolean) => {
    if (!text.trim() || busy) return
    setBusy(unblock ? 'reply' : 'comment')
    setError(null)
    try {
      await onSend(text, unblock)
      setText('')
      setSent(unblock ? 'Sent and unblocked. A worker picks it up next.' : status === 'running' ? 'Sent to the worker.' : 'Comment added.')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="kb-reply">
      <textarea
        value={text}
        onChange={e => {
          setText(e.target.value)
          setSent(null)
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void send(blocked)
          }
        }}
        placeholder={blocked ? 'Answer what it needs…' : status === 'running' ? 'Message the worker…' : 'Add a comment…'}
        rows={2}
        aria-label="Reply to this task"
      />
      <div className="kb-reply-foot">
        <span className={`kb-reply-note ${error ? 'bad' : ''}`}>{error ?? sent ?? (blocked ? '⌘↵ reply and unblock' : '⌘↵ send')}</span>
        {blocked && (
          <button className="kb-btn" disabled={!ready} onClick={() => void send(false)} title="Add your comment without unblocking">
            {busy === 'comment' ? 'Sending…' : 'Comment only'}
          </button>
        )}
        <button className="kb-btn primary" disabled={!ready} onClick={() => void send(blocked)}>
          {busy && (!blocked || busy === 'reply') ? (blocked ? 'Unblocking…' : 'Sending…') : primary}
        </button>
      </div>
    </div>
  )
}

/** Hermes's health warnings can run long (whole error logs); they open on click. */
function Diagnostic({ severity, title, detail }: { severity: string; title: string; detail: string }) {
  const [open, setOpen] = useState(false)
  return (
    <li className={`${severity === 'warning' ? '' : 'bad'} ${open ? 'open' : ''}`}>
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} title={open ? 'Show less' : 'Show the full warning'}>
        <Icon d="M8 2.2 14 13H2L8 2.2ZM8 6.4v3M8 11.2v.1" />
        <span>
          <strong>{title}</strong>
          {detail && <span>{detail}</span>}
        </span>
      </button>
    </li>
  )
}

const COMMENT_FOLD = 360

/** One comment: who and when on top, the text below; long ones fold. Yours are tinted. */
function Comment({ author, ago, body, botId }: { author: string; ago: string; body: string; botId: string }) {
  const long = body.length > COMMENT_FOLD || body.split('\n').length > 6
  const [open, setOpen] = useState(false)
  const mine = author === 'user'
  const name = mine ? 'You' : author
  return (
    <li className={`kb-comment ${mine ? 'mine' : ''}`}>
      <div className="kb-comment-head">
        <span className="kb-comment-avatar" aria-hidden>
          {name.charAt(0).toUpperCase()}
        </span>
        <strong>{name}</strong>
        {ago && <span>{ago}</span>}
      </div>
      <div className={`kb-comment-body ${long && !open ? 'folded' : ''}`}>
        <Markdown text={body} botId={botId} />
      </div>
      {long && (
        <button className="kb-comment-more" onClick={() => setOpen(o => !o)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </li>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="kb-section">
      <h4>{title}</h4>
      {children}
    </section>
  )
}

function Links({ items, known, onSelect }: { items: { id: string; title: string; status: string }[]; known: Set<string>; onSelect: (id: string) => void }) {
  return (
    <ul className="kb-links">
      {items.map(l => (
        <li key={l.id}>
          <button disabled={!known.has(l.id)} onClick={() => onSelect(l.id)} title={known.has(l.id) ? 'Open task' : 'Not on this board (archived?)'}>
            <StatusIcon status={l.status} />
            <span className="kb-link-title">{l.title || l.id}</span>
            <span className="kb-link-status">{l.status ? label(l.status) : ''}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function Empty({ title, body, onRetry, action = 'Try again' }: { title: string; body: string; onRetry?: () => void; action?: string }) {
  return (
    <div className="kanban-empty">
      <BoardIcon size={28} />
      <h3>{title}</h3>
      <p>{body}</p>
      {onRetry && (
        <button className="kb-retry" onClick={onRetry}>
          {action}
        </button>
      )}
    </div>
  )
}

function BoardSkeleton() {
  return (
    <div className="kanban-cols" aria-busy>
      {[3, 2, 4, 1].map((n, i) => (
        <section key={i} className="kb-col">
          <div className="kb-col-head">
            <span className="kb-skel shimmer-box" style={{ width: 70 }} />
          </div>
          <div className="kb-cards">
            {Array.from({ length: n }, (_, j) => (
              <div key={j} className="kb-card kb-card-skel">
                <span className="kb-skel shimmer-box" style={{ width: '85%' }} />
                <span className="kb-skel shimmer-box" style={{ width: '55%' }} />
                <span className="kb-skel shimmer-box small" style={{ width: '40%' }} />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function Icon({ d, size = 12 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  )
}

export function BoardIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2.5" />
      <path d="M6 2.5v11M10 2.5v11" />
      <path d="M3.6 5h.8M7.6 5h.8M7.6 7.4h.8M11.6 5h.8" />
    </svg>
  )
}

/** One glyph per workflow state, in the spirit of Hermes's own (◇ ◻ ⏱ ▶ ● ⊘ ◎ ✓). */
export function StatusIcon({ status }: { status: string }) {
  const p = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, className: `kb-glyph g-${status}`, 'aria-hidden': true }
  switch (status) {
    case 'triage':
      return (
        <svg {...p}>
          <path d="M8 2.5 13.5 8 8 13.5 2.5 8Z" />
        </svg>
      )
    case 'scheduled':
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5.2V8l1.8 1.2" />
        </svg>
      )
    case 'ready':
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M6.9 5.9v4.2L10 8z" fill="currentColor" />
        </svg>
      )
    case 'running':
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.5" opacity="0.25" />
          <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" className="kb-spin" />
        </svg>
      )
    case 'blocked':
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M4.2 11.8l7.6-7.6" />
        </svg>
      )
    case 'review':
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.5" />
          <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'done':
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M5.6 8.2l1.6 1.6 3.2-3.4" />
        </svg>
      )
    case 'failed':
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M6 6l4 4M10 6l-4 4" />
        </svg>
      )
    case 'archived':
      return (
        <svg {...p}>
          <rect x="2.5" y="3" width="11" height="3" rx="1" />
          <path d="M3.5 6v6.5h9V6M6.5 8.5h3" />
        </svg>
      )
    default:
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.5" />
        </svg>
      )
  }
}
