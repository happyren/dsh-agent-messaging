/**
 * Collaboration accounting: what this plugin cost, and what it caught.
 *
 * Every other feature here is justified by someone else's measured failure
 * rates. None of them is justified by *ours*, and until that changes nobody —
 * including the maintainer — can say whether the plugin improves outcomes or
 * merely adds turns. Anthropic's research system is the cautionary case: it was
 * worth 15× the tokens, and the only reason that is known is that it was
 * measured.
 *
 * So the vocabulary below is deliberately shaped as **cost versus catch** rather
 * than as usage counters. "42 messages sent" says nothing. "42 receiver turns
 * spent, 6 collisions avoided, 3 false claims caught" is a judgement someone can
 * actually make.
 *
 * The audience is the operator, not the model, which is why this surfaces as a
 * report command rather than an eleventh tool competing for model attention.
 */

/** Something worth counting. */
export type MetricKind =
  // ---- cost: turns this plugin caused a receiver to spend ----
  /** A message reached an agent's inbox and will cost it a turn. */
  | 'message-delivered'
  /** Loop control dropped a message as a repeat or over budget. */
  | 'message-dropped'
  /** Inbound policy held a message for operator release. */
  | 'message-held'
  /** Inbound policy refused a message. */
  | 'message-refused'
  /** A message was spooled for a session that was not running. */
  | 'message-spooled'
  // ---- catch: things that would otherwise have gone wrong ----
  /** A claim was taken without conflict. */
  | 'claim-granted'
  /** A claim was refused because a peer held the resource: duplicate work avoided. */
  | 'claim-conflict'
  /** A verification was requested. */
  | 'verification-sent'
  /** A verification came back confirming the claim. */
  | 'verification-confirmed'
  /** A verification came back refuting the claim: a false premise caught. */
  | 'verification-refuted'
  /** A verification could not settle the question either way. */
  | 'verification-unsettled'
  /** A mutual wait was detected at the moment it closed. */
  | 'deadlock-detected'
  /** A decision was recorded in the ledger. */
  | 'decision-recorded'

/** Every {@link MetricKind}, for validation on read. */
export const METRIC_KINDS: readonly MetricKind[] = [
  'message-delivered',
  'message-dropped',
  'message-held',
  'message-refused',
  'message-spooled',
  'claim-granted',
  'claim-conflict',
  'verification-sent',
  'verification-confirmed',
  'verification-refuted',
  'verification-unsettled',
  'deadlock-detected',
  'decision-recorded',
]

/** One counted occurrence. */
export interface MetricEvent {
  readonly kind: MetricKind
  /** Unix epoch milliseconds. */
  readonly at: number
}

/** Counts over a window, grouped as cost and catch. */
export interface CollaborationSummary {
  /** The window's lower bound, or 0 for all of time. */
  readonly since: number
  readonly totalEvents: number
  /** Turns this plugin caused a receiver to spend. */
  readonly cost: {
    readonly receiverTurns: number
    readonly dropped: number
    readonly held: number
    readonly refused: number
    readonly spooled: number
  }
  /** Things that would otherwise have gone wrong. */
  readonly catches: {
    readonly collisionsAvoided: number
    readonly falseClaimsCaught: number
    readonly verificationsConfirmed: number
    readonly verificationsUnsettled: number
    readonly deadlocksDetected: number
  }
  readonly activity: {
    readonly claimsTaken: number
    readonly verificationsRequested: number
    readonly decisionsRecorded: number
  }
}

/**
 * Aggregate raw events into a cost/catch summary.
 *
 * Pure, so the interpretation can be tested without a filesystem or a clock.
 * @param events - every recorded event.
 * @param since - lower bound in Unix epoch milliseconds; 0 for all of time.
 * @returns the summary.
 */
export function summarize(events: readonly MetricEvent[], since = 0): CollaborationSummary {
  const counts = new Map<MetricKind, number>()
  let total = 0
  for (const event of events) {
    if (event.at < since) continue
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1)
    total += 1
  }
  const n = (kind: MetricKind): number => counts.get(kind) ?? 0

  return {
    since,
    totalEvents: total,
    cost: {
      receiverTurns: n('message-delivered'),
      dropped: n('message-dropped'),
      held: n('message-held'),
      refused: n('message-refused'),
      spooled: n('message-spooled'),
    },
    catches: {
      collisionsAvoided: n('claim-conflict'),
      falseClaimsCaught: n('verification-refuted'),
      verificationsConfirmed: n('verification-confirmed'),
      verificationsUnsettled: n('verification-unsettled'),
      deadlocksDetected: n('deadlock-detected'),
    },
    activity: {
      claimsTaken: n('claim-granted'),
      verificationsRequested: n('verification-sent'),
      decisionsRecorded: n('decision-recorded'),
    },
  }
}

/**
 * Render a summary as an operator-readable report.
 *
 * States the honest limit at the bottom rather than implying the counts settle
 * the question: a caught collision is a real save, but nothing here proves the
 * turns spent were worth it.
 * @param summary - the aggregated counts.
 * @returns the report text.
 */
export function renderSummary(summary: CollaborationSummary): string {
  if (summary.totalEvents === 0) {
    return 'No collaboration activity recorded in this window.'
  }

  const { cost, catches, activity } = summary
  const totalCatches =
    catches.collisionsAvoided + catches.falseClaimsCaught + catches.deadlocksDetected

  return [
    'COST — turns this plugin caused a session to spend',
    `  messages delivered        ${cost.receiverTurns}`,
    `  dropped by loop control   ${cost.dropped}`,
    `  held for operator         ${cost.held}`,
    `  refused by policy         ${cost.refused}`,
    `  spooled for later         ${cost.spooled}`,
    '',
    'CAUGHT — what would otherwise have gone wrong',
    `  collisions avoided        ${catches.collisionsAvoided}   (a peer already held the resource)`,
    `  false claims caught       ${catches.falseClaimsCaught}   (verification refuted them)`,
    `  deadlocks detected        ${catches.deadlocksDetected}`,
    '',
    'ACTIVITY',
    `  claims taken              ${activity.claimsTaken}`,
    `  verifications requested   ${activity.verificationsRequested}   (confirmed ${catches.verificationsConfirmed}, unsettled ${catches.verificationsUnsettled})`,
    `  decisions recorded        ${activity.decisionsRecorded}`,
    '',
    `${cost.receiverTurns} receiver turns spent, ${totalCatches} problems caught.`,
    'Read this as evidence, not as a verdict: a caught collision is a real save,',
    'but these counts cannot tell you whether the turns spent were worth it.',
  ].join('\n')
}
