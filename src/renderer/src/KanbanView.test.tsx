import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { KanbanColumns, KanbanDetailView, ReadState } from './KanbanView'

test('renders keyboard-operable cards and native task dependencies', () => {
  const html = renderToStaticMarkup(<KanbanColumns tasks={[{ id: 'task-1', title: '<safe title>', status: 'blocked', assignee: 'builder', parents: ['parent-1'], children: [], blockReason: 'Waiting for access' }]} search="" hideDone={false} onSelect={() => {}} />)
  assert.match(html, /<button/)
  assert.match(html, /&lt;safe title&gt;/)
  assert.match(html, /parent-1/)
  assert.match(html, /Waiting for access/)
  assert.match(html, /Blocked/)
})
test('distinguishes loading, errors and genuinely empty boards', () => {
  assert.match(renderToStaticMarkup(<ReadState state={{ loading: true }} />), /Loading/)
  assert.match(renderToStaticMarkup(<ReadState state={{ loading: false, error: 'Cannot connect' }} />), /role="alert"/)
  assert.match(renderToStaticMarkup(<KanbanColumns tasks={[]} search="" hideDone={false} onSelect={() => {}} />), /No tasks on this board/)
})
test('empty columns can be hidden without losing tasks or totals', () => {
  const html = renderToStaticMarkup(<KanbanColumns tasks={[{ id: 'one', title: 'Useful task', status: 'running', assignee: '', parents: [], children: [], blockReason: '' }]} search="" hideDone={false} hideEmpty onSelect={() => {}} />)
  assert.match(html, /Useful task/)
  assert.doesNotMatch(html, /aria-label="Triage"/)
  assert.match(html, /1 of 1 tasks/)
})

test('detail preserves body, result and comments as readable safe text', () => {
  const html = renderToStaticMarkup(<KanbanDetailView task={{ id: 'task-1', title: 'Build', status: 'review', assignee: 'builder', parents: ['p'], children: ['c'], blockReason: '', body: 'Actual spec', result: 'Actual result', comments: [{ author: 'reviewer', body: '<script>untrusted</script>' }] }} />)
  assert.match(html, /Actual spec/)
  assert.match(html, /Actual result/)
  assert.match(html, /&lt;script&gt;/)
})
