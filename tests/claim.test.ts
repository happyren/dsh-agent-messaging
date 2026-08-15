import { describe, expect, it } from 'vitest'

import {
  createClaim,
  findConflicts,
  isExpired,
  normalizeResource,
  resourcesOverlap,
  type Claim,
  type ClaimDraft,
} from '../src/domain/claim.ts'
import { PeerError } from '../src/domain/errors.ts'

const MINUTE = 60_000

function claim(overrides: Partial<ClaimDraft> = {}): Claim {
  return createClaim({
    sessionId: 'session-a',
    name: 'payments-api',
    scope: 'path',
    resource: 'api/charges.ts',
    intent: 'adding tenant_id',
    now: 0,
    ttlMs: 30 * MINUTE,
    ...overrides,
  })
}

describe('normalizeResource', () => {
  it('collapses equivalent path spellings to one identity', () => {
    const forms = ['src/a.ts', './src/a.ts', 'src//a.ts', '  src/a.ts  ', '/src/a.ts']
    const normalized = new Set(forms.map((form) => normalizeResource('path', form)))
    expect([...normalized]).toEqual(['src/a.ts'])
  })

  it('lowercases and collapses whitespace in topics', () => {
    expect(normalizeResource('topic', '  Release   Notes ')).toBe('release notes')
  })

  it('rejects traversal rather than resolving it', () => {
    // Resolving would let a session claim a parent it never named.
    expect(() => normalizeResource('path', '../secrets')).toThrowError(/may not contain/)
    expect(() => normalizeResource('path', 'src/../../etc')).toThrow(PeerError)
  })

  it('rejects an empty or path-only-separators resource', () => {
    expect(() => normalizeResource('path', '   ')).toThrow(PeerError)
    expect(() => normalizeResource('path', '///')).toThrow(PeerError)
  })

  it('rejects an oversized resource', () => {
    expect(() => normalizeResource('topic', 'x'.repeat(513))).toThrowError(/exceeds/)
  })
})

describe('createClaim', () => {
  it('normalizes and freezes', () => {
    const made = claim({ resource: './api/charges.ts' })
    expect(made.resource).toBe('api/charges.ts')
    expect(Object.isFrozen(made)).toBe(true)
  })

  it('derives expiry from the supplied clock, never a real one', () => {
    const made = claim({ now: 1_000, ttlMs: 5 * MINUTE })
    expect(made.claimedAt).toBe(1_000)
    expect(made.expiresAt).toBe(1_000 + 5 * MINUTE)
  })

  it('requires an intent, so a peer can decide whether to wait', () => {
    expect(() => claim({ intent: '   ' })).toThrowError(/needs an intent/)
  })

  it('rejects a non-positive lifetime', () => {
    expect(() => claim({ ttlMs: 0 })).toThrow(PeerError)
    expect(() => claim({ ttlMs: -1 })).toThrow(PeerError)
  })
})

describe('isExpired', () => {
  it('lapses exactly at its expiry, not after', () => {
    const made = claim({ now: 0, ttlMs: 10 })
    expect(isExpired(made, 9)).toBe(false)
    expect(isExpired(made, 10)).toBe(true)
  })
})

describe('resourcesOverlap', () => {
  it('treats a directory claim as covering what is beneath it', () => {
    expect(resourcesOverlap('path', 'src', 'src/a.ts')).toBe(true)
    expect(resourcesOverlap('path', 'src/a.ts', 'src')).toBe(true)
  })

  it('does not confuse a sibling with a child', () => {
    // The prefix bug: "src/app" must not appear to contain "src/apple".
    expect(resourcesOverlap('path', 'src/app', 'src/apple')).toBe(false)
    expect(resourcesOverlap('path', 'api', 'apiv2/x.ts')).toBe(false)
  })

  it('matches identical paths', () => {
    expect(resourcesOverlap('path', 'src/a.ts', 'src/a.ts')).toBe(true)
  })

  it('does not nest topics, which have no structure to nest along', () => {
    expect(resourcesOverlap('topic', 'release', 'release notes')).toBe(false)
    expect(resourcesOverlap('topic', 'release', 'release')).toBe(true)
  })
})

describe('findConflicts', () => {
  const held = [
    claim({ sessionId: 'session-b', name: 'checkout', resource: 'client', now: 0, ttlMs: 30 * MINUTE }),
    claim({ sessionId: 'session-c', name: 'docs', resource: 'docs/api.md', now: 0, ttlMs: 10 * MINUTE }),
  ]

  it('reports a peer holding a parent directory', () => {
    const found = findConflicts(held, { scope: 'path', resource: 'client/checkout.ts' }, 'session-a', 0)
    expect(found.map((c) => c.name)).toEqual(['checkout'])
  })

  it('never conflicts with the asking session itself', () => {
    const own = [claim({ sessionId: 'session-a', resource: 'client' })]
    expect(findConflicts(own, { scope: 'path', resource: 'client/x.ts' }, 'session-a', 0)).toEqual([])
  })

  it('ignores lapsed claims', () => {
    const later = 20 * MINUTE
    const found = findConflicts(held, { scope: 'path', resource: 'docs/api.md' }, 'session-a', later)
    expect(found).toEqual([])
  })

  it('ignores a different scope with the same string', () => {
    const topics = [claim({ sessionId: 'session-b', scope: 'topic', resource: 'client' })]
    expect(findConflicts(topics, { scope: 'path', resource: 'client' }, 'session-a', 0)).toEqual([])
  })

  it('returns nothing for an unclaimed resource', () => {
    expect(findConflicts(held, { scope: 'path', resource: 'api/charges.ts' }, 'session-a', 0)).toEqual([])
  })

  it('orders by soonest expiry, so a caller learns the shortest wait first', () => {
    const overlapping = [
      claim({ sessionId: 'session-b', name: 'long', resource: 'src', now: 0, ttlMs: 30 * MINUTE }),
      claim({ sessionId: 'session-c', name: 'short', resource: 'src/a.ts', now: 0, ttlMs: 5 * MINUTE }),
    ]
    const found = findConflicts(overlapping, { scope: 'path', resource: 'src/a.ts' }, 'session-a', 0)
    expect(found.map((c) => c.name)).toEqual(['short', 'long'])
  })
})
