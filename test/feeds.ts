import type { FeedEntry } from '../src/feed.ts'

export function entry(slug: string, overrides: Partial<FeedEntry> = {}): FeedEntry {
  const url = `https://blog.test/writing/${slug}.html`
  return {
    id: url,
    url,
    title: `Title ${slug}`,
    summary: null,
    html: `<p>Body of ${slug}</p>`,
    published: new Date('2026-10-01T00:00:00Z'),
    updated: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  }
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function rss(entries: FeedEntry[]): string {
  const items = entries
    .map(
      (e) => `<item><title>${escapeXml(e.title)}</title><link>${e.url}</link><guid isPermaLink="true">${e.id}</guid><pubDate>${e.published.toUTCString()}</pubDate>${
        e.summary ? `<description>${escapeXml(e.summary)}</description>` : ''
      }<content:encoded><![CDATA[${e.html}]]></content:encoded></item>`,
    )
    .join('')
  return `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Test</title><link>https://blog.test/</link><description>d</description>${items}</channel></rss>`
}
