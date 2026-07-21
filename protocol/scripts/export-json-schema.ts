/**
 * Export the protocol's zod schemas as JSON Schema (draft-07) into
 * `protocol/schema/`, so third-party and other-language clients have a
 * language-neutral spec. Run with `pnpm --filter @pherry/protocol export-schema`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { ResponseFrame } from '../src/envelope.js'
import { Hello, HelloAck } from '../src/handshake.js'
import { METHODS } from '../src/methods.js'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'schema')

mkdirSync(outDir, { recursive: true })

const written: string[] = []

function write(name: string, schema: Parameters<typeof zodToJsonSchema>[0]): void {
  const json = zodToJsonSchema(schema, { name, target: 'jsonSchema7' })
  writeFileSync(join(outDir, `${name}.schema.json`), `${JSON.stringify(json, null, 2)}\n`)
  written.push(name)
}

for (const method of Object.values(METHODS)) {
  const base = method.name.replace(/\./g, '_')
  write(`${base}.params`, method.params)
  write(`${base}.result`, method.result)
}

write('Hello', Hello)
write('HelloAck', HelloAck)
write('ResponseFrame', ResponseFrame)

console.log(`Wrote ${written.length} JSON Schema files to ${outDir}`)
