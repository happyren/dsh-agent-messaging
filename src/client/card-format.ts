/**
 * The small presentation decisions a card makes, kept out of the component.
 *
 * All of it is derivable from the message alone, and none of it needs React —
 * so it is written as pure functions and tested directly, leaving the component
 * with layout only.
 */

import type { PeerMessage } from './peer-message.ts'

/** How many characters of a session id stand in for a missing display name. */
const ID_FRAGMENT_CHARS = 8

/** Distinct hues assigned to peers, spaced far enough apart to tell apart. */
const HUE_STEPS = 12

/**
 * The name to show for a sender.
 *
 * A session that never published a name is shown by a fragment of its id rather
 * than a friendly invention: the reader is looking at an identity they may have
 * to address, and a made-up label would not resolve.
 * @param peer - the arriving message's attribution.
 * @returns the display name.
 */
export function displayName(peer: PeerMessage): string {
  return peer.name ?? peer.sessionId.slice(0, ID_FRAGMENT_CHARS)
}

/**
 * The monogram shown in a sender's avatar.
 *
 * Two initials when the name divides into words, otherwise the first two
 * characters — enough to distinguish peers at a glance without a lookup.
 * @param name - the sender's display name.
 * @returns one or two uppercase characters.
 */
export function monogram(name: string): string {
  const words = name.split(/[\s._/-]+/).filter((word) => word.length > 0)
  if (words.length === 0) return '?'
  if (words.length === 1) return (words[0] as string).slice(0, 2).toUpperCase()
  return `${(words[0] as string)[0] as string}${(words[1] as string)[0] as string}`.toUpperCase()
}

/**
 * A stable colour for one peer.
 *
 * Derived from the session id, not the display name: a session that is retitled
 * mid-run keeps its colour, so a reader tracking "the blue one" is not misled
 * by a rename.
 * @param sessionId - the sender's session id.
 * @returns a hue in degrees.
 */
export function accentHue(sessionId: string): number {
  let hash = 0
  for (let index = 0; index < sessionId.length; index += 1) {
    hash = (hash * 31 + sessionId.charCodeAt(index)) % 360
  }
  return Math.round(hash / (360 / HUE_STEPS)) * (360 / HUE_STEPS)
}

/**
 * Wall-clock time for a card's corner.
 * @param time - Unix epoch milliseconds.
 * @returns `HH:MM` in the reader's own timezone.
 */
export function clockTime(time: number): string {
  const at = new Date(time)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}
