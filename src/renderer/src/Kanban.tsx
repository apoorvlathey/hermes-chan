import { useEffect, useRef, useState } from 'react'
import type { BotConfig, KanbanDetail, KanbanTask } from '../../shared/types'
import { hermes } from './bridge'
import { Resource, type ResourceState } from './kanban-resource'
import { KanbanColumns, KanbanDetailView, ReadState } from './KanbanView'

function useResource<T>() {
  const [state, setState] = useState<ResourceState<T>>({ loading: false })
  const [resource] = useState(() => new Resource<T>(setState))
  useEffect(() => () => resource.clear(), [resource])
  return [state, resource] as const
}

export function Kanban({ bots, initialBotId }: { bots: BotConfig[]; initialBotId?: string }) {
  const [botId, setBotId] = useState(initialBotId || bots[0]?.id || '')
  const [board, setBoard] = useState('')
  const [search, setSearch] = useState('')
  const [hideDone, setHideDone] = useState(false)
  const [hideEmpty, setHideEmpty] = useState(true)
  const [selected, setSelected] = useState('')
  const [boards, boardsResource] = useResource<{ boards: { slug: string; name: string }[]; current: string }>()
  const [tasks, tasksResource] = useResource<{ tasks: KanbanTask[] }>()
  const [detail, detailResource] = useResource<KanbanDetail>()
  const closeRef = useRef<HTMLButtonElement>(null)
  const lastCard = useRef<HTMLElement | null>(null)
  const bot = bots.find(b => b.id === botId)

  // Clear the dependent selections before reading a new connection. The keyed board area below
  // also prevents one connection's data appearing under another connection's label.
  useEffect(() => {
    setBoard(''); setSelected(''); tasksResource.clear(); detailResource.clear()
    void boardsResource.load(() => hermes.kanbanBoards(botId))
  }, [botId, boardsResource, tasksResource, detailResource])

  const effectiveBoard = board || (boards.data?.boards.some(b => b.slug === boards.data?.current) ? boards.data.current : boards.data?.boards[0]?.slug) || ''
  useEffect(() => {
    setSelected(''); detailResource.clear()
    if (!effectiveBoard || boards.loading || boards.error) { tasksResource.clear(); return }
    void tasksResource.load(() => hermes.kanbanTasks(botId, effectiveBoard))
  }, [botId, effectiveBoard, boards.loading, boards.error, tasksResource, detailResource])

  useEffect(() => {
    if (!selected) { detailResource.clear(); return }
    void detailResource.load(() => hermes.kanbanDetail(botId, effectiveBoard, selected))
    closeRef.current?.focus()
  }, [botId, effectiveBoard, selected, detailResource])

  const closeDetail = () => { setSelected(''); lastCard.current?.focus() }
  const refresh = () => {
    setSelected(''); detailResource.clear()
    void boardsResource.load(() => hermes.kanbanBoards(botId))
  }

  return <section className="kanban-page" aria-label="Native Hermes Kanban">
    <div className="kanban-toolbar">
      <h1>Kanban</h1>
      <label>Connection / profile<select aria-label="Kanban connection" value={botId} onChange={e => { setBotId(e.target.value); setBoard(''); setSelected(''); boardsResource.clear(); tasksResource.clear(); detailResource.clear() }}>
        {bots.map(b => <option key={b.id} value={b.id}>{b.name || b.transport.profile} · {b.transport.kind === 'ssh' ? b.transport.host : 'This device'} / {b.transport.profile}</option>)}
      </select></label>
      <label>Board<select aria-label="Kanban board" value={effectiveBoard} disabled={!boards.data?.boards.length || boards.loading} onChange={e => { setBoard(e.target.value); setSelected(''); tasksResource.clear(); detailResource.clear() }}>
        {!boards.data?.boards.length && <option value="">No board selected</option>}
        {boards.data?.boards.map(b => <option key={b.slug} value={b.slug}>{b.name || b.slug}{b.slug === boards.data?.current ? ' (current)' : ''}</option>)}
      </select></label>
      <button className="kanban-refresh" disabled={boards.loading || tasks.loading} onClick={refresh}>Refresh</button>
      <label className="kanban-check"><input type="checkbox" checked={hideDone} onChange={e => setHideDone(e.target.checked)} /> Hide done</label>
      <label className="kanban-check"><input type="checkbox" checked={hideEmpty} onChange={e => setHideEmpty(e.target.checked)} /> Hide empty columns</label>
      <input aria-label="Filter Kanban tasks" placeholder="Filter tasks…" value={search} onChange={e => setSearch(e.target.value)} />
    </div>
    <p className="kanban-scope">Native Hermes tasks · Read-only · {bot?.transport.kind === 'ssh' ? 'SSH server' : 'This device'} / {bot?.transport.profile}. Not Conduit workstreams. Refresh to see changes.</p>
    <ReadState state={boards} />
    {!boards.loading && boards.data?.boards.length === 0 && <p>No Kanban boards found on this connection.</p>}
    <ReadState state={tasks} />
    {!boards.loading && !boards.error && tasks.data && <KanbanColumns tasks={tasks.data.tasks} search={search} hideDone={hideDone} hideEmpty={hideEmpty} onSelect={id => { lastCard.current = document.activeElement as HTMLElement; setSelected(id) }} />}
    {selected && <aside className="kanban-detail" aria-label="Task details" onKeyDown={e => { if (e.key === 'Escape') closeDetail() }}>
      <button ref={closeRef} className="kanban-close" onClick={closeDetail}>Close details <kbd>Esc</kbd></button>
      <ReadState state={detail} />
      {detail.data && <KanbanDetailView task={detail.data} />}
    </aside>}
  </section>
}
