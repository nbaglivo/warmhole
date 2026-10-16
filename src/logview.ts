import { createInterface } from 'node:readline'

type Line = {
  '@timestamp': string
  level: string
  logger: string
  message: string
  properties: Record<string, unknown>
}

function parse(raw: string): Line | null {
  if (!raw.startsWith('{')) return null
  try {
    return JSON.parse(raw) as Line
  } catch {
    return null
  }
}

function clock(timestamp: string, timeZone?: string): string {
  return new Date(timestamp).toLocaleTimeString('en-GB', { timeZone, hourCycle: 'h23' })
}

function activityKind(id: URL): string {
  const fragment = id.hash.slice(1)
  if (fragment.startsWith('accepts/')) return 'Accept'
  const kind = fragment.split('-')[0]
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

function describeDelivery(properties: Record<string, unknown>): string | null {
  if (typeof properties.activityId !== 'string' || typeof properties.inbox !== 'string') return null
  const id = new URL(properties.activityId)
  const host = new URL(properties.inbox).host
  const post = /\/posts\/([^/]+)$/.exec(id.pathname)?.[1]
  return ['sent', activityKind(id), post, '→', host].filter(Boolean).join(' ')
}

export function describeLine(raw: string, timeZone?: string): string | null {
  if (raw.trim() === '') return null
  const line = parse(raw)
  if (line === null) return raw

  const { properties } = line
  let text: string
  if (line.logger === 'fedify.federation.http' && typeof properties.path === 'string') {
    if (properties.path === '/healthz') return null
    text = `${properties.method} ${properties.path} ${properties.status}`
  } else {
    const delivery = line.logger === 'fedify.federation.outbox' && line.message.startsWith('Successfully sent') ? describeDelivery(properties) : null
    const level = line.level === 'WARN' || line.level === 'ERROR' || line.level === 'FATAL' ? `${line.level} ` : ''
    text = delivery ?? `${level}${line.message.replace(/"([^"]*)"/g, '$1')}`
  }
  return `${clock(line['@timestamp'], timeZone)} ${text}`
}

if (import.meta.main) {
  for await (const raw of createInterface({ input: process.stdin })) {
    const text = describeLine(raw)
    if (text !== null) console.log(text)
  }
}
