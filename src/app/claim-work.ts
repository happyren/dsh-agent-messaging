/**
 * The claim use case: check a resource, take it, or give it back.
 *
 * The check is the point. Taking a claim is bookkeeping; discovering that a peer
 * already holds the file you were about to edit is what prevents the duplicated
 * work this feature exists to remove.
 */

import { createClaim, findConflicts, type Claim, type ClaimScope } from '../domain/claim.ts'
import { noMetrics, type Clock, type MetricsSink } from '../ports/index.ts'

/** Where claims are read from and written to. */
export interface ClaimRepository {
  readAll(now: number): Promise<readonly Claim[]>
  readOwn(sessionId: string, now: number): Promise<readonly Claim[]>
  publish(sessionId: string, claims: readonly Claim[]): Promise<void>
  withdraw(sessionId: string): Promise<void>
}

/** What the caller controls about one claim attempt. */
export interface ClaimRequest {
  readonly scope: ClaimScope
  readonly resource: string
  readonly intent: string
  readonly ttlMs: number
  /**
   * Take the claim even when a peer holds an overlapping one.
   *
   * The conflict is still reported: this exists so a caller who has already
   * spoken to the holder is not blocked by advice, not so the check can be
   * skipped silently.
   */
  readonly force?: boolean
}

/** The outcome of a claim attempt. */
export interface ClaimOutcome {
  /** Whether the claim is now held by the caller. */
  readonly granted: boolean
  /** Overlapping claims held by peers, soonest to expire first. */
  readonly conflicts: readonly Claim[]
  /** The claim taken, when one was. */
  readonly claim?: Claim
}

/** Reads, takes and releases advisory work claims. */
export class WorkClaims {
  readonly #repository: ClaimRepository
  readonly #clock: Clock
  readonly #metrics: MetricsSink

  constructor(deps: { repository: ClaimRepository; clock: Clock; metrics?: MetricsSink }) {
    this.#repository = deps.repository
    this.#clock = deps.clock
    this.#metrics = deps.metrics ?? noMetrics
  }

  /**
   * Take a claim, unless a peer already holds an overlapping one.
   * @param holder - the claiming session's identity.
   * @param request - what to claim, why, and for how long.
   * @returns whether the claim was granted, and any conflicts found.
   */
  async take(
    holder: { sessionId: string; name: string },
    request: ClaimRequest,
  ): Promise<ClaimOutcome> {
    const now = this.#clock.now()
    const candidate = createClaim({
      sessionId: holder.sessionId,
      name: holder.name,
      scope: request.scope,
      resource: request.resource,
      intent: request.intent,
      now,
      ttlMs: request.ttlMs,
    })

    const conflicts = findConflicts(
      await this.#repository.readAll(now),
      candidate,
      holder.sessionId,
      now,
    )
    if (conflicts.length > 0 && request.force !== true) {
      // The clearest save this plugin produces: a session was about to work a
      // resource a peer already holds, and did not.
      this.#metrics.record('claim-conflict')
      return { granted: false, conflicts }
    }

    // Re-taking the same resource refreshes rather than duplicating it.
    const own = (await this.#repository.readOwn(holder.sessionId, now)).filter(
      (held) => !(held.scope === candidate.scope && held.resource === candidate.resource),
    )
    await this.#repository.publish(holder.sessionId, [...own, candidate])

    this.#metrics.record('claim-granted')
    return { granted: true, conflicts, claim: candidate }
  }

  /**
   * Release one claim, or all of this session's claims.
   * @param sessionId - the holding session.
   * @param target - the claim to drop; omitted, every claim is dropped.
   * @returns how many claims were released.
   */
  async release(
    sessionId: string,
    target?: { scope: ClaimScope; resource: string },
  ): Promise<number> {
    const now = this.#clock.now()
    const own = await this.#repository.readOwn(sessionId, now)
    if (own.length === 0) return 0

    if (!target) {
      await this.#repository.withdraw(sessionId)
      return own.length
    }

    const normalized = createClaim({
      sessionId,
      name: sessionId,
      scope: target.scope,
      resource: target.resource,
      intent: 'release',
      now,
      ttlMs: 1,
    })
    const remaining = own.filter(
      (held) => !(held.scope === normalized.scope && held.resource === normalized.resource),
    )
    if (remaining.length === own.length) return 0

    await this.#repository.publish(sessionId, remaining)
    return own.length - remaining.length
  }

  /**
   * Every live claim on this machine, for display alongside the peer listing.
   * @returns live claims from every session.
   */
  async all(): Promise<readonly Claim[]> {
    return this.#repository.readAll(this.#clock.now())
  }

  /**
   * Drop a session's claims without inspecting them, for agent teardown.
   * @param sessionId - the departing session.
   */
  async withdrawAll(sessionId: string): Promise<void> {
    await this.#repository.withdraw(sessionId)
  }
}
