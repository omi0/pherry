import { defineConfig } from 'drizzle-kit'

/**
 * Drizzle Kit config for `pnpm --filter @pherry/control-plane db:generate`.
 *
 * `generate` is fully offline — it diffs {@link ./src/db/schema.ts} against the
 * committed migration journal in {@link ./drizzle} and writes the next SQL
 * migration. No database connection is required (or configured) here; applying
 * migrations is `migrateDb` in `src/db/migrate.ts`.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
})
