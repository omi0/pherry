/**
 * Typed, zod-validated configuration for the relay cell.
 *
 * {@link loadConfig} is **pure** over an injected environment record — no I/O, no
 * globals, no sockets — so the parsing and the production URL guard are unit-tested
 * directly while `main.ts` stays a thin bind-and-serve shell (mirroring the control
 * plane's `config.ts` / `main.ts` split).
 *
 * Threat model for `CONTROL_PLANE_URL`: the relay presents `INTERNAL_API_KEY` — the
 * shared secret that gates the control plane's `/internal/relay/*` authorizer — on
 * **every** call to that URL. If the URL is plain `http://` to a non-loopback host, the
 * secret (and the ticket/host-key traffic) travels in cleartext and can be sniffed or
 * MITM'd. So:
 *
 * - The schema requires an absolute **http(s)** URL (a `tcp://…`, a bare host, or a
 *   relative path is rejected at parse time rather than failing obscurely at fetch time).
 * - In production (`NODE_ENV === 'production'`) a non-`https` URL is **refused** unless
 *   its host is loopback — a co-located sidecar (`http://127.0.0.1:3000`) never leaves the
 *   box, so it stays allowed and the documented dev default keeps working.
 */
import { z } from 'zod'

/** Loopback hosts a plain-`http` `CONTROL_PLANE_URL` may target even in production. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * Parse `value` as an absolute **http(s)** URL, or `null` when it is not a URL at all
 * or carries any other scheme (`tcp:`, `ws:`, a relative path, …). Used both by the zod
 * refinement and the production guard, so they agree on what "an http(s) URL" means.
 */
function parseHttpUrl(value: string): URL | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
}

/** Whether `url`'s host is loopback (IPv6 brackets stripped, so `http://[::1]` matches). */
function isLoopbackHost(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ''))
}

/**
 * The relay's runtime environment schema. `CONTROL_PLANE_URL` is refined to an
 * absolute http(s) URL here; the cross-field production-https rule lives in
 * {@link loadConfig} (it needs `NODE_ENV` too).
 */
export const EnvSchema = z.object({
  /** This cell's stable id, bound into every host registration challenge. */
  CELL_ID: z.string().min(1),
  /** The interface to bind. Defaults to all interfaces. */
  LISTEN_HOST: z.string().min(1).default('0.0.0.0'),
  /** The TCP port to accept host / controller connections on. */
  LISTEN_PORT: z.coerce.number().int().positive().default(9443),
  /** The process environment name; `production` turns on the https guard below. */
  NODE_ENV: z.string().min(1).optional(),
  /** The control plane's base URL, for the internal authorizer API. Must be http(s). */
  CONTROL_PLANE_URL: z
    .string()
    .min(1)
    .refine((value) => parseHttpUrl(value) !== null, {
      message: 'CONTROL_PLANE_URL must be an absolute http(s) URL',
    }),
  /** The shared secret guarding the internal API. */
  INTERNAL_API_KEY: z.string().min(1),
})

/** The fully-resolved relay configuration. */
export interface RelayConfig {
  /** This cell's stable id. */
  readonly cellId: string
  /** The interface to bind the raw-TCP listener to. */
  readonly listenHost: string
  /** The raw-TCP port to accept host / controller connections on. */
  readonly listenPort: number
  /** The process environment name (`NODE_ENV`), or `undefined` outside production. */
  readonly nodeEnv: string | undefined
  /** The control plane's base URL for the internal authorizer API (validated http(s)). */
  readonly controlPlaneUrl: string
  /** The shared secret presented as `x-internal-key` on every internal call. */
  readonly internalApiKey: string
}

/**
 * Parse an environment record into a typed {@link RelayConfig}. Throws a `ZodError`
 * on a malformed value (missing `CELL_ID`, a non-http(s) `CONTROL_PLANE_URL`, …), and
 * a plain `Error` when production is asked to carry the shared secret over cleartext
 * `http` to a non-loopback control plane.
 */
export function loadConfig(env: Record<string, string | undefined>): RelayConfig {
  const parsed = EnvSchema.parse(env)

  if (parsed.NODE_ENV === 'production') {
    // Non-null: the schema already rejected anything that is not an absolute http(s) URL.
    const url = parseHttpUrl(parsed.CONTROL_PLANE_URL)
    if (url !== null && url.protocol !== 'https:' && !isLoopbackHost(url)) {
      throw new Error(
        'CONTROL_PLANE_URL must be https in production — refusing to send INTERNAL_API_KEY over ' +
          'cleartext http to a non-loopback control plane; use https, or a loopback host for a ' +
          'co-located sidecar',
      )
    }
  }

  return {
    cellId: parsed.CELL_ID,
    listenHost: parsed.LISTEN_HOST,
    listenPort: parsed.LISTEN_PORT,
    nodeEnv: parsed.NODE_ENV,
    controlPlaneUrl: parsed.CONTROL_PLANE_URL,
    internalApiKey: parsed.INTERNAL_API_KEY,
  }
}
