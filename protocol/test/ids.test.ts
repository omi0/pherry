import { describe, expect, it } from 'vitest'
import {
  DeviceId,
  HostId,
  SessionRef,
  StreamId,
  makeIdSchema,
  newDeviceId,
  newHostId,
  newSessionRef,
} from '../src/index.js'

describe('ids', () => {
  it('mints ids matching <prefix>_<32 hex>', () => {
    expect(newSessionRef()).toMatch(/^sref_[0-9a-f]{32}$/)
    expect(newHostId()).toMatch(/^host_[0-9a-f]{32}$/)
    expect(newDeviceId()).toMatch(/^dev_[0-9a-f]{32}$/)
  })

  it('round-trips a minted id through its schema', () => {
    const ref = newSessionRef()
    expect(SessionRef.parse(ref)).toBe(ref)
  })

  it('rejects a wrong prefix', () => {
    expect(SessionRef.safeParse(`host_${'a'.repeat(32)}`).success).toBe(false)
  })

  it('rejects a wrong length or uppercase hex', () => {
    expect(SessionRef.safeParse(`sref_${'a'.repeat(31)}`).success).toBe(false)
    expect(SessionRef.safeParse(`sref_${'a'.repeat(33)}`).success).toBe(false)
    expect(SessionRef.safeParse(`sref_${'A'.repeat(32)}`).success).toBe(false)
  })

  it('makeIdSchema builds a matching schema', () => {
    const schema = makeIdSchema('thing')
    expect(schema.safeParse(`thing_${'0'.repeat(32)}`).success).toBe(true)
    expect(schema.safeParse('thing_nope').success).toBe(false)
  })

  it('validates StreamId as a u32', () => {
    expect(StreamId.safeParse(0).success).toBe(true)
    expect(StreamId.safeParse(0xff_ff_ff_ff).success).toBe(true)
    expect(StreamId.safeParse(-1).success).toBe(false)
    expect(StreamId.safeParse(0x1_00_00_00_00).success).toBe(false)
    expect(StreamId.safeParse(1.5).success).toBe(false)
  })

  it('distinguishes host and device ids by prefix', () => {
    expect(DeviceId.safeParse(newDeviceId()).success).toBe(true)
    expect(HostId.safeParse(newDeviceId()).success).toBe(false)
  })
})
