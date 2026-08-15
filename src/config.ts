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
  /**
   * Whether to record collaboration counts for `npm run report`.
   *
   * Counts are local, aggregate, and contain no message content — but recording
   * anything at all should be the operator's choice, so it is a switch.
   */
  metrics: boolean
  /** How often buffered counts are flushed to disk, in milliseconds. */
  metricsFlushMs: number
  /**
   * Shape of each named group, keyed by group name without its `#`.
   *
   * Topology is a deployment decision rather than something that emerges from
   * who happens to be running, because denser is not automatically better and
   * every extra recipient costs a turn. A group with no entry here defaults to
   * `mesh`.
   */
  groups: Record<string, { topology: 'mesh' | 'star'; lead?: string }>
  /** Most recipients one group message may reach. */
  maxFanout: number
  /**
   * External agents reachable over Agent2Agent, keyed by a local alias.
   *
   * They appear in `peer_list` and accept `peer_send` like any other peer, and
   * are always treated as untrusted regardless of `peerAuthority`.
   */
  a2aEndpoints: Record<string, { url: string; token?: string }>
  /**
   * Which capabilities register tools.
   *
   * Every tool competes for a model's attention against everything else in the
   * harness, so a deployment that does not use a capability should not pay for
   * its description. All default on so an upgrade never silently removes a tool
   * a workflow depends on; a deployment that wants a lean surface turns off what
   * it does not use.
   */
  capabilities: {
    /** `peer_claim`. Advisory work claims. */
    claims: boolean
    /** `peer_verify`, `peer_verify_reply`. Cross-session verification. */
    verification: boolean
    /** `peer_card`, `peer_status`. Self-declaration and task state. */
    identity: boolean
    /** `peer_decide`, `peer_decisions`. The shared decision ledger. */
    decisions: boolean
  }
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
  metrics: Schema.boolean()
    .default(true)
    .description('Record collaboration counts locally, so `npm run report` can tell you what this cost and caught. No message content is stored.'),
  metricsFlushMs: Schema.number()
    .min(1_000)
    .default(30_000)
    .description('How often buffered counts are flushed to disk.'),
  groups: Schema.dict(
    Schema.object({
      topology: Schema.union(['mesh', 'star'] as const)
        .default('mesh')
        .description('mesh: everyone hears everyone. star: everything passes through the lead.'),
      lead: Schema.string().description('The relaying session for a star group, by name or session id.'),
    }),
  )
    .default({})
    .description('Shape of each named group. A group with no entry defaults to mesh.'),
  maxFanout: Schema.number()
    .min(1)
    .default(8)
    .description('Most recipients one group message may reach, so one address cannot spend unbounded turns.'),
  a2aEndpoints: Schema.dict(
    Schema.object({
      url: Schema.string().required().description('Absolute JSON-RPC endpoint. https, or localhost.'),
      token: Schema.string().description('Optional bearer token.'),
    }),
  )
    .default({})
    .description('External Agent2Agent agents, keyed by local alias. Always treated as untrusted.'),
  capabilities: Schema.object({
    claims: Schema.boolean().default(true).description('peer_claim — advisory work claims.'),
    verification: Schema.boolean()
      .default(true)
      .description('peer_verify and peer_verify_reply — cross-session verification.'),
    identity: Schema.boolean()
      .default(true)
      .description('peer_card and peer_status — self-declaration and task state.'),
    decisions: Schema.boolean()
      .default(true)
      .description('peer_decide and peer_decisions — the shared decision ledger.'),
  })
    .default({ claims: true, verification: true, identity: true, decisions: true })
    .description('Which capabilities register tools. peer_list and peer_send are always registered.'),
})
