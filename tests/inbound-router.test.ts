import { beforeEach, describe, expect, it } from 'vitest'

import { InboundRouter } from '../src/app/receive-message.ts'
import { createEnvelope, type Envelope } from '../src/domain/envelope.ts'
import { LoopGuard, type InboundPolicy } from '../src/domain/policy.ts'
import type { DeliveryReceipt, InboxSink } from '../src/ports/index.ts'

class RecordingSink implements InboxSink {
  readonly delivered: Envelope[] = []
  receipt: DeliveryReceipt = { status: 'delivered' }

  deliver(envelope: Envelope): DeliveryReceipt {
    this.delivered.push(envelope)
    return this.receipt
  }
}

let clockValue = 0
const clock = { now: () => clockValue }

function envelope(body: string, to = 'session-b'): Envelope {
  return createEnvelope({
    id: `msg-${body}`,
    sentAt: clockValue,
    from: { sessionId: 'session-a', name: 'alpha' },
    to,
    mode: 'followup',
    body,
  })
}

function router(policy: InboundPolicy, sink: RecordingSink, maxHeld = 3): InboundRouter {
  return new InboundRouter({
    policy,
    guard: new LoopGuard({ maxPerWindow: 5, windowMs: 1_000, duplicateWindowMs: 100 }),
    sink,
    clock,
    maxHeld,
  })
}

beforeEach(() => {
  clockValue = 0
})

describe('InboundRouter', () => {
  it('delivers under the accept policy', () => {
    const sink = new RecordingSink()
    expect(router('accept', sink).accept(envelope('hi')).status).toBe('delivered')
    expect(sink.delivered).toHaveLength(1)
  })

  it('drops under the refuse policy without touching the sink', () => {
    const sink = new RecordingSink()
    const receipt = router('refuse', sink).accept(envelope('hi'))
    expect(receipt.status).toBe('refused')
    expect(receipt.detail).toBeTruthy()
    expect(sink.delivered).toHaveLength(0)
  })

  it('holds under the hold policy and exposes what is waiting', () => {
    const sink = new RecordingSink()
    const inbound = router('hold', sink)
    expect(inbound.accept(envelope('hi')).status).toBe('held')
    expect(sink.delivered).toHaveLength(0)
    expect(inbound.held('session-b')).toHaveLength(1)
    expect(inbound.held('session-b')[0]?.envelope.body).toBe('hi')
  })

  it('releases held messages into the sink on request', () => {
    const sink = new RecordingSink()
    const inbound = router('hold', sink)
    inbound.accept(envelope('one'))
    clockValue += 200
    inbound.accept(envelope('two'))

    expect(inbound.release('session-b')).toBe(2)
    expect(sink.delivered.map((e) => e.body)).toEqual(['one', 'two'])
    expect(inbound.held('session-b')).toHaveLength(0)
  })

  it('bounds the held queue, discarding the oldest', () => {
    const sink = new RecordingSink()
    const inbound = router('hold', sink, 2)
    for (const body of ['one', 'two', 'three']) {
      inbound.accept(envelope(body))
      clockValue += 200
    }
    expect(inbound.held('session-b').map((h) => h.envelope.body)).toEqual(['two', 'three'])
  })

  it('keeps held queues separate per recipient', () => {
    const sink = new RecordingSink()
    const inbound = router('hold', sink)
    inbound.accept(envelope('for-b', 'session-b'))
    inbound.accept(envelope('for-c', 'session-c'))
    expect(inbound.held('session-b')).toHaveLength(1)
    expect(inbound.held('session-c')).toHaveLength(1)
    expect(inbound.release('session-b')).toBe(1)
    expect(inbound.held('session-c')).toHaveLength(1)
  })

  it('applies loop control before holding, so a flood cannot fill the queue', () => {
    const sink = new RecordingSink()
    const inbound = router('hold', sink, 100)
    // Identical bodies inside the duplicate window: only the first is admitted.
    for (let i = 0; i < 5; i += 1) inbound.accept(envelope('same'))
    expect(inbound.held('session-b')).toHaveLength(1)
  })

  it('reports a rate-limited message as dropped', () => {
    const sink = new RecordingSink()
    const inbound = router('accept', sink)
    for (let i = 0; i < 5; i += 1) {
      clockValue += 1
      inbound.accept(envelope(`body-${i}`))
    }
    clockValue += 1
    const blocked = inbound.accept(envelope('body-over'))
    expect(blocked.status).toBe('dropped')
    expect(sink.delivered).toHaveLength(5)
  })

  it('passes a sink refusal through to the sender', () => {
    const sink = new RecordingSink()
    sink.receipt = { status: 'refused', detail: 'not live here' }
    expect(router('accept', sink).accept(envelope('hi'))).toEqual({
      status: 'refused',
      detail: 'not live here',
    })
  })

  it('discards retained state on clear', () => {
    const sink = new RecordingSink()
    const inbound = router('hold', sink)
    inbound.accept(envelope('one'))
    inbound.clear()
    expect(inbound.held('session-b')).toHaveLength(0)
    // Loop-guard state is cleared too, so the same body is admitted again.
    expect(inbound.accept(envelope('one')).status).toBe('held')
  })
})
