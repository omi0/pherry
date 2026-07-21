/**
 * `@pherry/protocol` — the Pherry wire.
 *
 * One versioned, capability-negotiated protocol shared by two roles: hosts
 * produce agent sessions, controllers steer them. This package is pure logic —
 * zod schemas, a binary PTY codec, and version/capability rules. No I/O.
 */

// Versioning
export { MIN_COMPATIBLE_VERSION, PROTOCOL_VERSION, evaluateCompat } from './version.js'
export type { CompatResult } from './version.js'

// Capabilities
export {
  ATTENTION,
  FOLLOW_CUSTODY,
  KNOWN_CAPABILITIES,
  MIRROR_SNAPSHOT,
  PTY_STREAM,
  SANDBOX,
  SEMANTIC_MIRROR,
  SESSION_APPROVE,
  SESSION_INPUT,
  negotiate,
} from './capabilities.js'
export type { KnownCapability } from './capabilities.js'

// Ids
export {
  DeviceId,
  HostId,
  SessionRef,
  StreamId,
  makeIdSchema,
  newDeviceId,
  newHostId,
  newSessionRef,
} from './schemas/ids.js'

// Primitives
export { Base64 } from './schemas/primitives.js'

// Session schemas
export { Ack, ApprovalReply, InputFrame, SessionSubscribe, Size } from './schemas/session.js'

// Mirror
export { MirrorStreamAck } from './schemas/mirror.js'

// Sandbox
export { SandboxSpec, SpawnResult } from './schemas/sandbox.js'

// Attention
export { AttentionEvent } from './schemas/attention.js'

// Custody
export {
  CustodyClaim,
  CustodyReservation,
  CustodySpec,
  SessionInfo,
  SessionList,
} from './schemas/custody.js'

// Handshake
export { Hello, HelloAck, Role, negotiateHello } from './handshake.js'
export type { HandshakeOutcome } from './handshake.js'

// Control envelope
export {
  ERROR_CODES,
  ErrorCode,
  ErrorCodeSchema,
  ResponseFrame,
  RpcError,
  RpcRequest,
  RpcSuccess,
  failure,
  newRequestId,
  success,
} from './envelope.js'

// Method registry
export { METHODS, defineMethod } from './methods.js'
export type { MethodDescriptor, MethodName, ParamsOf, ResultOf } from './methods.js'

// Binary PTY frames
export {
  HEADER_BYTES,
  PTY_FRAME_KIND,
  PTY_FRAME_VERSION,
  PtyOpcode,
  decodePtyFrame,
  encodePtyFrame,
} from './pty-frame.js'
export type { PtyFrame } from './pty-frame.js'

// PTY frame payloads
export {
  decodeExitPayload,
  decodeSizePayload,
  encodeExitPayload,
  encodeSizePayload,
} from './pty-payloads.js'
