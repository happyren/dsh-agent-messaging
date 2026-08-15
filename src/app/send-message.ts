/**
 * The send use case: resolve an address, build an envelope, hand it to the
 * transport.
 *
 * The sender's identity is a constructor input, never a call argument — a tool
 * caller supplies the recipient and the text, and cannot claim to be someone
 * else.
 */

import { createEnvelope, type DeliveryMode, type Envelope } from '../domain/envelope.ts'
import { PeerError } from '../domain/errors.ts'
import {
  assertFanoutWithinBound,
  membersOf,
  normalizeGroupName,
  resolveFanout,
  type GroupMember,
  type GroupShape,
} from '../domain/group.ts'
import { resolvePeer, type PeerDescriptor } from '../domain/peer.ts'
import type { Clock, DeliveryReceipt, IdFactory, PeerDirectory, PeerTransport } from '../ports/index.ts'

/** What the caller controls about one send. */
export interface SendRequest {
  /** A session id, display name, or distinguishing fragment. */
  readonly to: string
  readonly body: string
  readonly mode: DeliveryMode
  /** The message id being answered, when this is a reply. */
  readonly replyTo?: string
  readonly signal?: AbortSignal
}

/** The sender's own identity, resolved once per call from the executing agent. */
export interface SenderIdentity {
  readonly sessionId: string
  readonly name: string
  readonly cwd?: string
}

/** What the sender learns about a completed group send. */
export interface GroupSendOutcome {
  readonly group: string
  readonly topology: string
  /** One outcome per recipient the topology selected. */
  readonly deliveries: readonly { readonly to: string; readonly status: string; readonly detail?: string }[]
  /** Set when a star topology routed through its lead rather than to everyone. */
  readonly relayedVia?: string
}

/** What the sender learns about a completed send. */
export interface SendOutcome {
  readonly receipt: DeliveryReceipt
  /** The delivered envelope, whose `id` correlates a later reply. */
  readonly envelope: Envelope
  readonly peer: PeerDescriptor
}

/** Resolves an address and delivers one message to it. */
export class MessageSender {
  readonly #directory: PeerDirectory
  readonly #transport: PeerTransport
  readonly #clock: Clock
  readonly #ids: IdFactory

  constructor(deps: {
    directory: PeerDirectory
    transport: PeerTransport
    clock: Clock
    ids: IdFactory
  }) {
    this.#directory = deps.directory
    this.#transport = deps.transport
    this.#clock = deps.clock
    this.#ids = deps.ids
  }

  /**
   * Send one message on behalf of one session.
   * @param sender - the executing agent's identity; not caller-supplied.
   * @param request - recipient, text, and delivery mode.
   * @returns the delivery outcome and the envelope that was sent.
   * @throws {PeerError} when the address does not resolve to exactly one reachable peer.
   */
  async send(sender: SenderIdentity, request: SendRequest): Promise<SendOutcome> {
    const peers = await this.#directory.list(request.signal)
    const addressable = peers.filter((peer) => peer.sessionId !== sender.sessionId)
    const peer = resolvePeer(addressable, request.to)

    const envelope = createEnvelope({
      id: this.#ids.next(),
      sentAt: this.#clock.now(),
      from: {
        sessionId: sender.sessionId,
        name: sender.name,
        ...(sender.cwd === undefined ? {} : { cwd: sender.cwd }),
      },
      to: peer.sessionId,
      mode: request.mode,
      body: request.body,
      ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
    })

    const receipt = await this.#transport.deliver(peer, envelope, request.signal)
    return { receipt, envelope, peer }
  }

  /**
   * Send one message to every member of a group the topology selects.
   *
   * Each recipient is an ordinary send, so inbound policy, loop control and
   * accounting apply per recipient exactly as they would one at a time. A group
   * address is a convenience for the sender, never a way around the receiver.
   * @param sender - the executing agent's identity.
   * @param members - group membership, read from capability cards.
   * @param shape - the operator-declared shape for this group.
   * @param maxFanout - the largest number of recipients permitted.
   * @param request - group address, text, and delivery mode.
   * @returns one outcome per recipient.
   * @throws {PeerError} when the group is empty, unshaped, or over the bound.
   */
  async sendToGroup(
    sender: SenderIdentity,
    members: readonly GroupMember[],
    shape: GroupShape,
    maxFanout: number,
    request: SendRequest,
  ): Promise<GroupSendOutcome> {
    const group = normalizeGroupName(request.to)
    const inGroup = membersOf(members, group)
    if (inGroup.length === 0) {
      throw new PeerError('peer-not-found', `No session has declared membership of #${group}.`)
    }

    const fanout = resolveFanout(inGroup, shape, sender.sessionId)
    if (fanout.recipients.length === 0) {
      throw new PeerError('peer-not-found', `#${group} has no other members to deliver to.`)
    }
    assertFanoutWithinBound(fanout.recipients, maxFanout)

    const peers = await this.#directory.list(request.signal)
    const deliveries: { to: string; status: string; detail?: string }[] = []

    for (const member of fanout.recipients) {
      const peer = peers.find((candidate) => candidate.sessionId === member.sessionId)
      if (!peer) {
        deliveries.push({ to: member.name, status: 'failed', detail: 'no longer reachable' })
        continue
      }
      try {
        const envelope = createEnvelope({
          id: this.#ids.next(),
          sentAt: this.#clock.now(),
          from: {
            sessionId: sender.sessionId,
            name: sender.name,
            ...(sender.cwd === undefined ? {} : { cwd: sender.cwd }),
          },
          to: peer.sessionId,
          mode: request.mode,
          body: request.body,
        })
        const receipt = await this.#transport.deliver(peer, envelope, request.signal)
        deliveries.push({
          // The member name, not the directory name: a group outcome that says
          // "via tech-lead" must not then list that same session by its folded
          // title.
          to: member.name,
          status: receipt.status,
          ...(receipt.detail === undefined ? {} : { detail: receipt.detail }),
        })
      } catch (error) {
        // One unreachable member must not abort delivery to the rest.
        deliveries.push({
          to: member.name,
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return {
      group,
      topology: shape.topology,
      deliveries,
      ...(fanout.relayedVia === undefined ? {} : { relayedVia: fanout.relayedVia.name }),
    }
  }

  /**
   * List the peers this session may address.
   * @param selfSessionId - the calling session, excluded from the result.
   * @param signal - optional cancellation.
   * @returns the addressable peer set.
   */
  async peers(selfSessionId: string, signal?: AbortSignal): Promise<readonly PeerDescriptor[]> {
    const peers = await this.#directory.list(signal)
    return peers.filter((peer) => peer.sessionId !== selfSessionId)
  }
}

/**
 * Turn a domain failure into text a model can act on.
 * @param error - the caught value.
 * @returns guidance naming the next useful step.
 */
export function explainSendFailure(error: unknown): string {
  if (!(error instanceof PeerError)) {
    return error instanceof Error ? error.message : String(error)
  }
  if (error.code === 'peer-ambiguous' && error.candidates?.length) {
    return `${error.message} Candidates: ${error.candidates.join(', ')}.`
  }
  if (error.code === 'peer-not-found') {
    return `${error.message} Call peer_list to see reachable sessions.`
  }
  return error.message
}
