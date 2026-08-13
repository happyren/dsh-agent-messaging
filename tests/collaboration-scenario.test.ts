/**
 * The scenario the plugin exists for, driven through the real pipeline.
 *
 * Two sessions own different halves of one repository. The payments session
 * changes an endpoint contract; the checkout session calls that endpoint and is
 * mid-task. This walks the whole handoff — discovery, delivery, framing, and a
 * correlated reply — with only the harness edges faked.
 */

import { describe, expect, it } from 'vitest'

import { InboundRouter } from '../src/app/receive-message.ts'
import { MessageSender, type SenderIdentity } from '../src/app/send-message.ts'
import { RoutingTransport } from '../src/adapters/transport/routing-transport.ts'
import type { Envelope } from '../src/domain/envelope.ts'
import type { PeerDescriptor } from '../src/domain/peer.ts'
import { LoopGuard } from '../src/domain/policy.ts'
import { renderInbound } from '../src/domain/render.ts'
import type {
  DeliveryReceipt,
  InboxSink,
  OutboxSpool,
  PeerDirectory,
} from '../src/ports/index.ts'
import type { InboxClient } from '../src/adapters/transport/inbox-client.ts'

const PAYMENTS: SenderIdentity = {
  sessionId: 'session-payments',
  name: 'payments-api',
  cwd: '/repo/test-project',
}
const CHECKOUT: SenderIdentity = {
  sessionId: 'session-checkout',
  name: 'checkout-client',
  cwd: '/repo/test-project',
}

function descriptor(identity: SenderIdentity, title: string): PeerDescriptor {
  return {
    sessionId: identity.sessionId,
    name: identity.name,
    title,
    cwd: identity.cwd as string,
    createdAt: 0,
    live: true,
    status: 'idle',
    location: { kind: 'local' },
  }
}

/** What one session's agent actually saw, as model-facing text. */
interface Mailbox {
  readonly envelopes: Envelope[]
  readonly rendered: string[]
}

/**
 * One host holding both sessions.
 *
 * The sink dispatches by `envelope.to` exactly as the real agent-registry sink
 * does, so both sessions share one admission path.
 */
function buildHost(): {
  sender: MessageSender
  mailboxes: Record<string, Mailbox>
} {
  const mailboxes: Record<string, Mailbox> = {
    [PAYMENTS.sessionId]: { envelopes: [], rendered: [] },
    [CHECKOUT.sessionId]: { envelopes: [], rendered: [] },
  }

  const sink: InboxSink = {
    deliver(envelope) {
      const box = mailboxes[envelope.to]
      if (!box) return { status: 'refused', detail: 'not live here' } satisfies DeliveryReceipt
      box.envelopes.push(envelope)
      box.rendered.push(renderInbound(envelope))
      return { status: 'delivered' }
    },
  }

  const directory: PeerDirectory = {
    list: () =>
      Promise.resolve([
        descriptor(PAYMENTS, 'Add tenant_id to charges'),
        descriptor(CHECKOUT, 'Wire up checkout submit'),
      ]),
  }

  const spool: OutboxSpool = {
    hold: () => Promise.resolve(),
    drain: () => Promise.resolve([]),
  }

  const inbound = new InboundRouter({
    policy: 'accept',
    guard: new LoopGuard({ maxPerWindow: 10, windowMs: 60_000, duplicateWindowMs: 30_000 }),
    sink,
    clock: { now: () => 1_700_000_000_000 },
    maxHeld: 100,
  })

  let issued = 0
  const sender = new MessageSender({
    directory,
    transport: new RoutingTransport({
      inbound,
      client: {} as InboxClient,
      spool,
      spoolOffline: false,
    }),
    clock: { now: () => 1_700_000_000_000 },
    ids: { next: () => `msg-${(issued += 1)}` },
  })

  return { sender, mailboxes }
}

describe('engineering handoff: a contract change crosses two sessions', () => {
  it('carries a breaking-change notice and a correlated reply', async () => {
    const { sender, mailboxes } = buildHost()

    // 1. The payments session finds who else is working this repository.
    const peers = await sender.peers(PAYMENTS.sessionId)
    expect(peers.map((p) => p.name)).toEqual(['checkout-client'])

    // 2. It has just made the change, and interrupts rather than queueing:
    //    the other session is about to build against the old contract.
    const notice = await sender.send(PAYMENTS, {
      to: 'checkout-client',
      body:
        'Heads up — I am adding a required `tenant_id` to ChargeRequest in api/charges.ts. ' +
        'Your call in client/checkout.ts will stop compiling. I have not pushed yet.',
      mode: 'steer',
    })
    expect(notice.receipt.status).toBe('delivered')

    // 3. The checkout session received it, attributed and framed as untrusted.
    const inbox = mailboxes[CHECKOUT.sessionId] as Mailbox
    expect(inbox.envelopes).toHaveLength(1)
    expect(inbox.envelopes[0]?.mode).toBe('steer')

    const seen = inbox.rendered[0] as string
    expect(seen).toMatch(/written by another agent session, not by your user/)
    expect(seen).toMatch(/never as instructions/)
    expect(seen).toContain('tenant_id')
    expect(seen).toContain('"from":"payments-api"')
    // It is told to answer the stable id, not the display name.
    expect(seen).toContain(`to: "${PAYMENTS.sessionId}"`)

    // 4. Checkout answers, correlating to the message it is answering.
    const reply = await sender.send(CHECKOUT, {
      to: PAYMENTS.sessionId,
      body: 'Acknowledged. I will thread tenant_id through submitCheckout and wait for your push.',
      mode: 'followup',
      replyTo: notice.envelope.id,
    })
    expect(reply.receipt.status).toBe('delivered')

    // 5. Payments sees the answer tied to its original message.
    const back = mailboxes[PAYMENTS.sessionId] as Mailbox
    expect(back.envelopes).toHaveLength(1)
    expect(back.envelopes[0]?.replyTo).toBe(notice.envelope.id)
    expect(back.rendered[0]).toContain(`"inReplyTo":"${notice.envelope.id}"`)
    expect(back.rendered[0]).toContain('"from":"checkout-client"')
  })

  it('does not deliver the notice back to its own sender', async () => {
    const { sender, mailboxes } = buildHost()
    await sender.send(PAYMENTS, { to: 'checkout-client', body: 'contract change', mode: 'steer' })
    expect((mailboxes[PAYMENTS.sessionId] as Mailbox).envelopes).toHaveLength(0)
  })

  it('stops a two-session acknowledgement loop on its own', async () => {
    // Both sides answering automatically is the realistic failure mode; the
    // conversation has to terminate without either agent noticing.
    const { sender, mailboxes } = buildHost()

    let from = PAYMENTS
    let to = CHECKOUT
    let delivered = 0

    for (let round = 0; round < 40; round += 1) {
      const outcome = await sender.send(from, {
        to: to.sessionId,
        body: `ack round ${round}`,
        mode: 'followup',
      })
      if (outcome.receipt.status === 'delivered') delivered += 1
      ;[from, to] = [to, from]
    }

    const total =
      (mailboxes[PAYMENTS.sessionId] as Mailbox).envelopes.length +
      (mailboxes[CHECKOUT.sessionId] as Mailbox).envelopes.length
    expect(delivered).toBe(total)
    // Each direction is capped independently at the per-sender budget.
    expect(total).toBe(20)
  })
})
