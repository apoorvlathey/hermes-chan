/** Identifier-only IPC boundary. Resolves configured transports in main, never from renderer data. */
import type { KanbanBoards, KanbanDetail, KanbanTask, Transport } from '../shared/types'
import { getKanbanDetail, listKanbanBoards, listKanbanTasks } from './kanban'

interface Readers {
  boards(t: Transport): Promise<KanbanBoards>
  tasks(t: Transport, board: string): Promise<{ tasks: KanbanTask[] }>
  detail(t: Transport, board: string, task: string): Promise<KanbanDetail>
}
interface IpcRegistrar<E> {
  handle(name: string, fn: (event: E, ...args: any[]) => unknown): void
}

export function registerKanbanIpc<E>(
  ipc: IpcRegistrar<E>,
  transportFor: (botId: string) => Transport | undefined,
  allowed: (event: E) => boolean,
  readers: Readers = { boards: listKanbanBoards, tasks: listKanbanTasks, detail: getKanbanDetail }
): void {
  function transport(event: E, botId: unknown): Transport {
    if (!allowed(event)) throw new Error('Kanban IPC sender refused')
    if (typeof botId !== 'string') throw new Error('Unknown Kanban bot')
    const t = transportFor(botId)
    if (!t) throw new Error('Unknown Kanban bot')
    return t
  }
  ipc.handle('hermes:kanban-boards', (event, botId: unknown) => readers.boards(transport(event, botId)))
  ipc.handle('hermes:kanban-tasks', (event, botId: unknown, board: string) => readers.tasks(transport(event, botId), board))
  ipc.handle('hermes:kanban-detail', (event, botId: unknown, board: string, task: string) => readers.detail(transport(event, botId), board, task))
}
