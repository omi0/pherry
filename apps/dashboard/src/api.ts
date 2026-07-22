/**
 * A thin, typed client over the control-plane HTTP API — the dashboard's only door
 * to the router. It mirrors the CLI's `ControlPlaneClient` discipline:
 *
 * - one method per endpoint the dashboard consumes, returning the useful inner data;
 * - a `Bearer` header attached on **every** call, from the injected `getToken`;
 * - any non-2xx surfaced as a {@link DashboardApiError} carrying `.status` and (when
 *   the uniform `{ error: { code, message } }` envelope parsed) `.code`;
 * - **no token ever reaches an error** — errors are built only from the response body
 *   and status, never from the request headers, so a bearer secret cannot leak.
 *
 * The `fetch` implementation is injectable (default `globalThis.fetch`) so tests
 * drive it with a fake and never touch the network.
 */

/** `GET /v1/me` — the session probe: who the bearer resolves to, and their org. */
export interface Me {
  readonly user: { readonly id: string }
  readonly org: { readonly id: string; readonly name: string }
}

/** A host row from `GET /v1/hosts`. */
export interface Host {
  readonly id: string
  readonly name: string
  readonly keyPrefix: string
  readonly lastSeenAt: string | null
  readonly revokedAt: string | null
}

/** `POST /v1/hosts/:id/pair` — the phone-pairing mint. */
export interface PairMint {
  readonly pairToken: string
  readonly expiresAt: number
  /** The `pherry://pair?…` deep link to render as a QR. */
  readonly qrUrl: string
}

/** A session-metadata row from `GET /v1/sessions`. */
export interface Session {
  readonly id: string
  readonly hostId: string
  readonly hostName: string
  readonly sessionRef: string
  readonly status: string
  readonly startedAt: string
  readonly endedAt: string | null
}

/** A device row from `GET /v1/devices`. */
export interface Device {
  readonly id: string
  readonly name: string
  readonly keyPrefix: string
  readonly lastSeenAt: string | null
  readonly revokedAt: string | null
}

/** One pending attention event from `GET /v1/attention` (newest first). */
export interface AttentionRecord {
  readonly id: string
  readonly hostId: string
  readonly sessionRef: string
  readonly kind: 'done' | 'blocked' | 'asks'
  readonly summary: string
  readonly question: string | null
  readonly options: string[] | null
  readonly urgency: 'call' | 'notify' | 'digest'
  readonly createdAt: number
}

/** `POST /v1/cli/auth/approve` success — the loopback redirect, or `null` (headless). */
export interface CliAuthApproval {
  readonly ok: true
  readonly redirectUrl: string | null
}

/** `GET /v1/cli/auth/:requestId` — what the approval page needs before approving. */
export interface CliAuthDescription {
  readonly requestId: string
  /** True for a headless request: the approver must enter the CLI's user code. */
  readonly needsCode: boolean
}

/**
 * A control-plane request that returned non-2xx. Carries the HTTP `status` and, when
 * the body parsed as the uniform envelope, the server's `code`. The message is the
 * server's `message` (or the status text) — never a request header, so no bearer
 * token can leak through it.
 */
export class DashboardApiError extends Error {
  /** The HTTP status code. */
  readonly status: number
  /** The server's `error.code`, when the response carried the uniform envelope. */
  readonly code: string | undefined

  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'DashboardApiError'
    this.status = status
    this.code = code
  }
}

/** True when `err` is a `401` from the API — a valid-shaped but unlinked/unknown token. */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof DashboardApiError && err.status === 401
}

/** The typed surface the views consume — an interface so tests can inject a fake. */
export interface DashboardApi {
  /** The session probe; a `401` drives the "account not linked" state. */
  me(): Promise<Me>
  /** List the caller's org's hosts. */
  listHosts(): Promise<Host[]>
  /** Mint a one-time phone-pairing token for a host. */
  pairHost(hostId: string): Promise<PairMint>
  /** Revoke a host (idempotent server-side). */
  revokeHost(hostId: string): Promise<void>
  /** List the org's session metadata. */
  listSessions(): Promise<Session[]>
  /** List the org's devices. */
  listDevices(): Promise<Device[]>
  /** Revoke a device (idempotent server-side). */
  revokeDevice(deviceId: string): Promise<void>
  /** List pending attention events, optionally only those after a `since` cursor. */
  listAttention(opts?: { since?: number }): Promise<AttentionRecord[]>
  /** Acknowledge (clear) one attention event; a second ack is a tolerated `404`. */
  ackAttention(id: string): Promise<void>
  /** Describe a pending CLI-auth request (whether it needs a user code). */
  describeCliAuth(requestId: string): Promise<CliAuthDescription>
  /**
   * Approve a pending CLI-auth request as the signed-in human. A headless request
   * requires `userCode` — the code shown in the CLI's terminal.
   */
  approveCliAuth(requestId: string, userCode?: string): Promise<CliAuthApproval>
}

/** Options for {@link createApi}: the base URL, the token source, and an optional `fetch`. */
export interface CreateApiOptions {
  /** The control plane's base URL; a trailing slash is tolerated. */
  apiUrl: string
  /** The bearer-token source — resolves `null` when the caller is not signed in. */
  getToken: () => Promise<string | null>
  /** The `fetch` to use; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch
}

/** Build a {@link DashboardApi} bound to a base URL and a token source. */
export function createApi(opts: CreateApiOptions): DashboardApi {
  const base = opts.apiUrl.replace(/\/+$/, '')
  const doFetch = opts.fetchImpl ?? globalThis.fetch

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await opts.getToken()
    const headers: Record<string, string> = {}
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (token !== null) headers.authorization = `Bearer ${token}`

    const init: RequestInit = { method, headers }
    if (body !== undefined) init.body = JSON.stringify(body)

    const response = await doFetch(`${base}${path}`, init)
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as T
  }

  return {
    me: () => request<Me>('GET', '/v1/me'),
    listHosts: async () => (await request<{ hosts: Host[] }>('GET', '/v1/hosts')).hosts,
    pairHost: (hostId) => request<PairMint>('POST', `/v1/hosts/${encodeURIComponent(hostId)}/pair`),
    revokeHost: async (hostId) => {
      await request('DELETE', `/v1/hosts/${encodeURIComponent(hostId)}`)
    },
    listSessions: async () =>
      (await request<{ sessions: Session[] }>('GET', '/v1/sessions')).sessions,
    listDevices: async () => (await request<{ devices: Device[] }>('GET', '/v1/devices')).devices,
    revokeDevice: async (deviceId) => {
      await request('DELETE', `/v1/devices/${encodeURIComponent(deviceId)}`)
    },
    listAttention: async (listOpts) => {
      const params = new URLSearchParams()
      if (listOpts?.since !== undefined) params.set('since', String(listOpts.since))
      const query = params.toString()
      const path = query ? `/v1/attention?${query}` : '/v1/attention'
      return (await request<{ events: AttentionRecord[] }>('GET', path)).events
    },
    ackAttention: async (id) => {
      await request('POST', `/v1/attention/${encodeURIComponent(id)}/ack`)
    },
    describeCliAuth: (requestId) =>
      request<CliAuthDescription>('GET', `/v1/cli/auth/${encodeURIComponent(requestId)}`),
    approveCliAuth: (requestId, userCode) =>
      request<CliAuthApproval>('POST', '/v1/cli/auth/approve', {
        requestId,
        ...(userCode !== undefined ? { userCode } : {}),
      }),
  }
}

/**
 * Build a {@link DashboardApiError} from a non-2xx response, preferring the uniform
 * `{ error: { code, message } }` envelope and falling back to the status text. Only
 * the response is inspected — never the request — so no token can leak.
 */
async function errorFromResponse(response: Response): Promise<DashboardApiError> {
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
  return new DashboardApiError(text, response.status, code)
}

/**
 * Merge freshly-fetched pending events into the client-side list, de-duplicating by
 * `id` and returning newest-first. An event already held is **kept** — the inbox
 * only ever drops an event on an explicit ack, never because the `since` cursor moved
 * past it — while a re-fetched copy refreshes its fields.
 */
export function mergePending(
  existing: AttentionRecord[],
  incoming: AttentionRecord[],
): AttentionRecord[] {
  const byId = new Map<string, AttentionRecord>()
  for (const event of existing) byId.set(event.id, event)
  for (const event of incoming) byId.set(event.id, event)
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt)
}
