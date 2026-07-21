import { describe, expect, it } from 'vitest'
import { MirrorStreamAck } from '../src/index.js'

describe('MirrorStreamAck', () => {
  it('accepts a stream id and snapshot seq', () => {
    expect(MirrorStreamAck.parse({ streamId: 7, snapshotSeq: 0 })).toEqual({
      streamId: 7,
      snapshotSeq: 0,
    })
  })

  it('rejects a negative snapshot seq or a non-u32 stream id', () => {
    expect(MirrorStreamAck.safeParse({ streamId: 7, snapshotSeq: -1 }).success).toBe(false)
    expect(MirrorStreamAck.safeParse({ streamId: -1, snapshotSeq: 0 }).success).toBe(false)
  })
})
