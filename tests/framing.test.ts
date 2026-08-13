import { describe, expect, it } from 'vitest'

import { encodeFrame, FrameDecoder } from '../src/adapters/transport/framing.ts'
import { PeerError } from '../src/domain/errors.ts'

describe('FrameDecoder', () => {
  it('decodes one whole frame', () => {
    const decoder = new FrameDecoder()
    expect(decoder.push(encodeFrame({ a: 1 }))).toEqual([{ a: 1 }])
  })

  it('yields nothing until a frame is terminated', () => {
    const decoder = new FrameDecoder()
    expect(decoder.push('{"a":')).toEqual([])
    expect(decoder.push('1}\n')).toEqual([{ a: 1 }])
  })

  it('reassembles a frame split across arbitrary chunk boundaries', () => {
    const decoder = new FrameDecoder()
    const wire = encodeFrame({ body: 'hello world', n: 2 })
    const out: unknown[] = []
    for (const char of wire) out.push(...decoder.push(char))
    expect(out).toEqual([{ body: 'hello world', n: 2 }])
  })

  it('returns every frame completed by one chunk', () => {
    const decoder = new FrameDecoder()
    const chunk = encodeFrame({ n: 1 }) + encodeFrame({ n: 2 }) + encodeFrame({ n: 3 })
    expect(decoder.push(chunk)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it('ignores blank lines', () => {
    expect(new FrameDecoder().push('\n\n{"a":1}\n\n')).toEqual([{ a: 1 }])
  })

  it('rejects a frame that is not JSON', () => {
    expect(() => new FrameDecoder().push('not json\n')).toThrow(PeerError)
  })

  it('bounds the buffer so an unterminated stream cannot exhaust memory', () => {
    const decoder = new FrameDecoder(64)
    expect(() => decoder.push('x'.repeat(65))).toThrowError(/exceeded 64 bytes/)
  })

  it('drops the oversized buffer instead of retaining it', () => {
    const decoder = new FrameDecoder(64)
    expect(() => decoder.push('x'.repeat(65))).toThrow()
    // The decoder is reusable and did not keep the discarded text.
    expect(decoder.push(encodeFrame({ ok: true }))).toEqual([{ ok: true }])
  })
})
