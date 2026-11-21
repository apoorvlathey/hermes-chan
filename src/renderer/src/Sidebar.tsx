import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { Avatar } from './Avatar'
import { hermes } from './bridge'
import { BoardIcon } from './Kanban'
import {
  botBusy,
  botUnread,
  hiddenRoutineCount,
  hostKey,
  kanbanHosts,
  lastBotId,
  loadKanbanBoards,
  openKanban,
  markAllRead,
  unreadSessions,
  isUnread,
  movePinned,
  renameSession,
  newChat,
  openSetup,
  openBot,
  openBotSettings,
  openSession,
  pinnedSessions,
  reconnectBot,
  reorderBots,
  setPinned,
  setSearch,
  toggleRoutine,
  useStore,
  viewBot,
  visibleSessions,
  type SessionRow
} from './store'
import { ago, bucket } from './time'

const BOT_DRAG_TYPE = 'application/x-hermeschan-bot'

function BotsRow() {
  const config = useStore(s => s.config)
  const bots = useStore(s => s.bots)
  const view = useStore(s => s.view)
  const statuses = useStore(s => s.statuses)
  const unread = useStore(s => Object.fromEntries(Object.values(s.bots).map(b => [b.id, botUnread(b, s)])))
  const busy = useStore(s => Object.fromEntries(Object.keys(s.bots).map(id => [id, botBusy(id, s)])))

  // Drag a tile to reorder: the row rearranges live while dragging, and the order saves on drop.
  const [dragId, setDragId] = useState<string | null>(null)
  const [order, setOrder] = useState<string[] | null>(null)
  const ids = order ?? config?.bots.map(b => b.id) ?? []
  const tiles = useRef(new Map<string, HTMLElement>())
  const lastX = useRef(new Map<string, number>())

  // Slide tiles from their old spot to the new one when the order changes (FLIP).
  useLayoutEffect(() => {
    for (const [id, el] of tiles.current) {
      const x = el.getBoundingClientRect().left
      const before = lastX.current.get(id)
      lastX.current.set(id, x)
      if (before === undefined || before === x || id === dragId) continue
      el.animate([{ transform: `translateX(${before - x}px)` }, { transform: 'none' }], {
        duration: 180,
        easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)'
      })
    }
  })

  const moveOver = (overId: string, clientX: number) => {
    if (!dragId || overId === dragId) return
    const el = tiles.current.get(overId)
    if (!el) return
    const r = el.getBoundingClientRect()
    const next = ids.filter(id => id !== dragId)
    const at = next.indexOf(overId) + (clientX > r.left + r.width / 2 ? 1 : 0)
    next.splice(at, 0, dragId)
    if (next.some((id, i) => id !== ids[i])) setOrder(next)
  }

  const endDrag = () => {
    if (order) reorderBots(order)
    setDragId(null)
    setOrder(null)
  }

  return (
    <div className={`bots ${dragId ? 'reordering' : ''}`}>
      {ids.map((id, i) => {
        const cfg = config?.bots.find(b => b.id === id)
        const bot = bots[id]
        if (!cfg || !bot) return null
        const st = statuses[cfg.id]?.state ?? 'connecting'
        const active = view?.kind === 'bot' && view.botId === cfg.id
        return (
          <button
            key={cfg.id}
            ref={el => {
              if (el) tiles.current.set(cfg.id, el)
              else tiles.current.delete(cfg.id)
            }}
            draggable
            onDragStart={e => {
              e.dataTransfer.setData(BOT_DRAG_TYPE, cfg.id)
              e.dataTransfer.effectAllowed = 'move'
              setDragId(cfg.id)
            }}
            onDragOver={e => {
              if (!dragId) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              moveOver(cfg.id, e.clientX)
            }}
            onDrop={e => e.preventDefault()}
            onDragEnd={endDrag}
            className={`bot-tile ${active ? 'active' : ''} ${busy[cfg.id] ? 'busy' : ''} ${st !== 'ready' ? 'offline' : ''} ${dragId === cfg.id ? 'dragging' : ''}`}
            onClick={() => openBot(cfg.id)}
            onContextMenu={e => {
              e.preventDefault()
              void botMenu(cfg.id, st === 'ready')
            }}
            title={`${bot.name}${bot.description ? ` — ${bot.description}` : ''}  ⌘${i + 1} · right-click for settings · drag to reorder`}
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

/** A bot tile's right-click menu (native). */
async function botMenu(botId: string, online: boolean) {
  const picked = await hermes.contextMenu([
    { id: 'chat', label: 'Open Bot Chat' },
    { id: 'new', label: 'New Chat' },
    { separator: true },
    { id: 'soul', label: 'Edit Soul…', enabled: online },
    { id: 'settings', label: 'Bot Settings…', enabled: online },
    { separator: true },
    { id: 'reconnect', label: 'Reconnect' },
    { id: 'manage', label: 'Add or Remove Bots…' }
  ])
  if (picked === 'chat') openBot(botId)
  else if (picked === 'new') newChat(botId)
  else if (picked === 'soul') openBotSettings(botId, 'soul')
  else if (picked === 'settings') openBotSettings(botId, 'profile')
  else if (picked === 'reconnect') void reconnectBot(botId)
  else if (picked === 'manage') openSetup()
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
  const [editing, setEditing] = useState(false)
  const [failed, setFailed] = useState(false)

  const menu = async () => {
    const picked = await hermes.contextMenu([
      { id: 'open', label: 'Open' },
      { id: 'rename', label: 'Rename…' },
      { id: 'pin', label: row.pinned ? 'Unpin' : 'Pin' }
    ])
    if (picked === 'open') openSession(row)
    else if (picked === 'rename') setEditing(true)
    else if (picked === 'pin') void setPinned(row, !row.pinned)
  }

  if (editing) {
    return (
      <div className={`session editing ${active ? 'active' : ''} ${failed ? 'failed' : ''}`}>
        <span className="session-dot" style={{ background: bot?.color }} />
        <RenameField
          initial={row.title || ''}
          placeholder={title}
          onDone={next => {
            setEditing(false)
            if (next === null) return
            setFailed(false)
            renameSession(row, next).catch(() => {
              setFailed(true)
              setTimeout(() => setFailed(false), 2500)
            })
          }}
        />
      </div>
    )
  }

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      className={`session ${active ? 'active' : ''} ${unread ? 'unread' : ''} ${row.pinned ? 'pinned' : ''} ${drag.draggingKey === row.key ? 'dragging' : ''} ${failed ? 'failed' : ''}`}
      onClick={() => openSession(row)}
      onContextMenu={e => {
        e.preventDefault()
        void menu()
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') openSession(row)
        else if (e.key === 'F2') setEditing(true)
      }}
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

/** The title as a text field: ↵ saves, Esc or an empty name cancels, clicking away saves. */
function RenameField({ initial, placeholder, onDone }: { initial: string; placeholder: string; onDone: (title: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const finish = (value: string | null) => {
    if (done.current) return
    done.current = true
    onDone(value && value.trim() ? value : null)
  }
  useLayoutEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      className="session-rename"
      defaultValue={initial}
      placeholder={placeholder}
      aria-label="Chat name"
      maxLength={200}
      spellCheck={false}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(e.currentTarget.value)
        else if (e.key === 'Escape') finish(null)
      }}
      onBlur={e => finish(e.currentTarget.value)}
    />
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
  const unread = useStore(s => unreadSessions(s).length)
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

  // Sits on the first date header's line (e.g. "Today ……… ✓✓ Read all  ⚙︎ 12 hidden").
  // Always there; with nothing unread it's dimmed and a small tooltip says so on hover (drawn in CSS:
  // Electron's native title tooltips don't show reliably). aria-disabled keeps it hoverable.
  const readAll = (
    <button
      className={`routine-toggle read-all ${unread ? '' : 'idle'}`}
      onClick={() => unread && markAllRead()}
      aria-disabled={!unread}
      title={unread ? `Mark ${unread} unread chat${unread === 1 ? '' : 's'} as read` : undefined}
      data-tip={unread ? undefined : 'All chats are read'}
      aria-label={unread ? 'Mark all as read' : 'All chats are read'}
    >
      <svg width="14" height="10" viewBox="0 0 14 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M1 5.4 3.6 8 9 2" />
        <path d="M7.2 7.4 7.8 8 13.2 2" />
      </svg>
      <span className="read-all-label">Read all</span>
    </button>
  )
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
            {i === 0 && (
              <span className="h4-actions">
                {readAll}
                {toggle}
              </span>
            )}
          </h4>
          {g.rows.map(r => (
            <SessionItem key={r.key} row={r} drag={drag} />
          ))}
        </section>
      ))}
      {groups.length === 0 && anyLoaded && (
        <h4>
          <span className="h4-actions">
            {readAll}
            {toggle}
          </span>
        </h4>
      )}
    </div>
  )
}

const BOARDS_POLL_MS = 60_000

/** The way into the Kanban board of the host of the bot in view, with what's moving on it. */
function KanbanLink() {
  const botId = useStore(s => viewBot(s) ?? lastBotId() ?? s.config?.bots[0]?.id)
  const host = useStore(s => (botId ? kanbanHosts(s).find(h => h.key === hostKey(botId, s)) : undefined))
  const active = useStore(s => s.view?.kind === 'kanban')
  const online = useStore(s => !!host && s.statuses[host.botId]?.state === 'ready')
  const boards = useStore(s => (botId ? s.kanbanBoards[hostKey(botId, s)] : undefined))
  const readVia = host?.botId

  // Keep the counts fresh while the board itself isn't open (it polls on its own).
  useEffect(() => {
    if (!readVia || !online || active) return
    const load = () => void loadKanbanBoards(readVia).catch(() => undefined)
    load()
    const t = setInterval(load, BOARDS_POLL_MS)
    window.addEventListener('focus', load)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', load)
    }
  }, [readVia, online, active])

  if (!host) return null
  const count = (status: string) => (boards ?? []).reduce((n, b) => n + (b.counts[status] ?? 0), 0)
  const running = count('running')
  const attention = count('blocked') + count('triage')
  const open = (boards ?? []).reduce((n, b) => n + b.total, 0) - count('done')
  const hint = [running && `${running} running`, attention && `${attention} need${attention === 1 ? 's' : ''} attention`, !running && !attention && open && `${open} open`]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="nav">
      <button className={`nav-row ${active ? 'active' : ''}`} onClick={() => openKanban(botId)} title={`Kanban on ${host.label} (${host.bots.join(', ')})${hint ? `: ${hint}` : ''}`}>
        <span className="nav-icon">
          <BoardIcon size={15} />
        </span>
        <span className="nav-label">Kanban</span>
        {running > 0 && (
          <span className="nav-meta">
            <span className="nav-live" />
            {running}
          </span>
        )}
        {attention > 0 && <span className="nav-attention" title={`${attention} need${attention === 1 ? 's' : ''} attention`}>{attention}</span>}
      </button>
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
        <img className="brand-mark" src="./logo.svg" alt="" draggable={false} />
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

      <KanbanLink />
      <SessionList />
      <ConnectionPill />
    </aside>
  )
}
