/**
 * Peer identity, naming, and address resolution.
 *
 * A session id is exact but unreadable, so peers also carry a derived display
 * name. Name derivation is deterministic and collision-aware: the same corpus
 * always produces the same names, and two sessions never share one.
 */

import { PeerError } from './errors.ts'

/** Where a peer can be reached from this process. */
export type PeerLocation =
  /** A live agent in this host process; delivery is a direct call. */
  | { readonly kind: 'local' }
  /** A live agent in another host process, reachable over its inbox socket. */
  | { readonly kind: 'remote'; readonly hostId: string; readonly socketPath: string }
  /** Known to the corpus but not currently hosted anywhere. */
  | { readonly kind: 'offline' }

/** One addressable session. */
export interface PeerDescriptor {
  readonly sessionId: string
  /** Unique, human-usable address derived from title, directory, or id. */
  readonly name: string
  /** The session's latest folded title, when it has one. */
  readonly title?: string
  readonly cwd?: string
  /** Unix epoch milliseconds the session was created. */
  readonly createdAt: number
  /** Whether a live agent currently drives this session. */
  readonly live: boolean
  /** The agent's lifecycle state, when it is live in this process. */
  readonly status?: 'idle' | 'running'
  /** Set when the session was created as a subagent child rather than by a user. */
  readonly origin?: 'subagent'
  readonly location: PeerLocation
}

/** The inputs name derivation needs, before a name exists. */
export interface PeerNameSource {
  readonly sessionId: string
  readonly title?: string
  readonly cwd?: string
}

const MAX_NAME_LENGTH = 32

/**
 * Reduce arbitrary text to a compact, address-safe slug.
 * @param text - title or directory text.
 * @returns a lowercase hyphenated slug, or an empty string when nothing survives.
 */
function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/g, '')
}

/**
 * A short stable discriminator for a session id.
 *
 * Deliberately derived from the id's own characters rather than a hash: an id
 * is already unique, and reusing its tail keeps the suffix recognizable when a
 * user reads it back from a listing.
 * @param sessionId - the session id to shorten.
 * @returns up to four address-safe characters.
 */
function discriminator(sessionId: string): string {
  const safe = sessionId.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return safe.length <= 4 ? safe : safe.slice(-4)
}

/**
 * The preferred name for one peer, before collisions are considered.
 * @param source - the session's identifying metadata.
 * @returns the base name.
 */
function baseName(source: PeerNameSource): string {
  const fromTitle = source.title ? slugify(source.title) : ''
  if (fromTitle) return fromTitle

  const fromCwd = source.cwd ? slugify(source.cwd.split('/').filter(Boolean).at(-1) ?? '') : ''
  if (fromCwd) return fromCwd

  return slugify(source.sessionId) || 'session'
}

/**
 * Assign every peer a unique display name.
 *
 * Sessions that share a base name — the common case for several sessions in one
 * repository — each receive an id-derived suffix, so an address a user reads in
 * one listing still resolves in the next.
 * @param sources - identifying metadata for the full peer set.
 * @returns session id to unique display name.
 */
export function assignPeerNames(sources: readonly PeerNameSource[]): ReadonlyMap<string, string> {
  const byBase = new Map<string, PeerNameSource[]>()
  for (const source of sources) {
    const base = baseName(source)
    const bucket = byBase.get(base)
    if (bucket) bucket.push(source)
    else byBase.set(base, [source])
  }

  const names = new Map<string, string>()
  for (const [base, bucket] of byBase) {
    const collides = bucket.length > 1
    for (const source of bucket) {
      names.set(source.sessionId, collides ? `${base}-${discriminator(source.sessionId)}` : base)
    }
  }

  // A suffix can still collide when two ids share a tail; fall back to the id.
  const seen = new Set<string>()
  for (const source of sources) {
    const name = names.get(source.sessionId) as string
    if (seen.has(name)) names.set(source.sessionId, source.sessionId)
    else seen.add(name)
  }
  return names
}

/**
 * Resolve a user- or model-supplied address to exactly one peer.
 *
 * Matching runs most-specific first and stops at the first tier that produces
 * hits, so an exact name is never made ambiguous by an unrelated substring
 * match. A tie within a tier is reported rather than guessed.
 * @param peers - the addressable peer set.
 * @param address - a session id, display name, or distinguishing fragment.
 * @returns the single matching peer.
 * @throws {PeerError} `peer-not-found` when nothing matches.
 * @throws {PeerError} `peer-ambiguous` when the best tier matches several peers.
 */
export function resolvePeer(peers: readonly PeerDescriptor[], address: string): PeerDescriptor {
  const query = address.trim()
  if (!query) throw new PeerError('peer-not-found', 'No address was given.')
  const lowered = query.toLowerCase()

  const tiers: readonly ((peer: PeerDescriptor) => boolean)[] = [
    (peer) => peer.sessionId === query,
    (peer) => peer.name.toLowerCase() === lowered,
    (peer) => peer.name.toLowerCase().includes(lowered),
    (peer) => peer.sessionId.toLowerCase().includes(lowered),
    (peer) => (peer.title ?? '').toLowerCase().includes(lowered),
    (peer) => (peer.cwd ?? '').toLowerCase().includes(lowered),
  ]

  for (const matches of tiers) {
    const hits = peers.filter(matches)
    if (hits.length === 1) return hits[0] as PeerDescriptor
    if (hits.length > 1) {
      throw new PeerError(
        'peer-ambiguous',
        `"${query}" matches ${hits.length} sessions. Use one of these names, or a session id.`,
        hits.map((peer) => peer.name),
      )
    }
  }

  throw new PeerError('peer-not-found', `No session matches "${query}".`)
}
