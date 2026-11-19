import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupTasks } from './kanban-state'

test('groups every task once, preserving unknown and scheduled statuses', () => {
  const tasks = ['todo', 'ready', 'running', 'blocked', 'review', 'done', 'triage', 'scheduled', 'future'].map((status, i) => ({ id: String(i), title: status, status, assignee: '', parents: [], children: [], blockReason: '' }))
  const columns = groupTasks(tasks, '', false)
  assert.equal(columns.flatMap(c => c.tasks).length, tasks.length)
  assert.ok(columns.some(c => c.status === 'future'))
  assert.equal(groupTasks(tasks, '', true).flatMap(c => c.tasks).length, tasks.length - 1)
  assert.equal(groupTasks(tasks, 'BLOCK', false).flatMap(c => c.tasks).length, 1)
})
