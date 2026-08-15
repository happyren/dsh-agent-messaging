import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CardStore } from '../src/adapters/cards.ts'
import { createCard, ownersOf, summarizeCard, type CardDraft } from '../src/domain/card.ts'
import { PeerError } from '../src/domain/errors.ts'

const silentLogger = { warn: () => {}, error: () => {} }

function card(overrides: Partial<CardDraft> = {}) {
  return createCard({
    sessionId: 'session-a',
    role: 'Owns the charge API and its validation rules.',
    owns: [{ resource: 'api' }],
    skills: ['payments'],
    now: 1_000,
    ...overrides,
  })
}

describe('createCard', () => {
  it('freezes the card and its collections', () => {
    const made = card()
    expect(Object.isFrozen(made)).toBe(true)
    expect(Object.isFrozen(made.owns)).toBe(true)
    expect(Object.isFrozen(made.skills)).toBe(true)
  })

  it('normalizes owned paths with the same rule as claims', () => {
    // One vocabulary: "./api/" as ownership must compare equal to "api" as a claim.
    expect(card({ owns: [{ resource: './api/' }] }).owns[0]?.resource).toBe('api')
  })

  it('defaults ownership scope to path', () => {
    expect(card({ owns: [{ resource: 'api' }] }).owns[0]?.scope).toBe('path')
  })

  it('lowercases and de-duplicates skills', () => {
    const made = card({ skills: ['Payments', 'payments', ' SQL '] })
    expect(made.skills).toEqual(['payments', 'sql'])
  })

  it('drops blank skills rather than storing empties', () => {
    expect(card({ skills: ['  ', 'real'] }).skills).toEqual(['real'])
  })

  it('requires a role, since a card with none says nothing a title does not', () => {
    expect(() => card({ role: '   ' })).toThrowError(/needs a role/)
  })

  it('rejects an oversized role', () => {
    expect(() => card({ role: 'x'.repeat(401) })).toThrowError(/exceeds 400/)
  })

  it('bounds how much one card may declare', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ resource: `p${i}` }))
    expect(() => card({ owns: many })).toThrowError(/At most 20/)
    expect(() => card({ skills: Array.from({ length: 13 }, (_, i) => `s${i}`) })).toThrowError(/At most 12/)
  })

  it('rejects traversal in an owned path', () => {
    expect(() => card({ owns: [{ resource: '../elsewhere' }] })).toThrow(PeerError)
  })

  it('accepts a card with no ownership or skills', () => {
    const bare = card({ owns: [], skills: [] })
    expect(bare.owns).toEqual([])
    expect(bare.skills).toEqual([])
  })
})

describe('ownersOf', () => {
  const cards = [
    card({ sessionId: 'session-a', owns: [{ resource: 'api' }] }),
    card({ sessionId: 'session-b', owns: [{ resource: 'client/checkout.ts' }] }),
    card({ sessionId: 'session-c', owns: [{ resource: 'release', scope: 'topic' }] }),
  ]

  it('finds the owner of a file beneath an owned directory', () => {
    expect(ownersOf(cards, { scope: 'path', resource: 'api/charges.ts' }).map((c) => c.sessionId)).toEqual([
      'session-a',
    ])
  })

  it('finds an exact file owner', () => {
    expect(
      ownersOf(cards, { scope: 'path', resource: './client/checkout.ts' }).map((c) => c.sessionId),
    ).toEqual(['session-b'])
  })

  it('does not confuse a sibling directory for a child', () => {
    expect(ownersOf(cards, { scope: 'path', resource: 'apiv2/x.ts' })).toEqual([])
  })

  it('keeps topic ownership separate from path ownership', () => {
    expect(ownersOf(cards, { scope: 'topic', resource: 'release' }).map((c) => c.sessionId)).toEqual([
      'session-c',
    ])
    expect(ownersOf(cards, { scope: 'path', resource: 'release' })).toEqual([])
  })

  it('reports nobody for an unowned resource', () => {
    expect(ownersOf(cards, { scope: 'path', resource: 'docs/readme.md' })).toEqual([])
  })
})

describe('summarizeCard', () => {
  it('reads as one line covering role, ownership and skills', () => {
    expect(summarizeCard(card())).toBe(
      'Owns the charge API and its validation rules. · owns api · skills: payments',
    )
  })

  it('omits empty sections', () => {
    expect(summarizeCard(card({ owns: [], skills: [] }))).toBe(
      'Owns the charge API and its validation rules.',
    )
  })
})

describe('CardStore', () => {
  let stateRoot: string

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), 'dsh-am-cards-'))
  })
  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true })
  })

  function store(): CardStore {
    return new CardStore({ stateRoot, logger: silentLogger })
  }

  it('returns nothing before anything is published', async () => {
    expect(await store().readAll()).toEqual([])
    expect(await store().readOwn('session-a')).toBeUndefined()
  })

  it('round-trips a card', async () => {
    const s = store()
    const made = card()
    await s.publish(made)
    expect(await s.readAll()).toEqual([made])
    expect(await s.readOwn('session-a')).toEqual(made)
  })

  it('keeps one card per session, replacing on republish', async () => {
    const s = store()
    await s.publish(card({ role: 'first' }))
    await s.publish(card({ role: 'second' }))
    const all = await s.readAll()
    expect(all).toHaveLength(1)
    expect(all[0]?.role).toBe('second')
  })

  it('keeps sessions separate', async () => {
    const s = store()
    await s.publish(card({ sessionId: 'session-a' }))
    await s.publish(card({ sessionId: 'session-b' }))
    expect((await s.readAll()).map((c) => c.sessionId).sort()).toEqual(['session-a', 'session-b'])
  })

  it('withdraws a session\'s card', async () => {
    const s = store()
    await s.publish(card())
    await s.withdraw('session-a')
    expect(await s.readAll()).toEqual([])
  })

  it('does not expire, unlike a claim', async () => {
    // A card is standing responsibility; liveness is the directory's job.
    const s = store()
    await s.publish(card({ now: 0 }))
    expect(await s.readAll()).toHaveLength(1)
  })
})

describe('card alias', () => {
  it('slugifies a declared alias so configuration can rely on its shape', () => {
    expect(card({ alias: '  Tech Lead ' } as never).alias).toBe('tech-lead')
  })

  it('omits an alias that was not declared', () => {
    expect('alias' in card()).toBe(false)
  })

  it('leads the summary with the alias, since that is the addressable handle', () => {
    expect(summarizeCard(card({ alias: 'tech-lead' } as never))).toMatch(/^"tech-lead" — /)
  })
})
