/**
 * The browser half of this plugin.
 *
 * It contributes exactly one thing: the transcript row for a message another
 * agent session sent to this one. Nothing here talks to the host — the facts
 * the card needs already travel in the durable message record, so the card is a
 * pure read of the session log and the plugin keeps working with this half
 * absent (the harness's own injected-context row renders instead).
 *
 * @module dsh-agent-messaging/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Loaded for its Context augmentations: `slots` and `conversationEvents`.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
// Loaded for its Context augmentation: `locale`.
import type {} from '@deepseek-ai/dsh-client-locale/client'

import { AgentMessageCard } from './AgentMessageCard.tsx'
import { AGENT_MESSAGE_KIND, agentMessageDefinition } from './chat-node.ts'
import { LOCALE_NS, en, zh } from './locales.ts'
import { installStyles } from './styles.ts'

/** Services this half needs: the projection registry, the slot registry, and the copy. */
export const inject = ['conversationEvents', 'slots', 'locale']

/**
 * Register the peer-message row.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  installStyles()

  ctx.effect(
    () => ctx.conversationEvents.register(agentMessageDefinition),
    'agent-messaging: peer message projection',
  )
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'agent-messaging: dictionaries')
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register(
      { name: 'conversation.chat.node', key: AGENT_MESSAGE_KIND, locale: LOCALE_NS },
      AgentMessageCard,
    ),
  )
}
