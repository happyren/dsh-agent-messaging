import { describe, expect, it } from 'vitest'

import { PeerError } from '../src/domain/errors.ts'
import {
  assertFanoutWithinBound,
  isGroupAddress,
  membersOf,
  normalizeGroupName,
  resolveFanout,
  type GroupMember,
} from '../src/domain/group.ts'

function member(sessionId: string, name: string, groups: string[]): GroupMember {
  return { sessionId, name, groups }
}

const team = [
  member('s-lead', 'tech-lead', ['backend']),
  member('s-api', 'payments-api', ['backend']),
  member('s-web', 'checkout-client', ['backend', 'frontend']),
  member('s-docs', 'docs', ['frontend']),
]

describe('isGroupAddress', () => {
  it('recognises the prefix, and only the prefix', () => {
    expect(isGroupAddress('#backend')).toBe(true)
    expect(isGroupAddress('  #backend ')).toBe(true)
    expect(isGroupAddress('backend')).toBe(false)
    expect(isGroupAddress('payments-api')).toBe(false)
  })
})

describe('normalizeGroupName', () => {
  it('makes the prefix and case irrelevant, so a card and an address agree', () => {
    const forms = ['#backend', 'backend', '  Backend ', '##backend']
    expect(new Set(forms.map(normalizeGroupName)).size).toBe(1)
    expect(normalizeGroupName('#Backend')).toBe('backend')
  })

  it('rejects an empty or oversized name', () => {
    expect(() => normalizeGroupName('#')).toThrow(PeerError)
    expect(() => normalizeGroupName('   ')).toThrow(PeerError)
    expect(() => normalizeGroupName('x'.repeat(49))).toThrowError(/exceeds 48/)
  })
})

describe('membersOf', () => {
  it('selects only declared members', () => {
    expect(membersOf(team, 'backend').map((m) => m.name)).toEqual([
      'tech-lead',
      'payments-api',
      'checkout-client',
    ])
  })

  it('lets a session belong to several groups', () => {
    expect(membersOf(team, 'frontend').map((m) => m.name)).toEqual(['checkout-client', 'docs'])
  })

  it('returns nothing for an unknown group', () => {
    expect(membersOf(team, 'nobody')).toEqual([])
  })
})

describe('resolveFanout', () => {
  const backend = membersOf(team, 'backend')

  it('mesh reaches everyone but the sender', () => {
    const fanout = resolveFanout(backend, { topology: 'mesh' }, 's-api')
    expect(fanout.recipients.map((m) => m.name)).toEqual(['tech-lead', 'checkout-client'])
    expect(fanout.relayedVia).toBeUndefined()
  })

  it('star routes a member\'s message to the lead alone', () => {
    // The whole saving: one message in costs one turn, not N.
    const fanout = resolveFanout(backend, { topology: 'star', lead: 'tech-lead' }, 's-api')
    expect(fanout.recipients.map((m) => m.name)).toEqual(['tech-lead'])
    expect(fanout.relayedVia?.name).toBe('tech-lead')
  })

  it('star lets the lead reach everyone', () => {
    const fanout = resolveFanout(backend, { topology: 'star', lead: 'tech-lead' }, 's-lead')
    expect(fanout.recipients.map((m) => m.name)).toEqual(['payments-api', 'checkout-client'])
    expect(fanout.relayedVia).toBeUndefined()
  })

  it('accepts a lead named by session id as well as by name', () => {
    const fanout = resolveFanout(backend, { topology: 'star', lead: 's-lead' }, 's-api')
    expect(fanout.recipients.map((m) => m.name)).toEqual(['tech-lead'])
  })

  it('refuses a star group with no lead configured', () => {
    expect(() => resolveFanout(backend, { topology: 'star' }, 's-api')).toThrowError(/no lead is configured/)
  })

  it('refuses a lead that is not in the group', () => {
    expect(() => resolveFanout(backend, { topology: 'star', lead: 'docs' }, 's-api')).toThrowError(
      /not in this group/,
    )
  })

  it('never delivers a group message back to its sender', () => {
    for (const topology of ['mesh', 'star'] as const) {
      const fanout = resolveFanout(backend, { topology, lead: 'tech-lead' }, 's-lead')
      expect(fanout.recipients.map((m) => m.sessionId)).not.toContain('s-lead')
    }
  })

  it('returns nobody for a group of one', () => {
    expect(resolveFanout([member('s-a', 'a', ['x'])], { topology: 'mesh' }, 's-a').recipients).toEqual([])
  })
})

describe('assertFanoutWithinBound', () => {
  it('permits a fan-out at the bound', () => {
    expect(() => assertFanoutWithinBound(membersOf(team, 'backend'), 3)).not.toThrow()
  })

  it('refuses one over it, and suggests the cheaper shape', () => {
    try {
      assertFanoutWithinBound(membersOf(team, 'backend'), 2)
      expect.unreachable('expected a bound failure')
    } catch (error) {
      expect((error as PeerError).code).toBe('rate-limited')
      expect((error as PeerError).message).toMatch(/star topology with a lead/)
    }
  })
})

describe('lead configuration against a declared alias', () => {
  it('resolves a lead by the alias an operator can actually configure', () => {
    // Found live: display names are folded from session titles, so an operator
    // has nothing stable to name a lead against. A card-declared alias is that
    // stable handle, and the lead lookup must match it.
    const withAlias = [
      member('s-lead', 'tech-lead', ['backend']),
      member('s-api', 'payments-api', ['backend']),
    ]
    const fanout = resolveFanout(withAlias, { topology: 'star', lead: 'tech-lead' }, 's-api')
    expect(fanout.relayedVia?.name).toBe('tech-lead')
  })
})
