/**
 * The authorizer seam — how a cell resolves identity and routing without knowing
 * how they were issued.
 *
 * Real issuance and authorization (which user/org may reach which host, how a
 * ticket is minted and scoped) is the **control plane's** job (leg P2b). P2a
 * keeps the cell testable standalone by injecting a {@link RelayAuthorizer}: a
 * pure lookup that answers two questions — what is a host's registered static
 * public key, and what does a ticket route to. Tests supply an in-memory
 * implementation.
 *
 * Two enforcement layers, kept deliberately separate:
 * - the **authorizer** *resolves* — it maps a hostId to a static public key and a
 *   ticket to a {@link TicketRecord}, or returns `null` when it does not know;
 * - the **cell** *enforces* — using the injected clock it rejects an expired
 *   ticket, and using its own used-ticket set it rejects a reused one. Expiry and
 *   one-time use are the cell's runtime policy, not the authorizer's; the
 *   authorizer only states the facts (`hostId`, `expiresAt`).
 */

/** What a ticket routes to. */
export interface TicketRecord {
  /** The host this ticket reaches. */
  readonly hostId: string
  /** The ticket's expiry, as epoch milliseconds; the cell enforces it against its clock. */
  readonly expiresAt: number
}

/** Resolves relay identity and routing for a cell. Every method may be sync or async. */
export interface RelayAuthorizer {
  /**
   * The channel static **public** key registered for `hostId`, or `null` if the
   * host is unknown. The cell verifies a host proof against this key.
   */
  hostStaticPublicKey(hostId: string): Promise<Uint8Array | null> | Uint8Array | null
  /**
   * Resolve `ticket` to its routing record, or `null` if the ticket is unknown.
   * The cell separately enforces expiry (against {@link TicketRecord.expiresAt})
   * and one-time use.
   */
  resolveTicket(ticket: string): Promise<TicketRecord | null> | TicketRecord | null
}
