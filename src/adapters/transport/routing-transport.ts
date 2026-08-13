/**
 * Chooses a route for one envelope.
 *
 * A local delivery goes through the same {@link InboundRouter} as a socket
 * delivery rather than calling the agent directly. That is deliberate: inbound
 * policy and loop control must not be bypassable by happening to share a
 * process with the recipient.
 */

import type { InboundRouter } from '../../app/receive-message.ts'
import type { Envelope } from '../../domain/envelope.ts'
import { PeerError } from '../../domain/errors.ts'
import type { PeerDescriptor } from '../../domain/peer.ts'
import type { DeliveryReceipt, OutboxSpool, PeerTransport } from '../../ports/index.ts'
import type { InboxClient } from './inbox-client.ts'

/** Construction inputs for {@link RoutingTransport}. */
export interface RoutingTransportOptions {
  readonly inbound: InboundRouter
  readonly client: InboxClient
  readonly spool: OutboxSpool
  /** Whether a message to a non-running session is spooled or rejected. */
  readonly spoolOffline: boolean
}

/** Routes an envelope to a local agent, a peer host, or the offline spool. */
export class RoutingTransport implements PeerTransport {
  readonly #inbound: InboundRouter
  readonly #client: InboxClient
  readonly #spool: OutboxSpool
  readonly #spoolOffline: boolean

  constructor(options: RoutingTransportOptions) {
    this.#inbound = options.inbound
    this.#client = options.client
    this.#spool = options.spool
    this.#spoolOffline = options.spoolOffline
  }

  /**
   * Carry an envelope to its addressee by the route its location implies.
   * @param peer - the resolved recipient.
   * @param envelope - the message to deliver.
   * @param signal - optional cancellation.
   * @returns the delivery outcome.
   * @throws {PeerError} `peer-unreachable` when the target is offline and spooling is disabled.
   */
  async deliver(peer: PeerDescriptor, envelope: Envelope, signal?: AbortSignal): Promise<DeliveryReceipt> {
    switch (peer.location.kind) {
      case 'local':
        return this.#inbound.accept(envelope)

      case 'remote':
        return this.#client.send(peer.location.socketPath, envelope, signal)

      case 'offline': {
        if (!this.#spoolOffline) {
          throw new PeerError(
            'peer-unreachable',
            `Session "${peer.name}" is not running, and offline spooling is disabled.`,
          )
        }
        await this.#spool.hold(envelope)
        return {
          status: 'spooled',
          detail: `Session "${peer.name}" is not running; the message is queued for its next start.`,
        }
      }
    }
  }
}
