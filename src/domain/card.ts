/**
 * Capability cards: what a session is for, and what it owns.
 *
 * This attacks two MAST failure modes — disobeying role specification, and task
 * derailment (7.4%) — and role specification was one of only two interventions
 * that work measured directly, at +9.4%.
 *
 * The mechanism is unglamorous: a peer that knows what another session is *for*
 * addresses it about the right things, and a peer that does not guesses from a
 * folded title. A title says what a session was asked once; a card says what it
 * is responsible for now.
 *
 * Shaped after A2A Agent Cards — name, description, skills, ownership — so the
 * same declaration can later serve cross-vendor discovery without a second
 * vocabulary.
 */

import { normalizeResource, type ClaimScope } from './claim.ts'
import { PeerError } from './errors.ts'

/** Longest accepted role description. */
const MAX_ROLE_CHARS = 400

/** Most owned resources one card may declare. */
const MAX_OWNS = 20

/** Most skills one card may declare. */
const MAX_SKILLS = 12

/** Longest accepted skill label. */
const MAX_SKILL_CHARS = 60

/** One session's self-declared purpose and responsibilities. */
export interface CapabilityCard {
  readonly sessionId: string
  /** What this session is for, in its own words. */
  readonly role: string
  /**
   * Resources this session considers itself responsible for.
   *
   * Ownership is a claim about *responsibility*, not a claim on the resource —
   * it does not reserve anything and never conflicts. `peer_claim` is the
   * short-lived reservation; this is the standing answer to "whose is this?".
   */
  readonly owns: readonly OwnedResource[]
  /** Short labels a peer can match a need against, e.g. `sql-migrations`. */
  readonly skills: readonly string[]
  /** Unix epoch milliseconds the card was last published. */
  readonly updatedAt: number
}

/** One resource a session is responsible for. */
export interface OwnedResource {
  readonly scope: ClaimScope
  readonly resource: string
}

/** Inputs for {@link createCard}; time is supplied, never read. */
export interface CardDraft {
  readonly sessionId: string
  readonly role: string
  readonly owns?: readonly { scope?: ClaimScope; resource: string }[]
  readonly skills?: readonly string[]
  readonly now: number
}

/**
 * Validate a draft and freeze it into a {@link CapabilityCard}.
 *
 * Owned resources reuse the claim normalizer, so `./api` and `api/` describe the
 * same thing whether they arrive as ownership or as a reservation — one
 * vocabulary, one comparison rule.
 * @param draft - the card's facts.
 * @returns the frozen card.
 * @throws {PeerError} `invalid-body` when any field is unusable.
 */
export function createCard(draft: CardDraft): CapabilityCard {
  const role = draft.role.trim()
  if (!role) throw new PeerError('invalid-body', 'A card needs a role, or it says nothing a title does not.')
  if (role.length > MAX_ROLE_CHARS) {
    throw new PeerError('invalid-body', `Role exceeds ${MAX_ROLE_CHARS} characters.`)
  }

  const ownsInput = draft.owns ?? []
  if (ownsInput.length > MAX_OWNS) {
    throw new PeerError('invalid-body', `At most ${MAX_OWNS} owned resources are accepted.`)
  }
  const owns = ownsInput.map((entry) => {
    const scope = entry.scope ?? 'path'
    return Object.freeze({ scope, resource: normalizeResource(scope, entry.resource) })
  })

  const skillsInput = draft.skills ?? []
  if (skillsInput.length > MAX_SKILLS) {
    throw new PeerError('invalid-body', `At most ${MAX_SKILLS} skills are accepted.`)
  }
  const skills = skillsInput
    .map((skill) => skill.trim().toLowerCase())
    .filter((skill) => skill.length > 0)
    .map((skill) => {
      if (skill.length > MAX_SKILL_CHARS) {
        throw new PeerError('invalid-body', `Skill "${skill}" exceeds ${MAX_SKILL_CHARS} characters.`)
      }
      return skill
    })

  return Object.freeze({
    sessionId: draft.sessionId,
    role,
    owns: Object.freeze(owns),
    skills: Object.freeze([...new Set(skills)]),
    updatedAt: draft.now,
  })
}

/**
 * Which cards claim responsibility for a resource.
 *
 * Uses the same nesting rule as claims — owning `api` covers `api/charges.ts` —
 * so "who owns this file?" and "who has reserved it?" answer consistently.
 * @param cards - every known card.
 * @param target - the resource being asked about.
 * @returns cards whose ownership covers the target.
 */
export function ownersOf(
  cards: readonly CapabilityCard[],
  target: { scope: ClaimScope; resource: string },
): readonly CapabilityCard[] {
  const wanted = normalizeResource(target.scope, target.resource)
  return cards.filter((card) =>
    card.owns.some((owned) => {
      if (owned.scope !== target.scope) return false
      if (owned.resource === wanted) return true
      if (target.scope === 'topic') return false
      const left = owned.resource.split('/')
      const right = wanted.split('/')
      const shared = Math.min(left.length, right.length)
      for (let i = 0; i < shared; i += 1) {
        if (left[i] !== right[i]) return false
      }
      return true
    }),
  )
}

/**
 * Render a card as one line for a peer listing.
 * @param card - the card to summarize.
 * @returns a compact single-line description, or an empty string when bare.
 */
export function summarizeCard(card: CapabilityCard): string {
  const parts = [card.role]
  if (card.owns.length > 0) parts.push(`owns ${card.owns.map((o) => o.resource).join(', ')}`)
  if (card.skills.length > 0) parts.push(`skills: ${card.skills.join(', ')}`)
  return parts.join(' · ')
}
