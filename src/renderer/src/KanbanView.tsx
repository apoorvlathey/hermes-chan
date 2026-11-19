import type { KanbanDetail, KanbanTask } from '../../shared/types'
import { groupTasks } from './kanban-state'
import type { ResourceState } from './kanban-resource'

export const statusLabel = (status: string) => status.charAt(0).toUpperCase() + status.slice(1)

export function ReadState({ state }: { state: ResourceState<unknown> }) {
  if (state.loading) return <p role="status">Loading Kanban…</p>
  if (state.error) return <p className="kanban-error" role="alert">{state.error}</p>
  return null
}

export function KanbanColumns({ tasks, search, hideDone, hideEmpty = false, onSelect }: { tasks: KanbanTask[]; search: string; hideDone: boolean; hideEmpty?: boolean; onSelect: (id: string) => void }) {
  const columns = groupTasks(tasks, search, hideDone)
  const visible = columns.flatMap(c => c.tasks).length
  return <>
    <p className="kanban-count" role="status">{visible} of {tasks.length} tasks{search || hideDone ? ' (filtered)' : ''}</p>
    {!visible && <p>{tasks.length ? 'No tasks match these filters.' : 'No tasks on this board.'}</p>}
    <div className="kanban-columns" tabIndex={0} aria-label="Kanban columns, scroll horizontally">
      {columns.filter(c => (!hideEmpty || c.tasks.length > 0) && (c.status !== 'archived' || c.tasks.length > 0)).map(column => <section className="kanban-column" key={column.status} aria-label={statusLabel(column.status)}>
        <h2>{statusLabel(column.status)} <span>{column.tasks.length}</span></h2>
        {column.tasks.map(task => <button key={task.id} className="kanban-card" onClick={() => onSelect(task.id)}>
          <small>{task.id} · {task.assignee || 'Unassigned'}</small>
          <strong>{task.title}</strong>
          {task.parents.length > 0 && <span>Depends on: {task.parents.join(', ')}</span>}
          {task.blockReason && <span className="kanban-error">{task.blockReason}</span>}
        </button>)}
        {!column.tasks.length && <p className="kanban-empty-column">No tasks</p>}
      </section>)}
    </div>
  </>
}

export function KanbanDetailView({ task }: { task: KanbanDetail }) {
  return <article className="kanban-detail-body">
    <h2>{task.title}</h2>
    <p>{task.id} · {statusLabel(task.status)} · {task.assignee || 'Unassigned'}</p>
    {task.blockReason && <p className="kanban-error">{task.blockReason}</p>}
    <p>Depends on: {task.parents.join(', ') || 'None'}</p>
    <p>Children: {task.children.join(', ') || 'None'}</p>
    <h3>Description</h3><pre>{task.body || 'No description.'}</pre>
    {task.result && <><h3>Result</h3><pre>{task.result}</pre></>}
    <h3>Comments ({task.comments.length})</h3>
    {task.comments.map((comment, i) => <div key={i}><strong>{comment.author}</strong><pre>{comment.body}</pre></div>)}
  </article>
}
