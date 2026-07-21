/**
 * `@pherry/cli` — the `pherry` command, plus the reusable pieces its commands are
 * built from.
 *
 * The commands `run` / `attach` are **development** tooling (see the bin and the
 * README). What is exported here is the production-core machinery underneath them
 * — above all the local-terminal client {@link runTerminalClient}, which leg 3c's
 * PATH shims reuse to render a custodied TUI into a user's own terminal — so that
 * layer can import the engine and the host-key helpers rather than reimplement
 * them.
 */

// The reusable local-terminal client engine (production-core).
export { runTerminalClient } from './terminal-client.js'
export type { TerminalIo, TerminalClientResult } from './terminal-client.js'
export { processTerminalIo } from './terminal-io.js'

// Host identity: the persisted static keypair a controller pins.
export {
  defaultHostKeyDir,
  loadOrCreateHostKey,
  publicKeyPath,
  readHostPublicKey,
  secretKeyPath,
} from './host-key.js'

// Local run/attach socket layout.
export { latestSocket, runDir, sessionRefFromSocket, socketPathFor } from './paths.js'

// The dev commands, as callable functions.
export { resolveAgentArgv, startRun } from './commands/run.js'
export type { RunHandle, RunOptions } from './commands/run.js'
export { runAttach } from './commands/attach.js'
export type { AttachOptions } from './commands/attach.js'
