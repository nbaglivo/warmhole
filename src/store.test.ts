import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { Store, slugFor } from './store.ts'
import { contentHash } from './diff.ts'
import { entry } from '../test/feeds.ts'

function freshStore(): Store {
  const store = new Store(new DatabaseSync(':memory:'))
  store.migrate()
  return store
}

const none = { create: [], update: [], delete: [], silent: false }

test('migrate is idempotent', () => {
  const store = freshStore()
  store.migrate()
  assert.deepEqual(store.listPosts('s'), [])
})

test('slugFor uses the last meaningful path segment', () => {
  assert.equal(slugFor('https://x.dev/writing/notes-to-self.html', new Set()), 'notes-to-self')
  assert.equal(slugFor('https://x.dev/2026/My Post/', new Set()), 'my-post')
  assert.equal(slugFor('https://x.dev/', new Set()), 'post')
  assert.equal(slugFor('https://x.dev/a.html', new Set(['a'])), 'a-2')
  assert.equal(slugFor('https://x.dev/a.html', new Set(['a', 'a-2'])), 'a-3')
})

test('index.html posts get distinct slugs from their folders', () => {
  const store = freshStore()
  store.applyChanges('s', {
    ...none,
    create: [
      entry('x', { id: '1', url: 'https://x.dev/2026/first/index.html' }),
      entry('x', { id: '2', url: 'https://x.dev/2026/second/index.html' }),
      entry('x', { id: '3', url: 'https://x.dev/2027/first/index.html' }),
    ],
  })
  assert.deepEqual(store.listPosts('s').map((p) => p.slug).sort(), ['first', 'first-2', 'second'])
})

test('created posts are pending Create unless silent', () => {
  const store = freshStore()
  store.applyChanges('s', { ...none, create: [entry('a')], silent: true })
  assert.equal(store.listPending('s').length, 0)
  store.applyChanges('s', { ...none, create: [entry('b')] })
  const pending = store.listPending('s')
  assert.deepEqual(pending.map((p) => [p.slug, p.pendingActivity]), [['b', 'Create']])
  assert.equal(pending[0].contentHash, contentHash(entry('b')))
  assert.equal(pending[0].published, '2026-10-01T00:00:00.000Z')
})

test('update marks Update, but keeps an unsent Create', () => {
  const store = freshStore()
  store.applyChanges('s', { ...none, create: [entry('a')], silent: true })
  store.applyChanges('s', { ...none, create: [entry('b')] })
  store.applyChanges('s', { ...none, update: [entry('a', { title: 'A2' }), entry('b', { title: 'B2' })] })
  const bySlug = Object.fromEntries(store.listPosts('s').map((p) => [p.slug, p]))
  assert.equal(bySlug.a.pendingActivity, 'Update')
  assert.equal(bySlug.a.title, 'A2')
  assert.equal(bySlug.b.pendingActivity, 'Create')
  assert.equal(bySlug.b.title, 'B2')
})

test('delete sets deletedAt and pending Delete; published list skips it', () => {
  const store = freshStore()
  store.applyChanges('s', { ...none, create: [entry('a'), entry('b')], silent: true })
  store.applyChanges('s', { ...none, delete: [entry('a').id] }, new Date('2026-10-15T00:00:00Z'))
  const a = store.getPostBySlug('s', 'a')!
  assert.equal(a.deletedAt, '2026-10-15T00:00:00.000Z')
  assert.equal(a.pendingActivity, 'Delete')
  assert.deepEqual(store.listPublishedPosts('s', { offset: 0, limit: 10 }).map((p) => p.slug), ['b'])
  assert.equal(store.countPublishedPosts('s'), 1)
})

test('clearPending clears one post', () => {
  const store = freshStore()
  store.applyChanges('s', { ...none, create: [entry('a')] })
  store.clearPending('s', entry('a').id)
  assert.deepEqual(store.listPending('s'), [])
})

test('published posts are newest first and paged', () => {
  const store = freshStore()
  store.applyChanges('s', {
    ...none,
    create: [
      entry('old', { published: new Date('2026-01-01T00:00:00Z') }),
      entry('new', { published: new Date('2026-03-01T00:00:00Z') }),
      entry('mid', { published: new Date('2026-02-01T00:00:00Z') }),
    ],
    silent: true,
  })
  assert.deepEqual(store.listPublishedPosts('s', { offset: 0, limit: 2 }).map((p) => p.slug), ['new', 'mid'])
  assert.deepEqual(store.listPublishedPosts('s', { offset: 2, limit: 2 }).map((p) => p.slug), ['old'])
})

test('sites do not see each other', () => {
  const store = freshStore()
  store.applyChanges('a', { ...none, create: [entry('x')] })
  assert.deepEqual(store.listPosts('b'), [])
  assert.equal(store.getPostBySlug('b', 'x'), undefined)
})

test('followers: upsert, remove, remove by inbox, page', () => {
  const store = freshStore()
  store.addFollower('s', { actorId: 'https://m.social/users/a', inbox: 'https://m.social/users/a/inbox', sharedInbox: 'https://m.social/inbox' })
  store.addFollower('s', { actorId: 'https://m.social/users/a', inbox: 'https://m.social/users/a/inbox2', sharedInbox: 'https://m.social/inbox' })
  store.addFollower('s', { actorId: 'https://m.social/users/b', inbox: 'https://m.social/users/b/inbox', sharedInbox: 'https://m.social/inbox' })
  store.addFollower('s', { actorId: 'https://p.social/users/c', inbox: 'https://p.social/users/c/inbox', sharedInbox: null })
  assert.equal(store.countFollowers('s'), 3)
  assert.equal(store.listFollowers('s', { offset: 0, limit: 10 }).find((f) => f.actorId.endsWith('/a'))?.inbox, 'https://m.social/users/a/inbox2')
  assert.equal(store.listFollowers('s', { offset: 0, limit: 2 }).length, 2)

  store.removeFollower('s', 'https://p.social/users/c')
  assert.equal(store.countFollowers('s'), 2)

  assert.equal(store.removeFollowersByInbox('https://m.social/inbox'), 2)
  assert.equal(store.countFollowers('s'), 0)
})

test('keys round-trip and are not overwritten', () => {
  const store = freshStore()
  const key = { kind: 'rsa' as const, privateJwk: { kty: 'RSA', d: '1' }, publicJwk: { kty: 'RSA' } }
  store.saveKeys('s', [key])
  store.saveKeys('s', [{ ...key, privateJwk: { kty: 'RSA', d: '2' } }])
  assert.deepEqual(store.getKeys('s'), [key])
  assert.deepEqual(store.getKeys('other'), [])
})
