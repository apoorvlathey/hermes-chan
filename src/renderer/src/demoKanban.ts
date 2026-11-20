/** Demo Kanban boards (`pnpm demo`): made-up tasks for the demo bots. Atlas and Pixel share this
 *  Mac's boards; Sage lives on a pretend home server with its own. */
import type { KanbanBoard, KanbanBoardInfo, KanbanCard, KanbanTaskDetail } from '../../shared/types'

const m = (n: number) => Math.floor(Date.now() / 1000 - n * 60)
const h = (n: number) => m(n * 60)

interface Task extends Partial<KanbanCard> {
  id: string
  title: string
  status: string
  assignee: string
  body?: string
  result?: string
  /** Tasks this one waits on (its parents in Hermes's terms). */
  waitsOn?: string[]
  commentsList?: { author: string; body: string; at: number }[]
  runs?: KanbanTaskDetail['runs']
  diagnostics?: KanbanTaskDetail['diagnostics']
  lastError?: string
}

const LOCAL: Record<string, { name: string; current: boolean; tasks: Task[] }> = {
  default: {
    name: 'Personal',
    current: true,
    tasks: [
      { id: 't_4f1c09ae', title: 'Sort out the travel insurance for Lisbon', status: 'triage', assignee: 'default', createdAt: m(25), body: 'Came in from the inbox: the card’s cover ends on the 30th. Decide whether to extend it or buy a single-trip policy.' },
      { id: 't_7a20c3d3', title: 'Shortlist three quiet guesthouses near Alfama', status: 'running', assignee: 'default', createdAt: h(3), runStartedAt: m(18),
        body: 'For the 14th to the 21st.\n\n- Walkable to Alfama, **quiet at night**\n- Under €160 a night\n- Hold, don’t pay: I’ll confirm the pick',
        commentsList: [
          { author: 'default', body: 'Five candidates so far; two are above bars, dropping those.', at: m(12) },
          { author: 'user', body: 'A small terrace would be lovely, not a must.', at: m(7) }
        ],
        runs: [{ id: 1, profile: 'default', status: 'running', outcome: '', summary: '', error: '', startedAt: m(18), endedAt: 0 }] },
      { id: 't_7a20c3d2', title: 'Compare fares for the 14th', status: 'done', assignee: 'default', createdAt: h(3), completedAt: m(30), summary: 'Cheapest sensible option: TP 1351 at 07:40, €212 return with a carry-on. Two others within €20.' },
      { id: 't_7a20c3d1', title: 'Book the Lisbon flights and the stay', status: 'todo', assignee: 'default', createdAt: h(3), waitsOn: ['t_7a20c3d2', 't_7a20c3d3'], body: 'Once fares and the shortlist are in, hold the best pair and send me a summary to confirm.' },
      { id: 't_2b9e5f10', title: 'Draft the Q3 board update from the metrics sheet', status: 'review', assignee: 'default', createdAt: h(6), comments: 1,
        summary: 'Draft is in the shared folder. Revenue and retention figures checked against the sheet; churn note needs your call.',
        body: 'Use the July–September tab. Keep it to one page plus the appendix table.' },
      { id: 't_9c3d7e21', title: 'Refresh the deck cover in the new palette', status: 'ready', assignee: 'pixel', createdAt: h(2), body: 'Three options, 16:9, using the warm palette from the brand doc.' },
      { id: 't_5e8a1b42', title: 'Export last year’s receipts to the accountant folder', status: 'blocked', assignee: 'default', createdAt: h(26), blockKind: 'needs_input', comments: 1,
        warnings: { count: 1, severity: 'error' },
        body: 'Every receipt from last year as PDF, one folder per month.',
        lastError: 'PermissionError: the accountant folder is read-only for this account',
        diagnostics: [{ severity: 'error', title: 'Blocked twice for the same reason', detail: 'The worker could not write to the accountant folder. Share it with write access, or pick another folder.' }],
        commentsList: [{ author: 'default', body: 'The folder is shared view-only. Can you give me edit access, or should I use a new folder?', at: h(20) }],
        runs: [
          { id: 1, profile: 'default', status: 'done', outcome: 'blocked', summary: '', error: 'The accountant folder is read-only', startedAt: h(25), endedAt: h(25) - 400 },
          { id: 2, profile: 'default', status: 'done', outcome: 'blocked', summary: '', error: 'The accountant folder is read-only', startedAt: h(21), endedAt: h(21) - 300 }
        ] },
      { id: 't_8d4c2a63', title: 'Renew the domain and move DNS to the new host', status: 'scheduled', assignee: 'default', createdAt: h(30), body: 'Renewal opens on the 1st. Move DNS the same day.' },
      { id: 't_3f6b8c74', title: 'Pick a typeface for the Field Notes landing page', status: 'todo', assignee: 'pixel', createdAt: h(5) },
      { id: 't_1a7d9e85', title: 'Summarise the inbox backlog by sender', status: 'done', assignee: 'default', createdAt: h(50), completedAt: h(46), summary: '212 threads, 31 need a reply. Top senders: the landlord (6), the accountant (5) and the school (4).' },
      { id: 't_6c2e4f96', title: 'Fix the flaky integration tests on the api repo', status: 'done', assignee: 'default', createdAt: h(9), completedAt: h(7), summary: 'Two tests shared a temp directory. Each now gets its own; 50 runs in a row pass.' },
      { id: 't_0b5f3a17', title: 'Three logo directions for the newsletter', status: 'done', assignee: 'pixel', createdAt: h(28), completedAt: h(24), summary: 'Wordmark, monogram and a small owl mark, each in light and dark.' }
    ]
  },
  'field-notes': {
    name: 'Field Notes app',
    current: false,
    tasks: [
      { id: 't_f1e2d3c4', title: 'Write the App Store description', status: 'ready', assignee: 'pixel', createdAt: h(4) },
      { id: 't_f1e2d3c5', title: 'Record the 30-second preview video', status: 'todo', assignee: 'pixel', createdAt: h(4), waitsOn: ['t_f1e2d3c4'] },
      { id: 't_f1e2d3c6', title: 'Set up TestFlight for the beta group', status: 'done', assignee: 'default', createdAt: h(30), completedAt: h(22), summary: 'Build 14 is live for 40 testers.' }
    ]
  }
}

const SERVER: typeof LOCAL = {
  default: {
    name: 'Research',
    current: true,
    tasks: [
      { id: 't_s0a1b2c3', title: 'Read the three papers on sleep and memory and compare their methods', status: 'running', assignee: 'research', createdAt: h(2), runStartedAt: m(41) },
      { id: 't_s0a1b2c4', title: 'Summarise the city’s new cycling plan', status: 'review', assignee: 'research', createdAt: h(8), summary: 'Two pages: what changes, when, and which streets. The funding section is vague; flagged.' },
      { id: 't_s0a1b2c5', title: 'Find the original source of the “10,000 steps” figure', status: 'done', assignee: 'research', createdAt: h(30), completedAt: h(27), summary: 'A 1965 Japanese pedometer was sold as the manpo-kei, “10,000-step meter”: marketing, not a study.' }
    ]
  }
}

const COLUMNS = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done']

const boardsFor = (botId: string) => (botId === 'sage' ? SERVER : LOCAL)

function toCard(t: Task, tasks: Task[]): KanbanCard {
  const children = tasks.filter(x => x.waitsOn?.includes(t.id))
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    assignee: t.assignee,
    priority: t.priority ?? 0,
    createdAt: t.createdAt ?? 0,
    runStartedAt: t.runStartedAt ?? 0,
    completedAt: t.completedAt ?? 0,
    summary: t.summary ?? '',
    comments: t.commentsList?.length ?? t.comments ?? 0,
    parents: t.waitsOn?.length ?? 0,
    children: children.length,
    warnings: t.warnings ?? null,
    blockKind: t.blockKind ?? ''
  }
}

export function demoKanbanBoards(botId: string): KanbanBoardInfo[] {
  return Object.entries(boardsFor(botId)).map(([slug, b]) => {
    const counts: Record<string, number> = {}
    for (const t of b.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1
    return { slug, name: b.name, current: b.current, total: b.tasks.length, counts }
  })
}

export function demoKanbanBoard(botId: string, slug: string): KanbanBoard {
  const tasks = boardsFor(botId)[slug]?.tasks ?? []
  return {
    columns: COLUMNS.map(status => ({
      status,
      cards: tasks
        .filter(t => t.status === status)
        .sort((a, b) => (status === 'done' ? (b.completedAt ?? 0) - (a.completedAt ?? 0) : 0))
        .map(t => toCard(t, tasks))
    })),
    now: Math.floor(Date.now() / 1000)
  }
}

export function demoKanbanTask(botId: string, slug: string, id: string): KanbanTaskDetail {
  const tasks = boardsFor(botId)[slug]?.tasks ?? []
  const t = tasks.find(x => x.id === id)
  if (!t) throw new Error('Task not found')
  const ref = (x: Task) => ({ id: x.id, title: x.title, status: x.status })
  return {
    card: toCard(t, tasks),
    body: t.body ?? '',
    result: t.result ?? '',
    summary: t.summary ?? '',
    createdBy: 'you',
    lastError: t.lastError ?? '',
    parents: tasks.filter(x => t.waitsOn?.includes(x.id)).map(ref),
    children: tasks.filter(x => x.waitsOn?.includes(t.id)).map(ref),
    comments: t.commentsList ?? [],
    runs: t.runs ?? (t.completedAt ? [{ id: 1, profile: t.assignee, status: 'done', outcome: 'completed', summary: t.summary ?? '', error: '', startedAt: t.completedAt - 900, endedAt: t.completedAt }] : []),
    diagnostics: t.diagnostics ?? []
  }
}

/** A reply from the task panel: the comment lands, and an unblocked task goes back to Ready. */
export function demoKanbanReply(botId: string, slug: string, id: string, body: string, unblock: boolean) {
  const t = boardsFor(botId)[slug]?.tasks.find(x => x.id === id)
  if (!t) throw new Error('Task not found')
  t.commentsList = [...(t.commentsList ?? []), { author: 'user', body: body.trim(), at: Math.floor(Date.now() / 1000) }]
  if (unblock && t.status === 'blocked') {
    t.status = 'ready'
    t.blockKind = ''
    t.warnings = null
    t.diagnostics = []
  }
}
