import { useRef, useState } from 'react'

import { Avatar } from './Avatar'
import {
  botBusy,
  botUnread,
  hiddenRoutineCount,
  isUnread,
  movePinned,
  newChat,
  openSetup,
  openBot,
  openSession,
  pinnedSessions,
  reconnectBot,
  setPinned,
  setSearch,
  toggleRoutine,
  useStore,
  visibleSessions,
  type SessionRow
} from './store'
import { ago, bucket } from './time'

function BotsRow() {
  const config = useStore(s => s.config)
  const bots = useStore(s => s.bots)
  const view = useStore(s => s.view)
  const statuses = useStore(s => s.statuses)
  const unread = useStore(s => Object.fromEntries(Object.values(s.bots).map(b => [b.id, botUnread(b, s)])))
  const busy = useStore(s => Object.fromEntries(Object.keys(s.bots).map(id => [id, botBusy(id, s)])))

  return (
    <div className="bots">
      {config?.bots.map((cfg, i) => {
        const bot = bots[cfg.id]
        if (!bot) return null
        const st = statuses[cfg.id]?.state ?? 'connecting'
        const active = view?.kind === 'bot' && view.botId === cfg.id
        return (
          <button
            key={cfg.id}
            className={`bot-tile ${active ? 'active' : ''} ${busy[cfg.id] ? 'busy' : ''} ${st !== 'ready' ? 'offline' : ''}`}
            onClick={() => openBot(cfg.id)}
            title={`${bot.name}${bot.description ? ` — ${bot.description}` : ''}  ⌘${i + 1}`}
            style={{ ['--bot' as string]: bot.color }}
          >
            <span className="bot-avatar-wrap">
              <Avatar bot={bot} size={46} />
              {unread[cfg.id] && <span className="unread-dot" />}
              {busy[cfg.id] && (
                <span className="busy-badge">
                  <i />
                  <i />
                  <i />
                </span>
              )}
            </span>
            <span className="bot-name">{bot.name}</span>
          </button>
        )
      })}
      <button className="bot-tile add" onClick={openSetup} title="Add or remove bots">
        <span className="bot-avatar-wrap">
          <span className="add-tile">＋</span>
        </span>
        <span className="bot-name">Bots</span>
      </button>
    </div>
  )
}

const DRAG_TYPE = 'application/x-hermeschan-session'

interface DragProps {
  draggingKey: string | null
  onDragStart: (row: SessionRow) => void
  onDragEnd: () => void
}

function SessionItem({ row, drag }: { row: SessionRow; drag: DragProps }) {
  const bot = useStore(s => s.bots[row.botId])
  const active = useStore(s => s.view?.kind === 'session' && s.view.key === row.key)
  const unread = useStore(s => isUnread(row.key, row.lastActive, s))
  const running = useStore(s => s.threads[row.key]?.running ?? row.running)
  const title = row.title || row.preview || 'Untitled chat'
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      className={`session ${active ? 'active' : ''} ${unread ? 'unread' : ''} ${row.pinned ? 'pinned' : ''} ${drag.draggingKey === row.key ? 'dragging' : ''}`}
      onClick={() => openSession(row)}
      onKeyDown={e => e.key === 'Enter' && openSession(row)}
      onDragStart={e => {
        e.dataTransfer.setData(DRAG_TYPE, row.key)
        e.dataTransfer.effectAllowed = 'move'
        drag.onDragStart(row)
      }}
      onDragEnd={drag.onDragEnd}
      title={title}
    >
      <span className="session-dot" style={{ background: bot?.color }} />
      <span className="session-title">{title}</span>
      {running ? <span className="session-spinner" /> : <span className="session-time">{ago(row.lastActive)}</span>}
      {unread && <span className="session-unread" />}
      <button
        className="session-pin"
        title={row.pinned ? 'Unpin' : 'Pin'}
        aria-label={row.pinned ? 'Unpin chat' : 'Pin chat'}
        onClick={e => {
          e.stopPropagation()
          void setPinned(row, !row.pinned)
        }}
      >
        📌
      </button>
    </div>
  )
}

/** Pinned chats: drag within to reorder, drop any chat here to pin it at that spot. */
function PinnedSection({ rows, drag, dragging }: { rows: SessionRow[]; drag: DragProps; dragging: SessionRow | null }) {
  const [dropAt, setDropAt] = useState<number | null>(null)
  const list = useRef<HTMLDivElement>(null)

  if (!rows.length && !dragging) return null

  const indexFor = (clientY: number) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>('.session') ?? [])]
    const i = items.findIndex(el => {
      const r = el.getBoundingClientRect()
      return clientY < r.top + r.height / 2
    })
    return i < 0 ? items.length : i
  }

  return (
    <section
      className={`pinned-section ${dragging ? 'drop-armed' : ''} ${dropAt !== null ? 'drop-over' : ''}`}
      onDragOver={e => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropAt(indexFor(e.clientY))
      }}
      onDragLeave={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null)
      }}
      onDrop={e => {
        e.preventDefault()
        const at = dropAt ?? rows.length
        setDropAt(null)
        if (!dragging) return
        if (dragging.pinned) {
          const from = rows.findIndex(r => r.key === dragging.key)
          movePinned(dragging.key, from >= 0 && from < at ? at - 1 : at)
        } else {
          void setPinned(dragging, true)
          movePinned(dragging.key, at)
        }
        drag.onDragEnd()
      }}
    >
      <h4>
        <span>📌 Pinned</span>
      </h4>
      <div ref={list}>
        {rows.map((r, i) => (
          <div key={r.key}>
            {dropAt === i && <div className="drop-line" />}
            <SessionItem row={r} drag={drag} />
          </div>
        ))}
        {dropAt === rows.length && rows.length > 0 && <div className="drop-line" />}
        {!rows.length && <div className="pin-drop-hint">Drop here to pin</div>}
      </div>
    </section>
  )
}

function SessionList() {
  const rows = useStore(s => visibleSessions(s))
  const pinned = useStore(s => pinnedSessions(s))
  const hidden = useStore(s => hiddenRoutineCount(s))
  const showRoutine = useStore(s => s.showRoutine)
  const search = useStore(s => s.search)
  const anyLoaded = useStore(s => Object.keys(s.sessions).length > 0)
  const [dragging, setDragging] = useState<SessionRow | null>(null)

  const drag: DragProps = {
    draggingKey: dragging?.key ?? null,
    onDragStart: row => setDragging(row),
    onDragEnd: () => setDragging(null)
  }

  const groups: { label: string; rows: SessionRow[] }[] = []
  for (const r of rows) {
    const label = bucket(r.lastActive)
    const g = groups[groups.length - 1]
    if (g?.label === label) g.rows.push(r)
    else groups.push({ label, rows: [r] })
  }

  // Sits on the first date header's line (e.g. "Today ……… ⚙︎ 12 hidden").
  const toggle =
    hidden > 0 ? (
      <button
        className={`routine-toggle ${showRoutine ? 'on' : ''}`}
        onClick={toggleRoutine}
        title={showRoutine ? 'Hide routine and cron runs' : `Show ${hidden} routine and cron run${hidden === 1 ? '' : 's'}`}
      >
        <span aria-hidden>⚙︎</span>
        {showRoutine ? 'Hide routines' : `${hidden} hidden`}
      </button>
    ) : null

  return (
    <div className="sessions">
      {!anyLoaded && <div className="sessions-empty shimmer">Fetching chats…</div>}
      {anyLoaded && rows.length === 0 && !pinned.length && (
        <div className="sessions-empty">{search ? 'Nothing matches that.' : 'No chats yet. Press ⌘N to start one.'}</div>
      )}
      <PinnedSection rows={pinned} drag={drag} dragging={dragging} />
      {groups.map((g, i) => (
        <section key={g.label}>
          <h4>
            <span>{g.label}</span>
            {i === 0 && toggle}
          </h4>
          {g.rows.map(r => (
            <SessionItem key={r.key} row={r} drag={drag} />
          ))}
        </section>
      ))}
      {groups.length === 0 && toggle && <h4>{toggle}</h4>}
    </div>
  )
}

function ConnectionPill() {
  const config = useStore(s => s.config)
  const statuses = useStore(s => s.statuses)
  if (!config) return null
  const states = config.bots.map(b => statuses[b.id]?.state ?? 'connecting')
  const ready = states.filter(s => s === 'ready').length
  const busy = states.some(s => s === 'connecting')
  const tone = ready === states.length ? 'ok' : ready === 0 ? 'down' : 'partial'
  const offline = config.bots.filter(b => (statuses[b.id]?.state ?? 'connecting') !== 'ready').map(b => b.name ?? b.id)
  const label =
    tone === 'ok' ? 'All bots online' : busy && ready === 0 ? 'Connecting…' : offline.length === 1 ? `${offline[0]} offline` : `${offline.length} bots offline`
  const detail = config.bots
    .map(b => {
      const st = statuses[b.id]
      return `${b.name ?? b.id}: ${st?.state ?? 'connecting'}${st?.detail ? ` (${st.detail})` : ''} via ${b.transport.kind === 'ssh' ? b.transport.host : 'this Mac'}`
    })
    .join('\n')
  return (
    <div className={`conn conn-${tone}`} title={detail}>
      <span className="conn-dot" />
      <span className="conn-label">{label}</span>
      {tone !== 'ok' && (
        <button className="conn-retry" onClick={() => void reconnectBot()} disabled={busy} title="Reconnect offline bots">
          {busy ? <span className="session-spinner" /> : '↻'} Reconnect
        </button>
      )}
    </div>
  )
}

export function Sidebar() {
  const search = useStore(s => s.search)
  return (
    <aside className="sidebar">
      <div className="titlebar-drag" />
      <div className="brand">
        <span className="brand-mark">☤</span>
        <span className="brand-name">HermesChan</span>
      </div>

      <BotsRow />

      <div className="chats-head">
        <div className="search">
          <span className="search-icon">⌕</span>
          <input id="search" placeholder="Search chats" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === 'Escape' && setSearch('')} />
          <kbd>⌘K</kbd>
        </div>
        <button className="new-chat" onClick={() => newChat()} title="New chat  ⌘N">
          ＋
        </button>
      </div>

      <SessionList />
      <ConnectionPill />
    </aside>
  )
}
