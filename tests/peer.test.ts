import { describe, expect, it } from 'vitest'

import { PeerError } from '../src/domain/errors.ts'
import { assignPeerNames, resolvePeer, type PeerDescriptor } from '../src/domain/peer.ts'

function peer(overrides: Partial<PeerDescriptor> & Pick<PeerDescriptor, 'sessionId' | 'name'>): PeerDescriptor {
  return {
    createdAt: 0,
    live: true,
    location: { kind: 'local' },
    ...overrides,
  }
}

describe('assignPeerNames', () => {
  it('prefers the folded title over the directory', () => {
    const names = assignPeerNames([{ sessionId: 's1', title: 'Fix Payments API', cwd: '/repo/web' }])
    expect(names.get('s1')).toBe('fix-payments-api')
  })

  it('falls back to the directory basename, then the id', () => {
    const names = assignPeerNames([
      { sessionId: 's1', cwd: '/home/k/projects/checkout' },
      { sessionId: 'session-xyz' },
    ])
    expect(names.get('s1')).toBe('checkout')
    expect(names.get('session-xyz')).toBe('session-xyz')
  })

  it('disambiguates sessions that share a base name', () => {
    const names = assignPeerNames([
      { sessionId: 'aaaa1111', cwd: '/repo/web' },
      { sessionId: 'bbbb2222', cwd: '/repo/web' },
    ])
    expect(names.get('aaaa1111')).toBe('web-1111')
    expect(names.get('bbbb2222')).toBe('web-2222')
    expect(new Set(names.values()).size).toBe(2)
  })

  it('never issues the same name twice, even when suffixes collide', () => {
    const names = assignPeerNames([
      { sessionId: 'x-1234', cwd: '/repo/web' },
      { sessionId: 'y-1234', cwd: '/repo/web' },
    ])
    expect(new Set(names.values()).size).toBe(2)
  })

  it('is stable across calls for the same corpus', () => {
    const sources = [
      { sessionId: 's1', title: 'Alpha' },
      { sessionId: 's2', title: 'Beta' },
    ]
    expect([...assignPeerNames(sources)]).toEqual([...assignPeerNames(sources)])
  })
})

describe('resolvePeer', () => {
  const peers = [
    peer({ sessionId: 'session-a', name: 'payments', title: 'Payments API', cwd: '/repo/payments' }),
    peer({ sessionId: 'session-b', name: 'payments-ui', cwd: '/repo/ui' }),
    peer({ sessionId: 'session-c', name: 'docs', cwd: '/repo/docs' }),
  ]

  it('matches an exact session id first', () => {
    expect(resolvePeer(peers, 'session-b').name).toBe('payments-ui')
  })

  it('prefers an exact name over a substring of another name', () => {
    // "payments" is also a prefix of "payments-ui"; the exact tier must win.
    expect(resolvePeer(peers, 'payments').sessionId).toBe('session-a')
  })

  it('is case-insensitive on names', () => {
    expect(resolvePeer(peers, 'DOCS').sessionId).toBe('session-c')
  })

  it('falls through to a unique substring match', () => {
    expect(resolvePeer(peers, '-ui').sessionId).toBe('session-b')
  })

  it('reports candidates when a fragment is ambiguous', () => {
    try {
      resolvePeer(peers, 'payment')
      expect.unreachable('expected an ambiguous match')
    } catch (error) {
      expect(error).toBeInstanceOf(PeerError)
      expect((error as PeerError).code).toBe('peer-ambiguous')
      expect((error as PeerError).candidates).toEqual(['payments', 'payments-ui'])
    }
  })

  it('reports a miss', () => {
    expect(() => resolvePeer(peers, 'nothing')).toThrowError(/No session matches/)
    expect(() => resolvePeer(peers, '  ')).toThrow(PeerError)
  })
})
