import type { KanbanTask } from '../../shared/types'

export function groupTasks(tasks: KanbanTask[], search: string, hideDone: boolean) {
  const statuses = ['triage', 'todo', 'ready', 'running', 'blocked', 'scheduled', 'review', 'done', 'archived']
  for (const task of tasks) if (!statuses.includes(task.status)) statuses.push(task.status)
  const query = search.trim().toLowerCase()
  return statuses.filter(s => !hideDone || !['done', 'archived'].includes(s)).map(status => ({
    status,
    tasks: tasks.filter(t => t.status === status && (!query || [t.id, t.title, t.assignee, t.blockReason].join(' ').toLowerCase().includes(query)))
  }))
}
