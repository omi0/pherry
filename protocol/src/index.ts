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
  LAUNCH,
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

// Launch
export {
  LaunchAgent,
  LaunchModel,
  LaunchOptions,
  LaunchProject,
  LaunchStartParams,
  LaunchStartResult,
} from './schemas/launch.js'

// Handshake
export { Hello, HelloAck, Role, negotiateHello } from './handshake.js'
export type { HandshakeOutcome } from './handshake.js'
export {
  DEVICE_AUTH_LABEL,
  DEVICE_AUTH_SESSION_ID_BYTES,
  DEVICE_AUTH_SIGNATURE_BYTES,
  DEVICE_KEY_ID_LENGTH,
  DEVICE_KEY_ID_PATTERN,
  DEVICE_PUBLIC_KEY_BYTES,
  NULL_DEVICE_AUTH,
  NULL_DEVICE_KEY_ID,
  deviceAuthMessage,
  deviceFingerprint,
  deviceKeyIdOf,
} from './device-auth.js'
export type { DeviceAuthInput } from './device-auth.js'

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
export { METHOD_CAPABILITY, METHODS, defineMethod, requiredCapability } from './methods.js'
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
