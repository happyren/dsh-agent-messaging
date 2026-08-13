/**
 * Inbound admission: what a session does with an arriving message, and the
 * loop control that keeps two chatty agents from talking forever.
 *
 * Both are deterministic — the guard takes `now` as an argument instead of
 * reading a clock — so admission behavior is pinned by tests rather than timing.
 */

import type { Envelope } from './envelope.ts'

/** What a session does with messages arriving from peers. */
export type InboundPolicy =
  /** Deliver every admitted message. */
  | 'accept'
  /** Accept nothing automatically; hold for the operator to release. */
  | 'hold'
  /** Drop arriving messages without delivering them. */
  | 'refuse'

/** The outcome of admitting one envelope. */
export type InboundDecision =
  | { readonly kind: 'deliver' }
  | { readonly kind: 'hold'; readonly reason: string }
  | { readonly kind: 'refuse'; readonly reason: string }

/**
 * Apply a session's inbound policy to one arriving envelope.
 * @param policy - the receiving session's configured policy.
 * @returns the admission decision.
 */
export function decideInbound(policy: InboundPolicy): InboundDecision {
  switch (policy) {
    case 'accept':
      return { kind: 'deliver' }
    case 'hold':
      return { kind: 'hold', reason: 'This session holds peer messages for operator release.' }
    case 'refuse':
      return { kind: 'refuse', reason: 'This session refuses peer messages.' }
  }
}

/** Bounds that stop a message loop between two agents. */
export interface LoopLimits {
  /** Most messages one sender may deliver within {@link windowMs}. */
  readonly maxPerWindow: number
  /** Rolling rate window, in milliseconds. */
  readonly windowMs: number
  /** Window within which an identical body from the same sender is dropped. */
  readonly duplicateWindowMs: number
}

/** Why the guard rejected an envelope, or that it accepted one. */
export type AdmitResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

interface SenderState {
  /** Delivery timestamps inside the current rate window. */
  readonly recent: number[]
  /** Body digest to the time it was last seen. */
  readonly lastBody: Map<string, number>
}

/**
 * Per-sender rate and duplicate suppression for one receiving session.
 *
 * Two agents that answer each other automatically will converge on a loop; the
 * guard makes that loop terminate on its own rather than relying on either
 * agent noticing.
 */
export class LoopGuard {
  readonly #limits: LoopLimits
  readonly #senders = new Map<string, SenderState>()

  constructor(limits: LoopLimits) {
    this.#limits = limits
  }

  /**
   * Decide whether one envelope may be delivered, recording it when it may.
   * @param envelope - the arriving message.
   * @param now - current Unix epoch milliseconds.
   * @returns acceptance, or a reason the sender can act on.
   */
  admit(envelope: Envelope, now: number): AdmitResult {
    const state = this.#stateFor(envelope.from.sessionId)

    const windowStart = now - this.#limits.windowMs
    const recent = state.recent.filter((at) => at > windowStart)
    state.recent.length = 0
    state.recent.push(...recent)

    for (const [body, at] of state.lastBody) {
      if (at <= now - this.#limits.duplicateWindowMs) state.lastBody.delete(body)
    }

    const seenAt = state.lastBody.get(envelope.body)
    if (seenAt !== undefined) {
      return {
        ok: false,
        reason: 'An identical message from this sender arrived moments ago and was dropped.',
      }
    }

    if (recent.length >= this.#limits.maxPerWindow) {
      return {
        ok: false,
        reason: `Sender exceeded ${this.#limits.maxPerWindow} messages per ${Math.round(
          this.#limits.windowMs / 1000,
        )}s to this session.`,
      }
    }

    state.recent.push(now)
    state.lastBody.set(envelope.body, now)
    return { ok: true }
  }

  /**
   * Drop all retained per-sender state.
   *
   * Called on dispose so a reloaded plugin does not inherit a stale rate window.
   */
  clear(): void {
    this.#senders.clear()
  }

  #stateFor(sessionId: string): SenderState {
    const existing = this.#senders.get(sessionId)
    if (existing) return existing
    const created: SenderState = { recent: [], lastBody: new Map() }
    this.#senders.set(sessionId, created)
    return created
  }
}
