import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { MemoryKvStore } from '@fedify/fedify'
import { Store } from './store.ts'
import { buildFederation } from './federation.ts'
import { buildApp, findSiteByResource } from './app.ts'
import { FeedError } from './feed.ts'
import { GuardError } from './diff.ts'
import { TEST_CONFIG } from '../test/fake-remote.ts'
import type { SyncResult } from './sync.ts'

function setup(sync: (siteId: string) => Promise<SyncResult> = async () => ({ new: 1, updated: 0, deleted: 0 })) {
  const store = new Store(new DatabaseSync(':memory:'))
  store.migrate()
  const federation = buildFederation({ config: TEST_CONFIG, store, kv: new MemoryKvStore() })
  const calls: string[] = []
  const app = buildApp({
    config: TEST_CONFIG,
    federation,
    syncer: {
      sync: (siteId) => {
        calls.push(siteId)
        return sync(siteId)
      },
    },
  })
  const request = (path: string, init?: RequestInit) => app.request(`https://ap.test${path}`, init)
  return { app, calls, request }
}

test('findSiteByResource accepts the usual resource forms', () => {
  for (const resource of [
    'acct:nico@innermonologue.test',
    'nico@innermonologue.test',
    'acct:NICO@InnerMonologue.TEST',
    'acct:nico@ap.test',
    'https://ap.test/users/inner-monologue',
  ]) {
    assert.equal(findSiteByResource(TEST_CONFIG, resource)?.id, 'inner-monologue', resource)
  }
  for (const resource of ['acct:nico@other.test', 'acct:someone@innermonologue.test', 'https://ap.test/users/nope', 'garbage']) {
    assert.equal(findSiteByResource(TEST_CONFIG, resource), undefined, resource)
  }
})

test('webfinger answers with the site handle and the actor link', async () => {
  const { request } = setup()
  const res = await request('/.well-known/webfinger?resource=acct:nico@ap.test')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /application\/jrd\+json/)
  assert.deepEqual(await res.json(), {
    subject: 'acct:nico@innermonologue.test',
    aliases: ['https://ap.test/users/inner-monologue'],
    links: [
      { rel: 'self', type: 'application/activity+json', href: 'https://ap.test/users/inner-monologue' },
      { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: 'https://innermonologue.test/' },
    ],
  })
})

test('webfinger errors', async () => {
  const { request } = setup()
  assert.equal((await request('/.well-known/webfinger')).status, 400)
  assert.equal((await request('/.well-known/webfinger?resource=acct:x@y.test')).status, 404)
})

test('site webfinger file matches the webfinger answer', async () => {
  const { request } = setup()
  const file = await (await request('/sites/inner-monologue/webfinger.json')).json()
  const answer = await (await request('/.well-known/webfinger?resource=acct:nico@innermonologue.test')).json()
  assert.deepEqual(file, answer)
  assert.equal((await request('/sites/nope/webfinger.json')).status, 404)
})

test('sync requires the right bearer token', async () => {
  const { request, calls } = setup()
  assert.equal((await request('/sites/inner-monologue/sync', { method: 'POST' })).status, 401)
  assert.equal((await request('/sites/inner-monologue/sync', { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status, 401)
  assert.equal((await request('/sites/nope/sync', { method: 'POST', headers: { authorization: 'Bearer secret' } })).status, 401)
  assert.deepEqual(calls, [])

  const res = await request('/sites/inner-monologue/sync', { method: 'POST', headers: { authorization: 'Bearer secret' } })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { new: 1, updated: 0, deleted: 0 })
  assert.deepEqual(calls, ['inner-monologue'])
})

test('sync maps feed errors to 502 and guards to 422', async () => {
  const headers = { authorization: 'Bearer secret' }
  const feedDown = setup(async () => {
    throw new FeedError('fetching https://innermonologue.test/feed.xml returned 500')
  })
  const down = await feedDown.request('/sites/inner-monologue/sync', { method: 'POST', headers })
  assert.equal(down.status, 502)
  assert.deepEqual(await down.json(), { error: 'fetching https://innermonologue.test/feed.xml returned 500' })

  const guarded = setup(async () => {
    throw new GuardError('feed has no entries')
  })
  const refused = await guarded.request('/sites/inner-monologue/sync', { method: 'POST', headers })
  assert.equal(refused.status, 422)
  assert.deepEqual(await refused.json(), { error: 'feed has no entries' })
})

test('healthz and Fedify routes are reachable', async () => {
  const { request } = setup()
  assert.equal(await (await request('/healthz')).text(), 'ok')
  const actor = await request('/users/inner-monologue', { headers: { accept: 'application/activity+json' } })
  assert.equal(actor.status, 200)
  assert.equal((await request('/nothing-here')).status, 404)
})
