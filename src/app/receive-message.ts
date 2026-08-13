/**
 * The receive use case: apply this session's inbound policy and loop control,
 * then hand an admitted envelope to its agent.
 *
 * Every arriving message passes through here, whichever transport carried it,
 * so policy cannot be bypassed by choosing a different route.
 */

import type { Envelope } from '../domain/envelope.ts'
import { decideInbound, LoopGuard, type InboundPolicy } from '../domain/policy.ts'
import type { Clock, DeliveryReceipt, InboxSink } from '../ports/index.ts'

/** One message set aside for operator release. */
export interface HeldMessage {
  readonly envelope: Envelope
  /** Unix epoch milliseconds the message was held. */
  readonly heldAt: number
}

/** Construction inputs for {@link InboundRouter}. */
export interface InboundRouterOptions {
  readonly policy: InboundPolicy
  readonly guard: LoopGuard
  readonly sink: InboxSink
  readonly clock: Clock
  /** Most messages retained for release before the oldest is discarded. */
  readonly maxHeld: number
}

/** Applies admission to arriving envelopes for one host process. */
export class InboundRouter {
  readonly #policy: InboundPolicy
  readonly #guard: LoopGuard
  readonly #sink: InboxSink
  readonly #clock: Clock
  readonly #maxHeld: number
  /** Held messages by recipient session id, oldest first. */
  readonly #held = new Map<string, HeldMessage[]>()

  constructor(options: InboundRouterOptions) {
    this.#policy = options.policy
    this.#guard = options.guard
    this.#sink = options.sink
    this.#clock = options.clock
    this.#maxHeld = options.maxHeld
  }

  /**
   * Admit one arriving envelope and deliver it when policy allows.
   * @param envelope - the message as received.
   * @returns the outcome, reported back to the sender.
   */
  accept(envelope: Envelope): DeliveryReceipt {
    const decision = decideInbound(this.#policy)

    if (decision.kind === 'refuse') {
      return { status: 'refused', detail: decision.reason }
    }

    // Loop control runs before holding as well as before delivering, so a
    // runaway sender cannot fill the held queue either.
    const admitted = this.#guard.admit(envelope, this.#clock.now())
    if (!admitted.ok) {
      return { status: 'dropped', detail: admitted.reason }
    }

    if (decision.kind === 'hold') {
      this.#hold(envelope)
      return { status: 'held', detail: decision.reason }
    }

    return this.#sink.deliver(envelope)
  }

  /**
   * The messages waiting for operator release.
   * @param sessionId - the recipient session.
   * @returns held messages, oldest first.
   */
  held(sessionId: string): readonly HeldMessage[] {
    return this.#held.get(sessionId) ?? []
  }

  /**
   * Release every held message for one session into its agent.
   * @param sessionId - the recipient session.
   * @returns the number of messages delivered.
   */
  release(sessionId: string): number {
    const waiting = this.#held.get(sessionId)
    if (!waiting?.length) return 0
    this.#held.delete(sessionId)
    let delivered = 0
    for (const item of waiting) {
      if (this.#sink.deliver(item.envelope).status === 'delivered') delivered += 1
    }
    return delivered
  }

  /** Discard all retained state on plugin unload. */
  clear(): void {
    this.#held.clear()
    this.#guard.clear()
  }

  #hold(envelope: Envelope): void {
    const queue = this.#held.get(envelope.to) ?? []
    queue.push({ envelope, heldAt: this.#clock.now() })
    while (queue.length > this.#maxHeld) queue.shift()
    this.#held.set(envelope.to, queue)
  }
}
