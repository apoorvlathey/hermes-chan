import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

import type { Transport } from '../shared/types'
import { registerKanbanIpc } from './kanban-ipc'

test('IPC accepts only a configured bot ID from the trusted main frame; no renderer transports', async () => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const local: Transport = {kind:'local',profile:'default'}
  const calls: unknown[][] = []
  registerKanbanIpc({ handle: (name, fn) => { handlers.set(name, fn) } },
    id => id === 'bot' ? local : undefined, event => event === 'trusted', {
      boards: async t => { calls.push([t]); return {boards:[],current:'default'} },
      tasks: async (t, board) => { calls.push([t,board]); return {tasks:[]} },
      detail: async (t, board, task) => { calls.push([t,board,task]); return {} as any }
    })
  assert.deepEqual([...handlers.keys()].sort(), ['hermes:kanban-boards','hermes:kanban-detail','hermes:kanban-tasks'])
  assert.deepEqual(await handlers.get('hermes:kanban-tasks')!('trusted','bot','research'), {tasks:[]})
  assert.deepEqual(calls, [[local,'research']])
  for (const [event,id] of [['untrusted','bot'],['trusted','unknown'],['trusted',{kind:'ssh',host:'evil'}]]) {
    await assert.rejects(async () => handlers.get('hermes:kanban-boards')!(event,id))
  }
  assert.equal(calls.length, 1)
  await handlers.get('hermes:kanban-boards')!('trusted','bot')
  await handlers.get('hermes:kanban-detail')!('trusted','bot','research','t_deadbeef')
  assert.deepEqual(calls.at(-1), [local,'research','t_deadbeef'])
})

test('main registration resolves current config and refuses subframes and other windows', async () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true)
  let call: ts.CallExpression | undefined
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'registerKanbanIpc') call = node
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(call, 'main must register the Kanban IPC handlers')
  const mainFrame = {}
  const webContents = {mainFrame}
  const config = {bots:[{id:'bot',transport:{kind:'local',profile:'default'}}]}
  let resolve: (id: string) => Transport | undefined = () => undefined
  let allowed: (event: unknown) => boolean = () => false
  vm.runInNewContext(call.getText(ast), {
    config, ipcMain:{}, win:{isDestroyed:()=>false,webContents},
    registerKanbanIpc: (_ipc: unknown, lookup: typeof resolve, guard: typeof allowed) => { resolve=lookup; allowed=guard }
  })
  assert.equal(resolve('bot'),config.bots[0].transport)
  assert.equal(resolve('unknown'),undefined)
  assert.equal(allowed({sender:webContents,senderFrame:mainFrame}),true)
  assert.equal(allowed({sender:webContents,senderFrame:{}}),false)
  assert.equal(allowed({sender:{},senderFrame:mainFrame}),false)
})

test('preload exposes only the exact identifier-only Kanban bridge contract', async () => {
  const source = readFileSync(new URL('../preload/index.ts', import.meta.url), 'utf8')
  const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText
  const calls: unknown[][] = []
  let exposed: any
  vm.runInNewContext(js, {
    exports: {}, require: (name: string) => {
      assert.equal(name,'electron')
      return {contextBridge:{exposeInMainWorld: (_name: string, value: unknown) => { exposed = value }},
        ipcRenderer:{invoke: async (...args: unknown[]) => { calls.push(args); return {ok:true} }}}
    }
  })
  assert.equal(typeof exposed.kanbanBoards, 'function')
  await exposed.kanbanBoards('bot')
  await exposed.kanbanTasks('bot','research')
  await exposed.kanbanDetail('bot','research','t_deadbeef')
  assert.deepEqual(calls, [ ['hermes:kanban-boards','bot'], ['hermes:kanban-tasks','bot','research'], ['hermes:kanban-detail','bot','research','t_deadbeef'] ])
})
