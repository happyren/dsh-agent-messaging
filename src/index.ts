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

import { InboundRouter } from './app/receive-message.ts'
import { MessageSender, type SenderIdentity } from './app/send-message.ts'
import { AgentInboxSink } from './adapters/agent-sink.ts'
import { SessionQueryPeerDirectory } from './adapters/directory.ts'
import { PresenceStore, socketPathFor } from './adapters/presence.ts'
import { FileOutboxSpool } from './adapters/spool.ts'
import { createHostId, resolveStateRoot, systemClock, uuidIdFactory } from './adapters/system.ts'
import { parseEnvelope } from './domain/envelope.ts'
import { InboxClient } from './adapters/transport/inbox-client.ts'
import { InboxServer } from './adapters/transport/inbox-server.ts'
import { RoutingTransport } from './adapters/transport/routing-transport.ts'
import { LoopGuard } from './domain/policy.ts'
import { PLUGIN_NAME } from './plugin-name.ts'
import { createPeerInboxTool } from './tools/peer-inbox.ts'
import { createPeerListTool } from './tools/peer-list.ts'
import { createPeerSendTool } from './tools/peer-send.ts'
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

  const presence = new PresenceStore({ stateRoot, hostId, socketPath, logger })
  const spool = new FileOutboxSpool({
    stateRoot,
    limits: { maxAgeMs: config.spoolMaxAgeMs, maxPerSession: config.spoolMaxPerSession },
    logger,
  })

  const sink = new AgentInboxSink(ctx.agents)
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
  })

  const directory = new SessionQueryPeerDirectory({
    sessionQuery: ctx.sessionQuery,
    agents: ctx.agents,
    presence,
    logger,
    includeSubagents: config.includeSubagents,
  })

  const transport = new RoutingTransport({
    inbound,
    client: new InboxClient({ timeoutMs: config.deliveryTimeoutMs }),
    spool,
    spoolOffline: config.spoolOffline,
  })

  const sender = new MessageSender({
    directory,
    transport,
    clock: systemClock,
    ids: uuidIdFactory,
  })

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

  ctx.effect(() => {
    const disposeList = ctx.tools.register(createPeerListTool(sender))
    const disposeSend = ctx.tools.register(createPeerSendTool(sender, identify))
    const disposeInbox = ctx.tools.register(createPeerInboxTool(inbound))
    return () => {
      disposeList()
      disposeSend()
      disposeInbox()
    }
  }, 'dsh-agent-messaging:tools')

  // Presence must describe what is live *now*: republish whenever the set of
  // local agents changes, and drain anything spooled for an agent that just
  // came up.
  const republish = (): void => {
    void presence
      .publish(ctx.agents.list().map((agent) => agent.id))
      .catch((error: unknown) => {
        logger.warn(`could not publish presence: ${describe(error)}`)
      })
  }

  ctx.on('agent/created', ({ agent }) => {
    republish()
    void deliverSpooled(agent.id)
  })
  ctx.on('agent/disposed', () => republish())

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
        await presence.withdraw().catch(() => undefined)
        if (started) await server.close().catch(() => undefined)
      })()
    }
  }, 'dsh-agent-messaging:inbox')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
