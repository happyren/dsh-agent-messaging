/**
 * Delivers an envelope to an external agent over Agent2Agent.
 *
 * Slots in beside the Unix-socket client behind the same `PeerTransport` seam,
 * which is what the port existed for: swapping how a message travels without
 * touching the use cases that decide whether it should.
 */

import { readA2AResponse, toA2ARequest, type A2AEndpoint } from '../../domain/a2a.ts'
import type { Envelope } from '../../domain/envelope.ts'
import { PeerError } from '../../domain/errors.ts'
import type { DeliveryReceipt } from '../../ports/index.ts'

/** Posts JSON-RPC `message/send` to an external agent. */
export class A2AClient {
  readonly #timeoutMs: number

  constructor(options: { timeoutMs: number }) {
    this.#timeoutMs = options.timeoutMs
  }

  /**
   * Deliver one envelope to an external agent.
   * @param endpoint - the configured target.
   * @param envelope - the message to send.
   * @param signal - optional caller cancellation.
   * @returns the delivery outcome.
   * @throws {PeerError} `transport-failed` on a network, timeout, or protocol failure.
   */
  async send(
    endpoint: A2AEndpoint,
    envelope: Envelope,
    signal?: AbortSignal,
  ): Promise<DeliveryReceipt> {
    // An already-aborted signal never fires its event, so a caller that
    // cancelled before calling would otherwise have its message delivered.
    if (signal?.aborted) {
      throw new PeerError('transport-failed', `Delivery to "${endpoint.alias}" was cancelled.`)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    timer.unref?.()
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}),
        },
        body: JSON.stringify(toA2ARequest(envelope)),
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new PeerError(
          'transport-failed',
          `A2A peer "${endpoint.alias}" answered ${response.status}.`,
        )
      }

      const outcome = readA2AResponse(await response.json())
      return outcome.accepted
        ? { status: 'delivered' }
        : {
            status: 'refused',
            ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
          }
    } catch (error) {
      if (error instanceof PeerError) throw error
      const reason =
        controller.signal.aborted && signal?.aborted !== true
          ? `did not answer within ${this.#timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error)
      throw new PeerError('transport-failed', `A2A peer "${endpoint.alias}" ${reason}.`)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}
