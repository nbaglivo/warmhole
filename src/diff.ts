import { createHash } from 'node:crypto'
import type { FeedEntry } from './feed.ts'

export type StoredPost = { entryId: string; contentHash: string; deleted: boolean; published: string }

export type Changes = { create: FeedEntry[]; update: FeedEntry[]; delete: string[]; silent: boolean }

export class GuardError extends Error {
  name = 'GuardError'
  status = 422 as const
}

export function contentHash(entry: FeedEntry): string {
  return createHash('sha256').update(JSON.stringify([entry.title, entry.summary, entry.html, entry.url])).digest('hex')
}

export function diff(stored: StoredPost[], entries: FeedEntry[], { deleteMissing }: { deleteMissing: boolean }): Changes {
  if (entries.length === 0) throw new GuardError('feed has no entries')

  const unique = new Map<string, FeedEntry>()
  for (const e of entries) if (!unique.has(e.id)) unique.set(e.id, e)

  if (stored.length === 0) {
    return { create: [...unique.values()], update: [], delete: [], silent: true }
  }

  const byId = new Map(stored.map((p) => [p.entryId, p]))
  const create: FeedEntry[] = []
  const update: FeedEntry[] = []

  for (const e of unique.values()) {
    const post = byId.get(e.id)
    if (!post) create.push(e)
    else if (!post.deleted && post.contentHash !== contentHash(e)) update.push(e)
  }

  const active = stored.filter((p) => !p.deleted)
  const oldest = Math.min(...[...unique.values()].map((e) => e.published.getTime()))
  const removed = deleteMissing
    ? active.filter((p) => !unique.has(p.entryId) && new Date(p.published).getTime() >= oldest).map((p) => p.entryId)
    : []

  if (removed.length * 2 > active.length) {
    throw new GuardError(`sync would delete ${removed.length} of ${active.length} posts; refusing`)
  }

  return { create, update, delete: removed, silent: false }
}
