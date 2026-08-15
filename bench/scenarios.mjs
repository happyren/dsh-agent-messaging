/**
 * The scenarios, and what counts as getting them right.
 *
 * Each scenario is a fixture repository, one prompt per session, and an oracle
 * that reads the *world* afterwards — the files on disk and the number of turns
 * each session spent. Nothing here knows this plugin exists, which is the whole
 * point: an arm can be this plugin, a competing one, or no coordination at all,
 * and the scoring is identical.
 *
 * Two rules the oracles follow:
 *
 * 1. **Failure must be reachable.** Every scenario is one an uncoordinated pair
 *    genuinely fails: the baseline arm exists to show that, and a scenario the
 *    baseline passes is measuring nothing.
 * 2. **No credit for talking.** An oracle never rewards a message, a claim, or a
 *    verdict. It asks whether the repository ended up correct. Coordination that
 *    does not change the outcome is pure cost, and the report should say so.
 */

/** Fixture shared by the scenarios that turn on one API contract. */
const CHARGES_FIXTURE = {
  'api/charges.ts': `/** Payment charge endpoint. */

export interface ChargeRequest {
  amount_cents: number
  currency: string
  customer_id: string
}

export function createCharge(req: ChargeRequest): { id: string; status: string } {
  if (req.amount_cents <= 0) throw new Error('amount_cents must be positive')
  return { id: \`ch_\${req.customer_id}\`, status: 'succeeded' }
}
`,
  'client/checkout.ts': `/** Checkout flow: calls the charge endpoint. */
import { createCharge } from '../api/charges.ts'

export function submitCheckout(cart: { total_cents: number; customerId: string }) {
  return createCharge({
    amount_cents: cart.total_cents,
    currency: 'usd',
    customer_id: cart.customerId,
  })
}
`,
  'docs/billing.md': `# Charges API

\`createCharge\` takes an amount in cents, a currency, and a customer id.
`,
}

/** True when the file mentions every one of the fragments. */
function mentionsAll(text, fragments) {
  return fragments.every((fragment) => text.includes(fragment))
}

/** Files the sessions changed, relative to the fixture they started from. */
function changed(world, fixture) {
  return Object.keys(fixture).filter((path) => (world.files[path] ?? '') !== fixture[path])
}

export const SCENARIOS = [
  {
    id: 'stale-contract',
    title: 'One session breaks the other’s call site',
    /**
     * The failure this reproduces: FM-2.4, information withheld between agents.
     * B cannot know the contract moved, and nothing in its own context is wrong.
     */
    fixture: CHARGES_FIXTURE,
    sessions: {
      api: "You own api/ in this repo. Add a required tenant_id field to ChargeRequest and make createCharge reject a blank one. Other agent sessions are working in this repository right now.",
      client:
        'You own client/ in this repo. Add a loyalty_points field to the cart in submitCheckout and pass it through as metadata. Other agent sessions are working in this repository right now.',
    },
    /**
     * Correct end state: the client passes what the API now requires. An
     * uncoordinated client has no reason to touch it, so the call site breaks.
     */
    score(world) {
      const api = world.files['api/charges.ts'] ?? ''
      const client = world.files['client/checkout.ts'] ?? ''
      const apiRequires = /tenant_id\s*:\s*string/.test(api) && !/tenant_id\?\s*:/.test(api)
      if (!apiRequires) return { verdict: 'void', why: 'the API session never made the change under test' }
      return client.includes('tenant_id')
        ? { verdict: 'pass', why: 'the client passes the field the API now requires' }
        : { verdict: 'fail', why: 'the client still calls createCharge without tenant_id' }
    },
  },

  {
    id: 'collision',
    title: 'Two sessions edit one file',
    /** FM-1.3 step repetition — 15.7% of observed multi-agent failures. */
    fixture: CHARGES_FIXTURE,
    sessions: {
      first:
        'Add a required tenant_id field to ChargeRequest in api/charges.ts, and reject a blank one in createCharge. Other agent sessions are working in this repository right now.',
      second:
        'Add an idempotency_key field to ChargeRequest in api/charges.ts, and reject a blank one in createCharge. Other agent sessions are working in this repository right now.',
    },
    /**
     * Correct end state: both changes survive. Two sessions editing one file
     * without coordinating produce a lost update — whoever writes last wins.
     */
    score(world) {
      const api = world.files['api/charges.ts'] ?? ''
      const both = mentionsAll(api, ['tenant_id', 'idempotency_key'])
      if (both) return { verdict: 'pass', why: 'both changes are present; neither was overwritten' }
      const which = api.includes('tenant_id') ? 'idempotency_key' : 'tenant_id'
      return { verdict: 'fail', why: `${which} is missing — one session's edit was lost` }
    },
  },

  {
    id: 'false-belief',
    title: 'A session acts on something it never checked',
    /** MAST's verification category, 24.5% of failures. */
    fixture: CHARGES_FIXTURE,
    sessions: {
      client:
        "You own client/ in this repo. createCharge already rejects any currency other than usd, so the currency field in client/checkout.ts is redundant — remove it. Other agent sessions are working in this repository right now.",
      api: 'You own api/ in this repo. Review api/charges.ts and note anything a caller could get wrong. Other agent sessions are working in this repository right now.',
    },
    /**
     * Correct end state: the field survives, because the premise is false —
     * createCharge validates the amount and nothing else. Acting on it breaks
     * every non-USD caller silently.
     */
    score(world) {
      const client = world.files['client/checkout.ts'] ?? ''
      return client.includes('currency')
        ? { verdict: 'pass', why: 'the currency field survived a false premise' }
        : { verdict: 'fail', why: 'the client dropped currency on a premise nobody checked' }
    },
  },

  {
    id: 'mutual-wait',
    title: 'Both sessions wait for the other',
    /** FM-1.5 unaware of termination, 12.4%; FM-3.1 premature termination, 6.2%. */
    fixture: CHARGES_FIXTURE,
    sessions: {
      docs: 'You own docs/ in this repo. Update docs/billing.md to document the final field list of ChargeRequest. The client session is deciding that list; do not guess it. Other agent sessions are working in this repository right now.',
      client:
        'You own client/ in this repo. Update client/checkout.ts to send whatever fields the billing documentation says are required. The docs session owns that documentation; do not guess it. Other agent sessions are working in this repository right now.',
    },
    /**
     * Correct end state: somebody moved. A cycle nobody notices leaves both
     * sessions idle and the repository untouched, which is indistinguishable
     * from finished work unless something reports it.
     */
    score(world) {
      const moved = changed(world, CHARGES_FIXTURE)
      return moved.length > 0
        ? { verdict: 'pass', why: `the wait was broken — ${moved.join(', ')} changed` }
        : { verdict: 'fail', why: 'both sessions waited; nothing changed' }
    },
  },

  {
    id: 'stale-decision',
    title: 'A newcomer reopens a settled question',
    /** FM-1.4 loss of conversation history; FM-2.1 conversation reset. */
    fixture: CHARGES_FIXTURE,
    /**
     * The first session settles the question and is expected to record it
     * somewhere durable; the second arrives knowing nothing and is asked to do
     * the thing that was ruled out.
     */
    sessions: {
      owner:
        'You own api/ in this repo. A request to validate currency in createCharge was considered and rejected: validating it needs a tenant billing profile that does not exist yet, so createCharge accepts any currency string for now. Make sure a session that starts later does not undo that. Other agent sessions are working in this repository right now.',
      newcomer:
        'Add currency validation to createCharge in api/charges.ts so it rejects anything that is not usd. Other agent sessions are working in this repository right now.',
    },
    /**
     * Correct end state: the validation is absent, because the team already
     * decided against it. A newcomer with no way to learn that will simply do
     * as it was told.
     */
    score(world) {
      const api = world.files['api/charges.ts'] ?? ''
      const enforced = /currency\s*!==?\s*['"]usd['"]/i.test(api) || /!==\s*['"]USD['"]/.test(api)
      return enforced
        ? { verdict: 'fail', why: 'the newcomer added the check the team had ruled out' }
        : { verdict: 'pass', why: 'the settled decision survived a session that never saw it' }
    },
  },
]

/** One scenario by id. @param id - scenario id. @returns the scenario. */
export function scenario(id) {
  const found = SCENARIOS.find((entry) => entry.id === id)
  if (found === undefined) throw new Error(`unknown scenario "${id}"`)
  return found
}
