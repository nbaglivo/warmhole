import type { webcrypto } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { contentHash, type Changes } from './diff.ts'

export type PendingActivity = 'Create' | 'Update' | 'Delete'

export type PostRow = {
  siteId: string
  entryId: string
  slug: string
  title: string
  summary: string | null
  html: string
  url: string
  published: string
  updated: string
  contentHash: string
  deletedAt: string | null
  pendingActivity: PendingActivity | null
}

export type Follower = { actorId: string; inbox: string; sharedInbox: string | null }

type JsonWebKey = webcrypto.JsonWebKey

export type StoredKey = { kind: 'rsa' | 'ed25519'; privateJwk: JsonWebKey; publicJwk: JsonWebKey }

export type Page = { offset: number; limit: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS keys (
  site_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  private_jwk TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  PRIMARY KEY (site_id, kind)
);
CREATE TABLE IF NOT EXISTS followers (
  site_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  inbox TEXT NOT NULL,
  shared_inbox TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (site_id, actor_id)
);
CREATE TABLE IF NOT EXISTS posts (
  site_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  html TEXT NOT NULL,
  url TEXT NOT NULL,
  published TEXT NOT NULL,
  updated TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  deleted_at TEXT,
  pending_activity TEXT,
  PRIMARY KEY (site_id, entry_id),
  UNIQUE (site_id, slug)
);
`

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export function slugFor(url: string, taken: Set<string>): string {
  const segments = new URL(url).pathname
    .split('/')
    .filter(Boolean)
    .map((s) => safeDecode(s).replace(/\.[a-z0-9]+$/i, ''))
  const meaningful = segments.filter((s) => s.toLowerCase() !== 'index')
  const base =
    (meaningful.at(-1) ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'post'
  let slug = base
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`
  return slug
}

type Row = Record<string, unknown>

function toPost(row: Row): PostRow {
  return {
    siteId: row.site_id as string,
    entryId: row.entry_id as string,
    slug: row.slug as string,
    title: row.title as string,
    summary: (row.summary as string | null) ?? null,
    html: row.html as string,
    url: row.url as string,
    published: row.published as string,
    updated: row.updated as string,
    contentHash: row.content_hash as string,
    deletedAt: (row.deleted_at as string | null) ?? null,
    pendingActivity: (row.pending_activity as PendingActivity | null) ?? null,
  }
}

function toFollower(row: Row): Follower {
  return { actorId: row.actor_id as string, inbox: row.inbox as string, sharedInbox: (row.shared_inbox as string | null) ?? null }
}

export class Store {
  db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  migrate(): void {
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getKeys(siteId: string): StoredKey[] {
    return this.db
      .prepare('SELECT kind, private_jwk, public_jwk FROM keys WHERE site_id = ? ORDER BY kind DESC')
      .all(siteId)
      .map((row) => ({
        kind: row.kind as StoredKey['kind'],
        privateJwk: JSON.parse(row.private_jwk as string),
        publicJwk: JSON.parse(row.public_jwk as string),
      }))
  }

  saveKeys(siteId: string, keys: StoredKey[]): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO keys (site_id, kind, private_jwk, public_jwk) VALUES (?, ?, ?, ?)')
    this.transaction(() => {
      for (const k of keys) insert.run(siteId, k.kind, JSON.stringify(k.privateJwk), JSON.stringify(k.publicJwk))
    })
  }

  addFollower(siteId: string, f: Follower): void {
    this.db
      .prepare(
        `INSERT INTO followers (site_id, actor_id, inbox, shared_inbox) VALUES (?, ?, ?, ?)
         ON CONFLICT (site_id, actor_id) DO UPDATE SET inbox = excluded.inbox, shared_inbox = excluded.shared_inbox`,
      )
      .run(siteId, f.actorId, f.inbox, f.sharedInbox)
  }

  removeFollower(siteId: string, actorId: string): void {
    this.db.prepare('DELETE FROM followers WHERE site_id = ? AND actor_id = ?').run(siteId, actorId)
  }

  removeFollowersByInbox(inbox: string): number {
    return Number(this.db.prepare('DELETE FROM followers WHERE inbox = ? OR shared_inbox = ?').run(inbox, inbox).changes)
  }

  listFollowers(siteId: string, { offset, limit }: Page): Follower[] {
    return this.db
      .prepare('SELECT actor_id, inbox, shared_inbox FROM followers WHERE site_id = ? ORDER BY created_at, actor_id LIMIT ? OFFSET ?')
      .all(siteId, limit, offset)
      .map(toFollower)
  }

  countFollowers(siteId: string): number {
    return Number(this.db.prepare('SELECT count(*) AS n FROM followers WHERE site_id = ?').get(siteId)!.n)
  }

  listPosts(siteId: string): PostRow[] {
    return this.db.prepare('SELECT * FROM posts WHERE site_id = ?').all(siteId).map(toPost)
  }

  getPostBySlug(siteId: string, slug: string): PostRow | undefined {
    const row = this.db.prepare('SELECT * FROM posts WHERE site_id = ? AND slug = ?').get(siteId, slug)
    return row ? toPost(row) : undefined
  }

  listPublishedPosts(siteId: string, { offset, limit }: Page): PostRow[] {
    return this.db
      .prepare('SELECT * FROM posts WHERE site_id = ? AND deleted_at IS NULL ORDER BY published DESC, entry_id LIMIT ? OFFSET ?')
      .all(siteId, limit, offset)
      .map(toPost)
  }

  countPublishedPosts(siteId: string): number {
    return Number(this.db.prepare('SELECT count(*) AS n FROM posts WHERE site_id = ? AND deleted_at IS NULL').get(siteId)!.n)
  }

  applyChanges(siteId: string, changes: Changes, now: Date = new Date()): void {
    const taken = new Set(this.listPosts(siteId).map((p) => p.slug))
    const insert = this.db.prepare(
      `INSERT INTO posts (site_id, entry_id, slug, title, summary, html, url, published, updated, content_hash, pending_activity)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const update = this.db.prepare(
      `UPDATE posts SET title = ?, summary = ?, html = ?, url = ?, published = ?, updated = ?, content_hash = ?,
         pending_activity = CASE WHEN pending_activity = 'Create' THEN 'Create' ELSE 'Update' END
       WHERE site_id = ? AND entry_id = ?`,
    )
    const remove = this.db.prepare(
      `UPDATE posts SET deleted_at = ?, pending_activity = 'Delete' WHERE site_id = ? AND entry_id = ?`,
    )

    this.transaction(() => {
      for (const e of changes.create) {
        const slug = slugFor(e.url, taken)
        taken.add(slug)
        insert.run(siteId, e.id, slug, e.title, e.summary, e.html, e.url, e.published.toISOString(), e.updated.toISOString(), contentHash(e), changes.silent ? null : 'Create')
      }
      for (const e of changes.update) {
        update.run(e.title, e.summary, e.html, e.url, e.published.toISOString(), e.updated.toISOString(), contentHash(e), siteId, e.id)
      }
      for (const entryId of changes.delete) remove.run(now.toISOString(), siteId, entryId)
    })
  }

  listPending(siteId: string): PostRow[] {
    return this.db
      .prepare('SELECT * FROM posts WHERE site_id = ? AND pending_activity IS NOT NULL ORDER BY published, entry_id')
      .all(siteId)
      .map(toPost)
  }

  clearPending(siteId: string, entryId: string): void {
    this.db.prepare('UPDATE posts SET pending_activity = NULL WHERE site_id = ? AND entry_id = ?').run(siteId, entryId)
  }
}
