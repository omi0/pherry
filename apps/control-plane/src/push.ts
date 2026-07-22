/**
 * The **push seam** — outbound device push behind an injected interface, mirroring
 * the identity seam (`identity.ts`). The wire carries a device push **token** as an
 * opaque credential; APNs lives only in `adapters/apns.ts` (via `jose` + `node:http2`,
 * no SDK), and a self-hoster swaps in any {@link PushSender}. Tests inject
 * {@link FakePushSender}; APNs is never hit in tests.
 *
 * Push tokens are treated like credentials: they are **never logged and never echoed
 * in errors**. A {@link PushDelivery} reports only *whether* delivery worked and — on
 * failure — an undifferentiated reason, never the token itself.
 */

/** The failure kinds a {@link PushSender} may report, both undifferentiated of the token. */
export type PushFailure = 'bad-token' | 'unavailable'

/** One push to deliver: an alert (UserNotifications) or a voip (PushKit → CallKit). */
export interface OutboundPush {
  /** `alert` → a user-facing notification; `voip` → a PushKit wake that must ring. */
  readonly kind: 'alert' | 'voip'
  /** The device push token (an APNs alert token or a PushKit token). A credential — never logged. */
  readonly token: string
  /** The APNs JSON body (`{ aps, pherry }`) — host-authored metadata only, never session content. */
  readonly payload: Record<string, unknown>
}

/**
 * The outcome of a {@link PushSender.send}. `ok: true` shipped; `ok: false` carries an
 * **undifferentiated** reason and never the token:
 *
 * - `bad-token` — the token is dead (APNs `400`/`410`), so the push channel self-heals
 *   by clearing it from the device row.
 * - `unavailable` — a transient or unknown failure (a `5xx`, a transport throw); the
 *   token is left in place to try again on the next raise.
 */
export type PushDelivery =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PushFailure }

/** Deliver one push. Implementations must **never throw** — a failure is a {@link PushDelivery}. */
export interface PushSender {
  /** Send one push and resolve its delivery outcome. Never rejects. */
  send(push: OutboundPush): Promise<PushDelivery>
}

/**
 * A deterministic {@link PushSender} for tests — the only sender any test ever sees
 * (APNs is never hit). It records every {@link OutboundPush} in the public
 * {@link FakePushSender.sent} array and returns `{ ok: true }` unless a token has been
 * scripted to fail, via the constructor map or {@link FakePushSender.fail}.
 */
export class FakePushSender implements PushSender {
  /** Every push handed to {@link FakePushSender.send}, in call order — the assertion surface. */
  readonly sent: OutboundPush[] = []
  readonly #failures: Map<string, PushFailure>

  /** @param failures token → the reason `send` returns for it; defaults to none failing. */
  constructor(failures: Map<string, PushFailure> = new Map()) {
    this.#failures = new Map(failures)
  }

  /** Script `token` to fail with `reason` on its next (and every subsequent) send. */
  fail(token: string, reason: PushFailure): void {
    this.#failures.set(token, reason)
  }

  async send(push: OutboundPush): Promise<PushDelivery> {
    this.sent.push(push)
    const reason = this.#failures.get(push.token)
    return reason !== undefined ? { ok: false, reason } : { ok: true }
  }
}
