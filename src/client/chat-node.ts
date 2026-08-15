/**
 * The transcript contribution: one arriving peer message, as its own row.
 *
 * Without this, a peer message renders as the harness's generic injected-context
 * row — correct, but indistinguishable from a skill catalog or a reconciled
 * instruction file, and attributed to an opaque session id. This definition
 * claims the same durable event and publishes a second, richer node anchored
 * just above it, so the card leads and the harness's row stays beneath it as the
 * evidence of what the model actually read.
 *
 * Pure: it reads only the event it is handed, which is what makes the whole
 * projection testable without a browser.
 */

import type { ChatNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ConversationMatch,
  ConversationMatchResult,
  ConversationNodeContext,
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'

import { readPeerBody, readPeerMessage, type PeerMessage } from './peer-message.ts'

/**
 * The durable event a Definition is handed.
 *
 * Taken from the contract rather than imported from the session package
 * directly: the two resolve to the same declaration in a healthy install and to
 * different copies in a hoisted one, and only this form is immune to that.
 */
type MatchedEvent = Parameters<ConversationNodeDefinition['match']>[0]

/** This definition's registered kind, and the renderer key it dispatches to. */
export const AGENT_MESSAGE_KIND = 'agent-message'

/**
 * How far above the harness's own row the card sits.
 *
 * Fractional, like every synthetic anchor in the chat view: the card belongs to
 * the same durable event, so it must order against it rather than take a
 * position of its own.
 */
const CARD_ANCHOR_OFFSET = 0.1

/** One arriving peer message as the card renders it. */
export interface AgentMessageChatData {
  /** Seq of the durable `user/message` this card presents. */
  readonly seq: number
  /** Unix epoch milliseconds the message was logged. */
  readonly time: number
  /** Who sent it, and how it arrived. */
  readonly peer: PeerMessage
  /** What is shown in the card body. */
  readonly body: string
  /**
   * Whether {@link AgentMessageChatData.body} is the raw logged text because the
   * framing could not be read. A card says so rather than presenting harness
   * framing as the sender's words.
   */
  readonly raw: boolean
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    /** One message another agent session addressed to this one. */
    'agent-message': AgentMessageChatData
  }
}

/**
 * Read the model-facing text out of one logged user message.
 * @param content - the durable content blocks.
 * @returns the first text block's text, or an empty string.
 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  for (const block of content as readonly unknown[]) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') return text
    }
  }
  return ''
}

/**
 * Project one matched event into the card's state.
 * @param event - the durable `user/message` event.
 * @returns the card state, or undefined when the event is not a peer message.
 */
function stateOf(event: MatchedEvent): AgentMessageChatData | undefined {
  if (event.type !== 'user/message') return undefined
  const data = event.data as { readonly content?: unknown; readonly source?: unknown }
  const peer = readPeerMessage(data.source)
  if (peer === null) return undefined

  const text = textOf(data.content)
  const body = readPeerBody(text)
  return {
    seq: event.seq,
    time: event.time,
    peer,
    body: body ?? text,
    raw: body === null,
  }
}

/** One arriving peer message, published as its own Chat row. */
export const agentMessageDefinition: ConversationNodeDefinition<AgentMessageChatData> = {
  kind: AGENT_MESSAGE_KIND,
  target: 'chat',

  match(event: MatchedEvent): ConversationMatchResult | null {
    if (event.type !== 'user/message') return null
    // Identity comes from the event's own seq rather than the message id: the
    // seq is what the anchor is derived from, and a card is one durable event.
    return stateOf(event) === undefined ? null : { id: String(event.seq), role: 'start' }
  },

  start(_context: ConversationNodeContext<AgentMessageChatData>, match: ConversationMatch): AgentMessageChatData {
    const state = stateOf(match.event)
    /* v8 ignore next -- match already proved this event projects. */
    if (state === undefined) throw new Error('agent-message start requires a peer message')
    return state
  },

  update(context: ConversationNodeContext<AgentMessageChatData> & { readonly state: AgentMessageChatData }) {
    // A delivered message is settled the moment it is logged; nothing updates it.
    return context.state
  },

  buildViewNode(context: ConversationNodeContext<AgentMessageChatData>): ChatNode<'agent-message'> | null {
    const state = context.state
    if (state === undefined) return null
    return {
      key: context.key,
      kind: AGENT_MESSAGE_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: state.seq - CARD_ANCHOR_OFFSET,
      location: context.start?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: state,
    }
  },
}
