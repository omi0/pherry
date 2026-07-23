import { generateKeyPair } from '@pherry/channel'
import { describe, expect, it } from 'vitest'
import {
  type HostChallengeSecret,
  cellDataAuthKey,
  dataAuthMac,
  hostDataAuthKey,
  makeChallenge,
  newTicket,
  proveHost,
  verifyDataAuthMac,
  verifyProof,
  wipeChallenge,
} from '../src/index.js'

const HOST_ID = 'host_alpha'
const CELL_ID = 'cell_one'

/** A deterministic 32-byte bridge nonce for the data-leg tests. */
const nonce = (fill: number): Uint8Array => new Uint8Array(32).fill(fill)

describe('host proof', () => {
  it('a proof from the real static key verifies', () => {
    const host = generateKeyPair()
    const challenge = makeChallenge(CELL_ID)
    const mac = proveHost(challenge, HOST_ID, host)
    expect(verifyProof(challenge, HOST_ID, host.publicKey, mac)).toBe(true)
  })

  it('a proof from a different static key is rejected', () => {
    const host = generateKeyPair()
    const impostor = generateKeyPair()
    const challenge = makeChallenge(CELL_ID)
    // The impostor answers with its own secret; verified against the real pubkey.
    const mac = proveHost(challenge, HOST_ID, impostor)
    expect(verifyProof(challenge, HOST_ID, host.publicKey, mac)).toBe(false)
  })

  it('a fresh challenge uses a fresh nonce and ephemeral each time', () => {
    const a = makeChallenge(CELL_ID)
    const b = makeChallenge(CELL_ID)
    expect(a.nonce).not.toEqual(b.nonce)
    expect(a.cellEphemeralPub).not.toEqual(b.cellEphemeralPub)
  })

  it('an old proof cannot be replayed against a new challenge', () => {
    const host = generateKeyPair()
    const first = makeChallenge(CELL_ID)
    const mac = proveHost(first, HOST_ID, host)
    const second = makeChallenge(CELL_ID)
    expect(verifyProof(second, HOST_ID, host.publicKey, mac)).toBe(false)
  })

  describe('transcript binding — tampering any bound field fails verification', () => {
    const host = generateKeyPair()
    const challenge = makeChallenge(CELL_ID)
    const mac = proveHost(challenge, HOST_ID, host)

    it('a different hostId fails', () => {
      expect(verifyProof(challenge, 'host_other', host.publicKey, mac)).toBe(false)
    })

    it('a different cellId fails', () => {
      const tampered: HostChallengeSecret = { ...challenge, cellId: 'cell_evil' }
      expect(verifyProof(tampered, HOST_ID, host.publicKey, mac)).toBe(false)
    })

    it('a tampered nonce fails', () => {
      const nonce = challenge.nonce.slice()
      nonce[0] ^= 0xff
      const tampered: HostChallengeSecret = { ...challenge, nonce }
      expect(verifyProof(tampered, HOST_ID, host.publicKey, mac)).toBe(false)
    })

    it('a swapped cell ephemeral fails', () => {
      const other = makeChallenge(CELL_ID)
      const tampered: HostChallengeSecret = {
        ...challenge,
        cellEphemeralPub: other.cellEphemeralPub,
        cellEphemeralSecret: other.cellEphemeralSecret,
      }
      expect(verifyProof(tampered, HOST_ID, host.publicKey, mac)).toBe(false)
    })
  })

  it('wipeChallenge zero-fills the ephemeral secret (best-effort hygiene)', () => {
    const challenge = makeChallenge(CELL_ID)
    expect(challenge.cellEphemeralSecret.some((b) => b !== 0)).toBe(true)
    wipeChallenge(challenge)
    expect([...challenge.cellEphemeralSecret].every((b) => b === 0)).toBe(true)
  })

  it('a truncated / wrong-length MAC is rejected (constant-time compare returns false)', () => {
    const host = generateKeyPair()
    const challenge = makeChallenge(CELL_ID)
    const mac = proveHost(challenge, HOST_ID, host)
    expect(verifyProof(challenge, HOST_ID, host.publicKey, mac.slice(0, 31))).toBe(false)
    const flipped = mac.slice()
    flipped[flipped.length - 1] ^= 0x01
    expect(verifyProof(challenge, HOST_ID, host.publicKey, flipped)).toBe(false)
  })
})

describe('data-leg authentication (k_data / data-auth MAC)', () => {
  it('the host and the cell derive the same k_data from the same challenge DH', () => {
    const host = generateKeyPair()
    const challenge = makeChallenge(CELL_ID)
    const cellKey = cellDataAuthKey(challenge, host.publicKey)
    expect(cellKey).not.toBeNull()
    // Host: X25519(host_static_priv, cell_ephemeral_pub); cell: X25519(cell_ephemeral_priv, host_static_pub).
    expect(hostDataAuthKey(challenge, host)).toEqual(cellKey)
  })

  it("derives a distinct k_data from the proof key (different HKDF 'info')", () => {
    const host = generateKeyPair()
    const challenge = makeChallenge(CELL_ID)
    // The proof MAC and the data-leg MAC over the same fields must not collide: they
    // key off independently-derived secrets, so knowing one never yields the other.
    const proofMac = proveHost(challenge, HOST_ID, host)
    const dataMac = dataAuthMac(hostDataAuthKey(challenge, host), CELL_ID, newTicket(), nonce(1))
    expect(dataMac).not.toEqual(proofMac)
  })

  it("a host's data-auth MAC verifies on the cell for the same (cellId, ticket, nonce)", () => {
    const host = generateKeyPair()
    const challenge = makeChallenge(CELL_ID)
    const cellKey = cellDataAuthKey(challenge, host.publicKey)
    if (cellKey === null) throw new Error('cell could not derive k_data')
    const ticket = newTicket()
    const bridgeNonce = nonce(0x11)
    const mac = dataAuthMac(hostDataAuthKey(challenge, host), CELL_ID, ticket, bridgeNonce)
    expect(verifyDataAuthMac(cellKey, CELL_ID, ticket, bridgeNonce, mac)).toBe(true)
  })

  describe('a data-auth MAC does not verify when any bound field differs', () => {
    const host = generateKeyPair()
    const challenge = makeChallenge(CELL_ID)
    const kData = hostDataAuthKey(challenge, host) // == the cell's key (proven above)
    const ticket = newTicket()
    const bridgeNonce = nonce(0x22)
    const mac = dataAuthMac(kData, CELL_ID, ticket, bridgeNonce)

    it('a different bridge nonce fails (no fixed-nonce replay)', () => {
      expect(verifyDataAuthMac(kData, CELL_ID, ticket, nonce(0x23), mac)).toBe(false)
    })
    it('a different ticket fails', () => {
      expect(verifyDataAuthMac(kData, CELL_ID, newTicket(), bridgeNonce, mac)).toBe(false)
    })
    it('a different cellId fails', () => {
      expect(verifyDataAuthMac(kData, 'cell_evil', ticket, bridgeNonce, mac)).toBe(false)
    })
    it("a different host's k_data fails", () => {
      const other = hostDataAuthKey(makeChallenge(CELL_ID), generateKeyPair())
      expect(verifyDataAuthMac(other, CELL_ID, ticket, bridgeNonce, mac)).toBe(false)
    })
    it('a truncated MAC fails (constant-time compare returns false)', () => {
      expect(verifyDataAuthMac(kData, CELL_ID, ticket, bridgeNonce, mac.slice(0, 31))).toBe(false)
    })
  })

  it('a fresh challenge yields a fresh k_data (nonce + ephemeral both vary)', () => {
    const host = generateKeyPair()
    const a = hostDataAuthKey(makeChallenge(CELL_ID), host)
    const b = hostDataAuthKey(makeChallenge(CELL_ID), host)
    expect(a).not.toEqual(b)
  })
})
