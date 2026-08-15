/**
 * Where to look to check something.
 *
 * Shared by verification requests and recorded decisions, because both are
 * claims a reader may want to confirm and neither is worth much without a
 * pointer. A claim with `file:line` is checked in seconds; one without it sends
 * the reader searching, and a reader who has to search usually just believes it.
 */

import { PeerError } from './errors.ts'

/** Most evidence pointers one record may carry. */
export const MAX_EVIDENCE = 10

/** Longest accepted locator. */
const MAX_LOCATOR_CHARS = 512

/** One place to look. */
export interface Evidence {
  /** A workspace-relative path, commit sha, command, or URL. */
  readonly locator: string
  /** Optional line or range within a file, as written by the author. */
  readonly at?: string
  /** Why this is relevant. */
  readonly note?: string
}

/**
 * Validate and freeze a list of evidence pointers.
 * @param evidence - the pointers as supplied.
 * @returns the frozen, trimmed list.
 * @throws {PeerError} `invalid-body` when a locator is empty or the list is oversized.
 */
export function normalizeEvidence(evidence: readonly Evidence[]): readonly Evidence[] {
  if (evidence.length > MAX_EVIDENCE) {
    throw new PeerError('invalid-body', `At most ${MAX_EVIDENCE} evidence pointers are accepted.`)
  }
  return Object.freeze(
    evidence.map((item) => {
      const locator = item.locator.trim()
      if (!locator) throw new PeerError('invalid-body', 'A verification evidence locator cannot be empty.')
      if (locator.length > MAX_LOCATOR_CHARS) {
        throw new PeerError('invalid-body', `An evidence locator exceeds ${MAX_LOCATOR_CHARS} characters.`)
      }
      return Object.freeze({
        locator,
        ...(item.at?.trim() ? { at: item.at.trim() } : {}),
        ...(item.note?.trim() ? { note: item.note.trim() } : {}),
      })
    }),
  )
}

/**
 * Render evidence pointers as indented lines.
 * @param evidence - the pointers to render.
 * @returns one line per pointer.
 */
export function renderEvidence(evidence: readonly Evidence[]): string[] {
  return evidence.map((item) => {
    const at = item.at ? `:${item.at}` : ''
    const note = item.note ? ` — ${item.note}` : ''
    return `  - ${item.locator}${at}${note}`
  })
}

/**
 * Narrow model-supplied rows to evidence, dropping those without a locator.
 * @param rows - whatever a tool caller passed.
 * @returns usable evidence pointers.
 */
export function toEvidence(
  rows: readonly { locator?: string; at?: string; note?: string }[] | undefined,
): readonly Evidence[] {
  return (rows ?? [])
    .filter((row): row is { locator: string; at?: string; note?: string } => Boolean(row?.locator?.trim()))
    .map((row) => ({
      locator: row.locator,
      ...(row.at === undefined ? {} : { at: row.at }),
      ...(row.note === undefined ? {} : { note: row.note }),
    }))
}
