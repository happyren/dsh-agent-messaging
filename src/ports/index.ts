/**
 * The seams the use cases depend on.
 *
 * Everything here is an interface owned by the inner layers; the harness and
 * Node adapters implement them. Nothing in `domain/` or `app/` imports a
 * framework module, so both are testable with plain objects.
 */

import type { Envelope } from '../domain/envelope.ts'
import type { PeerDescriptor } from '../domain/peer.ts'

/** What happened to one delivery attempt. */
export type DeliveryStatus =
  /** The message reached the receiving agent's inbox. */
  | 'delivered'
  /** The receiver's policy held it for operator release. */
  | 'held'
  /** The receiver's policy dropped it. */
  | 'refused'
  /** Loop control dropped it as a repeat or over budget. */
  | 'dropped'
  /** The receiver was offline; the message was spooled for its next start. */
  | 'spooled'

/** The outcome the sender is told about. */
export interface DeliveryReceipt {
  readonly status: DeliveryStatus
  /** Operator- and model-readable explanation. Always present for a non-delivery. */
  readonly detail?: string
}

/** Discovery over the session corpus. */
export interface PeerDirectory {
  /**
   * List every addressable peer, newest session first.
   * @param signal - optional cancellation for corpus reads.
   * @returns the peer set, excluding the calling session.
   */
  list(signal?: AbortSignal): Promise<readonly PeerDescriptor[]>
}

/** Delivery of one envelope to one already-resolved peer. */
export interface PeerTransport {
  /**
   * Carry an envelope to its addressee.
   * @param peer - the resolved recipient, whose `location` selects the route.
   * @param envelope - the message to deliver.
   * @param signal - optional cancellation.
   * @returns the delivery outcome.
   */
  deliver(peer: PeerDescriptor, envelope: Envelope, signal?: AbortSignal): Promise<DeliveryReceipt>
}

/** Delivery into a live agent hosted by this process. */
export interface InboxSink {
  /**
   * Hand one admitted envelope to its local agent.
   * @param envelope - the message, already past policy and loop control.
   * @returns the delivery outcome.
   */
  deliver(envelope: Envelope): DeliveryReceipt
}

/** Durable holding area for messages addressed to sessions that are not running. */
export interface OutboxSpool {
  /**
   * Retain one envelope until its addressee next starts.
   * @param envelope - the message to hold.
   */
  hold(envelope: Envelope): Promise<void>

  /**
   * Remove and return the messages waiting for one session.
   * @param sessionId - the session that just became live.
   * @returns the waiting envelopes, oldest first, with expired ones already dropped.
   */
  drain(sessionId: string): Promise<readonly Envelope[]>
}

/** Injectable time, so admission and expiry are deterministic under test. */
export interface Clock {
  /** @returns current Unix epoch milliseconds. */
  now(): number
}

/** Injectable identity, so envelope ids are deterministic under test. */
export interface IdFactory {
  /** @returns a fresh unique message id. */
  next(): string
}

/** The subset of the harness logger the plugin uses. */
export interface Logger {
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}
