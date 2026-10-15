import { readFileSync } from 'node:fs'

export type SiteConfig = {
  id: string
  handle: string
  domain: string
  feedUrl: URL
  name: string
  summary: string | undefined
  icon: URL | undefined
  syncToken: string
  deleteMissing: boolean
}

export type Config = { publicUrl: URL; sites: SiteConfig[] }

export type Env = Record<string, string | undefined>

export class ConfigError extends Error {
  name = 'ConfigError'
}

const ID = /^[a-z0-9][a-z0-9-]*$/
const HANDLE = /^[a-z0-9_]+$/
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(obj: Record<string, unknown>, key: string, at: string): string {
  const value = obj[key]
  if (typeof value !== 'string' || value.trim() === '') throw new ConfigError(`${at}.${key} is required`)
  return value.trim()
}

function optionalString(obj: Record<string, unknown>, key: string, at: string): string | undefined {
  const value = obj[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new ConfigError(`${at}.${key} must be a string`)
  return value
}

function secureUrl(value: unknown, field: string): URL {
  if (typeof value !== 'string') throw new ConfigError(`${field} is required`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`${field} is not a valid URL: ${value}`)
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new ConfigError(`${field} must use https: ${value}`)
  }
  return url
}

export function parseConfig(raw: unknown, env: Env): Config {
  if (!isRecord(raw)) throw new ConfigError('config must be a JSON object')

  const publicUrl = secureUrl(raw.publicUrl, 'publicUrl')
  if (publicUrl.pathname !== '/' || publicUrl.search !== '') {
    throw new ConfigError('publicUrl must not have a path or query')
  }

  if (!Array.isArray(raw.sites) || raw.sites.length === 0) throw new ConfigError('sites must be a non-empty array')

  const ids = new Set<string>()
  const handles = new Set<string>()

  const sites = raw.sites.map((entry: unknown, i: number): SiteConfig => {
    const at = `sites[${i}]`
    if (!isRecord(entry)) throw new ConfigError(`${at} must be an object`)

    const id = requiredString(entry, 'id', at)
    if (!ID.test(id)) throw new ConfigError(`${at}.id must match ${ID}`)
    if (ids.has(id)) throw new ConfigError(`${at}.id duplicates "${id}"`)
    ids.add(id)

    const handle = requiredString(entry, 'handle', at).toLowerCase()
    if (!HANDLE.test(handle)) throw new ConfigError(`${at}.handle must match ${HANDLE}`)
    if (handles.has(handle)) throw new ConfigError(`${at}.handle duplicates "${handle}"`)
    handles.add(handle)

    const domain = requiredString(entry, 'domain', at).toLowerCase()
    if (!HOSTNAME.test(domain)) throw new ConfigError(`${at}.domain must be a hostname like blog.example.dev`)

    const feedUrl = secureUrl(entry.feedUrl, `${at}.feedUrl`)
    const name = requiredString(entry, 'name', at)
    const summary = optionalString(entry, 'summary', at)
    const icon = entry.icon === undefined ? undefined : secureUrl(entry.icon, `${at}.icon`)

    const tokenEnv = requiredString(entry, 'syncTokenEnv', at)
    const syncToken = env[tokenEnv]
    if (!syncToken) throw new ConfigError(`${at}.syncTokenEnv: environment variable ${tokenEnv} is not set`)

    if (entry.deleteMissing !== undefined && typeof entry.deleteMissing !== 'boolean') {
      throw new ConfigError(`${at}.deleteMissing must be true or false`)
    }

    return { id, handle, domain, feedUrl, name, summary, icon, syncToken, deleteMissing: entry.deleteMissing === true }
  })

  return { publicUrl, sites }
}

export function loadConfig(path: string, env: Env = process.env): Config {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (error) {
    throw new ConfigError(`could not read config at ${path}: ${(error as Error).message}`)
  }
  return parseConfig(raw, env)
}
