import { describe, expect, it } from 'vitest'

import {
  presentCardCall,
  presentClaimCall,
  presentClaimResult,
  presentDecideCall,
  presentDecisionsCall,
  presentListCall,
  presentSendCall,
  presentSendResult,
  presentStatusCall,
  presentStatusResult,
  presentVerifyCall,
  presentVerifyReplyCall,
} from '../src/tools/presentation.ts'

const text = (body: string) => ({ content: [{ type: 'text', text: body }] })

describe('peer_send cards', () => {
  it('names the recipient and translates the mode into plain language', () => {
    expect(presentSendCall({ to: 'checkout-client', mode: 'steer' }).title).toBe(
      'Message checkout-client (interrupt)',
    )
    expect(presentSendCall({ to: 'x', mode: 'context' }).title).toContain('quiet')
    expect(presentSendCall({ to: 'x' }).title).toContain('next turn')
  })

  it('shows the message body rather than making a reader expand for it', () => {
    const view = presentSendCall({ to: 'x', message: 'tenant_id is required' })
    expect(view.card === 'generic' && view.content?.[0]).toEqual({
      type: 'text',
      text: 'tenant_id is required',
    })
  })

  it('leads the completed card with the outcome, since a refusal must not be missed', () => {
    expect(presentSendResult({}, text('refused → checkout\nheld for operator')).title).toBe(
      'refused → checkout',
    )
  })
})

describe('peer_claim cards', () => {
  it('distinguishes taking from releasing', () => {
    expect(presentClaimCall({ resource: 'api/charges.ts' }).title).toBe('Claim api/charges.ts')
    expect(presentClaimCall({ resource: 'api/charges.ts', release: true }).title).toBe(
      'Release api/charges.ts',
    )
  })

  it('offers a path claim as a follow-along location, but not a topic', () => {
    const path = presentClaimCall({ resource: 'api/charges.ts' })
    expect(path.card === 'generic' && path.locations).toEqual([{ path: 'api/charges.ts' }])
    const topic = presentClaimCall({ resource: 'release notes' })
    expect(topic.card === 'generic' && topic.locations).toBeUndefined()
  })

  it('makes a refusal legible without expanding the card', () => {
    const view = presentClaimResult({}, text('refused: "api" overlaps a claim held by another session.'))
    expect(view.title).toBe('Claim refused — a peer holds it')
    expect(view.card === 'generic' && view.content?.[0]?.type).toBe('text')
  })
})

describe('verification cards', () => {
  it('turns cited evidence into follow-along locations', () => {
    const view = presentVerifyCall({
      to: 'payments-api',
      claim: 'currency is validated',
      evidence: [{ locator: 'api/charges.ts' }, { locator: 'some prose note' }],
    })
    expect(view.title).toBe('Ask payments-api to verify')
    // Only a real path is a location; a prose note is not.
    expect(view.card === 'generic' && view.locations).toEqual([{ path: 'api/charges.ts' }])
  })

  it('puts the verdict in the title, which is the whole point of the reply', () => {
    expect(presentVerifyReplyCall({ to: 'checkout', verdict: 'refuted' }).title).toBe(
      'REFUTED — answering checkout',
    )
  })
})

describe('peer_status cards', () => {
  it('names what a session is blocked on', () => {
    expect(presentStatusCall({ phase: 'blocked', blocked_on: 'payments-api' }).title).toBe(
      'Status: blocked on payments-api',
    )
    expect(presentStatusCall({ phase: 'done' }).title).toBe('Status: done')
  })

  it('surfaces a deadlock in the title', () => {
    const view = presentStatusResult({}, text('published: blocked\nDEADLOCK — you are in a mutual wait: a → b'))
    expect(view.title).toBe('DEADLOCK — mutual wait detected')
  })

  it('leaves an ordinary status quiet', () => {
    expect(presentStatusResult({}, text('published: working')).title).toBe('published: working')
  })
})

describe('identity and ledger cards', () => {
  it('names the alias being declared', () => {
    expect(presentCardCall({ alias: 'tech-lead', role: 'coordinates' }).title).toBe(
      'Declare identity: tech-lead',
    )
    expect(presentCardCall({ role: 'coordinates' }).title).toBe('Declare identity')
  })

  it('distinguishes recording from superseding, and scopes both', () => {
    expect(presentDecideCall({ statement: 's', about: 'api' }).title).toBe('Record a decision [api]')
    expect(presentDecideCall({ statement: 's', about: 'api', supersedes: 'd1' }).title).toBe(
      'Supersede a decision [api]',
    )
  })

  it('names what a decision query is scoped to', () => {
    expect(presentDecisionsCall({ about: 'api/charges.ts' }).title).toBe('Decisions about api/charges.ts')
    expect(presentDecisionsCall({}).title).toBe('Decisions on record')
  })

  it('labels the peer listing', () => {
    expect(presentListCall().title).toBe('List reachable sessions')
  })
})

describe('replay safety', () => {
  it('tolerates arguments from an older version of a tool', () => {
    // Presenters run on replayed history, where a logged call may predate a
    // parameter. None of them may throw on a missing field.
    expect(() => presentSendCall({})).not.toThrow()
    expect(() => presentClaimCall({})).not.toThrow()
    expect(() => presentVerifyCall({})).not.toThrow()
    expect(() => presentVerifyReplyCall({})).not.toThrow()
    expect(() => presentStatusCall({})).not.toThrow()
    expect(() => presentCardCall({})).not.toThrow()
    expect(() => presentDecideCall({})).not.toThrow()
    expect(() => presentDecisionsCall({})).not.toThrow()
  })

  it('tolerates a result with no content', () => {
    expect(() => presentSendResult({}, {})).not.toThrow()
    expect(() => presentClaimResult({}, {})).not.toThrow()
    expect(() => presentStatusResult({}, {})).not.toThrow()
  })

  it('keeps titles to one line, whatever the input', () => {
    const long = 'x'.repeat(500)
    expect(presentSendResult({}, text(long)).title?.length).toBeLessThanOrEqual(80)
    expect(presentStatusResult({}, text(long)).title?.length).toBeLessThanOrEqual(80)
  })
})
