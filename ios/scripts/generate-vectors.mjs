#!/usr/bin/env node
/**
 * generate-vectors.mjs — regenerate the PherryKit conformance vectors from the BUILT TypeScript
 * dists.
 *
 * This is the cross-implementation bridge: it drives the *reference* wire (`@pherry/channel`,
 * `@pherry/relay-core`, `@pherry/protocol`) — the exact code the CLI/host/control-plane run — over
 * fixed, deterministic inputs and writes the resulting bytes as JSON vectors the Swift tests
 * consume. If PherryKit ever diverges from the TS wire by a single byte, `swift test` fails.
 *
 * It is a plain Node ESM script (NOT a workspace member, no package.json): it deep-imports the
 * compiled `dist/*.js` by relative path, and reaches `@noble` (for raw x25519 and the ChaCha
 * primitives) through `module.createRequire` anchored inside `packages/channel`, so pnpm's
 * symlinks resolve.
 *
 * Prereq: the TS packages must be built (`pnpm -r build` from the repo root) so the `dist/`
 * folders exist. Deterministic + idempotent: fixed inputs only, no randomness — re-running
 * produces byte-identical files.
 *
 * Usage:  node ios/scripts/generate-vectors.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

// Deep-import the built TS dists (the reference implementation).
const { deriveSessionKeys } = await import(
  resolve(repoRoot, 'packages/channel/dist/kdf.js')
)
const { Sealer } = await import(resolve(repoRoot, 'packages/channel/dist/record.js'))
const { relayChannelContext } = await import(
  resolve(repoRoot, 'packages/relay-core/dist/context.js')
)
const { encodeOuterMessage } = await import(
  resolve(repoRoot, 'packages/relay-core/dist/outer-frame.js')
)
const { encodePtyFrame, decodePtyFrame } = await import(
  resolve(repoRoot, 'protocol/dist/pty-frame.js')
)

// Reach @noble through pnpm's symlinks, anchored inside packages/channel.
const channelRequire = createRequire(resolve(repoRoot, 'packages/channel/package.json'))
const { x25519 } = channelRequire('@noble/curves/ed25519.js')
const { sha256 } = channelRequire('@noble/hashes/sha256.js')
const { xchacha20poly1305, hchacha } = channelRequire('@noble/ciphers/chacha.js')

// --- helpers ----------------------------------------------------------------

const hex = (bytes) => Buffer.from(bytes).toString('hex')
const enc = new TextEncoder()

/** Fixed 32-byte pattern from a seed byte (deterministic, non-random). */
const fixed32 = (seed) => Uint8Array.from({ length: 32 }, (_, i) => (seed + i) & 0xff)

/** u32 big-endian length prefix. */
function u32be(n) {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
}

/** Independent HChaCha20 (validated below against @noble's `hchacha`). */
function hchacha20(key, in16) {
  const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0
  const le = (u8, o) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0
  const s = new Uint32Array(16)
  s[0] = 0x61707865
  s[1] = 0x3320646e
  s[2] = 0x79622d32
  s[3] = 0x6b206574
  for (let i = 0; i < 8; i++) s[4 + i] = le(key, i * 4)
  for (let i = 0; i < 4; i++) s[12 + i] = le(in16, i * 4)
  const qr = (a, b, c, d) => {
    s[a] = (s[a] + s[b]) >>> 0
    s[d] = rotl(s[d] ^ s[a], 16)
    s[c] = (s[c] + s[d]) >>> 0
    s[b] = rotl(s[b] ^ s[c], 12)
    s[a] = (s[a] + s[b]) >>> 0
    s[d] = rotl(s[d] ^ s[a], 8)
    s[c] = (s[c] + s[d]) >>> 0
    s[b] = rotl(s[b] ^ s[c], 7)
  }
  for (let r = 0; r < 10; r++) {
    qr(0, 4, 8, 12)
    qr(1, 5, 9, 13)
    qr(2, 6, 10, 14)
    qr(3, 7, 11, 15)
    qr(0, 5, 10, 15)
    qr(1, 6, 11, 12)
    qr(2, 7, 8, 13)
    qr(3, 4, 9, 14)
  }
  const words = [s[0], s[1], s[2], s[3], s[12], s[13], s[14], s[15]]
  const out = new Uint8Array(32)
  const dv = new DataView(out.buffer)
  words.forEach((w, i) => dv.setUint32(i * 4, w >>> 0, true))
  return out
}

/** Cross-check our HChaCha20 against @noble's low-level `hchacha`. */
function nobleHChaCha20(key, in16) {
  const le = (u8, o) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0
  const toU32 = (u8) => Uint32Array.from({ length: u8.length / 4 }, (_, i) => le(u8, i * 4))
  const sigma = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574])
  const o32 = new Uint32Array(8)
  hchacha(sigma, toU32(key), toU32(in16), o32)
  const out = new Uint8Array(32)
  const dv = new DataView(out.buffer)
  o32.forEach((w, i) => dv.setUint32(i * 4, w >>> 0, true))
  return out
}

// --- vector builders --------------------------------------------------------

function buildHandshake() {
  const eI = fixed32(1)
  const eR = fixed32(100)
  const sR = fixed32(200)
  const eIpub = x25519.getPublicKey(eI)
  const eRpub = x25519.getPublicKey(eR)
  const sRpub = x25519.getPublicKey(sR)
  const dhEE = x25519.getSharedSecret(eI, eRpub)
  const dhES = x25519.getSharedSecret(eI, sRpub)

  const contexts = [
    { description: 'no context (absent)', context: undefined },
    { description: 'empty context', context: new Uint8Array(0) },
    {
      description: 'relayChannelContext(host_sample, tkt_sample)',
      context: relayChannelContext(
        'host_00000000000000000000000000000001',
        'tkt_0000000000000000000000000000abcd'
      ),
    },
  ]

  const cases = contexts.map(({ description, context }) => {
    const salt = sha256(
      concatAll([enc.encode('pherry/channel/v1/salt'), eIpub, eRpub, context ?? new Uint8Array(0)])
    )
    const keys = deriveSessionKeys({
      dhEE,
      dhES,
      initiatorEphemeralPub: eIpub,
      responderEphemeralPub: eRpub,
      ...(context !== undefined ? { context } : {}),
    })
    return {
      description,
      contextHex: context === undefined ? null : hex(context),
      saltHex: hex(salt),
      keyI2R: hex(keys.keyI2R),
      keyR2I: hex(keys.keyR2I),
      sessionId: hex(keys.sessionId),
    }
  })

  return {
    description: 'X25519 + HKDF-SHA256 key schedule, fixed keypairs, ± context',
    eI_secret: hex(eI),
    eR_secret: hex(eR),
    sR_secret: hex(sR),
    eI_pub: hex(eIpub),
    eR_pub: hex(eRpub),
    sR_pub: hex(sRpub),
    dhEE: hex(dhEE),
    dhES: hex(dhES),
    cases,
  }
}

function concatAll(arrays) {
  let total = 0
  for (const a of arrays) total += a.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const a of arrays) {
    out.set(a, offset)
    offset += a.length
  }
  return out
}

function buildRecords() {
  const key = fixed32(7)
  const sessionId = fixed32(50)
  // A sequence of frame plaintexts (already `tag(1) || payload` bytes at the channel layer, but
  // the record layer treats them as opaque). Same sequence sealed under each direction.
  const plaintexts = [
    new Uint8Array(0),
    enc.encode('hello'),
    Uint8Array.from({ length: 64 }, (_, i) => i & 0xff),
    enc.encode('the quick brown fox jumps over the lazy dog'),
  ]

  const directions = [
    { name: 'initiatorToResponder', byte: 0x00 },
    { name: 'responderToInitiator', byte: 0x01 },
  ]

  const perDirection = directions.map(({ name, byte }) => {
    const sealer = new Sealer(key, sessionId, byte)
    const records = plaintexts.map((pt, counter) => {
      const record = sealer.seal(pt)
      const wire = concatAll([u32be(record.length), record])
      return { counter, plaintextHex: hex(pt), recordHex: hex(record), wireHex: hex(wire) }
    })
    return { direction: name, directionByte: byte, records }
  })

  return {
    description:
      'record layer: XChaCha20-Poly1305 seal per counter (no AAD), wire = u32_BE(len) || record',
    keyHex: hex(key),
    sessionIdHex: hex(sessionId),
    directions: perDirection,
  }
}

function buildXChaCha() {
  const cases = [
    { description: 'empty plaintext', key: fixed32(11), nonce: fixed24(0), pt: new Uint8Array(0) },
    { description: 'short plaintext', key: fixed32(12), nonce: fixed24(9), pt: enc.encode('pherry') },
    {
      description: '64-byte plaintext',
      key: fixed32(13),
      nonce: fixed24(0x40),
      pt: Uint8Array.from({ length: 64 }, (_, i) => (255 - i) & 0xff),
    },
  ].map(({ description, key, nonce, pt }) => {
    const out = xchacha20poly1305(key, nonce).encrypt(pt)
    return {
      description,
      keyHex: hex(key),
      nonce24Hex: hex(nonce),
      plaintextHex: hex(pt),
      ciphertextHex: hex(out), // ciphertext || 16-byte tag
    }
  })
  return { description: 'XChaCha20-Poly1305 seal (no AAD), via @noble/ciphers', cases }
}

function fixed24(seed) {
  return Uint8Array.from({ length: 24 }, (_, i) => (seed + i) & 0xff)
}

function buildHChaCha() {
  const cases = [
    { description: 'sequential key/input', key: fixed32(0), in16: fixed16(0x10) },
    { description: 'high-byte key/input', key: fixed32(0x80), in16: fixed16(0xa0) },
  ].map(({ description, key, in16 }) => {
    const mine = hchacha20(key, in16)
    const noble = nobleHChaCha20(key, in16)
    if (hex(mine) !== hex(noble)) {
      throw new Error(`hchacha mismatch for "${description}": ${hex(mine)} != ${hex(noble)}`)
    }
    return { description, keyHex: hex(key), input16Hex: hex(in16), subkeyHex: hex(mine) }
  })
  return { description: 'HChaCha20 subkey derivation (cross-checked vs @noble hchacha)', cases }
}

function fixed16(seed) {
  return Uint8Array.from({ length: 16 }, (_, i) => (seed + i) & 0xff)
}

function buildContext() {
  const pairs = [
    { hostId: 'host_00000000000000000000000000000001', ticket: 'tkt_0000000000000000000000000000abcd' },
    { hostId: 'host_ffffffffffffffffffffffffffffffff', ticket: 'tkt_ffffffffffffffffffffffffffffffff' },
    { hostId: 'host_a1b2c3', ticket: 'tkt_deadbeef' },
  ].map(({ hostId, ticket }) => ({
    description: `${hostId} / ${ticket}`,
    hostId,
    ticket,
    contextHex: hex(relayChannelContext(hostId, ticket)),
  }))
  return { description: 'relayChannelContext(hostId, ticket)', cases: pairs }
}

function buildPtyFrames() {
  const frames = [
    { description: 'output', opcode: 1, streamId: 1, seq: 0, payload: enc.encode('$ ls\r\n') },
    { description: 'snapshotStart size', opcode: 2, streamId: 7, seq: 3, payload: sizePayload(120, 40) },
    { description: 'snapshotChunk', opcode: 3, streamId: 7, seq: 4, payload: enc.encode('\x1b[2Jscreen') },
    { description: 'snapshotEnd', opcode: 4, streamId: 7, seq: 5, payload: new Uint8Array(0) },
    { description: 'resized', opcode: 5, streamId: 7, seq: 6, payload: sizePayload(80, 24) },
    { description: 'ended exit 0', opcode: 6, streamId: 7, seq: 7, payload: exitPayload(0) },
    { description: 'ended exit 137', opcode: 6, streamId: 7, seq: 8, payload: exitPayload(137) },
    { description: 'ended signalled (null)', opcode: 6, streamId: 7, seq: 9, payload: new Uint8Array(0) },
    { description: 'gap', opcode: 7, streamId: 7, seq: 10, payload: new Uint8Array(0) },
    {
      description: 'large seq (u64 high word)',
      opcode: 1,
      streamId: 0xdeadbeef,
      seq: 0x1_0000_0002,
      payload: enc.encode('x'),
    },
  ].map((f) => {
    const bytes = encodePtyFrame({
      opcode: f.opcode,
      streamId: f.streamId,
      seq: f.seq,
      payload: f.payload,
    })
    // Sanity: round-trip through the reference decoder.
    const back = decodePtyFrame(bytes)
    if (!back || back.opcode !== f.opcode || back.streamId !== f.streamId || back.seq !== f.seq) {
      throw new Error(`pty frame round-trip failed for "${f.description}"`)
    }
    return {
      description: f.description,
      opcode: f.opcode,
      streamId: f.streamId,
      seq: f.seq,
      payloadHex: hex(f.payload),
      encodedHex: hex(bytes),
    }
  })

  // Undecodable byte strings: the reference decoder returns null.
  const undecodable = [
    { description: 'too short (8 bytes)', bytesHex: hex(new Uint8Array(8)) },
    {
      description: 'bad magic',
      bytesHex: hex(Uint8Array.from({ length: 16 }, (_, i) => (i === 0 ? 0x75 : 0))),
    },
    {
      description: 'bad version',
      bytesHex: hex(Uint8Array.from({ length: 16 }, (_, i) => (i === 0 ? 0x74 : i === 1 ? 0x02 : 0))),
    },
  ].map((c) => {
    const decoded = decodePtyFrame(Buffer.from(c.bytesHex, 'hex'))
    if (decoded !== null) throw new Error(`expected null decode for "${c.description}"`)
    return c
  })

  return { description: 'PTY frame codec (16-byte LE header)', frames, undecodable }
}

function sizePayload(cols, rows) {
  const out = new Uint8Array(4)
  const dv = new DataView(out.buffer)
  dv.setUint16(0, cols, true)
  dv.setUint16(2, rows, true)
  return out
}

function exitPayload(code) {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setInt32(0, code, true)
  return out
}

function buildOuterFrames() {
  const ticket = 'tkt_0000000000000000000000000000abcd'
  const messages = [
    { description: 'data-auth (controller)', message: { t: 'data-auth', role: 'controller', ticket } },
    { description: 'data-ready', message: { t: 'data-ready' } },
    { description: 'close bad-ticket', message: { t: 'close', code: 'bad-ticket' } },
    { description: 'close drained with reason', message: { t: 'close', code: 'drained', reason: 'cell draining' } },
  ].map(({ description, message }) => ({
    description,
    json: JSON.stringify(message),
    framedHex: hex(encodeOuterMessage(message)),
  }))

  // A coalesced stream: the data-ready frame immediately followed by trailing raw channel bytes
  // in a single chunk — exercises the leftover handoff to the raw phase.
  const dataReadyFramed = encodeOuterMessage({ t: 'data-ready' })
  const rawTail = Uint8Array.from({ length: 40 }, (_, i) => (i * 7) & 0xff)
  const coalesced = concatAll([dataReadyFramed, rawTail])

  return {
    description: 'outer coordination framing (u32_BE(len) || UTF-8 JSON, 16 KiB cap)',
    messages,
    coalesced: {
      description: 'data-ready frame + trailing raw channel bytes in one chunk',
      chunkHex: hex(coalesced),
      rawTailHex: hex(rawTail),
    },
  }
}

// --- IRTF draft-irtf-cfrg-xchacha reference vectors (for a hardcoded Swift test too) ----------

function buildIRTF() {
  // HChaCha20 test vector (Section 2.2.1).
  const hKey = Uint8Array.from({ length: 32 }, (_, i) => i)
  const hIn = Uint8Array.of(
    0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x4a, 0x00, 0x00, 0x00, 0x00, 0x31, 0x41, 0x59, 0x27
  )
  const hExpect = '82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc'
  const hActual = hex(hchacha20(hKey, hIn))
  if (hActual !== hExpect) throw new Error(`IRTF HChaCha20 mismatch: ${hActual}`)

  // XChaCha20-Poly1305 AEAD test vector (Appendix A.3.1) — this one authenticates AAD.
  const aKey = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i)
  const aIv = Uint8Array.from({ length: 24 }, (_, i) => 0x40 + i)
  const aAad = Uint8Array.of(0x50, 0x51, 0x52, 0x53, 0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7)
  const aPt = enc.encode(
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it."
  )
  const aExpect =
    'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b4522f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff921f9664c97637da9768812f615c68b13b52ec0875924c1c7987947deafd8780acf49'
  const aActual = hex(xchacha20poly1305(aKey, aIv, aAad).encrypt(aPt))
  if (aActual !== aExpect) throw new Error(`IRTF XChaCha20-Poly1305 mismatch: ${aActual}`)

  return {
    description: 'IRTF draft-irtf-cfrg-xchacha reference vectors',
    hchacha20: { keyHex: hex(hKey), input16Hex: hex(hIn), subkeyHex: hExpect },
    xchacha20poly1305Aead: {
      keyHex: hex(aKey),
      nonce24Hex: hex(aIv),
      aadHex: hex(aAad),
      plaintextHex: hex(aPt),
      ciphertextHex: aExpect, // ciphertext || 16-byte tag
    },
  }
}

// --- write ------------------------------------------------------------------

const outDir = resolve(here, '..', 'PherryKit', 'Tests', 'PherryKitTests', 'Vectors')
mkdirSync(outDir, { recursive: true })

const files = {
  'handshake.json': buildHandshake(),
  'records.json': buildRecords(),
  'xchacha.json': buildXChaCha(),
  'hchacha.json': buildHChaCha(),
  'context.json': buildContext(),
  'pty-frames.json': buildPtyFrames(),
  'outer-frames.json': buildOuterFrames(),
  'irtf.json': buildIRTF(),
}

for (const [name, value] of Object.entries(files)) {
  const path = resolve(outDir, name)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  console.log(`wrote ${path}`)
}

console.log(`\n${Object.keys(files).length} vector files regenerated under ${outDir}`)
