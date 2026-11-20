/** Hermes Kanban. Everything goes through the Kanban plugin's dashboard API on the bot's gateway
 *  (`/api/plugins/kanban/*`), the same calls the Hermes desktop app makes, so board resolution,
 *  ordering, health checks and state changes are Hermes's own. Reads return only the fields the
 *  board shows: workspace paths, PIDs and the like never leave the main process. The one write is
 *  answering a task (a comment, optionally unblocking it), and only on the user's click. */
import type { KanbanBoard, KanbanBoardInfo, KanbanCard, KanbanTaskDetail } from '../shared/types'
import type { BotConnection } from './bots'

const BASE = '/api/plugins/kanban'
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/
const TASK = /^[A-Za-z0-9_-]{1,128}$/

type Raw = Record<string, any>
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : [])

function friendly(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err)
  if (/not found/i.test(msg)) return new Error('This bot’s Hermes has no Kanban API. Update Hermes, or turn on the Kanban plugin.')
  return new Error(msg)
}

async function get<T>(conn: BotConnection, path: string, query?: Record<string, string>): Promise<T> {
  try {
    return await conn.apiGet<T>(BASE + path, query)
  } catch (err) {
    throw friendly(err)
  }
}

export async function kanbanBoards(conn: BotConnection): Promise<KanbanBoardInfo[]> {
  const r = await get<Raw>(conn, '/boards')
  return list(r.boards).map(b => ({
    slug: str(b.slug),
    name: str(b.name) || str(b.slug),
    current: !!b.is_current || b.slug === r.current,
    total: num(b.total),
    counts: Object.fromEntries(Object.entries((b.counts ?? {}) as Raw).map(([k, v]) => [k, num(v)]))
  }))
}

function card(t: Raw): KanbanCard {
  const w = t.warnings as Raw | null | undefined
  return {
    id: str(t.id),
    title: str(t.title),
    status: str(t.status),
    assignee: str(t.assignee),
    priority: num(t.priority),
    createdAt: num(t.created_at),
    runStartedAt: num(t.current_run_started_at) || num(t.started_at),
    completedAt: num(t.completed_at),
    summary: str(t.latest_summary),
    comments: num(t.comment_count),
    parents: num(t.link_counts?.parents),
    children: num(t.link_counts?.children),
    warnings: w && num(w.count) > 0 ? { count: num(w.count), severity: str(w.highest_severity) } : null,
    blockKind: str(t.block_kind)
  }
}

export async function kanbanBoard(conn: BotConnection, board: string): Promise<KanbanBoard> {
  if (!SLUG.test(board)) throw new Error('Invalid board')
  const r = await get<Raw>(conn, '/board', { board })
  return {
    columns: list(r.columns).map(c => ({ status: str(c.name), cards: list(c.tasks).map(card) })),
    now: num(r.now) || Math.floor(Date.now() / 1000)
  }
}

export async function kanbanTask(conn: BotConnection, board: string, taskId: string): Promise<KanbanTaskDetail> {
  if (!SLUG.test(board)) throw new Error('Invalid board')
  if (!TASK.test(taskId)) throw new Error('Invalid task')
  const r = await get<Raw>(conn, `/tasks/${encodeURIComponent(taskId)}`, { board })
  const t = (r.task ?? {}) as Raw
  const linked = new Map(list(r.link_tasks).map(l => [str(l.id), { id: str(l.id), title: str(l.title), status: str(l.status) }]))
  const links = (ids: unknown) =>
    (Array.isArray(ids) ? ids : []).map(id => linked.get(str(id)) ?? { id: str(id), title: '', status: '' })
  return {
    card: card({ ...t, comment_count: list(r.comments).length, link_counts: { parents: r.links?.parents?.length, children: r.links?.children?.length } }),
    body: str(t.body),
    result: str(t.result),
    summary: str(t.latest_summary),
    createdBy: str(t.created_by),
    lastError: str(t.last_failure_error),
    parents: links(r.links?.parents),
    children: links(r.links?.children),
    comments: list(r.comments).map(c => ({ author: str(c.author), body: str(c.body), at: num(c.created_at) })),
    runs: list(r.runs).map(x => ({
      id: num(x.id),
      profile: str(x.profile),
      status: str(x.status),
      outcome: str(x.outcome),
      summary: str(x.summary),
      error: str(x.error),
      startedAt: num(x.started_at),
      endedAt: num(x.ended_at)
    })),
    diagnostics: list(t.diagnostics).map(d => ({ severity: str(d.severity), title: str(d.title), detail: str(d.detail) }))
  }
}

/** Answer a task: add your comment, and with `unblock` move a blocked task back to the queue
 *  (Hermes's own unblock: Ready, or To do while it still waits on other tasks). A running task's
 *  worker reads new comments as it goes; a re-queued one starts with the comment in its context. */
export async function kanbanReply(conn: BotConnection, board: string, taskId: string, body: string, unblock: boolean): Promise<void> {
  if (!SLUG.test(board)) throw new Error('Invalid board')
  if (!TASK.test(taskId)) throw new Error('Invalid task')
  const text = body.trim()
  if (!text) throw new Error('Write a reply first')
  if (text.length > 20_000) throw new Error('That reply is too long')
  const task = `/tasks/${encodeURIComponent(taskId)}`
  try {
    await conn.api('POST', `${BASE}${task}/comments`, { board }, { author: 'user', body: text })
    if (unblock) await conn.api('PATCH', BASE + task, { board }, { status: 'ready' })
  } catch (err) {
    throw friendly(err)
  }
  // Ask the dispatcher to look now rather than on its next tick; it's fine if it can't.
  if (unblock) await conn.api('POST', `${BASE}/dispatch`, { board }, {}).catch(() => undefined)
}
