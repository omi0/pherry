/**
 * The migration entrypoint — apply the committed `drizzle/` migrations to the
 * database named by `DATABASE_URL`, then exit. It is the migration sibling of
 * `main.ts`: the only migration path that reads `process.env` and opens a
 * connection (tests call {@link migrateDb} against an injected `Db`). The runtime
 * image runs it before the server — `node dist/db/migrate-main.js && exec node
 * dist/main.js` — and on the host it is `pnpm --filter @pherry/control-plane
 * db:migrate`. It mirrors {@link makeDb}'s pool construction but keeps the pool
 * handle so it can close cleanly and let the process exit promptly.
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { migrateDb } from './migrate.js'
import * as schema from './schema.js'

/** Read `DATABASE_URL`, apply every pending migration, then close the pool. */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required')
  }

  const pool = new pg.Pool({ connectionString: databaseUrl })
  try {
    await migrateDb(drizzle(pool, { schema }))
  } finally {
    await pool.end()
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
