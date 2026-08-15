import { describe, expect, it } from 'vitest'

import { PeerError } from '../src/domain/errors.ts'
import {
  createRequest,
  createVerdict,
  renderRequest,
  renderVerdict,
  VERDICTS,
} from '../src/domain/verification.ts'

describe('createRequest', () => {
  it('trims and freezes', () => {
    const request = createRequest('  tenant_id is required  ')
    expect(request.claim).toBe('tenant_id is required')
    expect(Object.isFrozen(request)).toBe(true)
    expect(Object.isFrozen(request.evidence)).toBe(true)
  })

  it('normalizes evidence, dropping blank optional fields', () => {
    const request = createRequest('claim', [{ locator: ' api/charges.ts ', at: ' 7 ', note: '  ' }])
    expect(request.evidence[0]).toEqual({ locator: 'api/charges.ts', at: '7' })
  })

  it('rejects an empty claim', () => {
    expect(() => createRequest('   ')).toThrowError(/claim cannot be empty/)
  })

  it('rejects an oversized claim', () => {
    expect(() => createRequest('x'.repeat(1001))).toThrowError(/exceeds 1000/)
  })

  it('rejects evidence with no locator', () => {
    expect(() => createRequest('claim', [{ locator: '  ' }])).toThrow(PeerError)
  })

  it('bounds how much evidence one request carries', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ locator: `f${i}.ts` }))
    expect(() => createRequest('claim', many)).toThrowError(/At most 10/)
  })

  it('accepts a request with no evidence', () => {
    expect(createRequest('claim').evidence).toEqual([])
  })
})

describe('createVerdict', () => {
  it('accepts every declared verdict', () => {
    for (const verdict of VERDICTS) {
      expect(createVerdict(verdict, 'read the file').verdict).toBe(verdict)
    }
  })

  it('rejects an unknown verdict', () => {
    expect(() => createVerdict('maybe' as never, 'why')).toThrowError(/Unknown verdict/)
  })

  it('requires a rationale, so a verdict is never a bare label', () => {
    expect(() => createVerdict('confirmed', '  ')).toThrowError(/rationale cannot be empty/)
  })
})

describe('renderRequest', () => {
  it('instructs the receiver to check rather than agree', () => {
    const text = renderRequest(createRequest('tenant_id is required on ChargeRequest'))
    expect(text).toMatch(/check a claim, not to agree with it/)
    expect(text).toMatch(/do not take the claim on trust/)
    expect(text).toMatch(/do not assume the\s+sender checked carefully/)
  })

  it('lists where to look, with line and note', () => {
    const text = renderRequest(
      createRequest('claim', [{ locator: 'api/charges.ts', at: '7', note: 'the interface' }]),
    )
    expect(text).toContain('- api/charges.ts:7 — the interface')
  })

  it('names every verdict the replier may use', () => {
    const text = renderRequest(createRequest('claim'))
    for (const verdict of VERDICTS) expect(text).toContain(verdict)
    expect(text).toContain('peer_verify_reply')
  })

  it('names the reply tool before the claim, and rules out answering with peer_send', () => {
    // Live testing showed a verifier checking the claim properly and then
    // answering with peer_send, losing the typed verdict. The instruction has to
    // arrive before the reader is absorbed in the claim itself.
    const text = renderRequest(createRequest('some claim'))
    expect(text.indexOf('peer_verify_reply')).toBeLessThan(text.indexOf('some claim'))
    expect(text).toMatch(/Do NOT answer with peer_send/)
  })

  it('omits the evidence section when there is none', () => {
    expect(renderRequest(createRequest('claim'))).not.toContain('Where to look')
  })
})

describe('renderVerdict', () => {
  it('leads with the conclusion', () => {
    expect(renderVerdict(createVerdict('confirmed', 'read it'))).toMatch(
      /^VERIFICATION RESULT — CONFIRMED/,
    )
  })

  it('tells a refuted claimer to stop and re-examine', () => {
    const text = renderVerdict(createVerdict('refuted', 'line 7 says otherwise'))
    expect(text).toMatch(/did not survive checking/)
  })

  it('does not add that warning to a confirmation', () => {
    expect(renderVerdict(createVerdict('confirmed', 'checked'))).not.toMatch(/did not survive/)
  })

  it('lists what the verifier consulted', () => {
    const text = renderVerdict(
      createVerdict('refuted', 'mismatch', [{ locator: 'client/checkout.ts', at: '12' }]),
    )
    expect(text).toContain('- client/checkout.ts:12')
  })
})
