import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DecisionStore } from '../src/adapters/decisions.ts'
import {
  createDecision,
  decisionsAbout,
  foldCurrent,
  renderDecisions,
  type Decision,
  type DecisionDraft,
} from '../src/domain/decision.ts'
import { PeerError } from '../src/domain/errors.ts'

const silentLogger = { warn: () => {}, error: () => {} }

function decision(overrides: Partial<DecisionDraft> = {}): Decision {
  return createDecision({
    id: 'd1',
    sessionId: 'session-a',
    name: 'payments',
    statement: 'tenant_id is required on every charge',
    now: 1_000,
    ...overrides,
  })
}

describe('createDecision', () => {
  it('freezes and trims', () => {
    const made = decision({ statement: '  a decision  ' })
    expect(made.statement).toBe('a decision')
    expect(Object.isFrozen(made)).toBe(true)
  })

  it('requires a statement', () => {
    expect(() => decision({ statement: '   ' })).toThrowError(/needs a statement/)
  })

  it('rejects an oversized statement or rationale', () => {
    expect(() => decision({ statement: 'x'.repeat(501) })).toThrowError(/exceeds 500/)
    expect(() => decision({ rationale: 'x'.repeat(1001) })).toThrowError(/exceeds 1000/)
  })

  it('normalizes the subject with the same rule as claims and ownership', () => {
    expect(decision({ about: { resource: './api/' } }).about).toEqual({ scope: 'path', resource: 'api' })
  })

  it('defaults the subject scope to path', () => {
    expect(decision({ about: { resource: 'api' } }).about?.scope).toBe('path')
  })

  it('refuses to supersede itself', () => {
    expect(() => decision({ id: 'd1', supersedes: 'd1' })).toThrow(PeerError)
  })

  it('omits absent optional fields rather than storing undefined', () => {
    const made = decision()
    expect('rationale' in made).toBe(false)
    expect('about' in made).toBe(false)
    expect('supersedes' in made).toBe(false)
  })
})

describe('foldCurrent', () => {
  it('returns everything when nothing is superseded', () => {
    const all = [decision({ id: 'd1', now: 1 }), decision({ id: 'd2', now: 2 })]
    expect(foldCurrent(all).map((d) => d.id)).toEqual(['d2', 'd1'])
  })

  it('hides a superseded decision, so nobody acts on a reversed one', () => {
    const all = [
      decision({ id: 'd1', now: 1, statement: 'use usd only' }),
      decision({ id: 'd2', now: 2, statement: 'accept any currency', supersedes: 'd1' }),
    ]
    expect(foldCurrent(all).map((d) => d.id)).toEqual(['d2'])
  })

  it('follows a chain of supersessions to the latest', () => {
    const all = [
      decision({ id: 'd1', now: 1 }),
      decision({ id: 'd2', now: 2, supersedes: 'd1' }),
      decision({ id: 'd3', now: 3, supersedes: 'd2' }),
    ]
    expect(foldCurrent(all).map((d) => d.id)).toEqual(['d3'])
  })

  it('lets one session supersede another session\'s decision', () => {
    const all = [
      decision({ id: 'd1', sessionId: 'session-a', now: 1 }),
      decision({ id: 'd2', sessionId: 'session-b', now: 2, supersedes: 'd1' }),
    ]
    expect(foldCurrent(all).map((d) => d.id)).toEqual(['d2'])
  })

  it('ignores a supersedes pointing at nothing', () => {
    const all = [decision({ id: 'd1', now: 1, supersedes: 'ghost' })]
    expect(foldCurrent(all).map((d) => d.id)).toEqual(['d1'])
  })

  it('orders newest first', () => {
    const all = [decision({ id: 'old', now: 1 }), decision({ id: 'new', now: 9 })]
    expect(foldCurrent(all)[0]?.id).toBe('new')
  })
})

describe('decisionsAbout', () => {
  const all = [
    decision({ id: 'd1', about: { resource: 'api' } }),
    decision({ id: 'd2', about: { resource: 'client/checkout.ts' } }),
    decision({ id: 'd3', about: { resource: 'release', scope: 'topic' } }),
    decision({ id: 'd4' }),
  ]

  it('finds a decision about a directory when asking about a file beneath it', () => {
    expect(decisionsAbout(all, { scope: 'path', resource: 'api/charges.ts' }).map((d) => d.id)).toEqual(['d1'])
  })

  it('finds a decision about a file when asking about its directory', () => {
    expect(decisionsAbout(all, { scope: 'path', resource: 'client' }).map((d) => d.id)).toEqual(['d2'])
  })

  it('does not confuse siblings', () => {
    expect(decisionsAbout(all, { scope: 'path', resource: 'apiv2/x.ts' })).toEqual([])
  })

  it('keeps topics separate from paths', () => {
    expect(decisionsAbout(all, { scope: 'topic', resource: 'release' }).map((d) => d.id)).toEqual(['d3'])
    expect(decisionsAbout(all, { scope: 'path', resource: 'release' })).toEqual([])
  })

  it('excludes decisions with no subject', () => {
    expect(decisionsAbout(all, { scope: 'path', resource: 'anything' }).map((d) => d.id)).not.toContain('d4')
  })
})

describe('renderDecisions', () => {
  it('says so when there is nothing', () => {
    expect(renderDecisions([])).toBe('No decisions have been recorded.')
  })

  it('includes the id so a reader can supersede it', () => {
    expect(renderDecisions([decision({ id: 'abc' })])).toContain('id: abc')
  })

  it('includes rationale and evidence when present', () => {
    const text = renderDecisions([
      decision({ rationale: 'multi-tenant billing', evidence: [{ locator: 'api/charges.ts', at: '7' }] }),
    ])
    expect(text).toContain('why: multi-tenant billing')
    expect(text).toContain('- api/charges.ts:7')
  })
})

describe('DecisionStore', () => {
  let stateRoot: string

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), 'dsh-am-dec-'))
  })
  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true })
  })

  function store(): DecisionStore {
    return new DecisionStore({ stateRoot, logger: silentLogger })
  }

  it('returns nothing before anything is recorded', async () => {
    expect(await store().readAll()).toEqual([])
  })

  it('appends rather than replacing, unlike the other stores', async () => {
    const s = store()
    await s.append(decision({ id: 'd1', now: 1 }))
    await s.append(decision({ id: 'd2', now: 2 }))
    expect((await s.readAll()).map((d) => d.id)).toEqual(['d1', 'd2'])
  })

  it('merges decisions across sessions in time order', async () => {
    const s = store()
    await s.append(decision({ id: 'b', sessionId: 'session-b', now: 5 }))
    await s.append(decision({ id: 'a', sessionId: 'session-a', now: 1 }))
    expect((await s.readAll()).map((d) => d.id)).toEqual(['a', 'b'])
  })

  it('survives a session ending, which is the whole point', async () => {
    // Nothing withdraws a ledger: the failure being attacked is losing what was
    // already settled when the session that settled it goes away.
    const s = store()
    await s.append(decision({ id: 'd1' }))
    expect(await store().readAll()).toHaveLength(1)
  })

  it('supports supersession end to end across sessions', async () => {
    const s = store()
    await s.append(decision({ id: 'd1', sessionId: 'session-a', now: 1, statement: 'usd only' }))
    await s.append(
      decision({ id: 'd2', sessionId: 'session-b', now: 2, statement: 'any currency', supersedes: 'd1' }),
    )
    expect(foldCurrent(await s.readAll()).map((d) => d.id)).toEqual(['d2'])
  })
})
