/**
 * `@pherry/host` — the session runtime.
 *
 * A host owns agent sessions and mirrors them over the wire. It rests on three
 * invariants:
 *
 *  1. **The host always owns the PTY.** Every viewer — the user's own terminal
 *     and the phone alike — is an equal {@link SessionSink} subscriber to a
 *     host-owned {@link Session}.
 *  2. **Custody is first-class.** A hand-launched agent becomes a host-owned
 *     session through the {@link CustodyDesk} reserve -> claim handshake, on the
 *     very same {@link openSession} primitive that `pherry run` uses.
 *  3. **node-pty is isolated.** The one native module is lazy-imported inside
 *     {@link LocalPtyBackend} only; everything else — and every test — runs
 *     against the {@link Backend} interface and the {@link FakeBackend}.
 */

// Backend contract
export type { Backend, BackendHandle, Disposable, SessionSpec } from './backend/backend.js'
export { FakeBackend } from './backend/fake.js'
export { LocalPtyBackend, envForSpawn } from './backend/local-pty.js'

// Session runtime
export { Mirror } from './session/mirror.js'
export type { MirrorOptions } from './session/mirror.js'
export { ByteRing } from './session/ring.js'
export {
  DEFAULT_RING_BYTES,
  DEFAULT_STREAM_ID,
  SNAPSHOT_CHUNK_BYTES,
  Session,
} from './session/session.js'
export type { SessionOptions, SessionSink } from './session/session.js'
export { SessionRegistry } from './session/registry.js'
export { openSession, spawnSession } from './session/spawn.js'
export type { OpenSessionOptions } from './session/spawn.js'

// Custody
export { CustodyDesk, CustodyError } from './custody/open.js'
export type { CustodyDeskOptions, CustodyErrorCode, Reservation } from './custody/open.js'

// Agent adapters
export {
  AGENT_ADAPTERS,
  AGENT_IDS,
  detect,
  detectArgv,
  getAdapter,
  listAgents,
  resolveLaunch,
} from './agents/adapters.js'
export type { AgentAdapter, AgentId, DetectOptions } from './agents/adapters.js'
