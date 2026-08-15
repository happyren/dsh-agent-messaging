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
import { noMetrics, type DeliveryReceipt, type MetricsSink, type OutboxSpool, type PeerTransport } from '../../ports/index.ts'
import type { A2AEndpoint } from '../../domain/a2a.ts'
import type { A2AClient } from './a2a-client.ts'
import type { InboxClient } from './inbox-client.ts'

/** Construction inputs for {@link RoutingTransport}. */
export interface RoutingTransportOptions {
  readonly inbound: InboundRouter
  readonly client: InboxClient
  readonly spool: OutboxSpool
  /** Whether a message to a non-running session is spooled or rejected. */
  readonly spoolOffline: boolean
  /** Speaks Agent2Agent to agents outside DSH. */
  readonly a2aClient?: A2AClient
  /** External agents this deployment can reach, keyed by alias. */
  readonly a2aEndpoints?: Record<string, A2AEndpoint>
  /** Where spooling is counted. Defaults to counting nothing. */
  readonly metrics?: MetricsSink
}

/** Routes an envelope to a local agent, a peer host, or the offline spool. */
export class RoutingTransport implements PeerTransport {
  readonly #inbound: InboundRouter
  readonly #client: InboxClient
  readonly #spool: OutboxSpool
  readonly #spoolOffline: boolean
  readonly #metrics: MetricsSink
  readonly #a2aClient: A2AClient | undefined
  readonly #a2aEndpoints: Record<string, A2AEndpoint>

  constructor(options: RoutingTransportOptions) {
    this.#inbound = options.inbound
    this.#client = options.client
    this.#spool = options.spool
    this.#spoolOffline = options.spoolOffline
    this.#metrics = options.metrics ?? noMetrics
    this.#a2aClient = options.a2aClient
    this.#a2aEndpoints = options.a2aEndpoints ?? {}
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

      case 'a2a': {
        const endpoint = this.#a2aEndpoints[peer.location.alias]
        if (!this.#a2aClient || !endpoint) {
          throw new PeerError(
            'peer-unreachable',
            `External agent "${peer.location.alias}" is no longer configured.`,
          )
        }
        return this.#a2aClient.send(endpoint, envelope, signal)
      }

      case 'offline': {
        if (!this.#spoolOffline) {
          throw new PeerError(
            'peer-unreachable',
            `Session "${peer.name}" is not running, and offline spooling is disabled.`,
          )
        }
        await this.#spool.hold(envelope)
        this.#metrics.record('message-spooled')
        return {
          status: 'spooled',
          detail: `Session "${peer.name}" is not running; the message is queued for its next start.`,
        }
      }
    }
  }
}
