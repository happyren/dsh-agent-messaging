/**
 * Work claims: an advisory mark saying "I am working on this".
 *
 * This attacks the largest single failure mode in the MAST taxonomy — step
 * repetition, 15.7% of observed multi-agent failures — whose concrete instance
 * in coding is two sessions editing the same file, or re-deriving a finding a
 * sibling already has.
 *
 * Deliberately stigmergic: a claim is a mark left in a shared medium, read by
 * whoever looks, rather than a negotiation between agents. Nobody spends a model
 * call to coordinate, which is what keeps the mechanism affordable.
 *
 * Deliberately **advisory**. The plugin cannot stop another process writing a
 * file, and a lock that cannot be enforced is worse than an honest hint: it
 * invites callers to skip the check they would otherwise make.
 */

import { PeerError } from './errors.ts'

/** Longest accepted resource string. */
const MAX_RESOURCE_CHARS = 512

/** Longest accepted intent string. */
const MAX_INTENT_CHARS = 280

/** What kind of thing is being claimed. */
export type ClaimScope =
  /** A path in the workspace: a file, or a directory covering everything beneath it. */
  | 'path'
  /** A free-form subject with no filesystem meaning, e.g. `release-notes`. */
  | 'topic'

/** One session's stated intent to work on one resource. */
export interface Claim {
  /** The claiming session. */
  readonly sessionId: string
  /** The claiming session's display name at claim time. Presentation only. */
  readonly name: string
  readonly scope: ClaimScope
  /** Normalized resource identity; see {@link normalizeResource}. */
  readonly resource: string
  /** What the holder is doing with it, for a peer deciding whether to wait or ask. */
  readonly intent: string
  /** Unix epoch milliseconds the claim was made. */
  readonly claimedAt: number
  /** Unix epoch milliseconds after which the claim is ignored. */
  readonly expiresAt: number
}

/** Inputs for {@link createClaim}; time is supplied, never read from a clock. */
export interface ClaimDraft {
  readonly sessionId: string
  readonly name: string
  readonly scope: ClaimScope
  readonly resource: string
  readonly intent: string
  readonly now: number
  readonly ttlMs: number
}

/**
 * Reduce a resource to a comparable identity.
 *
 * Paths are compared as `/`-separated segments with `.`, empty segments, and a
 * leading `./` removed, so `./src/a.ts`, `src//a.ts` and `src/a.ts` are one
 * resource. `..` is rejected rather than resolved: a claim is a label, and
 * letting one escape upward would let a session claim a parent it never named.
 *
 * Topics are lowercased and whitespace-collapsed.
 * @param scope - how to interpret the resource.
 * @param resource - the caller's raw string.
 * @returns the normalized identity.
 * @throws {PeerError} `invalid-body` when the resource is empty, oversized, or
 *   a path containing `..`.
 */
export function normalizeResource(scope: ClaimScope, resource: string): string {
  const trimmed = resource.trim()
  if (!trimmed) throw new PeerError('invalid-body', 'A claim needs a resource.')
  if (trimmed.length > MAX_RESOURCE_CHARS) {
    throw new PeerError('invalid-body', `Resource exceeds ${MAX_RESOURCE_CHARS} characters.`)
  }

  if (scope === 'topic') return trimmed.toLowerCase().replace(/\s+/g, ' ')

  const segments = trimmed.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.includes('..')) {
    throw new PeerError('invalid-body', 'A path claim may not contain "..". Claim the directory itself.')
  }
  if (segments.length === 0) throw new PeerError('invalid-body', 'A claim needs a resource.')
  return segments.join('/')
}

/**
 * Validate a draft and freeze it into a {@link Claim}.
 * @param draft - the claim's facts, including caller-supplied time.
 * @returns the frozen claim.
 * @throws {PeerError} `invalid-body` when the resource or intent is unusable.
 */
export function createClaim(draft: ClaimDraft): Claim {
  const intent = draft.intent.trim()
  if (!intent) throw new PeerError('invalid-body', 'A claim needs an intent, so a peer knows whether to wait.')
  if (intent.length > MAX_INTENT_CHARS) {
    throw new PeerError('invalid-body', `Intent exceeds ${MAX_INTENT_CHARS} characters.`)
  }
  if (!Number.isFinite(draft.ttlMs) || draft.ttlMs <= 0) {
    throw new PeerError('invalid-body', 'A claim needs a positive lifetime.')
  }

  return Object.freeze({
    sessionId: draft.sessionId,
    name: draft.name,
    scope: draft.scope,
    resource: normalizeResource(draft.scope, draft.resource),
    intent,
    claimedAt: draft.now,
    expiresAt: draft.now + draft.ttlMs,
  })
}

/**
 * Whether a claim has lapsed.
 *
 * Expiry is what keeps an abandoned session from holding a resource forever;
 * there is no release-on-crash signal to rely on.
 * @param claim - the claim to test.
 * @param now - current Unix epoch milliseconds.
 * @returns whether the claim should be ignored.
 */
export function isExpired(claim: Claim, now: number): boolean {
  return claim.expiresAt <= now
}

/**
 * Whether two normalized resources overlap.
 *
 * Path claims nest: holding `src` covers `src/a.ts`, because a session working a
 * directory is working the files in it. Segment-wise comparison avoids the
 * prefix bug where `src/apple` looks like a child of `src/app`.
 *
 * Topics do not nest — they have no structure to nest along — so they overlap
 * only when identical.
 * @param scope - the shared scope of both resources.
 * @param a - one normalized resource.
 * @param b - the other normalized resource.
 * @returns whether a claim on one conflicts with a claim on the other.
 */
export function resourcesOverlap(scope: ClaimScope, a: string, b: string): boolean {
  if (a === b) return true
  if (scope === 'topic') return false

  const left = a.split('/')
  const right = b.split('/')
  const shared = Math.min(left.length, right.length)
  for (let i = 0; i < shared; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}

/**
 * The live claims held by other sessions that overlap a candidate resource.
 * @param claims - every known claim, from any session.
 * @param candidate - the resource a session wants to work on.
 * @param selfSessionId - the asking session, whose own claims never conflict.
 * @param now - current Unix epoch milliseconds.
 * @returns conflicting claims, soonest to expire first.
 */
export function findConflicts(
  claims: readonly Claim[],
  candidate: { scope: ClaimScope; resource: string },
  selfSessionId: string,
  now: number,
): readonly Claim[] {
  return claims
    .filter(
      (claim) =>
        claim.sessionId !== selfSessionId &&
        claim.scope === candidate.scope &&
        !isExpired(claim, now) &&
        resourcesOverlap(candidate.scope, claim.resource, candidate.resource),
    )
    .sort((a, b) => a.expiresAt - b.expiresAt)
}
