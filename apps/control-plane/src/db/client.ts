/**
 * The Drizzle database client.
 *
 * {@link Db} is the driver-agnostic database type — the query-builder surface the
 * app actually uses — typed against {@link schema}. Production builds it over a
 * `pg` `Pool` ({@link makeDb}); tests substitute a PGlite-backed instance of the
 * same {@link Db} type (see `test/support.ts`). Both share the same schema and the
 * same migrations, so a query written against `Db` runs identically on either.
 */
import type { ExtractTablesWithRelations } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import pg from 'pg'
import * as schema from './schema.js'

/** The control-plane schema, as a type. */
export type Schema = typeof schema

/**
 * The app's database handle — the driver-agnostic Drizzle surface typed against
 * {@link Schema}. Both the `node-postgres` (prod) and PGlite (test) drivers
 * produce a value assignable to this type.
 */
export type Db = PgDatabase<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>

/**
 * Build a production {@link Db} over a `pg` connection pool. Call only from
 * `main.ts`; `buildServer` receives an already-constructed `Db` so it does no
 * network or environment access.
 */
export function makeDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString })
  return drizzle(pool, { schema })
}
