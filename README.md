# warmhole

A warm little portal from your static site into the fediverse.

warmhole is a small, self-hosted server that turns your site's feed into a
fediverse account. People follow `@you@your-site.dev` from Mastodon, and each
new post shows up in their timeline. Your site stays static.

## How it works

Your site keeps publishing its RSS, Atom or JSON Feed. After each deploy, it
pings warmhole. warmhole reads the feed, works out what's new, edited or
removed, and sends it to your followers. Follows are accepted automatically.
Likes, boosts and replies are ignored for now.

Design and diagrams: [`docs/design.html`](docs/design.html).

## Run it

1. Copy `warmhole.example.json` to `warmhole.json` and fill in one entry per
   site. `syncTokenEnv` names an environment variable holding a long random
   token for that site.
2. Run the container, with the database on a volume you back up (it holds
   each site's private keys):

   ```bash
   docker build -t warmhole .
   docker run -d -p 8080:8080 \
     -e MY_BLOG_SYNC_TOKEN="$(openssl rand -hex 32)" \
     -v "$PWD/warmhole.json:/config/warmhole.json:ro" \
     -v warmhole-data:/data \
     warmhole
   ```

3. Put it behind HTTPS at the `publicUrl` from your config.

Without Docker: `mise install && npm ci && npm start`. Settings come from
`WARMHOLE_CONFIG` (default `./warmhole.json`), `WARMHOLE_DB` (default
`./data/warmhole.db`) and `PORT` (default `8080`).

## Connect a site

1. **WebFinger.** Download `https://<publicUrl>/sites/<id>/webfinger.json` and
   publish it on your site at `/.well-known/webfinger`, served as
   `application/jrd+json`. On Cloudflare Pages, add to `_headers`:

   ```
   /.well-known/webfinger
     Content-Type: application/jrd+json
     Access-Control-Allow-Origin: *
   ```

2. **Ping after deploy.** In GitHub Actions:

   ```yaml
   - name: Notify warmhole
     run: >
       curl --fail --retry 3 -X POST
       -H "Authorization: Bearer ${{ secrets.WARMHOLE_SYNC_TOKEN }}"
       https://ap.example.dev/sites/my-blog/sync
   ```

   The response says what happened, for example
   `{"new":1,"updated":0,"deleted":0}`. Pinging again is always safe.

The first ping for a site saves the existing posts without sending them, so new
followers aren't flooded.

## Check it works

- `npx @fedify/cli lookup @you@your-site.dev` should show your actor.
- `npx @fedify/cli inbox` gives you a throwaway account to follow from.
- Then follow from a real Mastodon account, publish a post and ping.

## Development

```bash
npm test
npm run typecheck
```
