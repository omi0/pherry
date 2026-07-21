/**
 * Apply the committed SQL migrations to a database.
 *
 * {@link migrateDb} runs against **either** backend — the production
 * `node-postgres` pool or a test PGlite instance. Drizzle's per-driver migrators
 * share a driver-agnostic body (`db.dialect.migrate(migrations, db.session, …)`),
 * so one migrator applies the same committed `drizzle/` SQL to any `Db`.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import type { Db, Schema } from './client.js'

/** Absolute path to the committed migrations folder (`apps/control-plane/drizzle`). */
const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

/**
 * Run every pending migration in `drizzle/` against `db`. Idempotent — Drizzle
 * tracks applied migrations in its journal table and skips them on re-run.
 */
export async function migrateDb(db: Db): Promise<void> {
  await migrate(db as NodePgDatabase<Schema>, { migrationsFolder: MIGRATIONS_FOLDER })
}
