import { describe, expect, it } from 'vitest'

import { AGENT_MESSAGE_KIND, agentMessageDefinition, type AgentMessageChatData } from '../src/client/chat-node.ts'
import { createEnvelope } from '../src/domain/envelope.ts'
import { renderInbound } from '../src/domain/render.ts'

/**
 * The durable event shape the projection reads. Built structurally and cast
 * once here, because the harness's own event type is branded and a test does
 * not need a real session to prove a pure projection.
 */
type Event = Parameters<typeof agentMessageDefinition.match>[0]

const envelope = createEnvelope({
  id: 'msg-1',
  sentAt: 1_700_000_000_000,
  from: { sessionId: 'session-a', name: 'payments-api' },
  to: 'session-b',
  mode: 'steer',
  body: 'tenant_id is required on ChargeRequest',
})

const PEER_SOURCE = {
  kind: 'plugin',
  plugin: 'dsh-agent-messaging',
  form: 'relay',
  senderSessionId: 'session-a',
  senderName: 'payments-api',
  mode: 'steer',
  authority: 'inform',
  messageId: 'msg-1',
  sentAt: 1_700_000_000_000,
}

function peerEvent(seq = 42, source: Record<string, unknown> = {}): Event {
  return {
    type: 'user/message',
    seq,
    time: 1_700_000_000_500,
    data: {
      id: 'message-id',
      role: 'user',
      content: [{ type: 'text', text: renderInbound(envelope) }],
      source: { ...PEER_SOURCE, ...source },
    },
  } as unknown as Event
}

/** Assemble the engine-owned context a Definition is handed. */
function contextFor(state: AgentMessageChatData | undefined) {
  return {
    key: 'agent-message:42',
    kind: AGENT_MESSAGE_KIND,
    id: '42',
    matches: [],
    start: { location: { kind: 'session' } },
    state,
    current: new Map(),
  } as unknown as Parameters<NonNullable<typeof agentMessageDefinition.buildViewNode>>[0]
}

describe('agent message projection', () => {
  it('claims a peer message and identifies it by the event it presents', () => {
    expect(agentMessageDefinition.match(peerEvent(42))).toEqual({ id: '42', role: 'start' })
  })

  it('ignores every message that is not one of ours', () => {
    const human = { ...peerEvent(), data: { content: [], source: { kind: 'user' } } } as unknown as Event
    const otherEvent = { ...peerEvent(), type: 'assistant/message' } as unknown as Event
    expect(agentMessageDefinition.match(human)).toBeNull()
    expect(agentMessageDefinition.match(otherEvent)).toBeNull()
  })

  it('projects the sender, the delivery, and the message itself', () => {
    const state = agentMessageDefinition.start(
      contextFor(undefined),
      { event: peerEvent(), role: 'start' } as never,
      undefined as never,
    )
    expect(state).toEqual({
      seq: 42,
      time: 1_700_000_000_500,
      peer: {
        sessionId: 'session-a',
        name: 'payments-api',
        mode: 'steer',
        authority: 'inform',
        messageId: 'msg-1',
        sentAt: 1_700_000_000_000,
        external: false,
      },
      body: 'tenant_id is required on ChargeRequest',
      raw: false,
    })
  })

  it('falls back to the logged text, and says so, when the framing is unreadable', () => {
    const odd = {
      ...peerEvent(),
      data: {
        content: [{ type: 'text', text: 'a message from an older framing' }],
        source: PEER_SOURCE,
      },
    } as unknown as Event
    const state = agentMessageDefinition.start(
      contextFor(undefined),
      { event: odd, role: 'start' } as never,
      undefined as never,
    )
    expect(state.body).toBe('a message from an older framing')
    expect(state.raw).toBe(true)
  })

  it('anchors the card immediately above the harness row it explains', () => {
    const state = agentMessageDefinition.start(
      contextFor(undefined),
      { event: peerEvent(42), role: 'start' } as never,
      undefined as never,
    )
    const node = agentMessageDefinition.buildViewNode?.(contextFor(state))
    expect(node).toMatchObject({
      kind: AGENT_MESSAGE_KIND,
      target: 'chat',
      visibility: 'visible',
      anchorSeq: 41.9,
    })
    expect(node?.data).toBe(state)
  })

  it('publishes nothing before its state exists', () => {
    expect(agentMessageDefinition.buildViewNode?.(contextFor(undefined))).toBeNull()
  })
})
