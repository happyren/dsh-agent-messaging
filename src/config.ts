/**
 * Plugin configuration.
 *
 * Anything two deployments might reasonably set differently is a field here
 * rather than a source constant, and every default lives on the schema.
 */

import Schema from '@deepseek-ai/schemastery'

/** Operator-controlled settings for peer messaging. */
export interface Config {
  /** What this session does with messages arriving from peers. */
  inbound: 'accept' | 'hold' | 'refuse'
  /**
   * Whether an authorised peer's request may be acted on directly.
   *
   * Prompt-level only: it changes what the receiving model is told, and grants
   * nothing. The session's own permission rules and sandbox are the enforcement
   * boundary at every level.
   */
  peerAuthority: 'inform' | 'act'
  /** Peers authorised by `peerAuthority: act`, by display name or session id. */
  trustedPeers: string[]
  /** Absolute directory for presence records and the offline spool. Defaults under `$DSH_HOME`. */
  stateRoot?: string
  /** Whether sessions created as subagent children are addressable as peers. */
  includeSubagents: boolean
  /** Whether a message to a non-running session is spooled for its next start. */
  spoolOffline: boolean
  /** Discard a spooled message older than this, in milliseconds. */
  spoolMaxAgeMs: number
  /** Most spooled messages retained per recipient. */
  spoolMaxPerSession: number
  /** Most messages one sender may deliver to one session per {@link rateWindowMs}. */
  rateMaxPerWindow: number
  /** Rolling rate-limit window, in milliseconds. */
  rateWindowMs: number
  /** Window within which an identical body from one sender is dropped, in milliseconds. */
  duplicateWindowMs: number
  /** Most held messages retained per session under the `hold` policy. */
  maxHeld: number
  /** How long to wait for a peer host's receipt, in milliseconds. */
  deliveryTimeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  inbound: Schema.union(['accept', 'hold', 'refuse'] as const)
    .default('accept')
    .description('What this session does with messages arriving from peer sessions.'),
  peerAuthority: Schema.union(['inform', 'act'] as const)
    .default('inform')
    .description(
      'Whether an authorised peer may be acted on directly. Prompt-level only — your permission rules still bound every action.',
    ),
  trustedPeers: Schema.array(Schema.string())
    .default([])
    .description('Peers authorised by peerAuthority: act, matched exactly on display name or session id.'),
  stateRoot: Schema.string().description(
    'Absolute directory for presence records and the offline spool. Defaults to $DSH_HOME/agent-messaging.',
  ),
  includeSubagents: Schema.boolean()
    .default(false)
    .description('Make subagent child sessions addressable. Off by default: children are reached through their parent.'),
  spoolOffline: Schema.boolean()
    .default(true)
    .description('Hold messages addressed to a session that is not running, and deliver them when it next starts.'),
  spoolMaxAgeMs: Schema.number()
    .min(0)
    .default(24 * 60 * 60 * 1000)
    .description('Discard a spooled message older than this.'),
  spoolMaxPerSession: Schema.number()
    .min(1)
    .default(20)
    .description('Most spooled messages retained per recipient session.'),
  rateMaxPerWindow: Schema.number()
    .min(1)
    .default(10)
    .description('Most messages one sender may deliver to one session per rate window.'),
  rateWindowMs: Schema.number()
    .min(1000)
    .default(60_000)
    .description('Rolling rate-limit window.'),
  duplicateWindowMs: Schema.number()
    .min(0)
    .default(30_000)
    .description('Drop an identical body from the same sender inside this window.'),
  maxHeld: Schema.number()
    .min(1)
    .default(100)
    .description('Most held messages retained per session under the hold policy.'),
  deliveryTimeoutMs: Schema.number()
    .min(100)
    .default(5_000)
    .description("How long to wait for a peer host's receipt."),
})
