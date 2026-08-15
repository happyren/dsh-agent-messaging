/**
 * The card's copy, in the two locales this harness ships.
 *
 * Simplified Chinese is the key-set source of truth, as elsewhere in the
 * harness; English is checked complete against it by the shared key union, so a
 * key added to one and forgotten in the other is a compile error rather than a
 * blank label at runtime.
 */

/** Dictionary namespace owned by this plugin. */
export const LOCALE_NS = 'agentMessaging'

/** Simplified Chinese dictionary. */
export const zh = {
  'card.label': '智能体消息',
  'card.direction': '发给本会话',
  'mode.steer': '打断当前步骤',
  'mode.followup': '下一轮处理',
  'mode.context': '静默送达',
  'authority.inform': '仅供参考',
  'authority.act': '已获授权执行',
  'meta.external': '来自外部智能体',
  'meta.replyTo': '回复 {id}',
  'meta.raw': '按日志原文显示',
} as const

/** English dictionary, complete against the {@link zh} key set. */
export const en: Record<keyof typeof zh, string> = {
  'card.label': 'Agent message',
  'card.direction': 'to this session',
  'mode.steer': 'interrupted this step',
  'mode.followup': 'next turn',
  'mode.context': 'delivered quietly',
  'authority.inform': 'information only',
  'authority.act': 'authorised to act',
  'meta.external': 'from an external agent',
  'meta.replyTo': 'in reply to {id}',
  'meta.raw': 'shown as logged',
}

/** One key of this plugin's dictionary. */
export type AgentMessagingKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's transcript copy. */
    agentMessaging: AgentMessagingKey
  }
}
