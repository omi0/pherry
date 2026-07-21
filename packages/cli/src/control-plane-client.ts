/**
 * A thin typed HTTP client for the P2b control plane — the seam `dock`, the host
 * dial-out, and the remote controller all reach the router through.
 *
 * It is deliberately minimal: it builds a request, adds a `Bearer` token where the
 * endpoint demands one, parses the JSON response, and surfaces the control plane's
 * uniform `{ error: { code, message } }` envelope as a {@link ControlPlaneError}
 * (with `.code` exposed) on any non-2xx. The `fetch` implementation is injectable
 * (default `globalThis.fetch`) so tests drive it with a fake, and the base URL is
 * trailing-slash tolerant.
 *
 * **No token ever reaches an error.** Errors are built only from the response body
 * and status — never from the request headers — so a bearer secret cannot leak
 * through a throw.
 */

/** Everything `POST /v1/cli/auth/start` returns to begin the loopback login. */
export interface CliAuthStartResult {
  /** The auth request's id, echoed back to `exchange`. */
  requestId: string
  /** The CLI's half of the request secret, proving it owns the callback. */
  cliSecret: string
  /** Where to open the browser to sign in — may be relative; see {@link resolveApiUrl}. */
  browserUrl: string
  /** When the request expires, epoch millis. */
  expiresAt: number
  /** How often to poll `exchange`, in millis. */
  pollIntervalMs: number
}

/** The result of one `POST /v1/cli/auth/exchange` poll: still waiting, or the token. */
export type CliAuthExchangeResult =
  | { status: 'pending' }
  | { status: 'ok'; token: string; expiresAt: number }

/** What `POST /v1/hosts` returns — the `hk_` credential appears here **once**. */
export interface CreateHostResult {
  host: { id: string; name: string }
  /** The `hk_` host credential, in plaintext, once. */
  hostKey: string
  /** The director to dial out to, or `null` if the control plane assigns none. */
  directorUrl: string | null
}

/** What `POST /v1/hosts/:id/pair` returns — the phone-pairing mint. */
export interface MintPairResult {
  pairToken: string
  expiresAt: number
  /** The `pherry://pair?…` deep link to render as a QR. */
  qrUrl: string
}

/** A single session report in a heartbeat body. */
export interface SessionReport {
  sessionRef: string
  status: 'live' | 'ended'
  startedAt?: number
  endedAt?: number
}

/** The heartbeat acknowledgement. */
export interface HeartbeatResult {
  ok: true
}

/** What `POST /v1/relay/tickets` returns — a one-time ticket to reach a host. */
export interface RelayTicketResult {
  ticket: string
  expiresAt: number
  /** The cell to dial, or `null` if the control plane leaves it to the director. */
  cellUrl: string | null
  /** The host's static public key (base64) to pin the initiator channel to. */
  hostPublicKeyB64: string
}

/**
 * A control-plane request that returned non-2xx. Carries the HTTP `status` and, when
 * the body parsed as the uniform error envelope, the server's `code`. The message is
 * the server's `message` (or the status text) — never a request header, so no bearer
 * token can leak through it.
 */
export class ControlPlaneError extends Error {
  /** The HTTP status code. */
  readonly status: number
  /** The server's `error.code`, when the response carried the uniform envelope. */
  readonly code: string | undefined

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'ControlPlaneError'
    this.status = status
    this.code = code
  }
}

/** Constructor options: the base URL and an optional `fetch` (defaults to global). */
export interface ControlPlaneClientOptions {
  /** The control plane's base URL; a trailing slash is tolerated. */
  apiUrl: string
  /** The `fetch` to use; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * Resolve a (possibly relative) URL the control plane hands back — such as
 * `browserUrl` — against the client's `apiUrl`. An already-absolute URL (one with a
 * scheme) is returned unchanged; a relative one is joined onto `apiUrl`.
 */
export function resolveApiUrl(apiUrl: string, maybeRelative: string): string {
  try {
    // Absolute already (has a scheme): `new URL` succeeds without a base.
    return new URL(maybeRelative).toString()
  } catch {
    const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`
    return new URL(maybeRelative, base).toString()
  }
}

/** A thin typed client over the P2b control-plane HTTP API. */
export class ControlPlaneClient {
  /** The base URL, normalised without a trailing slash. */
  private readonly apiUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: ControlPlaneClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '')
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  /** Begin the loopback login (no auth). */
  cliAuthStart(body: { callback?: string }): Promise<CliAuthStartResult> {
    return this.request('POST', '/v1/cli/auth/start', { body })
  }

  /** Poll for the human token once the browser leg completes (no auth). */
  cliAuthExchange(body: {
    requestId: string
    cliSecret: string
    code?: string
  }): Promise<CliAuthExchangeResult> {
    return this.request('POST', '/v1/cli/auth/exchange', { body })
  }

  /** Register the calling machine as a host (human token). */
  createHost(
    humanToken: string,
    body: { name: string; staticPublicKeyB64: string },
  ): Promise<CreateHostResult> {
    return this.request('POST', '/v1/hosts', { token: humanToken, body })
  }

  /** Mint a one-time phone-pairing token for a host (human token). */
  mintPair(humanToken: string, hostId: string): Promise<MintPairResult> {
    return this.request('POST', `/v1/hosts/${encodeURIComponent(hostId)}/pair`, {
      token: humanToken,
    })
  }

  /** Report liveness and optional session metadata (host `hk_` credential). */
  heartbeat(
    hostCredential: string,
    body: { sessions?: SessionReport[] },
  ): Promise<HeartbeatResult> {
    return this.request('POST', '/v1/host/heartbeat', { token: hostCredential, body })
  }

  /** Mint a one-time relay ticket to reach a host (device **or** human token). */
  relayTicket(token: string, hostId: string): Promise<RelayTicketResult> {
    return this.request('POST', '/v1/relay/tickets', { token, body: { hostId } })
  }

  /** Issue one request and parse its JSON, or throw a {@link ControlPlaneError}. */
  private async request<T>(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {}
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`

    const init: RequestInit = { method, headers }
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body)

    // Call through a bare reference so `this` is not bound onto the fetch impl.
    const doFetch = this.fetchImpl
    const response = await doFetch(`${this.apiUrl}${path}`, init)
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as T
  }
}

/**
 * Build a {@link ControlPlaneError} from a non-2xx response, preferring the uniform
 * `{ error: { code, message } }` envelope and falling back to the status text. Only
 * the response is inspected — never the request — so no token can leak.
 */
async function errorFromResponse(response: Response): Promise<ControlPlaneError> {
  let code: string | undefined
  let message: string | undefined

  const body = await response.json().catch(() => undefined)
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const error = (body as { error: unknown }).error
    if (typeof error === 'object' && error !== null) {
      const envelope = error as { code?: unknown; message?: unknown }
      if (typeof envelope.code === 'string') code = envelope.code
      if (typeof envelope.message === 'string') message = envelope.message
    }
  }

  const text = message ?? (response.statusText || `HTTP ${response.status}`)
  return new ControlPlaneError(text, response.status, code)
}
