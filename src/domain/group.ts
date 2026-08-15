/**
 * Groups and topology: addressing several sessions at once, with an explicit
 * shape.
 *
 * Communication topology measurably changes both the efficiency and the quality
 * of multi-agent collaboration, and denser is not automatically better. An
 * implicit all-to-all degrades as sessions multiply — every message costs every
 * receiver a turn — so the shape is a deployment decision an operator states,
 * not something that emerges from who happens to be running.
 *
 * Membership is declared on a session's capability card rather than through a
 * join tool: a session's groups are part of what it is for, which the card
 * already answers, and a separate tool would add surface for a fact that has a
 * natural home.
 */

import { PeerError } from './errors.ts'

/** Prefix distinguishing a group address from a session name. */
export const GROUP_PREFIX = '#'

/** Longest accepted group name. */
const MAX_NAME_CHARS = 48

/** How a message addressed to a group reaches its members. */
export type Topology =
  /** Everyone hears everyone. Simple, and quadratic in turns as members grow. */
  | 'mesh'
  /**
   * Everything passes through a lead.
   *
   * A member's message reaches only the lead; the lead's reaches everyone. Costs
   * far fewer turns than mesh and gives one session the whole picture, at the
   * price of the lead becoming a bottleneck and a single point of failure.
   */
  | 'star'

/** Every {@link Topology}. */
export const TOPOLOGIES: readonly Topology[] = ['mesh', 'star']

/** An operator's declaration of one group's shape. */
export interface GroupShape {
  readonly topology: Topology
  /** The session that relays, for `star`. By display name or session id. */
  readonly lead?: string
}

/** One session's membership, as read from its card. */
export interface GroupMember {
  readonly sessionId: string
  readonly name: string
  readonly groups: readonly string[]
}

/**
 * Whether an address names a group rather than a session.
 * @param address - the raw address.
 * @returns whether it carries the group prefix.
 */
export function isGroupAddress(address: string): boolean {
  return address.trim().startsWith(GROUP_PREFIX)
}

/**
 * Reduce a group name to a comparable identity.
 *
 * The prefix is optional in storage and stripped here, so a card declaring
 * `backend` and a message addressed to `#backend` name the same group.
 * @param name - the raw group name, with or without its prefix.
 * @returns the normalized name.
 * @throws {PeerError} `invalid-body` when the name is empty or oversized.
 */
export function normalizeGroupName(name: string): string {
  const trimmed = name.trim().replace(/^#+/, '').trim().toLowerCase()
  if (!trimmed) throw new PeerError('invalid-body', 'A group needs a name.')
  if (trimmed.length > MAX_NAME_CHARS) {
    throw new PeerError('invalid-body', `Group name exceeds ${MAX_NAME_CHARS} characters.`)
  }
  return trimmed
}

/**
 * The members of one group.
 * @param members - every session with declared memberships.
 * @param group - the normalized group name.
 * @returns members of that group, in the order given.
 */
export function membersOf(
  members: readonly GroupMember[],
  group: string,
): readonly GroupMember[] {
  return members.filter((member) => member.groups.includes(group))
}

/** Who a group message actually reaches, and why. */
export interface Fanout {
  readonly recipients: readonly GroupMember[]
  /** Set when the topology routed through a lead rather than to everyone. */
  readonly relayedVia?: GroupMember
}

/**
 * Decide who receives one message addressed to a group.
 *
 * The sender is always excluded — a session addressing its own group is talking
 * to the others, not to itself.
 * @param members - the group's members.
 * @param shape - the operator-declared shape.
 * @param senderSessionId - the sending session.
 * @returns the recipients, and the lead when one relayed.
 * @throws {PeerError} `peer-not-found` when `star` names a lead that is not a member.
 */
export function resolveFanout(
  members: readonly GroupMember[],
  shape: GroupShape,
  senderSessionId: string,
): Fanout {
  const others = members.filter((member) => member.sessionId !== senderSessionId)

  if (shape.topology === 'mesh') return { recipients: others }

  const wanted = shape.lead?.trim().toLowerCase()
  if (!wanted) {
    throw new PeerError('peer-not-found', 'This group is star-shaped but no lead is configured.')
  }
  const lead = members.find(
    (member) => member.sessionId === shape.lead || member.name.toLowerCase() === wanted,
  )
  if (!lead) {
    throw new PeerError('peer-not-found', `The configured lead "${shape.lead}" is not in this group.`)
  }

  // The lead broadcasts; everyone else reports to the lead. That asymmetry is
  // the entire saving: one message in costs one turn, not N.
  return lead.sessionId === senderSessionId
    ? { recipients: others }
    : { recipients: [lead], relayedVia: lead }
}

/**
 * Bound a fan-out, so one address cannot spend an unbounded number of turns.
 * @param recipients - the resolved recipients.
 * @param max - the largest fan-out permitted.
 * @throws {PeerError} `rate-limited` when the group is larger than the bound.
 */
export function assertFanoutWithinBound(recipients: readonly GroupMember[], max: number): void {
  if (recipients.length > max) {
    throw new PeerError(
      'rate-limited',
      `That group has ${recipients.length} recipients, over the fan-out limit of ${max}. ` +
        'Use a star topology with a lead, or message the sessions that actually need to know.',
    )
  }
}
