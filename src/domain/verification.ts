/**
 * Verification requests: ask a differently-situated peer to check a claim.
 *
 * This attacks the task-verification category of the MAST taxonomy — 24.5% of
 * observed multi-agent failures — and is the intervention with the largest
 * measured gain in that work (+15.6% from verifying against the high-level
 * objective).
 *
 * The reason it belongs in a *messaging* plugin rather than in an agent's own
 * loop is that self-verification is known to fail: a model asked to check its
 * own reasoning largely cannot. A peer is a different verifier in the way that
 * matters — it holds different context and did not produce the artefact, so it
 * has to go and look rather than re-reading its own conclusion.
 *
 * The structure here exists to make that looking cheap. A claim without evidence
 * pointers forces the verifier to search; with them, it opens two files.
 */

import { PeerError } from './errors.ts'

/** Longest accepted claim statement. */
const MAX_CLAIM_CHARS = 1_000

/** Longest accepted verdict rationale. */
const MAX_RATIONALE_CHARS = 2_000

/** Most evidence pointers one request may carry. */
const MAX_EVIDENCE = 10

/** Where a verifier should look to check a claim. */
export interface Evidence {
  /** A workspace-relative path, commit sha, command, or URL. */
  readonly locator: string
  /** Optional line or range within a file, as written by the claimer. */
  readonly at?: string
  /** Why this is relevant to the claim. */
  readonly note?: string
}

/** What the verifier concluded. */
export type Verdict =
  /** Checked, and the claim holds. */
  | 'confirmed'
  /** Checked, and the claim is wrong. */
  | 'refuted'
  /** Looked, but could not establish either way. */
  | 'inconclusive'
  /** Declined to check — out of scope, or lacking access. */
  | 'declined'

/** Every {@link Verdict}. */
export const VERDICTS: readonly Verdict[] = ['confirmed', 'refuted', 'inconclusive', 'declined']

/** One request for a peer to check something. */
export interface VerificationRequest {
  /** The exact proposition to check, stated so it can be falsified. */
  readonly claim: string
  /** Where to look. Empty is allowed but makes the verifier's job harder. */
  readonly evidence: readonly Evidence[]
}

/** One verifier's answer. */
export interface VerificationVerdict {
  readonly verdict: Verdict
  /** What the verifier actually checked, and what it found. */
  readonly rationale: string
  /** Anything the verifier looked at that the claimer did not cite. */
  readonly evidence: readonly Evidence[]
}

function requireText(value: string, max: number, what: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new PeerError('invalid-body', `A verification ${what} cannot be empty.`)
  if (trimmed.length > max) {
    throw new PeerError('invalid-body', `A verification ${what} exceeds ${max} characters.`)
  }
  return trimmed
}

function normalizeEvidence(evidence: readonly Evidence[]): readonly Evidence[] {
  if (evidence.length > MAX_EVIDENCE) {
    throw new PeerError('invalid-body', `At most ${MAX_EVIDENCE} evidence pointers are accepted.`)
  }
  return Object.freeze(
    evidence.map((item) => {
      const locator = requireText(item.locator, 512, 'evidence locator')
      return Object.freeze({
        locator,
        ...(item.at?.trim() ? { at: item.at.trim() } : {}),
        ...(item.note?.trim() ? { note: item.note.trim() } : {}),
      })
    }),
  )
}

/**
 * Validate and freeze a verification request.
 * @param claim - the proposition to check.
 * @param evidence - where the verifier should look.
 * @returns the frozen request.
 * @throws {PeerError} `invalid-body` when the claim or evidence is unusable.
 */
export function createRequest(claim: string, evidence: readonly Evidence[] = []): VerificationRequest {
  return Object.freeze({
    claim: requireText(claim, MAX_CLAIM_CHARS, 'claim'),
    evidence: normalizeEvidence(evidence),
  })
}

/**
 * Validate and freeze a verdict.
 * @param verdict - the conclusion.
 * @param rationale - what was checked and found.
 * @param evidence - anything additional the verifier consulted.
 * @returns the frozen verdict.
 * @throws {PeerError} `invalid-body` when the verdict or rationale is unusable.
 */
export function createVerdict(
  verdict: Verdict,
  rationale: string,
  evidence: readonly Evidence[] = [],
): VerificationVerdict {
  if (!VERDICTS.includes(verdict)) {
    throw new PeerError('invalid-body', `Unknown verdict "${verdict}".`)
  }
  return Object.freeze({
    verdict,
    rationale: requireText(rationale, MAX_RATIONALE_CHARS, 'rationale'),
    evidence: normalizeEvidence(evidence),
  })
}

/**
 * Render a request as the message body a peer receives.
 *
 * Written as an instruction rather than a data dump because the receiving model
 * has to act on it: the wording tells it to *check* rather than to agree, which
 * is the difference between verification and assent.
 * @param request - the validated request.
 * @returns the message body.
 */
export function renderRequest(request: VerificationRequest): string {
  const lines = [
    'VERIFICATION REQUEST — a peer session is asking you to check a claim, not to agree with it.',
    '',
    'Answer it by calling the peer_verify_reply tool. Do NOT answer with peer_send:',
    'peer_verify_reply carries the typed verdict the asker is waiting on, and a plain',
    'message does not.',
    '',
    `Claim: ${request.claim}`,
  ]

  if (request.evidence.length > 0) {
    lines.push('', 'Where to look:')
    for (const item of request.evidence) {
      const at = item.at ? `:${item.at}` : ''
      const note = item.note ? ` — ${item.note}` : ''
      lines.push(`  - ${item.locator}${at}${note}`)
    }
  }

  lines.push(
    '',
    'Go and look before answering; do not take the claim on trust, and do not assume the',
    'sender checked carefully.',
    '',
    `Then call peer_verify_reply with verdict = one of: ${VERDICTS.join(', ')}`,
    'and a rationale saying what you actually examined.',
  )
  return lines.join('\n')
}

/**
 * Render a verdict as the message body the original claimer receives.
 * @param verdict - the validated verdict.
 * @returns the message body.
 */
export function renderVerdict(verdict: VerificationVerdict): string {
  const lines = [
    `VERIFICATION RESULT — ${verdict.verdict.toUpperCase()}`,
    '',
    verdict.rationale,
  ]
  if (verdict.evidence.length > 0) {
    lines.push('', 'Checked:')
    for (const item of verdict.evidence) {
      const at = item.at ? `:${item.at}` : ''
      const note = item.note ? ` — ${item.note}` : ''
      lines.push(`  - ${item.locator}${at}${note}`)
    }
  }
  if (verdict.verdict === 'refuted') {
    lines.push('', 'Your claim did not survive checking. Re-examine it before acting on it.')
  }
  return lines.join('\n')
}
