/**
 * Delivery into a live agent hosted by this process.
 *
 * The three delivery modes map onto the inbox boundaries the harness already
 * owns, so a peer message is scheduled by the same machinery as any other
 * model-facing input rather than by a queue of this plugin's own.
 */

import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

import { decideAuthority, type AuthorityPolicy, type PeerAuthority } from '../domain/authority.ts'
import type { DeliveryMode, Envelope } from '../domain/envelope.ts'
import { renderInbound } from '../domain/render.ts'
import type { DeliveryReceipt, InboxSink } from '../ports/index.ts'
import { PLUGIN_NAME } from '../plugin-name.ts'

/**
 * Attribution retained on every delivered peer message.
 *
 * `form: 'relay'` is the harness vocabulary for "a message another agent
 * addressed to this one", the same form the subagent report path uses. The
 * sender's session id travels with it so a transcript can attribute the
 * message, and grants no authority on arrival.
 *
 * The remaining fields exist for one reason: the transcript is the only place a
 * human sees this exchange, and everything a reader needs — who sent it, how it
 * interrupted, what standing it was given — is knowable here and unrecoverable
 * later. The model-facing text is unaffected; this record is read by the UI
 * only. Every field is a plain JSON scalar, because a session log stores it.
 */
export interface PeerMessageSource {
  readonly kind: 'plugin'
  readonly plugin: typeof PLUGIN_NAME
  readonly form: 'relay'
  /**
   * The sending session's id — the authoritative identity, and the field the
   * harness's own relay presentation reads.
   */
  readonly senderSessionId: string
  /** The sender's display name at send time. Presentation only. */
  readonly senderName: string
  /** Which inbox boundary took delivery, so a reader knows what it cost. */
  readonly mode: DeliveryMode
  /** What the receiving model was told it may do with the message. */
  readonly authority: PeerAuthority
  /** Envelope identity, so a reply can be correlated to what it answers. */
  readonly messageId: string
  /** Unix epoch milliseconds the sender stamped on the envelope. */
  readonly sentAt: number
  /** The message this one answers, when it answers one. */
  readonly replyTo?: string
  /**
   * Set when the sender reached this session over A2A rather than a local
   * socket. A reader should weigh a stranger's message differently, and by the
   * time the transcript is read the routing is no longer visible anywhere else.
   */
  readonly external?: true
}

/** Routes admitted envelopes into live agents through the agent registry. */
export class AgentInboxSink implements InboxSink {
  readonly #agents: AgentRegistry
  readonly #authority: AuthorityPolicy

  constructor(agents: AgentRegistry, authority: AuthorityPolicy) {
    this.#agents = agents
    this.#authority = authority
  }

  /**
   * Deliver one envelope to its agent, if that agent is live here.
   * @param envelope - the admitted message.
   * @returns the delivery outcome.
   */
  deliver(envelope: Envelope): DeliveryReceipt {
    const agent = this.#agents.get(envelope.to as SessionId)
    if (!agent) {
      return { status: 'refused', detail: 'The addressed session is not live in this process.' }
    }

    // An external A2A sender is never elevated. The protocol cannot express
    // authority scope, so a stranger must not be able to claim standing by
    // choosing its own identifiers.
    const external = envelope.from.sessionId.startsWith('a2a:')
    const authority = external ? 'inform' : decideAuthority(this.#authority, envelope.from)
    const source: PeerMessageSource = {
      kind: 'plugin',
      plugin: PLUGIN_NAME,
      form: 'relay',
      senderSessionId: envelope.from.sessionId,
      senderName: envelope.from.name,
      mode: envelope.mode,
      authority,
      messageId: envelope.id,
      sentAt: envelope.sentAt,
      ...(envelope.replyTo === undefined ? {} : { replyTo: envelope.replyTo }),
      ...(external ? { external: true as const } : {}),
    }
    const message = createUserMessage({
      content: [{ type: 'text', text: renderInbound(envelope, authority) }],
      source,
    })

    switch (envelope.mode) {
      case 'steer':
        // Nearest step boundary: an idle agent starts a turn, a running agent
        // takes it between steps rather than mid-tool.
        agent.steer(message)
        break
      case 'followup':
        agent.followup(message)
        break
      case 'context':
        // No wake: the agent folds it into whatever it does next.
        agent.inject(message)
        break
    }

    return { status: 'delivered' }
  }
}
