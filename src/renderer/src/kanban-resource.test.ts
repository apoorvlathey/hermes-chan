import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Resource } from './kanban-resource'

test('old connection responses never overwrite a newly selected connection', async () => {
  const resource = new Resource<string>()
  let finish!: (v: string) => void
  const old = resource.load(() => new Promise(resolve => { finish = resolve }))
  await resource.load(async () => 'new host')
  finish('old host')
  await old
  assert.equal(resource.state.data, 'new host')
})
test('refresh clears old data and reports errors rather than empty success', async () => {
  const resource = new Resource<string[]>()
  await resource.load(async () => ['old'])
  const request = resource.load(async () => { throw new Error('SSH unavailable') })
  assert.equal(resource.state.data, undefined)
  assert.equal(resource.state.loading, true)
  await request
  assert.equal(resource.state.error, 'SSH unavailable')
  assert.equal(resource.state.loading, false)
})
