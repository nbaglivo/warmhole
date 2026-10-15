import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diff, contentHash, GuardError, type StoredPost } from './diff.ts'
import { entry } from '../test/feeds.ts'

function stored(...entries: ReturnType<typeof entry>[]): StoredPost[] {
  return entries.map((e) => ({ entryId: e.id, contentHash: contentHash(e), deleted: false, published: e.published.toISOString() }))
}

test('posts older than the feed window are not deleted', () => {
  const at = (month: number) => ({ published: new Date(Date.UTC(2026, month, 1)) })
  const posts = stored(entry('a', at(0)), entry('b', at(1)), entry('c', at(2)))
  assert.deepEqual(diff(posts, [entry('b', at(1)), entry('c', at(2)), entry('d', at(3))], { deleteMissing: true }).delete, [])
  assert.deepEqual(diff(posts, [entry('b', at(1)), entry('d', at(3))], { deleteMissing: true }).delete, [entry('c').id])
})

test('first sync creates everything silently', () => {
  const result = diff([], [entry('a'), entry('b')], { deleteMissing: true })
  assert.equal(result.silent, true)
  assert.deepEqual(result.create.map((e) => e.id), [entry('a').id, entry('b').id])
  assert.deepEqual(result.update, [])
  assert.deepEqual(result.delete, [])
})

test('new entries are created, not silent', () => {
  const result = diff(stored(entry('a')), [entry('a'), entry('b')], { deleteMissing: false })
  assert.equal(result.silent, false)
  assert.deepEqual(result.create.map((e) => e.id), [entry('b').id])
})

test('changed content is an update; unchanged is nothing', () => {
  const result = diff(stored(entry('a'), entry('b')), [entry('a', { title: 'New title' }), entry('b')], { deleteMissing: false })
  assert.deepEqual(result.update.map((e) => e.title), ['New title'])
  assert.deepEqual(result.create, [])
})

test('only title, summary, html and url count as content', () => {
  const later = entry('a', { updated: new Date('2026-12-01T00:00:00Z') })
  assert.equal(contentHash(later), contentHash(entry('a')))
  assert.notEqual(contentHash(entry('a', { summary: 'x' })), contentHash(entry('a')))
})

test('missing entries are deleted only with deleteMissing', () => {
  const posts = stored(entry('a'), entry('b'), entry('c'))
  assert.deepEqual(diff(posts, [entry('a'), entry('b')], { deleteMissing: false }).delete, [])
  assert.deepEqual(diff(posts, [entry('a'), entry('b')], { deleteMissing: true }).delete, [entry('c').id])
})

test('a deleted post that reappears stays deleted', () => {
  const posts: StoredPost[] = [...stored(entry('a')), { entryId: entry('b').id, contentHash: 'old', deleted: true, published: '2026-10-01T00:00:00.000Z' }]
  const result = diff(posts, [entry('a'), entry('b', { title: 'back' })], { deleteMissing: true })
  assert.deepEqual(result.create, [])
  assert.deepEqual(result.update, [])
  assert.deepEqual(result.delete, [])
})

test('duplicate ids in the feed keep the first', () => {
  const result = diff(stored(entry('x')), [entry('a'), entry('a', { title: 'dupe' })], { deleteMissing: false })
  assert.deepEqual(result.create.map((e) => e.title), ['Title a'])
})

test('guard: empty feed', () => {
  assert.throws(() => diff(stored(entry('a')), [], { deleteMissing: true }), { name: 'GuardError', message: /feed has no entries/ })
})

test('guard: deleting more than half of the posts', () => {
  const posts = stored(entry('a'), entry('b'), entry('c'), entry('d'))
  assert.equal(diff(posts, [entry('a'), entry('b')], { deleteMissing: true }).delete.length, 2)
  assert.throws(() => diff(posts, [entry('a')], { deleteMissing: true }), { name: 'GuardError', message: /would delete 3 of 4 posts/ })
})

test('GuardError carries status 422', () => {
  try {
    diff([], [], { deleteMissing: false })
    assert.fail('expected GuardError')
  } catch (error) {
    assert.ok(error instanceof GuardError)
    assert.equal(error.status, 422)
  }
})
