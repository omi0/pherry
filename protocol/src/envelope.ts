import { z } from 'zod'

/**
 * The RPC control frame — the JSON half of the wire.
 *
 * A request carries a correlation `id`, a `method` name, and optional `params`.
 * Every response echoes the `id` and is discriminated by `ok`: a success
 * carries `result` (and may set `stream: true` to announce that binary PTY
 * frames will follow on the shared socket), a failure carries a coded `error`.
 */

/** The closed set of error codes a failure response may carry. */
export const ERROR_CODES = [
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_FOUND',
  'INVALID_ARGUMENT',
  'UNAVAILABLE',
  'VERSION_INCOMPATIBLE',
  'INTERNAL',
] as const

/** One of the {@link ERROR_CODES}. */
export type ErrorCode = (typeof ERROR_CODES)[number]

/** Named accessors for the error codes. */
export const ErrorCode = {
  InvalidRequest: 'INVALID_REQUEST',
  Unauthorized: 'UNAUTHORIZED',
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  MethodNotFound: 'METHOD_NOT_FOUND',
  InvalidArgument: 'INVALID_ARGUMENT',
  Unavailable: 'UNAVAILABLE',
  VersionIncompatible: 'VERSION_INCOMPATIBLE',
  Internal: 'INTERNAL',
} as const satisfies Record<string, ErrorCode>

/** zod schema for {@link ErrorCode}. */
export const ErrorCodeSchema = z.enum(ERROR_CODES)

/** A method call awaiting a response. */
export const RpcRequest = z.object({
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
})
export type RpcRequest = z.infer<typeof RpcRequest>

/** A successful response. `stream: true` announces binary frames to follow. */
export const RpcSuccess = z.object({
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.unknown(),
  stream: z.literal(true).optional(),
})
export type RpcSuccess = z.infer<typeof RpcSuccess>

/** A failed response. */
export const RpcError = z.object({
  id: z.string().min(1),
  ok: z.literal(false),
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
    data: z.unknown().optional(),
  }),
})
export type RpcError = z.infer<typeof RpcError>

/** Any response frame, discriminated on `ok`. */
export const ResponseFrame = z.discriminatedUnion('ok', [RpcSuccess, RpcError])
export type ResponseFrame = z.infer<typeof ResponseFrame>

/** Build a success response for `id`. Set `opts.stream` to announce binary frames. */
export function success(id: string, result: unknown, opts?: { stream?: boolean }): RpcSuccess {
  return opts?.stream ? { id, ok: true, result, stream: true } : { id, ok: true, result }
}

/** Build a failure response for `id`. */
export function failure(id: string, code: ErrorCode, message: string, data?: unknown): RpcError {
  const error = data === undefined ? { code, message } : { code, message, data }
  return { id, ok: false, error }
}

/** Mint a fresh request-correlation id. */
export const newRequestId = (): string => crypto.randomUUID()
