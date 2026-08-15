/**
 * What a session can be said to be for before anyone declares it.
 *
 * A published `peer_card` is the good case, and it needs the model to make a
 * tool call before its session is useful to anyone. Models do not do reliable
 * setup, so a listing that says nothing until one does is a listing that is
 * usually empty of meaning. This derives the honest part of a card from facts
 * the workspace already carries — and only the honest part.
 *
 * Deliberately does NOT derive an alias. An alias is an address, and two
 * sessions in one directory would derive the same one, so every peer's send to
 * it becomes ambiguous. A folded display name is unique by construction; a
 * guessed alias is not, which makes it worse than none.
 */

import { createCard, type CapabilityCard } from './card.ts'

/** Longest derived role text, so a stray README paragraph cannot fill a listing. */
const MAX_HEADLINE_CHARS = 160

/** What the workspace can say about one session without asking it. */
export interface WorkspaceFacts {
  readonly sessionId: string
  /** The session's working directory. */
  readonly cwd?: string
  /** The enclosing project root, when one was found (a repository, usually). */
  readonly root?: string
  /**
   * The first meaningful line of the session directory's own `AGENTS.md` or
   * `README.md` — what the humans wrote about this part of the tree.
   */
  readonly headline?: string
}

/**
 * The path from a project root to a directory inside it.
 * @param root - the enclosing project root.
 * @param cwd - the session's working directory.
 * @returns the relative path, or undefined when cwd is not strictly inside root.
 */
function relativeTo(root: string, cwd: string): string | undefined {
  const base = root.endsWith('/') ? root : `${root}/`
  if (!cwd.startsWith(base)) return undefined
  const relative = cwd.slice(base.length).replace(/\/+$/, '')
  return relative.length > 0 ? relative : undefined
}

/**
 * Reduce a document's opening to one line of role text.
 * @param headline - the raw first meaningful line.
 * @returns the trimmed sentence, or undefined when nothing usable survives.
 */
function roleFromHeadline(headline: string): string | undefined {
  const text = headline
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length === 0) return undefined
  return text.length <= MAX_HEADLINE_CHARS ? text : `${text.slice(0, MAX_HEADLINE_CHARS - 1)}…`
}

/**
 * Build the card a session would have if it never published one.
 *
 * Ownership is derived only when the session works in a *subdirectory* of its
 * project: a session sitting at the repository root owns everything, which
 * tells a peer nothing and would collide with every other session there.
 * @param facts - what the workspace knows about this session.
 * @param now - the timestamp to stamp on the derived card.
 * @returns the derived card, or undefined when nothing worth saying was found.
 */
export function deriveCard(facts: WorkspaceFacts, now: number): CapabilityCard | undefined {
  const area =
    facts.cwd !== undefined && facts.root !== undefined ? relativeTo(facts.root, facts.cwd) : undefined
  const role = facts.headline === undefined ? undefined : roleFromHeadline(facts.headline)

  if (area === undefined && role === undefined) return undefined

  const card = createCard({
    sessionId: facts.sessionId,
    role: role ?? `Working in ${area as string}`,
    ...(area === undefined ? {} : { owns: [{ resource: area }] }),
    now,
  })
  return Object.freeze({ ...card, derived: true as const })
}
