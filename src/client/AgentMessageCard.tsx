/**
 * One arriving peer message, rendered as its own card.
 *
 * What the card exists to answer, in the order a reader asks it: is this from a
 * person or another agent, which agent, what did it cost me (did it interrupt),
 * what is this session allowed to do about it, and only then — what does it
 * say. The harness's own injected-context row stays directly beneath, holding
 * the exact text the model read; this card never claims to be that text.
 *
 * Layout only. Every derived value comes from the pure helpers beside it, so the
 * component has nothing in it that needs a browser to test.
 */

import { memo } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

import type { AgentMessageChatData } from './chat-node.ts'
import { accentHue, clockTime, displayName, monogram } from './card-format.ts'
import { css } from './styles.ts'
import { LOCALE_NS } from './locales.ts'

/** Composed props of the `agent-message` chat renderer. */
export type AgentMessageCardProps = PropsRuntime<'conversation.chat.node', 'agent-message'> &
  PropsLocale<typeof LOCALE_NS>

/**
 * Render one peer message card.
 * @param props - the chat node and the locale seat.
 * @returns the card.
 */
function AgentMessageCardView({ node, t }: AgentMessageCardProps) {
  const data: AgentMessageChatData = node.data
  const { peer } = data
  const name = displayName(peer)

  return (
    <div
      className={css.root}
      style={{ ['--dsh-am-hue' as string]: String(accentHue(peer.sessionId)) }}
      data-agent-message-from={peer.sessionId}
      aria-label={t('card.label')}
    >
      <div className={css.head}>
        <span className={css.avatar} aria-hidden="true">
          {monogram(name)}
        </span>
        <span className={css.who}>
          <span className={css.name} title={peer.sessionId}>
            {name}
          </span>
          <span className={css.direction}>{t('card.direction')}</span>
        </span>
        <span className={css.pills}>
          {peer.mode === undefined ? null : <span className={css.pill}>{t(`mode.${peer.mode}`)}</span>}
          {peer.authority === undefined ? null : (
            // Only `act` is coloured: it is the one that changes what this
            // session may do, and a warned pill on every message would make the
            // one that matters invisible.
            <span className={peer.authority === 'act' ? `${css.pill} ${css.pillWarn}` : css.pill}>
              {t(`authority.${peer.authority}`)}
            </span>
          )}
          {peer.external ? <span className={`${css.pill} ${css.pillWarn}`}>{t('meta.external')}</span> : null}
        </span>
        {peer.sentAt === undefined ? null : <span className={css.time}>{clockTime(peer.sentAt)}</span>}
      </div>

      <p className={css.body}>{data.body}</p>

      {peer.replyTo === undefined && !data.raw ? null : (
        <p className={css.meta}>
          {peer.replyTo === undefined ? null : <span>{t('meta.replyTo', { id: peer.replyTo })}</span>}
          {data.raw ? <span>{t('meta.raw')}</span> : null}
        </p>
      )}
    </div>
  )
}

/** Keyed Chat renderer for one message from another agent session. */
export const AgentMessageCard = memo(AgentMessageCardView)
