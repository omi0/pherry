/**
 * The control-plane HTTP authorizer — the concrete {@link RelayAuthorizer} the
 * deployed cell injects. It is the relay's **only** contact with the control-plane
 * world: it speaks the thin internal HTTP API (`/internal/relay/*`) over a shared
 * secret and knows nothing of Postgres, Clerk, or tenancy. The cell stays blind —
 * it sees ciphertext plus the routing facts these two calls return.
 *
 * Both methods **fail closed**: any transport error, non-`200` status, or
 * malformed body resolves to `null` (never a thrown exception into the cell), so a
 * control-plane hiccup refuses connections rather than crashing the relay or
 * leaking a bridge.
 */
import { decodeKey } from '@pherry/channel'
import type { RelayAuthorizer, TicketRecord } from '@pherry/relay-core'
import { z } from 'zod'

/** How {@link makeHttpAuthorizer} reaches the control plane. */
export interface HttpAuthorizerOptions {
  /** The control plane's base URL (a trailing slash is tolerated). */
  readonly controlPlaneUrl: string
  /** The shared secret sent as `x-internal-key` on every internal call. */
  readonly internalApiKey: string
  /** The `fetch` implementation to use; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch
}

/**
 * The subset of `POST /internal/relay/validate-ticket`'s 200 body this authorizer
 * needs to fill a relay-core {@link TicketRecord}. Extra fields (`orgId`,
 * `hostPublicKeyB64`) are ignored.
 */
const ValidateTicketResponse = z.object({
  hostId: z.string().min(1),
  expiresAt: z.number(),
})

/** The `POST /internal/relay/host-key` 200 body: the host's pinned static key. */
const HostKeyResponse = z.object({
  hostPublicKeyB64: z.string().min(1),
})

/**
 * Build a {@link RelayAuthorizer} backed by the control plane's internal API.
 *
 * ⚠️ **`resolveTicket` CONSUMES the ticket at the control plane.** The internal
 * validate endpoint resolves through a Redis `GETDEL`, so a ticket resolved once
 * — at this cell or any other — is dead everywhere afterward. The cell's own
 * used-ticket set is only a local backstop; the global one-time guarantee lives at
 * the control plane, not here.
 */
export function makeHttpAuthorizer(options: HttpAuthorizerOptions): RelayAuthorizer {
  const base = options.controlPlaneUrl.replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? fetch

  /** POST `body` as JSON to an internal path; `null` on any transport failure. */
  const post = async (path: string, body: unknown): Promise<Response | null> => {
    try {
      return await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-key': options.internalApiKey,
        },
        body: JSON.stringify(body),
      })
    } catch {
      // Network / DNS / abort: fail closed rather than throw into the cell.
      return null
    }
  }

  /** Parse a response's JSON against `schema`, or `null` on non-200 / malformed body. */
  const parseJson = async <T extends z.ZodTypeAny>(
    response: Response | null,
    schema: T,
  ): Promise<z.infer<T> | null> => {
    if (response === null || response.status !== 200) return null
    let json: unknown
    try {
      json = await response.json()
    } catch {
      return null
    }
    const result = schema.safeParse(json)
    return result.success ? result.data : null
  }

  return {
    async resolveTicket(ticket: string): Promise<TicketRecord | null> {
      const body = await parseJson(
        await post('/internal/relay/validate-ticket', { ticket }),
        ValidateTicketResponse,
      )
      if (body === null) return null
      return { hostId: body.hostId, expiresAt: body.expiresAt }
    },
    async hostStaticPublicKey(hostId: string): Promise<Uint8Array | null> {
      const body = await parseJson(
        await post('/internal/relay/host-key', { hostId }),
        HostKeyResponse,
      )
      if (body === null) return null
      try {
        return decodeKey(body.hostPublicKeyB64)
      } catch {
        return null
      }
    },
  }
}
