import { describe, expect, it } from 'vitest'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

import { AgentInboxSink } from '../src/adapters/agent-sink.ts'
import { readPeerBody, readPeerMessage } from '../src/client/peer-message.ts'
import type { AuthorityPolicy } from '../src/domain/authority.ts'
import { createEnvelope, type Envelope, type DeliveryMode } from '../src/domain/envelope.ts'

/** One recorded delivery: which inbox boundary took it, and what it carried. */
interface Delivery {
  readonly boundary: 'steer' | 'followup' | 'inject'
  readonly message: UserMessage
}

/** An agent registry holding one live agent that records what it is handed. */
function registry(deliveries: Delivery[], liveSessionId = 'session-b'): AgentRegistry {
  const agent = {
    steer: (message: UserMessage) => deliveries.push({ boundary: 'steer', message }),
    followup: (message: UserMessage) => deliveries.push({ boundary: 'followup', message }),
    inject: (message: UserMessage) => deliveries.push({ boundary: 'inject', message }),
  }
  return {
    get: (sessionId: string) => (sessionId === liveSessionId ? agent : undefined),
  } as unknown as AgentRegistry
}

function envelope(extra: Partial<Envelope> = {}): Envelope {
  return createEnvelope({
    id: 'msg-1',
    sentAt: 1_700_000_000_000,
    from: { sessionId: 'session-a', name: 'payments-api' },
    to: 'session-b',
    mode: 'steer',
    body: 'tenant_id is required on ChargeRequest',
    ...(extra.replyTo === undefined ? {} : { replyTo: extra.replyTo }),
    ...(extra.mode === undefined ? {} : { mode: extra.mode }),
    ...(extra.from === undefined ? {} : { from: extra.from }),
  })
}

const INFORM: AuthorityPolicy = { authority: 'inform', trustedPeers: [] }

describe('AgentInboxSink', () => {
  it('records who sent the message, how it arrived, and what it may be used for', () => {
    const deliveries: Delivery[] = []
    new AgentInboxSink(registry(deliveries), INFORM).deliver(envelope({ replyTo: 'msg-0' }))

    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.message.source).toEqual({
      kind: 'plugin',
      plugin: 'dsh-agent-messaging',
      form: 'relay',
      senderSessionId: 'session-a',
      senderName: 'payments-api',
      mode: 'steer',
      authority: 'inform',
      messageId: 'msg-1',
      sentAt: 1_700_000_000_000,
      replyTo: 'msg-0',
    })
  })

  it('writes an attribution the transcript can read back', () => {
    // The two halves of this plugin meet here: whatever the sink records is
    // what a card has to present, so the reader runs against the real record
    // rather than a copy of it that could drift.
    const deliveries: Delivery[] = []
    new AgentInboxSink(registry(deliveries), INFORM).deliver(envelope())
    const message = deliveries[0]?.message as UserMessage

    expect(readPeerMessage(message.source)).toEqual({
      sessionId: 'session-a',
      name: 'payments-api',
      mode: 'steer',
      authority: 'inform',
      messageId: 'msg-1',
      sentAt: 1_700_000_000_000,
      external: false,
    })
    const [block] = message.content
    expect(readPeerBody(block?.type === 'text' ? block.text : '')).toBe(
      'tenant_id is required on ChargeRequest',
    )
  })

  it('takes the inbox boundary the sender chose', () => {
    const cases: readonly [DeliveryMode, Delivery['boundary']][] = [
      ['steer', 'steer'],
      ['followup', 'followup'],
      ['context', 'inject'],
    ]
    for (const [mode, boundary] of cases) {
      const deliveries: Delivery[] = []
      new AgentInboxSink(registry(deliveries), INFORM).deliver(envelope({ mode }))
      expect(deliveries[0]?.boundary).toBe(boundary)
      expect(readPeerMessage(deliveries[0]?.message.source)?.mode).toBe(mode)
    }
  })

  it('records the elevated standing an authorised peer was given', () => {
    const deliveries: Delivery[] = []
    const policy: AuthorityPolicy = { authority: 'act', trustedPeers: ['session-a'] }
    new AgentInboxSink(registry(deliveries), policy).deliver(envelope())
    expect(readPeerMessage(deliveries[0]?.message.source)?.authority).toBe('act')
  })

  it('marks an external sender, and never elevates one', () => {
    const deliveries: Delivery[] = []
    // A2A senders choose their own identifiers, so an allowlist entry naming
    // one must not grant it standing.
    const policy: AuthorityPolicy = { authority: 'act', trustedPeers: ['a2a:stranger'] }
    new AgentInboxSink(registry(deliveries), policy).deliver(
      envelope({ from: { sessionId: 'a2a:stranger', name: 'stranger' } }),
    )

    const peer = readPeerMessage(deliveries[0]?.message.source)
    expect(peer?.external).toBe(true)
    expect(peer?.authority).toBe('inform')
  })

  it('refuses when the addressed session is not live here', () => {
    const deliveries: Delivery[] = []
    const receipt = new AgentInboxSink(registry(deliveries, 'someone-else'), INFORM).deliver(envelope())
    expect(receipt.status).toBe('refused')
    expect(deliveries).toHaveLength(0)
  })
})
