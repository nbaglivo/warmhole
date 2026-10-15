# warmhole: design

A warm little portal from your static site into the fediverse.

warmhole is a small, self-hosted Hono + Fedify server that turns a static site's
feed into a fediverse account people can follow from Mastodon and other
ActivityPub software. One instance can serve a few sites.

Visual version of this design (diagrams): https://claude.ai/artifact/JVkjHvMQCi6GpriY4NiSMa

## Goal and success criteria

- A Mastodon user follows `@nico@innermonologue.nbaglivo.dev`, a new post is
  published on that static site, and it appears in their home timeline.
- Someone else can point their own instance at their own blog using only
  configuration: no code changes, no dependency on how the site is built.

## Decisions

| Topic | Decision |
|---|---|
| Who runs it | You deploy your own instance. Sites are listed in a config file. No signup, no admin UI. |
| New posts | Ping only. The site's deploy calls the sync endpoint. No polling. |
| Ping safety | Sync responds only after the feed was read and saved; CI uses `curl --fail --retry 3`. Feed fetched with `Cache-Control: no-cache` and a cache-busting query. Re-pinging is always safe. |
| Domains | Handle on the site's domain. Actor, inbox, outbox and posts on the server's domain (e.g. `ap.nbaglivo.dev`). The site serves only a static WebFinger file. |
| Runtime | Node in Docker with one SQLite file. Cloudflare Workers is a later adapter behind the same storage and queue interfaces. |
| Post shape | `Article` with full HTML `content`, the feed entry's summary/subtitle as `summary`, and `url` pointing to the site's page. |
| Inbound | Only `Follow` and `Undo(Follow)` change state. Likes, boosts, replies and anything else: verified, answered with 202, dropped. |
| Framework | Hono for our routes, Fedify (via `@fedify/hono`) for all ActivityPub. |

### Out of scope (v1)

Showing replies or counts on the site, a Mastodon client API, editing the
profile through a UI, Cloudflare Workers support, polling.

## Architecture

One container. Our routes handle pings from sites; Fedify handles traffic from
other servers; both persist to one SQLite file.

```
CI ──ping──▶ Sync endpoint ─▶ Feed reader ──GET──▶ site feed.xml
                                  │
                                  ▼
                                Diff ─▶ SQLite (posts + queue) ─▶ Delivery worker ──signed POST──▶ follower servers
                                          ▲
follower servers ──signed POST──▶ Fedify routes ─▶ Inbox listeners
```

### Units

| Unit | Does | Depends on |
|---|---|---|
| `config` | Loads and validates the sites file; reads tokens from env. | nothing |
| `feed` | Fetches a feed and normalizes RSS, Atom or JSON Feed into one entry shape: `id`, `url`, `title`, `summary`, `html`, `published`, `updated`. | fetch, a feed parser library |
| `diff` | Pure function: stored posts + feed entries → `{ create, update, delete }`. | nothing |
| `store` | `keys`, `followers`, `posts` tables behind a small interface. | `node:sqlite` |
| `federation` | Fedify setup: actor, outbox, followers and post object dispatchers; inbox listeners; key pairs; sending. | Fedify, `store` |
| `sync` | Runs one sync for a site: feed → diff → store → send. Serialized per site. | `feed`, `diff`, `store`, `federation` |
| `app` | Hono app: sync, webfinger helper and health routes; Fedify mounted as middleware. | all of the above |

Fedify's `SqliteKvStore` and `SqliteMessageQueue` (from `@fedify/sqlite`, using
`node:sqlite`) share the same database file, so pending deliveries survive
restarts.

## Data

| Table | Columns | Purpose |
|---|---|---|
| `keys` | `site_id`, `kind` (`RSASSA-PKCS1-v1_5` or `Ed25519`), `private_jwk`, `public_jwk` | Generated on first start per site. Config never holds keys. |
| `followers` | `site_id`, `actor_id`, `inbox`, `shared_inbox`, `created_at`, `failing_since` | Delivery targets. PK `(site_id, actor_id)`. |
| `posts` | `site_id`, `entry_id`, `slug`, `title`, `summary`, `html`, `url`, `published`, `updated`, `content_hash`, `deleted_at` | What was sent; serves each Article at a stable URL independent of the feed. PK `(site_id, entry_id)`. |

`content_hash` is a SHA-256 over `title`, `summary`, `html` and `url`.
`slug` is derived from the entry URL's last path segment (extension removed),
de-duplicated per site.

The SQLite file holds private keys: it must live on a persistent volume and be
backed up.

## URLs

All on `publicUrl`:

| Path | Served by |
|---|---|
| `/users/{siteId}` | Fedify actor dispatcher |
| `/users/{siteId}/inbox`, `/inbox` (shared) | Fedify inbox |
| `/users/{siteId}/outbox` | Fedify outbox dispatcher (from `posts`, newest first, paged) |
| `/users/{siteId}/followers` | Fedify followers dispatcher (from `followers`) |
| `/users/{siteId}/posts/{slug}` | Fedify object dispatcher (`Article` or `Tombstone`) |
| `/.well-known/webfinger`, `/.well-known/nodeinfo` | Fedify |
| `POST /sites/{siteId}/sync` | Hono, bearer token |
| `GET /sites/{siteId}/webfinger.json` | Hono, returns the static file the site should serve |
| `GET /healthz` | Hono |

The actor identifier is the site id, not the handle, so two sites may share a
handle on different domains.

## Sync

1. CI calls `POST /sites/{siteId}/sync` with `Authorization: Bearer <token>`.
2. Fetch the feed with `Cache-Control: no-cache` and `?_=<timestamp>`; 10 s
   timeout, 5 MB limit.
3. Parse and normalize entries.
4. Run guards (below). If any trips, respond with an error and change nothing.
5. Diff against stored posts.
6. In one transaction: write post changes and enqueue activities
   (`ctx.sendActivity(..., "followers", ..., { preferSharedInbox: true })`).
7. Respond `200 { "new": n, "updated": n, "deleted": n }`.
8. Fedify's queue delivers in the background, with retries.

Two syncs for the same site never run concurrently; the second waits for the
first.

### Diff rules

| Entry vs. `posts` | Result |
|---|---|
| Not stored | Insert; send `Create(Article)` |
| Stored, `content_hash` changed | Update; send `Update(Article)` |
| Stored, hash unchanged | Nothing |
| Stored, missing from feed, `deleteMissing: true` | Set `deleted_at`; send `Delete` (object becomes a `Tombstone`) |
| Stored, missing from feed, `deleteMissing: false` (default) | Nothing |
| First sync for a site (no stored posts) | Insert all; send nothing |

### Guards

| Condition | Response |
|---|---|
| Feed can't be fetched or parsed | 502 |
| Feed has zero entries | 422 |
| Sync would delete more than half of the stored, non-deleted posts | 422 |

## Following

1. A follower's server POSTs a signed `Follow` to `/users/{siteId}/inbox`.
2. Fedify verifies the HTTP signature (fetching the remote key) before our
   listener runs.
3. The listener upserts the follower (`actor_id`, `inbox`, `shared_inbox`) and
   sends `Accept(Follow)` through the queue. Follows are always auto-accepted.
4. `Undo(Follow)` deletes the follower row.
5. Every other activity type: 202, dropped.

## Discovery across two domains

- The site serves `/.well-known/webfinger` as a static file
  (`application/jrd+json`): subject `acct:{handle}@{domain}`, `self` link to
  `{publicUrl}/users/{siteId}`.
- The server's own WebFinger answers `acct:{handle}@{serverHost}` and the actor
  URL with subject `acct:{handle}@{domain}`, so Mastodon resolves the site
  handle even when it meets the actor first (e.g. via a boost) and confirms it
  against the site's file.
- If the two answers disagree, Mastodon falls back to showing
  `@{handle}@{serverHost}`.

**To verify first during planning:** Fedify's option for serving handles on a
different host than the actor is set once per `Federation` instance. With
several sites on different domains, choose between one `Federation` per site
(sharing the KV store and queue) or a custom WebFinger handler for our routes.

## Configuration

One JSON file (path from `WARMHOLE_CONFIG`, default `./warmhole.json`). Secrets
are referenced by env var name, never stored in the file.

```json
{
  "publicUrl": "https://ap.nbaglivo.dev",
  "sites": [
    {
      "id": "inner-monologue",
      "handle": "nico",
      "domain": "innermonologue.nbaglivo.dev",
      "feedUrl": "https://innermonologue.nbaglivo.dev/feed.xml",
      "name": "The Open Inner Monologue",
      "summary": "The open inner monologue of Nicolás Baglivo.",
      "icon": "https://innermonologue.nbaglivo.dev/public/icons/avatar.png",
      "syncTokenEnv": "INNER_MONOLOGUE_SYNC_TOKEN",
      "deleteMissing": true
    }
  ]
}
```

Validation fails startup on: missing required fields, duplicate site ids,
non-HTTPS URLs, or a `syncTokenEnv` that is unset.

Other env: `PORT` (default 8080), `WARMHOLE_DB` (default `./data/warmhole.db`).

### Site setup

1. Serve the output of `GET /sites/{siteId}/webfinger.json` at
   `/.well-known/webfinger` with `Content-Type: application/jrd+json`.
2. Add a step after deploy:

```yaml
- name: Notify warmhole
  run: >
    curl --fail --retry 3 -X POST
    -H "Authorization: Bearer ${{ secrets.WARMHOLE_SYNC_TOKEN }}"
    https://ap.nbaglivo.dev/sites/inner-monologue/sync
```

## Errors and safety

- Sync tokens compared in constant time. Wrong token and unknown site id both
  return 401.
- Feed fetch: 10 s timeout, 5 MB limit.
- Bad inbox signatures rejected by Fedify; unhandled activities get 202.
- Deliveries retry with backoff via Fedify's queue. A follower whose deliveries
  have all failed for 7 days (`failing_since`) is removed.
- Logging through LogTape (as Fedify does), JSON lines on stdout.

## Testing

- **Unit:** feed normalization against RSS, Atom and JSON Feed fixtures,
  including the Inner Monologue's real `feed.xml`; every diff rule and guard;
  config validation.
- **Integration:** the Hono app with in-memory SQLite and a local feed; assert
  stored posts, queued activities and HTTP responses. A fake follower server
  checks that signed deliveries arrive.
- **Manual before release:** `fedify lookup` on the actor, `fedify inbox` as a
  throwaway follower, then a real follow from a test Mastodon account.

## Repository and stack

- TypeScript run directly by Node 26 (type stripping), no build step.
- Tests with `node:test`. Node pinned in `mise.toml`.
- Dependencies: `hono`, `@hono/node-server`, `@fedify/fedify`, `@fedify/hono`,
  `@fedify/sqlite`, a maintained feed parser (chosen during planning).
- `Dockerfile` on `node:26-slim`; SQLite on a mounted volume.
