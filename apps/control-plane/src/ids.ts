/**
 * Row-id minting for the control-plane-owned tables.
 *
 * Follows the Pherry id convention (`<prefix>_<32 lowercase hex>`, matching
 * `@pherry/protocol`'s `newHostId` / `newDeviceId`) for the entities the protocol
 * does not already name: orgs, users, pair-token rows, and session rows. Host and
 * device row ids are minted with `newHostId()` / `newDeviceId()` from the protocol
 * package — never here — so the wire and the database agree on their format.
 */
import { randomUUID } from 'node:crypto'

const hex32 = (): string => randomUUID().replace(/-/g, '')

/** Mint an org row id: `org_<32 hex>`. */
export const newOrgId = (): string => `org_${hex32()}`

/** Mint a user row id: `usr_<32 hex>`. */
export const newUserId = (): string => `usr_${hex32()}`

/** Mint a pair-token **row** id: `pt_<32 hex>` (distinct from the `pt_<40 hex>` secret). */
export const newPairTokenId = (): string => `pt_${hex32()}`

/** Mint a session row id: `ses_<32 hex>`. */
export const newSessionRowId = (): string => `ses_${hex32()}`
