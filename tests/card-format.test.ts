import { describe, expect, it } from 'vitest'

import { accentHue, clockTime, displayName, monogram } from '../src/client/card-format.ts'
import type { PeerMessage } from '../src/client/peer-message.ts'

const peer = (extra: Partial<PeerMessage> = {}): PeerMessage => ({
  sessionId: 'session-895ace79-1f2b',
  external: false,
  ...extra,
})

describe('displayName', () => {
  it('prefers the name the sender published', () => {
    expect(displayName(peer({ name: 'payments-api' }))).toBe('payments-api')
  })

  it('falls back to the identity a reply would be addressed to', () => {
    // Not a friendly invention: the reader may have to act on this identity.
    expect(displayName(peer())).toBe('session-')
  })
})

describe('monogram', () => {
  it('takes initials from a name that divides into words', () => {
    expect(monogram('payments api')).toBe('PA')
    expect(monogram('checkout-client')).toBe('CC')
    expect(monogram('docs.site')).toBe('DS')
  })

  it('takes the first two characters of a single word', () => {
    expect(monogram('alpha')).toBe('AL')
  })

  it('never renders empty', () => {
    expect(monogram('')).toBe('?')
    expect(monogram('   ')).toBe('?')
  })
})

describe('accentHue', () => {
  it('gives one session the same colour every time', () => {
    expect(accentHue('session-a')).toBe(accentHue('session-a'))
  })

  it('is derived from the id, so a retitled session keeps its colour', () => {
    expect(accentHue('session-a')).not.toBe(accentHue('session-b'))
  })

  it('stays a usable hue', () => {
    for (const id of ['a', 'session-b', 'a2a:remote-agent', '']) {
      const hue = accentHue(id)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThanOrEqual(360)
    }
  })
})

describe('clockTime', () => {
  it('pads to a stable width so a column of times lines up', () => {
    const at = new Date(2026, 0, 1, 9, 5).getTime()
    expect(clockTime(at)).toBe('09:05')
  })
})
