import { parseFeed } from 'feedsmith'

export type FeedEntry = {
  id: string
  url: string
  title: string
  summary: string | null
  html: string
  published: Date
  updated: Date
}

export type FetchFeedOptions = { timeoutMs?: number; maxBytes?: number }

export class FeedError extends Error {
  name = 'FeedError'
}

type RssItem = {
  title?: string
  link?: string
  guid?: string | { value?: string; isPermaLink?: boolean }
  description?: string
  pubDate?: string
  content?: { encoded?: string }
}
type AtomText = string | { value?: string }
type AtomEntry = {
  id?: string
  title?: AtomText
  links?: { href?: string; rel?: string }[]
  summary?: AtomText
  content?: AtomText
  published?: string
  updated?: string
}
type JsonItem = {
  id?: string
  url?: string
  external_url?: string
  title?: string
  summary?: string
  content_html?: string
  content_text?: string
  date_published?: string
  date_modified?: string
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null && 'value' in value && typeof value.value === 'string') return value.value
  return undefined
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function absolutize(html: string, base: string): string {
  return html.replace(/(\s(?:href|src)=)(["'])([^"']*)\2/gi, (match, attr: string, quote: string, value: string) => {
    if (value === '' || value.startsWith('#')) return match
    try {
      return `${attr}${quote}${new URL(value, base).href}${quote}`
    } catch {
      return match
    }
  })
}

type Draft = {
  id: string | undefined
  url: string | undefined
  title: string | undefined
  summary: string | undefined
  html: string | undefined
  published: string | undefined
  updated: string | undefined
}

function fromRss(item: RssItem): Draft {
  const guid = typeof item.guid === 'string' ? { value: item.guid } : item.guid
  const encoded = item.content?.encoded
  const permalink = guid?.isPermaLink !== false ? guid?.value : undefined
  return {
    id: guid?.value,
    url: item.link ?? (permalink?.startsWith('http') ? permalink : undefined),
    title: item.title,
    summary: encoded ? item.description : undefined,
    html: encoded ?? item.description,
    published: item.pubDate,
    updated: undefined,
  }
}

function fromAtom(entry: AtomEntry): Draft {
  const link = entry.links?.find((l) => !l.rel || l.rel === 'alternate')?.href
  return {
    id: entry.id,
    url: link,
    title: text(entry.title),
    summary: text(entry.summary),
    html: text(entry.content) ?? text(entry.summary),
    published: entry.published,
    updated: entry.updated,
  }
}

function fromJson(item: JsonItem): Draft {
  return {
    id: item.id,
    url: item.url ?? item.external_url,
    title: item.title,
    summary: item.summary,
    html: item.content_html ?? (item.content_text !== undefined ? `<p>${escapeHtml(item.content_text)}</p>` : undefined),
    published: item.date_published,
    updated: item.date_modified,
  }
}

function webUrl(value: string | undefined, base: URL | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value, base)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

function finish(draft: Draft, now: Date, base: URL | undefined): FeedEntry | undefined {
  const url = webUrl(draft.url, base)
  if (!url) return undefined
  const published = parseDate(draft.published) ?? parseDate(draft.updated) ?? now
  const updated = parseDate(draft.updated) ?? published
  return {
    id: draft.id || url,
    url,
    title: draft.title?.trim() || url,
    summary: draft.summary?.trim() || null,
    html: absolutize(draft.html ?? '', url),
    published,
    updated,
  }
}

export function normalizeFeed(body: string, now: Date = new Date(), base?: URL): FeedEntry[] {
  let parsed: ReturnType<typeof parseFeed>
  try {
    parsed = parseFeed(body)
  } catch (error) {
    throw new FeedError(`could not parse feed: ${(error as Error).message}`)
  }

  let drafts: Draft[]
  if (parsed.format === 'rss') {
    drafts = ((parsed.feed as { items?: RssItem[] }).items ?? []).map(fromRss)
  } else if (parsed.format === 'atom') {
    drafts = ((parsed.feed as { entries?: AtomEntry[] }).entries ?? []).map(fromAtom)
  } else if (parsed.format === 'json') {
    drafts = ((parsed.feed as { items?: JsonItem[] }).items ?? []).map(fromJson)
  } else {
    throw new FeedError(`unsupported feed format: ${parsed.format}`)
  }

  return drafts.map((d) => finish(d, now, base)).filter((e): e is FeedEntry => e !== undefined)
}

export async function fetchFeed(url: URL, { timeoutMs = 10_000, maxBytes = 5 * 1024 * 1024 }: FetchFeedOptions = {}): Promise<string> {
  const target = new URL(url)
  target.searchParams.set('_', Date.now().toString())

  try {
    const response = await fetch(target, {
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json;q=0.9, application/xml;q=0.9, */*;q=0.8',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new FeedError(`fetching ${url.href} returned ${response.status}`)
    if (!response.body) throw new FeedError(`fetching ${url.href} returned no body`)

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new FeedError(`feed is larger than ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks).toString('utf-8')
  } catch (error) {
    if (error instanceof FeedError) throw error
    throw new FeedError(`could not fetch ${url.href}: ${(error as Error).message}`)
  }
}
