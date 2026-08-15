import { describe, expect, it } from 'vitest'

import { summarizeCard } from '../src/domain/card.ts'
import { deriveCard } from '../src/domain/derived-card.ts'

const NOW = 1_700_000_000_000

describe('deriveCard', () => {
  it('owns the part of the project the session actually works in', () => {
    const card = deriveCard({ sessionId: 's1', root: '/repo', cwd: '/repo/services/billing' }, NOW)
    expect(card?.owns).toEqual([{ scope: 'path', resource: 'services/billing' }])
    expect(card?.role).toBe('Working in services/billing')
  })

  it('prefers what the humans wrote about that directory', () => {
    const card = deriveCard(
      {
        sessionId: 's1',
        root: '/repo',
        cwd: '/repo/api',
        headline: '# Charge API — owns the charge contract and its validation',
      },
      NOW,
    )
    expect(card?.role).toBe('Charge API — owns the charge contract and its validation')
    expect(card?.owns).toEqual([{ scope: 'path', resource: 'api' }])
  })

  it('claims no ownership from the project root, where owning everything says nothing', () => {
    // Every session in a single-directory repo shares this cwd; a card saying
    // each of them owns the whole tree is worse than no card.
    expect(deriveCard({ sessionId: 's1', root: '/repo', cwd: '/repo' }, NOW)).toBeUndefined()
    expect(deriveCard({ sessionId: 's1', root: '/repo', cwd: '/repo/' }, NOW)).toBeUndefined()
  })

  it('still describes a root session when the humans described it', () => {
    const card = deriveCard(
      { sessionId: 's1', root: '/repo', cwd: '/repo', headline: 'Payments monorepo' },
      NOW,
    )
    expect(card?.role).toBe('Payments monorepo')
    expect(card?.owns).toEqual([])
  })

  it('declines when the workspace says nothing at all', () => {
    expect(deriveCard({ sessionId: 's1' }, NOW)).toBeUndefined()
    expect(deriveCard({ sessionId: 's1', cwd: '/elsewhere', root: '/repo' }, NOW)).toBeUndefined()
  })

  it('never derives an alias', () => {
    // An alias is an address. Two sessions in one directory would derive the
    // same one, making every send to it ambiguous — worse than the folded
    // display name, which is unique by construction.
    const card = deriveCard({ sessionId: 's1', root: '/repo', cwd: '/repo/api' }, NOW)
    expect(card?.alias).toBeUndefined()
  })

  it('bounds a rambling headline', () => {
    const card = deriveCard(
      { sessionId: 's1', root: '/repo', cwd: '/repo/api', headline: 'x'.repeat(500) },
      NOW,
    )
    expect((card?.role.length ?? 0)).toBeLessThanOrEqual(160)
    expect(card?.role.endsWith('…')).toBe(true)
  })

  it('says out loud that it was inferred', () => {
    const card = deriveCard({ sessionId: 's1', root: '/repo', cwd: '/repo/api' }, NOW)
    expect(card?.derived).toBe(true)
    expect(summarizeCard(card!)).toContain('inferred from the workspace, not declared')
  })
})
