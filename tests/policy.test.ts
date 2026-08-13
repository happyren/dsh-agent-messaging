import { describe, expect, it } from 'vitest'

import { createEnvelope, type Envelope } from '../src/domain/envelope.ts'
import { decideInbound, LoopGuard } from '../src/domain/policy.ts'

function envelope(body: string, from = 'session-a'): Envelope {
  return createEnvelope({
    id: `msg-${body}-${from}`,
    sentAt: 0,
    from: { sessionId: from, name: from },
    to: 'session-b',
    mode: 'followup',
    body,
  })
}

describe('decideInbound', () => {
  it('maps each policy to its outcome', () => {
    expect(decideInbound('accept').kind).toBe('deliver')
    expect(decideInbound('hold').kind).toBe('hold')
    expect(decideInbound('refuse').kind).toBe('refuse')
  })

  it('explains a non-delivery', () => {
    const held = decideInbound('hold')
    expect(held.kind === 'hold' && held.reason).toBeTruthy()
  })
})

describe('LoopGuard', () => {
  const limits = { maxPerWindow: 3, windowMs: 1_000, duplicateWindowMs: 500 }

  it('admits up to the rate budget', () => {
    const guard = new LoopGuard(limits)
    expect(guard.admit(envelope('one'), 0).ok).toBe(true)
    expect(guard.admit(envelope('two'), 10).ok).toBe(true)
    expect(guard.admit(envelope('three'), 20).ok).toBe(true)
  })

  it('rejects the message past the budget, naming the limit', () => {
    const guard = new LoopGuard(limits)
    for (const body of ['one', 'two', 'three']) guard.admit(envelope(body), 0)
    const blocked = guard.admit(envelope('four'), 30)
    expect(blocked.ok).toBe(false)
    expect(blocked.ok === false && blocked.reason).toMatch(/exceeded 3 messages/)
  })

  it('lets the budget recover once the window rolls past', () => {
    const guard = new LoopGuard(limits)
    for (const body of ['one', 'two', 'three']) guard.admit(envelope(body), 0)
    expect(guard.admit(envelope('four'), 1_001).ok).toBe(true)
  })

  it('drops an identical body repeated inside the duplicate window', () => {
    const guard = new LoopGuard(limits)
    expect(guard.admit(envelope('same'), 0).ok).toBe(true)
    const repeat = guard.admit(envelope('same'), 100)
    expect(repeat.ok).toBe(false)
    expect(repeat.ok === false && repeat.reason).toMatch(/identical/i)
  })

  it('allows the same body again after the duplicate window', () => {
    const guard = new LoopGuard(limits)
    guard.admit(envelope('same'), 0)
    expect(guard.admit(envelope('same'), 501).ok).toBe(true)
  })

  it('budgets each sender separately', () => {
    const guard = new LoopGuard(limits)
    for (const body of ['one', 'two', 'three']) guard.admit(envelope(body, 'session-a'), 0)
    expect(guard.admit(envelope('one', 'session-c'), 0).ok).toBe(true)
  })

  it('forgets everything on clear', () => {
    const guard = new LoopGuard(limits)
    guard.admit(envelope('same'), 0)
    guard.clear()
    expect(guard.admit(envelope('same'), 1).ok).toBe(true)
  })

  it('terminates a two-agent ping-pong on its own', () => {
    // The failure this guards against: two agents that answer each other
    // automatically. Distinct bodies dodge duplicate suppression, so the rate
    // budget has to be what stops it.
    const guard = new LoopGuard(limits)
    let admitted = 0
    for (let round = 0; round < 50; round += 1) {
      if (guard.admit(envelope(`round-${round}`), round).ok) admitted += 1
    }
    expect(admitted).toBe(limits.maxPerWindow)
  })
})
