import { generateKeyPair } from '@pherry/channel'
import { describe, expect, it } from 'vitest'
import {
  type HostChallengeSecret,
  makeChallenge,
  proveHost,
  verifyProof,
  wipeChallenge,
} from '../src/index.js'

const HOST_ID = 'host_alpha'
const CELL_ID = 'cell_one'

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
