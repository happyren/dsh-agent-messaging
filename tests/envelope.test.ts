import { describe, expect, it } from 'vitest'

import {
  createEnvelope,
  MAX_BODY_CHARS,
  parseEnvelope,
  PROTOCOL_VERSION,
  type EnvelopeDraft,
} from '../src/domain/envelope.ts'
import { PeerError } from '../src/domain/errors.ts'

const draft: EnvelopeDraft = {
  id: 'msg-1',
  sentAt: 1_700_000_000_000,
  from: { sessionId: 'session-a', name: 'alpha', cwd: '/repo/a' },
  to: 'session-b',
  mode: 'followup',
  body: '  migration finished  ',
}

describe('createEnvelope', () => {
  it('trims the body and freezes the result', () => {
    const envelope = createEnvelope(draft)
    expect(envelope.body).toBe('migration finished')
    expect(envelope.protocol).toBe(PROTOCOL_VERSION)
    expect(Object.isFrozen(envelope)).toBe(true)
    expect(Object.isFrozen(envelope.from)).toBe(true)
  })

  it('omits replyTo rather than storing undefined', () => {
    expect('replyTo' in createEnvelope(draft)).toBe(false)
    expect(createEnvelope({ ...draft, replyTo: 'msg-0' }).replyTo).toBe('msg-0')
  })

  it('rejects an empty or whitespace-only body', () => {
    expect(() => createEnvelope({ ...draft, body: '   ' })).toThrow(PeerError)
    expect(() => createEnvelope({ ...draft, body: '' })).toThrowError(/empty/i)
  })

  it('rejects a body over the size bound', () => {
    const oversized = 'x'.repeat(MAX_BODY_CHARS + 1)
    expect(() => createEnvelope({ ...draft, body: oversized })).toThrowError(/limit is/)
  })

  it('rejects a session addressing itself', () => {
    expect(() => createEnvelope({ ...draft, to: 'session-a' })).toThrowError(/cannot message itself/)
  })
})

describe('parseEnvelope', () => {
  it('round-trips a valid envelope through JSON', () => {
    const original = createEnvelope(draft)
    const parsed = parseEnvelope(JSON.parse(JSON.stringify(original)))
    expect(parsed).toEqual(original)
  })

  it('rejects a foreign protocol version', () => {
    const wire = { ...createEnvelope(draft), protocol: 99 }
    expect(() => parseEnvelope(wire)).toThrowError(/Unsupported envelope protocol 99/)
  })

  it.each([
    ['a non-object', 'nope'],
    ['a missing id', { ...createEnvelope(draft), id: undefined }],
    ['a non-string body', { ...createEnvelope(draft), body: 42 }],
    ['a bad mode', { ...createEnvelope(draft), mode: 'shout' }],
    ['a negative timestamp', { ...createEnvelope(draft), sentAt: -1 }],
    ['a missing sender', { ...createEnvelope(draft), from: null }],
  ])('rejects %s', (_label, wire) => {
    expect(() => parseEnvelope(wire)).toThrow(PeerError)
  })

  it('applies the same body bound to wire input as to local input', () => {
    const wire = { ...createEnvelope(draft), body: 'y'.repeat(MAX_BODY_CHARS + 1) }
    expect(() => parseEnvelope(wire)).toThrowError(/limit is/)
  })
})
