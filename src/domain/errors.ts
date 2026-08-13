/**
 * Domain error vocabulary.
 *
 * Every failure a caller can act on differently gets its own `code`. Tools turn
 * a code into model-facing guidance, so codes are part of the plugin's contract
 * and must not be reworded casually.
 */

/** Stable, machine-readable classification for a peer-messaging failure. */
export type PeerErrorCode =
  /** The address matched no session in the corpus. */
  | 'peer-not-found'
  /** The address matched more than one session and cannot be narrowed. */
  | 'peer-ambiguous'
  /** The target exists but nothing can currently deliver to it. */
  | 'peer-unreachable'
  /** The caller addressed its own session. */
  | 'peer-self'
  /** The target's inbound policy refused the message. */
  | 'inbound-refused'
  /** The sender exceeded its rate budget, or repeated an identical message. */
  | 'rate-limited'
  /** The message body failed validation (empty, or over the size bound). */
  | 'invalid-body'
  /** A malformed or unsupported envelope arrived on the wire. */
  | 'invalid-envelope'
  /** The transport failed to carry the envelope. */
  | 'transport-failed'

/** A peer-messaging failure carrying a stable {@link PeerErrorCode}. */
export class PeerError extends Error {
  override readonly name = 'PeerError'

  constructor(
    readonly code: PeerErrorCode,
    message: string,
    /** Optional addresses that made an ambiguous match ambiguous. */
    readonly candidates?: readonly string[],
  ) {
    super(message)
  }
}

/**
 * Narrow an unknown thrown value to a {@link PeerError}.
 * @param value - the caught value.
 * @returns whether the value is a domain error.
 */
export function isPeerError(value: unknown): value is PeerError {
  return value instanceof PeerError
}
