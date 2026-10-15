import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { serve } from '@hono/node-server'
import { SqliteKvStore, SqliteMessageQueue } from '@fedify/sqlite'
import { configure, getConsoleSink, getJsonLinesFormatter, getLogger } from '@logtape/logtape'
import { loadConfig } from './config.ts'
import { Store } from './store.ts'
import { buildFederation } from './federation.ts'
import { Syncer } from './sync.ts'
import { buildApp } from './app.ts'

await configure({
  sinks: { console: getConsoleSink({ formatter: getJsonLinesFormatter() }) },
  loggers: [
    { category: ['warmhole'], sinks: ['console'], lowestLevel: 'info' },
    { category: ['fedify'], sinks: ['console'], lowestLevel: 'info' },
    { category: ['logtape', 'meta'], sinks: ['console'], lowestLevel: 'warning' },
  ],
})
const logger = getLogger(['warmhole'])

const config = loadConfig(process.env.WARMHOLE_CONFIG ?? './warmhole.json')
const dbPath = process.env.WARMHOLE_DB ?? './data/warmhole.db'
mkdirSync(dirname(dbPath), { recursive: true })

const db = new DatabaseSync(dbPath)
const store = new Store(db)
store.migrate()

const federation = buildFederation({ config, store, kv: new SqliteKvStore(db), queue: new SqliteMessageQueue(db) })
federation.startQueue(undefined).catch((error) => logger.error('delivery queue stopped: {error}', { error }))

const app = buildApp({ config, federation, syncer: new Syncer({ config, store, federation }) })

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) }, (info) => {
  logger.info('warmhole listening on port {port} for {sites}', { port: info.port, sites: config.sites.map((s) => s.id) })
})
