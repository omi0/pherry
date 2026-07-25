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

// S1 — where a remote pin comes from: this machine's known-hosts file, and the
// one-question confirm the first-use ceremony asks.
export {
  type KnownHost,
  fingerprintOfB64,
  forgetKnownHost,
  keyFingerprint,
  knownHostEntry,
  knownHostsPath,
  lookupKnownHost,
  readKnownHosts,
  writeKnownHost,
} from './known-hosts.js'
export { type PromptIo, confirm, isInteractive, processPromptIo } from './prompt.js'
export { runHostsForget, runHostsList, runHostsTrust } from './commands/hosts.js'
export type { HostsOptions } from './commands/hosts.js'

// The dev commands, as callable functions.
export { resolveAgentArgv, startRun } from './commands/run.js'
export type { RunHandle, RunOptions } from './commands/run.js'
export { runAttach } from './commands/attach.js'
export type { AttachOptions } from './commands/attach.js'

// Custody (leg 3c): the daemon/shim filesystem layout, the PATH shim template,
// the boarded/anchored registries, and the board/unboard/anchor commands.
export {
  anchoredListPath,
  boardedListPath,
  configPath,
  hostPidPath,
  hostSocketPath,
  shimsDir,
} from './paths.js'
export { renderShimScript } from './custody/shim.js'
export type { ShimScriptOptions } from './custody/shim.js'
export {
  addToAnchoredList,
  addToBoardedList,
  readAnchoredList,
  readBoardedList,
  removeFromAnchoredList,
  removeFromBoardedList,
} from './custody/boarded.js'
export {
  RC_BLOCK_CLOSE,
  RC_BLOCK_OPEN,
  ensureShimsOnShellPath,
  removeShimsFromShellPath,
} from './custody/shell-rc.js'
export type { EnsureRcResult, RemoveRcResult, ShellRcOptions } from './custody/shell-rc.js'
export { runAnchor, runBoard, runUnboard } from './commands/board.js'
export type {
  AnchorOptions,
  AnchorResult,
  BoardOptions,
  BoardResult,
  UnboardOptions,
  UnboardResult,
} from './commands/board.js'

// The custody daemon (leg 3c): the always-on host the shims talk to, plus the
// `open` / `sessions` / `dock` commands built on top of it.
export { startServe, stopServe } from './commands/serve.js'
export type { ServeOptions, ServeHandle, StopResult } from './commands/serve.js'
export { runOpen } from './commands/open.js'
export type { ExecFallbackRunner, OpenOptions, OpenResult } from './commands/open.js'
export { runSessions } from './commands/sessions.js'
export type { SessionsOptions } from './commands/sessions.js'
export { runDock } from './commands/dock.js'
export type { DockDaemonState, DockOptions, DockResult } from './commands/dock.js'

// P3a — host origination of attention events: the `attention` verb's engine
// (raise / list / watch / ack), pure functions the bin renders and the tests drive.
export {
  runAttentionAck,
  runAttentionList,
  runAttentionRaise,
  runAttentionWatch,
} from './commands/attention.js'
export type {
  AttentionAckOptions,
  AttentionKind,
  AttentionListOptions,
  AttentionRaiseOptions,
  AttentionRaiseResult,
  AttentionReadOptions,
  AttentionUrgency,
  AttentionWatchOptions,
} from './commands/attention.js'

// P2c — the online surface: the docked-state config, the typed control-plane
// client, the TCP cell dialer, the terminal QR renderer, and the daemon's
// reconnecting relay uplink. These are the pieces `dock`, the host dial-out, and
// the remote controller are built from — exported so the end-to-end proof (and any
// future controller) can drive the real code paths rather than reimplement them.
export {
  type DockConfig,
  dockConfigPath,
  readDockConfig,
  writeDockConfig,
} from './dock-config.js'
export { ControlPlaneClient, ControlPlaneError, resolveApiUrl } from './control-plane-client.js'
export type {
  AttentionEventRecord,
  CliAuthStartResult,
  CliAuthExchangeResult,
  ControlPlaneClientOptions,
  CreateHostResult,
  HeartbeatResult,
  MintPairResult,
  RaiseAttentionResult,
  RelayTicketResult,
  SessionReport,
} from './control-plane-client.js'
export { type CellAddress, connectCell, parseCellUrl } from './cell-url.js'
export { renderQrTerminal } from './qr.js'
export { startRelayUplink } from './daemon/relay-uplink.js'
export type {
  RelayUplinkHandle,
  RelayUplinkOptions,
  RelayUplinkState,
} from './daemon/relay-uplink.js'
