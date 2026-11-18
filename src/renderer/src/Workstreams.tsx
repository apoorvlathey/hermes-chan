/** The right-hand panel: what a bot is working on in the background (its Conduit workstreams).
 *  A running workstream's session is hidden from the sidebar, so this is where you follow it. */
import { useEffect, useState } from 'react'

import type { Workstream } from '../../shared/types'
import { focusedKey, isActiveWork, loadWorkstreams, openSessionRef, threadKey, toggleWorkstreams, useStore } from './store'

const POLL_MS = 15_000
const RECENT = 4

const STATUS: Record<string, { label: string; tone: 'work' | 'you' | 'wait' | 'done' | 'bad' }> = {
  starting: { label: 'Starting', tone: 'work' },
  running: { label: 'Working', tone: 'work' },
  needs_you: { label: 'Needs you', tone: 'you' },
  waiting: { label: 'Waiting on a bot', tone: 'wait' },
  ready: { label: 'Ready to review', tone: 'you' },
  done: { label: 'Done', tone: 'done' },
  failed: { label: 'Failed', tone: 'bad' },
  stopped: { label: 'Stopped', tone: 'done' },
  interrupted: { label: 'Interrupted', tone: 'bad' }
}

function ago(ts: number): string {
  if (!ts) return ''
  const s = Math.max(0, Date.now() / 1000 - ts)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  const d = Math.floor(s / 86400)
  return d === 1 ? 'yesterday' : `${d}d ago`
}

/** Which bot's panel to show: the Bot Chat's bot, or the bot whose workstream is open. */
export function usePanelBot(): string | null {
  return useStore(s => {
    const v = s.view
    if (!v) return null
    if (v.kind === 'bot') return v.botId
    if (v.kind !== 'session') return null
    const botId = s.threads[v.key]?.botId
    if (!botId) return null
    const list = s.workstreams[botId] ?? []
    return list.some(w => w.sessionId && threadKey(botId, w.sessionId) === v.key) ? botId : null
  })
}

/** Keep a bot's list fresh while its panel could be on screen. */
function usePoll(botId: string | null, online: boolean) {
  useEffect(() => {
    if (!botId || !online) return
    void loadWorkstreams(botId)
    const t = setInterval(() => void loadWorkstreams(botId), POLL_MS)
    const onFocus = () => void loadWorkstreams(botId)
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', onFocus)
    }
  }, [botId, online])
}

/** The chat-head button that opens and closes the panel, shown wherever the panel can appear. */
export function WorkstreamsToggle() {
  const botId = usePanelBot()
  const open = useStore(s => s.showWorkstreams)
  const list = useStore(s => (botId ? s.workstreams[botId] : undefined))
  if (!botId || !list?.length) return null
  const active = list.filter(isActiveWork)
  const attention = active.some(w => w.status === 'needs_you' || w.status === 'ready')
  return (
    <button
      className={`ws-toggle ${open ? 'on' : ''}`}
      onClick={() => toggleWorkstreams()}
      title={open ? 'Hide workstreams' : 'Show workstreams'}
      aria-pressed={open}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2.5" />
        <path d="M10 2.5v11" />
      </svg>
      {active.length > 0 && <span className={`ws-count ${attention ? 'attention' : ''}`}>{active.length}</span>}
    </button>
  )
}

export function WorkstreamsPanel() {
  const botId = usePanelBot()
  const online = useStore(s => !!botId && s.statuses[botId]?.state === 'ready')
  const open = useStore(s => s.showWorkstreams)
  const list = useStore(s => (botId ? s.workstreams[botId] : undefined))
  const bot = useStore(s => (botId ? s.bots[botId] : undefined))
  const current = useStore(s => focusedKey(s))
  const [more, setMore] = useState(false)
  // Re-render each minute so "5m ago" stays true.
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])
  usePoll(botId, online)

  if (!botId || !bot || !open || !list?.length) return null

  const active = list.filter(isActiveWork)
  const recent = list.filter(w => !isActiveWork(w))
  const shown = more ? recent : recent.slice(0, RECENT)

  return (
    <aside className="ws-panel" style={{ ['--bot' as string]: bot.color }}>
      <div className="ws-head">
        <div className="ws-title">Workstreams</div>
        <div className="ws-sub">{summary(active)}</div>
      </div>

      <div className="ws-scroll">
        {active.length > 0 && (
          <section className="ws-section">
            <div className="ws-label">Active</div>
            {active.map(w => (
              <Row key={w.ref} w={w} botId={botId} current={current} />
            ))}
          </section>
        )}
        {recent.length > 0 && (
          <section className="ws-section">
            <div className="ws-label">Recent</div>
            {shown.map(w => (
              <Row key={w.ref} w={w} botId={botId} current={current} />
            ))}
            {recent.length > RECENT && (
              <button className="ws-more" onClick={() => setMore(m => !m)}>
                {more ? 'Show less' : `Show ${recent.length - RECENT} more`}
              </button>
            )}
          </section>
        )}
      </div>
    </aside>
  )
}

/** "2 working · 8 to review", or "Nothing running". */
function summary(active: Workstream[]): string {
  const review = active.filter(w => w.status === 'ready' || w.status === 'needs_you').length
  const working = active.length - review
  const parts = [working && `${working} working`, review && `${review} to review`].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Nothing running'
}

function Row({ w, botId, current }: { w: Workstream; botId: string; current: string | null }) {
  const st = STATUS[w.status] ?? { label: w.status, tone: 'done' as const }
  const total = w.steps.length
  const doneSteps = w.steps.filter(s => s.state === 'done').length
  const now = w.steps.find(s => s.state === 'doing') ?? (isActiveWork(w) ? w.steps.find(s => s.state === 'todo') : undefined)
  const selected = !!w.sessionId && current === threadKey(botId, w.sessionId)
  const when = ago(w.closedAt || w.updatedAt || w.createdAt)

  return (
    <button
      className={`ws-row tone-${st.tone} ${selected ? 'selected' : ''}`}
      disabled={!w.sessionId}
      onClick={() => openSessionRef(w.sessionId, undefined, botId, w.title)}
      title={w.lastResult || w.error || w.title}
    >
      <span className="ws-icon" aria-hidden>
        <StatusIcon tone={st.tone} />
      </span>
      <span className="ws-body">
        <span className="ws-name">{w.title}</span>
        <span className="ws-meta">
          <span className="ws-ref">{w.ref}</span>
          <span className="ws-status">{st.label}</span>
          {total > 0 && isActiveWork(w) && (
            <span>
              {doneSteps}/{total}
            </span>
          )}
          {when && <span>{when}</span>}
        </span>
        {isActiveWork(w) && total > 0 && (
          <span className="ws-steps" aria-label={`${doneSteps} of ${total} steps done`}>
            {w.steps.map((s, i) => (
              <span key={i} className={`ws-seg ${s.state}`} />
            ))}
          </span>
        )}
        {isActiveWork(w) && now && <span className="ws-now">{now.step}</span>}
        {w.status === 'failed' && w.error && <span className="ws-now bad">{w.error}</span>}
      </span>
    </button>
  )
}

function StatusIcon({ tone }: { tone: 'work' | 'you' | 'wait' | 'done' | 'bad' }) {
  const p = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  switch (tone) {
    case 'work':
      return (
        <svg {...p} className="ws-spin">
          <circle cx="8" cy="8" r="5.5" opacity="0.25" />
          <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" />
        </svg>
      )
    case 'you':
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5v3.4M8 10.9v.1" />
        </svg>
      )
    case 'wait':
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M8 5.2V8l1.8 1.2" />
        </svg>
      )
    case 'bad':
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M6 6l4 4M10 6l-4 4" />
        </svg>
      )
    default:
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="5.5" />
          <path d="M5.6 8.2l1.6 1.6 3.2-3.4" />
        </svg>
      )
  }
}
