import { describe, expect, it } from 'vitest'
import {
  ERROR_CODES,
  ErrorCode,
  ResponseFrame,
  RpcRequest,
  failure,
  newRequestId,
  success,
} from '../src/index.js'

describe('envelope', () => {
  it('validates a request with and without params', () => {
    expect(RpcRequest.safeParse({ id: '1', method: 'session.input' }).success).toBe(true)
    expect(
      RpcRequest.safeParse({ id: '1', method: 'session.input', params: { a: 1 } }).success,
    ).toBe(true)
    expect(RpcRequest.safeParse({ id: '', method: 'x' }).success).toBe(false)
  })

  it('builds and parses a success frame', () => {
    const frame = success('req-1', { streamId: 3 })
    expect(frame).toEqual({ id: 'req-1', ok: true, result: { streamId: 3 } })
    expect(ResponseFrame.parse(frame).ok).toBe(true)
  })

  it('sets stream:true only when requested', () => {
    expect(success('r', {}).stream).toBeUndefined()
    expect(success('r', {}, { stream: true }).stream).toBe(true)
  })

  it('builds and parses a failure frame, with and without data', () => {
    const f1 = failure('r', ErrorCode.NotFound, 'gone')
    expect(f1).toEqual({ id: 'r', ok: false, error: { code: 'NOT_FOUND', message: 'gone' } })
    const f2 = failure('r', ErrorCode.InvalidArgument, 'bad', { field: 'cols' })
    expect(f2.error.data).toEqual({ field: 'cols' })
    expect(ResponseFrame.parse(f1).ok).toBe(false)
    expect(ResponseFrame.parse(f2).ok).toBe(false)
  })

  it('discriminates the response union on ok', () => {
    const ok = ResponseFrame.parse({ id: 'a', ok: true, result: 1 })
    if (ok.ok) {
      expect(ok.result).toBe(1)
    } else {
      throw new Error('expected success')
    }
    const err = ResponseFrame.parse({
      id: 'a',
      ok: false,
      error: { code: 'INTERNAL', message: 'boom' },
    })
    if (err.ok) {
      throw new Error('expected failure')
    }
    expect(err.error.code).toBe('INTERNAL')
  })

  it('accepts every declared error code', () => {
    for (const code of ERROR_CODES) {
      const f = failure('r', code, 'x')
      expect(ResponseFrame.parse(f).ok).toBe(false)
    }
  })

  it('rejects an unknown error code', () => {
    expect(
      ResponseFrame.safeParse({
        id: 'r',
        ok: false,
        error: { code: 'NOPE', message: 'x' },
      }).success,
    ).toBe(false)
  })

  it('mints unique request ids', () => {
    expect(newRequestId()).not.toBe(newRequestId())
  })
})
