/**
 * Cross-session agent-to-agent messaging for DeepSeek Harness.
 *
 * Composition root: builds the object graph, registers the three tools, binds
 * this host's inbox socket, and hands every long-lived resource to the fiber
 * that owns it. Nothing here contains policy — it wires the layers that do.
 *
 * @module dsh-agent-messaging
 */

import type { Context } from '@deepseek-ai/cordis'

import { WorkClaims } from './app/claim-work.ts'
import { InboundRouter } from './app/receive-message.ts'
import { MessageSender, type SenderIdentity } from './app/send-message.ts'
import { AgentInboxSink } from './adapters/agent-sink.ts'
import { CardStore } from './adapters/cards.ts'
import { ClaimStore } from './adapters/claims.ts'
import { MetricsRecorder } from './adapters/metrics.ts'
import { DecisionStore } from './adapters/decisions.ts'
import { TaskStateStore } from './adapters/task-states.ts'
import { SessionQueryPeerDirectory } from './adapters/directory.ts'
import { PresenceStore, socketPathFor } from './adapters/presence.ts'
import { FileOutboxSpool } from './adapters/spool.ts'
import { createHostId, resolveStateRoot, systemClock, uuidIdFactory } from './adapters/system.ts'
import { createEndpoint, type A2AEndpoint } from './domain/a2a.ts'
import { parseEnvelope } from './domain/envelope.ts'
import { A2AClient } from './adapters/transport/a2a-client.ts'
import { InboxClient } from './adapters/transport/inbox-client.ts'
import { InboxServer } from './adapters/transport/inbox-server.ts'
import { RoutingTransport } from './adapters/transport/routing-transport.ts'
import { LoopGuard } from './domain/policy.ts'
import { noMetrics, type MetricsSink } from './ports/index.ts'
import { PLUGIN_NAME } from './plugin-name.ts'
import { createPeerCardTool } from './tools/peer-card.ts'
import { createPeerClaimTool } from './tools/peer-claim.ts'
import { createPeerDecideTool, createPeerDecisionsTool } from './tools/peer-decisions.ts'
import { createPeerInboxTool } from './tools/peer-inbox.ts'
import { createPeerListTool } from './tools/peer-list.ts'
import { createPeerSendTool } from './tools/peer-send.ts'
import { createPeerStatusTool } from './tools/peer-status.ts'
import { createPeerVerifyReplyTool, createPeerVerifyTool } from './tools/peer-verify.ts'
import { Config } from './config.ts'

export const name = PLUGIN_NAME

/**
 * Services this plugin cannot work without.
 *
 * `sessionQuery` supplies the corpus that makes a session addressable, so the
 * plugin stays unloaded rather than degrading to live-agents-only discovery.
 */
export const inject = ['tools', 'agents', 'sessionQuery']

export { Config }
export type { Config as PeerMessagingConfig } from './config.ts'
export type { Envelope, DeliveryMode } from './domain/envelope.ts'
export type { PeerDescriptor } from './domain/peer.ts'

/**
 * Wire and start the plugin.
 * @param ctx - the plugin's Cordis context.
 * @param config - validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const stateRoot = resolveStateRoot(config.stateRoot)
  const hostId = createHostId()
  const socketPath = socketPathFor(hostId)
  const logger = ctx.logger(PLUGIN_NAME)

  const recorder = config.metrics
    ? new MetricsRecorder({ stateRoot, hostId, logger, flushMs: config.metricsFlushMs })
    : undefined
  const metrics: MetricsSink = recorder ?? noMetrics

  const presence = new PresenceStore({ stateRoot, hostId, socketPath, logger })
  const spool = new FileOutboxSpool({
    stateRoot,
    limits: { maxAgeMs: config.spoolMaxAgeMs, maxPerSession: config.spoolMaxPerSession },
    logger,
  })

  const sink = new AgentInboxSink(ctx.agents, {
    authority: config.peerAuthority,
    trustedPeers: config.trustedPeers,
  })
  const inbound = new InboundRouter({
    policy: config.inbound,
    guard: new LoopGuard({
      maxPerWindow: config.rateMaxPerWindow,
      windowMs: config.rateWindowMs,
      duplicateWindowMs: config.duplicateWindowMs,
    }),
    sink,
    clock: systemClock,
    maxHeld: config.maxHeld,
    metrics,
  })

  // A misconfigured endpoint is reported and skipped rather than failing the
  // plugin: local messaging must not stop working because one URL is wrong.
  const a2aEndpoints: Record<string, A2AEndpoint> = {}
  for (const [alias, entry] of Object.entries(config.a2aEndpoints)) {
    try {
      const endpoint = createEndpoint({
        alias,
        url: entry.url,
        ...(entry.token === undefined ? {} : { token: entry.token }),
      })
      a2aEndpoints[endpoint.alias] = endpoint
    } catch (error) {
      logger.warn(`ignoring A2A endpoint "${alias}": ${describe(error)}`)
    }
  }

  const directory = new SessionQueryPeerDirectory({
    sessionQuery: ctx.sessionQuery,
    agents: ctx.agents,
    presence,
    logger,
    includeSubagents: config.includeSubagents,
    a2aEndpoints,
  })

  const transport = new RoutingTransport({
    inbound,
    client: new InboxClient({ timeoutMs: config.deliveryTimeoutMs }),
    spool,
    spoolOffline: config.spoolOffline,
    metrics,
    a2aClient: new A2AClient({ timeoutMs: config.deliveryTimeoutMs }),
    a2aEndpoints,
  })

  const sender = new MessageSender({
    directory,
    transport,
    clock: systemClock,
    ids: uuidIdFactory,
  })

  const claims = new WorkClaims({
    repository: new ClaimStore({ stateRoot, logger }),
    clock: systemClock,
    metrics,
  })

  const cards = new CardStore({ stateRoot, logger })
  const taskStates = new TaskStateStore({ stateRoot, logger })
  const decisions = new DecisionStore({ stateRoot, logger })

  /**
   * Resolve this session's own peer identity from the shared directory, so the
   * name a sender stamps on a message is the same name the recipient would see
   * in its own listing.
   */
  const identify = async (sessionId: string, signal?: AbortSignal): Promise<SenderIdentity> => {
    const peers = await directory.list(signal)
    const self = peers.find((peer) => peer.sessionId === sessionId)
    return {
      sessionId,
      name: self?.name ?? sessionId,
      ...(self?.cwd === undefined ? {} : { cwd: self.cwd }),
    }
  }

  /**
   * Resolve a peer address to its session id, so a wait graph built from
   * human-written names still has one vocabulary.
   */
  const resolveSessionId = async (address: string, signal?: AbortSignal): Promise<string | undefined> => {
    const wanted = address.trim().toLowerCase()
    const peers = await directory.list(signal)
    return peers.find((peer) => peer.sessionId === address || peer.name.toLowerCase() === wanted)?.sessionId
  }

  ctx.effect(() => {
    const enabled = config.capabilities
    const definitions = [
      // Addressing and delivery are the plugin; without them nothing else has a
      // point, so they are not optional.
      createPeerListTool(sender, claims, cards, taskStates),
      createPeerSendTool(sender, identify, cards, config.groups, config.maxFanout),
      // Held messages only exist under the `hold` policy. Registering the tool
      // that reads them anywhere else spends model attention on a list that is
      // always empty.
      ...(config.inbound === 'hold' ? [createPeerInboxTool(inbound)] : []),
      ...(enabled.claims ? [createPeerClaimTool(claims, identify)] : []),
      ...(enabled.verification
        ? [
            createPeerVerifyTool(sender, identify, metrics),
            createPeerVerifyReplyTool(sender, identify, metrics),
          ]
        : []),
      ...(enabled.identity
        ? [
            createPeerCardTool(cards),
            createPeerStatusTool(taskStates, identify, resolveSessionId, metrics),
          ]
        : []),
      ...(enabled.decisions
        ? [
            createPeerDecideTool(decisions, identify, systemClock, uuidIdFactory, metrics),
            createPeerDecisionsTool(decisions),
          ]
        : []),
    ]
    const disposers = definitions.map((definition) => ctx.tools.register(definition))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-agent-messaging:tools')

  // Presence must describe what is live *now*: republish whenever the set of
  // local agents changes.
  const republish = (): void => {
    void presence
      .publish(ctx.agents.list().map((agent) => agent.id))
      .catch((error: unknown) => {
        logger.warn(`could not publish presence: ${describe(error)}`)
      })
  }

  ctx.on('agent/created', () => republish())

  // A departing session's claims must not outlive it, or peers keep deferring to
  // a holder that is gone. Expiry would eventually clear them, but a whole TTL of
  // false conflicts is exactly the duplicated-work stall claims exist to prevent.
  ctx.on('agent/disposed', ({ agent }) => {
    republish()
    void claims.withdrawAll(agent.id).catch((error: unknown) => {
      logger.warn(`could not release claims for ${agent.id}: ${describe(error)}`)
    })
    void cards.withdraw(agent.id).catch((error: unknown) => {
      logger.warn(`could not withdraw card for ${agent.id}: ${describe(error)}`)
    })
    void taskStates.withdraw(agent.id).catch((error: unknown) => {
      logger.warn(`could not withdraw task state for ${agent.id}: ${describe(error)}`)
    })
  })

  // Spooled messages are released at `agent/session-start`, not `agent/created`:
  // creation is composition-only, and this is the first point the harness
  // designates for seeding model-facing context. It fires on resume as well as a
  // fresh start, and re-draining on a `clear` or `compact` restart costs nothing
  // while closing the race where a message is spooled as the agent comes up.
  ctx.on('agent/session-start', ({ agent }) => {
    void deliverSpooled(agent.id)
  })

  const deliverSpooled = async (sessionId: string): Promise<void> => {
    if (!config.spoolOffline) return
    try {
      for (const envelope of await spool.drain(sessionId)) {
        inbound.accept(envelope)
      }
    } catch (error) {
      logger.warn(`could not deliver spooled messages: ${describe(error)}`)
    }
  }

  const server = new InboxServer({
    socketPath,
    // The server has already validated the frame; this narrows it to the type.
    handle: (frame) => inbound.accept(parseEnvelope(frame)),
    logger,
  })

  ctx.effect(() => {
    let started = false
    void server
      .listen()
      .then(() => {
        started = true
        republish()
      })
      .catch((error: unknown) => {
        // Without the socket this host can still send and receive locally; only
        // delivery *from* other host processes is lost.
        logger.warn(`inbox socket unavailable, cross-process delivery is off: ${describe(error)}`)
      })

    return () => {
      inbound.clear()
      void (async () => {
        await recorder?.close().catch(() => undefined)
        await presence.withdraw().catch(() => undefined)
        if (started) await server.close().catch(() => undefined)
      })()
    }
  }, 'dsh-agent-messaging:inbox')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
