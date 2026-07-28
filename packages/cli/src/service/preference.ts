/**
 * The remembered boot-service decision (leg-P3f), one field in the local
 * `config.json`: `'installed'` means dock silently refreshes the unit on every
 * run (the staleness cure), `'declined'` means dock never asks again, and an
 * absent field means the question is still open — a fresh machine, or a
 * `pherry service uninstall` (which clears it so a later dock may re-offer).
 *
 * Reads tolerate a missing or unparsable file; writes preserve every other
 * field the file carries.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { configPath } from '../paths.js'

/** The two remembered answers. Absent = never answered (or deliberately re-opened). */
export type ServicePreference = 'installed' | 'declined'

/** The `config.json` key the preference lives under. */
const KEY = 'service'

/** Read the whole config object, `{}` when missing or unparsable. */
async function readConfig(baseDir?: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath(baseDir), 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The remembered decision, or `null` when the question is still open. */
export async function readServicePreference(baseDir?: string): Promise<ServicePreference | null> {
  const value = (await readConfig(baseDir))[KEY]
  return value === 'installed' || value === 'declined' ? value : null
}

/**
 * Record `preference` (or clear it with `null`), preserving the file's other
 * fields — dock's legacy `{ version: 1 }` stays intact.
 */
export async function writeServicePreference(
  preference: ServicePreference | null,
  baseDir?: string,
): Promise<void> {
  const config = await readConfig(baseDir)
  if (preference === null) delete config[KEY]
  else config[KEY] = preference
  if (config.version === undefined) config.version = 1
  await writeFile(configPath(baseDir), `${JSON.stringify(config, null, 2)}\n`)
}
