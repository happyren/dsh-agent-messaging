/**
 * The decision ledger: what was decided, by whom, on what evidence.
 *
 * Attacks loss of conversation history and conversation reset in the MAST
 * taxonomy. Messages are ephemeral — delivered once, folded into a transcript,
 * and gone when that session compacts or ends. Common ground has to outlive
 * them, so it needs a record rather than a conversation ([Klein et al.]).
 *
 * This is the transactive-memory direction from the multi-agent memory
 * literature: rather than replicating every session's context into every other,
 * publish the small durable index of conclusions and let peers query it. A new
 * session joining a repository can read what has already been settled instead of
 * rediscovering it, which is the same waste `peer_claim` prevents in the present
 * tense.
 *
 * Supersession is what stops the ledger becoming a pile of contradictions. A
 * decision is never edited or deleted — a later one replaces it, and the earlier
 * one stays readable as history.
 */

import { normalizeResource, type ClaimScope } from './claim.ts'
import { PeerError } from './errors.ts'
import { normalizeEvidence, renderEvidence, type Evidence } from './evidence.ts'

/** Longest accepted decision statement. */
const MAX_STATEMENT_CHARS = 500

/** Longest accepted rationale. */
const MAX_RATIONALE_CHARS = 1_000

/** One recorded decision. */
export interface Decision {
  /** Unique identity, used to supersede this decision later. */
  readonly id: string
  readonly sessionId: string
  /** The deciding session's display name at the time. Presentation only. */
  readonly name: string
  /** What was decided, stated so a peer can act on it without the discussion. */
  readonly statement: string
  /** Why, when the reasoning is not obvious from the statement. */
  readonly rationale?: string
  /** Where a reader can check it. */
  readonly evidence: readonly Evidence[]
  /** What the decision is about, so peers can ask "what was decided about X?". */
  readonly about?: DecisionSubject
  /** The decision this replaces, when it reverses or refines an earlier one. */
  readonly supersedes?: string
  /** Unix epoch milliseconds the decision was recorded. */
  readonly decidedAt: number
}

/** What a decision concerns. */
export interface DecisionSubject {
  readonly scope: ClaimScope
  readonly resource: string
}

/** Inputs for {@link createDecision}; identity and time are supplied, not read. */
export interface DecisionDraft {
  readonly id: string
  readonly sessionId: string
  readonly name: string
  readonly statement: string
  readonly rationale?: string
  readonly evidence?: readonly Evidence[]
  readonly about?: { scope?: ClaimScope; resource: string }
  readonly supersedes?: string
  readonly now: number
}

/**
 * Validate a draft and freeze it into a {@link Decision}.
 * @param draft - the decision's facts.
 * @returns the frozen decision.
 * @throws {PeerError} `invalid-body` when a field is unusable.
 */
export function createDecision(draft: DecisionDraft): Decision {
  const statement = draft.statement.trim()
  if (!statement) {
    throw new PeerError('invalid-body', 'A decision needs a statement of what was decided.')
  }
  if (statement.length > MAX_STATEMENT_CHARS) {
    throw new PeerError('invalid-body', `Statement exceeds ${MAX_STATEMENT_CHARS} characters.`)
  }

  const rationale = draft.rationale?.trim()
  if (rationale && rationale.length > MAX_RATIONALE_CHARS) {
    throw new PeerError('invalid-body', `Rationale exceeds ${MAX_RATIONALE_CHARS} characters.`)
  }

  let about: DecisionSubject | undefined
  if (draft.about) {
    const scope = draft.about.scope ?? 'path'
    about = Object.freeze({ scope, resource: normalizeResource(scope, draft.about.resource) })
  }

  const supersedes = draft.supersedes?.trim()
  if (supersedes === draft.id) {
    throw new PeerError('invalid-body', 'A decision cannot supersede itself.')
  }

  return Object.freeze({
    id: draft.id,
    sessionId: draft.sessionId,
    name: draft.name,
    statement,
    ...(rationale ? { rationale } : {}),
    evidence: normalizeEvidence(draft.evidence ?? []),
    ...(about ? { about } : {}),
    ...(supersedes ? { supersedes } : {}),
    decidedAt: draft.now,
  })
}

/**
 * The decisions still in force, newest first.
 *
 * A decision is superseded when a later one names it. Nothing is deleted — the
 * full log stays readable — but a peer asking "what is true now?" should not
 * have to reconstruct the chain itself, because that is exactly where an agent
 * acts on a reversed decision.
 * @param decisions - every recorded decision.
 * @returns those not superseded, newest first.
 */
export function foldCurrent(decisions: readonly Decision[]): readonly Decision[] {
  const superseded = new Set<string>()
  for (const decision of decisions) {
    if (decision.supersedes) superseded.add(decision.supersedes)
  }
  return decisions
    .filter((decision) => !superseded.has(decision.id))
    .slice()
    .sort((a, b) => b.decidedAt - a.decidedAt)
}

/**
 * The decisions concerning one resource.
 *
 * Uses the same nesting rule as claims and ownership: a decision about `api`
 * covers `api/charges.ts`, because a rule set for a directory governs the files
 * in it. One vocabulary across every feature that names a resource.
 * @param decisions - the decisions to search.
 * @param target - the resource being asked about.
 * @returns matching decisions, in the order given.
 */
export function decisionsAbout(
  decisions: readonly Decision[],
  target: { scope: ClaimScope; resource: string },
): readonly Decision[] {
  const wanted = normalizeResource(target.scope, target.resource)
  return decisions.filter((decision) => {
    const about = decision.about
    if (!about || about.scope !== target.scope) return false
    if (about.resource === wanted) return true
    if (target.scope === 'topic') return false

    // A decision about a directory governs what is beneath it, and a query about
    // a directory surfaces decisions about its contents.
    const left = about.resource.split('/')
    const right = wanted.split('/')
    const shared = Math.min(left.length, right.length)
    for (let i = 0; i < shared; i += 1) {
      if (left[i] !== right[i]) return false
    }
    return true
  })
}

/**
 * Render decisions as the text a session reads.
 * @param decisions - the decisions to render, already ordered.
 * @returns readable lines.
 */
export function renderDecisions(decisions: readonly Decision[]): string {
  if (decisions.length === 0) return 'No decisions have been recorded.'
  return decisions
    .map((decision) => {
      const when = new Date(decision.decidedAt).toISOString().slice(0, 16).replace('T', ' ')
      const about = decision.about ? ` [${decision.about.resource}]` : ''
      const lines = [`${when} · ${decision.name}${about}`, `  ${decision.statement}`]
      if (decision.rationale) lines.push(`  why: ${decision.rationale}`)
      if (decision.evidence.length > 0) lines.push(...renderEvidence(decision.evidence))
      lines.push(`  id: ${decision.id}`)
      return lines.join('\n')
    })
    .join('\n\n')
}
