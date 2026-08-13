/**
 * How much standing a peer's request has with the receiving session.
 *
 * This is a *prompt-level* control, and the distinction matters. It changes what
 * the receiving model is told about the message; it grants nothing. The real
 * enforcement boundary is the receiving session's own permission rules and
 * sandbox, which apply identically at every authority level — a peer can never
 * widen them, and a message is never consent.
 *
 * The point of the setting is narrower and honest: at `inform`, a receiver that
 * *could* safely do the work still will not, because it is told not to. That is
 * the right default between strangers and the wrong one between two sessions
 * one operator is deliberately running together.
 */

import type { PeerIdentity } from './envelope.ts'

/** What the receiving session may do about a peer's request. */
export type PeerAuthority =
  /** Treat the message as information; act only if the receiver's own user asks. */
  | 'inform'
  /** Act on it directly, still bounded by the receiver's own permissions. */
  | 'act'

/** The receiving session's configured stance toward peers. */
export interface AuthorityPolicy {
  /** Standing granted to a peer on the allowlist. */
  readonly authority: PeerAuthority
  /**
   * Peers the operator has authorised, by display name or session id.
   *
   * Empty means "no peer is elevated" rather than "every peer is": an operator
   * raising `authority` has to say *who*, so a newly appearing session never
   * inherits standing it was never granted.
   */
  readonly trustedPeers: readonly string[]
}

/**
 * Decide one message's standing.
 *
 * Matching is exact on session id or display name — never a substring. A
 * fragment match would let a session whose title happens to contain an
 * authorised name inherit its standing.
 * @param policy - the receiving session's configured stance.
 * @param from - the sender, as the envelope reports them.
 * @returns the authority this message carries.
 */
export function decideAuthority(policy: AuthorityPolicy, from: PeerIdentity): PeerAuthority {
  if (policy.authority === 'inform') return 'inform'

  const authorised = policy.trustedPeers.some(
    (entry) => entry === from.sessionId || entry === from.name,
  )
  return authorised ? 'act' : 'inform'
}
