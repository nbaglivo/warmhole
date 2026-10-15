import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { federation as fedifyMiddleware } from '@fedify/hono'
import type { Federation } from '@fedify/fedify'
import type { Config, SiteConfig } from './config.ts'
import type { SyncResult } from './sync.ts'
import { FeedError } from './feed.ts'
import { GuardError } from './diff.ts'

export type AppDeps = {
  config: Config
  federation: Federation<void>
  syncer: { sync(siteId: string): Promise<SyncResult> }
}

function actorUrl(config: Config, site: SiteConfig): string {
  return new URL(`/users/${site.id}`, config.publicUrl).href
}

export function webfingerFor(config: Config, site: SiteConfig): Record<string, unknown> {
  const actor = actorUrl(config, site)
  return {
    subject: `acct:${site.handle}@${site.domain}`,
    aliases: [actor],
    links: [
      { rel: 'self', type: 'application/activity+json', href: actor },
      { rel: 'http://webfinger.net/rel/profile-page', type: 'text/html', href: `https://${site.domain}/` },
    ],
  }
}

export function findSiteByResource(config: Config, resource: string): SiteConfig | undefined {
  if (/^https?:\/\//i.test(resource)) {
    return config.sites.find((s) => actorUrl(config, s) === resource)
  }
  const match = /^(?:acct:)?([^@]+)@([^@]+)$/i.exec(resource.trim())
  if (!match) return undefined
  const handle = match[1].toLowerCase()
  const host = match[2].toLowerCase()
  return config.sites.find((s) => s.handle === handle && (host === s.domain || host === config.publicUrl.host))
}

function sameToken(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export function buildApp({ config, federation, syncer }: AppDeps): Hono {
  const app = new Hono()
  const sites = new Map(config.sites.map((s) => [s.id, s]))

  app.get('/.well-known/webfinger', (c) => {
    const resource = c.req.query('resource')
    if (!resource) return c.json({ error: 'resource is required' }, 400)
    const site = findSiteByResource(config, resource)
    if (!site) return c.json({ error: 'not found' }, 404)
    return c.body(JSON.stringify(webfingerFor(config, site)), 200, {
      'content-type': 'application/jrd+json',
      'access-control-allow-origin': '*',
    })
  })

  app.get('/sites/:id/webfinger.json', (c) => {
    const site = sites.get(c.req.param('id'))
    if (!site) return c.json({ error: 'not found' }, 404)
    return c.json(webfingerFor(config, site))
  })

  app.post('/sites/:id/sync', async (c) => {
    const site = sites.get(c.req.param('id'))
    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
    if (!site || !sameToken(token, site.syncToken)) return c.json({ error: 'unauthorized' }, 401)
    try {
      return c.json(await syncer.sync(site.id))
    } catch (error) {
      if (error instanceof FeedError) return c.json({ error: error.message }, 502)
      if (error instanceof GuardError) return c.json({ error: error.message }, 422)
      throw error
    }
  })

  app.get('/healthz', (c) => c.text('ok'))

  app.use(fedifyMiddleware(federation, () => undefined))

  return app
}
