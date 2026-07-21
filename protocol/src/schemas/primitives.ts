import { z } from 'zod'

/**
 * Standard RFC 4648 base64 (with `+/` and optional `=` padding).
 *
 * Used for opaque byte payloads carried inside JSON control frames — keystroke
 * data and public keys — where raw bytes would not survive JSON. The empty
 * string is accepted (an empty payload).
 */
export const Base64 = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, 'expected base64')
