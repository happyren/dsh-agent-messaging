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

import { decideAuthority, type AuthorityPolicy } from '../domain/authority.ts'
import type { Envelope } from '../domain/envelope.ts'
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
 */
export interface PeerMessageSource {
  readonly kind: 'plugin'
  readonly plugin: typeof PLUGIN_NAME
  readonly form: 'relay'
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

    const source: PeerMessageSource = { kind: 'plugin', plugin: PLUGIN_NAME, form: 'relay' }
    // An external A2A sender is never elevated. The protocol cannot express
    // authority scope, so a stranger must not be able to claim standing by
    // choosing its own identifiers.
    const authority = envelope.from.sessionId.startsWith('a2a:')
      ? 'inform'
      : decideAuthority(this.#authority, envelope.from)
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
