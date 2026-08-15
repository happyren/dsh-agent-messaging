import { describe, expect, it } from 'vitest'

// @ts-expect-error -- the benchmark is plain JS on purpose: it must run against
// any arm, from a checkout with no build step and no TypeScript toolchain.
import { SCENARIOS, scenario } from '../bench/scenarios.mjs'
// @ts-expect-error -- see above.
import { renderComparison, summarize, turnsPerPass } from '../bench/score.mjs'

interface Run {
  id: string
  verdict: 'pass' | 'fail' | 'void'
  why: string
  turns: number
}

/** The fixture as the scenarios ship it, so a test scores the real starting point. */
function fixtureOf(id: string): Record<string, string> {
  return scenario(id).fixture as Record<string, string>
}

describe('scenario oracles', () => {
  it('fails the stale-contract scenario when the call site was left broken', () => {
    const files = fixtureOf('stale-contract')
    const world = {
      files: {
        ...files,
        'api/charges.ts': files['api/charges.ts']!.replace(
          'customer_id: string',
          'customer_id: string\n  tenant_id: string',
        ),
      },
    }
    expect(scenario('stale-contract').score(world).verdict).toBe('fail')
  })

  it('passes it when the client followed the contract', () => {
    const files = fixtureOf('stale-contract')
    const world = {
      files: {
        'api/charges.ts': files['api/charges.ts']!.replace(
          'customer_id: string',
          'customer_id: string\n  tenant_id: string',
        ),
        'client/checkout.ts': files['client/checkout.ts']!.replace(
          'currency:',
          'tenant_id: cart.tenantId,\n    currency:',
        ),
      },
    }
    expect(scenario('stale-contract').score(world).verdict).toBe('pass')
  })

  it('voids the stale-contract scenario when the change under test never happened', () => {
    // Nothing to measure: scoring it as a pass would credit an arm for a run
    // where the premise never arose.
    expect(scenario('stale-contract').score({ files: fixtureOf('stale-contract') }).verdict).toBe('void')
  })

  it('detects a lost update in the collision scenario', () => {
    const files = fixtureOf('collision')
    const overwritten = {
      files: {
        ...files,
        'api/charges.ts': `${files['api/charges.ts']}\n// tenant_id: string`,
      },
    }
    expect(scenario('collision').score(overwritten).verdict).toBe('fail')
    expect(scenario('collision').score(overwritten).why).toContain('idempotency_key')

    const both = {
      files: { ...files, 'api/charges.ts': '  tenant_id: string\n  idempotency_key: string' },
    }
    expect(scenario('collision').score(both).verdict).toBe('pass')
  })

  it('fails the false-belief scenario when the field was dropped on an unchecked premise', () => {
    const files = fixtureOf('false-belief')
    const dropped = {
      files: { ...files, 'client/checkout.ts': files['client/checkout.ts']!.replace(/currency:.*\n/, '') },
    }
    expect(scenario('false-belief').score(dropped).verdict).toBe('fail')
    expect(scenario('false-belief').score({ files }).verdict).toBe('pass')
  })

  it('fails the mutual-wait scenario only when nothing moved at all', () => {
    const files = fixtureOf('mutual-wait')
    expect(scenario('mutual-wait').score({ files }).verdict).toBe('fail')
    expect(
      scenario('mutual-wait').score({ files: { ...files, 'docs/billing.md': '# Charges API\n\nfields: …' } })
        .verdict,
    ).toBe('pass')
  })

  it('fails the stale-decision scenario when a settled question was reopened', () => {
    const files = fixtureOf('stale-decision')
    const reopened = {
      files: {
        ...files,
        'api/charges.ts': `${files['api/charges.ts']}\nif (req.currency !== 'usd') throw new Error('usd only')`,
      },
    }
    expect(scenario('stale-decision').score(reopened).verdict).toBe('fail')
    expect(scenario('stale-decision').score({ files }).verdict).toBe('pass')
  })

  it('gives every scenario a fixture, prompts for at least two sessions, and an oracle', () => {
    for (const entry of SCENARIOS) {
      expect(Object.keys(entry.fixture).length, entry.id).toBeGreaterThan(0)
      expect(Object.keys(entry.sessions).length, entry.id).toBeGreaterThanOrEqual(2)
      expect(typeof entry.score, entry.id).toBe('function')
    }
  })
})

describe('scoring', () => {
  const runs: Run[] = [
    { id: 'a', verdict: 'pass', why: '', turns: 4 },
    { id: 'b', verdict: 'fail', why: 'broke', turns: 2 },
    { id: 'c', verdict: 'void', why: '', turns: 3 },
  ]

  it('counts a void scenario as measured by nobody', () => {
    const summary = summarize(runs)
    expect(summary).toMatchObject({ scenarios: 3, scored: 2, passed: 1, failed: 1, void: 1 })
  })

  it('charges every turn, including the ones spent on a scenario that did not score', () => {
    // Turns are what the arm actually cost the user; a void scenario still
    // burned them.
    expect(summarize(runs).turns).toBe(9)
  })

  it('reports what one correct outcome cost', () => {
    expect(turnsPerPass(summarize(runs))).toBe(9)
    expect(turnsPerPass(summarize([{ id: 'a', verdict: 'fail', why: '', turns: 5 }]))).toBeNull()
  })

  it('puts each arm in its own column and explains every failure', () => {
    const table = renderComparison({ baseline: summarize(runs), plugin: summarize(runs) })
    expect(table).toContain('baseline')
    expect(table).toContain('plugin')
    expect(table).toContain('turns per pass')
    expect(table).toContain('broke')
  })
})
