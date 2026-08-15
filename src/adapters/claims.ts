/**
 * On-disk work claims, shared by every session on the machine.
 *
 * Each session owns exactly one file and is its only writer, so concurrent
 * sessions never contend and no lock is needed: publishing is a whole-file
 * atomic replace, and reading is a merge across files. That is the whole
 * concurrency design, and it is why claims cost nothing to maintain.
 *
 * Claims are advisory. A reader treats every record as a hint that may already
 * be stale — the holder may have crashed, or simply moved on.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isExpired, type Claim, type ClaimScope } from '../domain/claim.ts'
import type { Logger } from '../ports/index.ts'

/** Claim file format version. */
export const CLAIMS_VERSION = 1

/** One session's published claim set. */
interface ClaimFile {
  readonly protocol: typeof CLAIMS_VERSION
  readonly sessionId: string
  readonly updatedAt: number
  readonly claims: readonly Claim[]
}

/**
 * Encode a session id as a single safe path segment.
 * @param sessionId - the owning session id.
 * @returns a filesystem-safe segment.
 */
function segmentFor(sessionId: string): string {
  return Buffer.from(sessionId, 'utf8').toString('base64url')
}

/** Reads and publishes work claims under one state directory. */
export class ClaimStore {
  readonly #dir: string
  readonly #logger: Logger

  constructor(options: { stateRoot: string; logger: Logger }) {
    this.#dir = join(options.stateRoot, 'claims')
    this.#logger = options.logger
  }

  /**
   * Replace one session's published claims.
   *
   * Written to a sibling temp file and renamed, so a concurrent reader sees
   * either the previous set or the new one, never a partial write.
   * @param sessionId - the owning session.
   * @param claims - its complete current claim set.
   */
  async publish(sessionId: string, claims: readonly Claim[]): Promise<void> {
    await mkdir(this.#dir, { recursive: true })
    const target = join(this.#dir, `${segmentFor(sessionId)}.json`)

    if (claims.length === 0) {
      // An empty set is an absent file, so a released claim leaves no residue.
      await rm(target, { force: true })
      return
    }

    const file: ClaimFile = {
      protocol: CLAIMS_VERSION,
      sessionId,
      updatedAt: Date.now(),
      claims: [...claims],
    }
    const staging = `${target}.${process.pid}.tmp`
    await writeFile(staging, JSON.stringify(file), 'utf8')
    await rename(staging, target)
  }

  /**
   * Every live claim on this machine.
   *
   * Lapsed claims are filtered on read rather than swept on a timer: expiry is
   * the only release signal that survives a crashed holder, so it has to be
   * evaluated by the reader.
   * @param now - current Unix epoch milliseconds.
   * @returns live claims from every session.
   */
  async readAll(now: number): Promise<readonly Claim[]> {
    let entries: string[]
    try {
      entries = await readdir(this.#dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const claims: Claim[] = []
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map(async (entry) => {
          const file = await this.#read(join(this.#dir, entry))
          if (!file) return
          for (const held of file.claims) {
            if (!isExpired(held, now)) claims.push(held)
          }
        }),
    )
    return claims
  }

  /**
   * One session's own live claims.
   * @param sessionId - the owning session.
   * @param now - current Unix epoch milliseconds.
   * @returns that session's unexpired claims.
   */
  async readOwn(sessionId: string, now: number): Promise<readonly Claim[]> {
    const file = await this.#read(join(this.#dir, `${segmentFor(sessionId)}.json`))
    return file ? file.claims.filter((held) => !isExpired(held, now)) : []
  }

  /**
   * Drop one session's claims entirely. Called when its agent goes away.
   * @param sessionId - the owning session.
   */
  async withdraw(sessionId: string): Promise<void> {
    await rm(join(this.#dir, `${segmentFor(sessionId)}.json`), { force: true })
  }

  async #read(path: string): Promise<ClaimFile | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      return isClaimFile(parsed) ? parsed : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      // One damaged file must not hide every healthy sibling's claims.
      this.#logger.warn(`ignoring unreadable claim file ${path}`)
      return undefined
    }
  }
}

function isClaim(value: unknown): value is Claim {
  if (typeof value !== 'object' || value === null) return false
  const claim = value as Record<string, unknown>
  const scopes: readonly ClaimScope[] = ['path', 'topic']
  return (
    typeof claim['sessionId'] === 'string' &&
    typeof claim['name'] === 'string' &&
    typeof claim['resource'] === 'string' &&
    typeof claim['intent'] === 'string' &&
    typeof claim['claimedAt'] === 'number' &&
    typeof claim['expiresAt'] === 'number' &&
    (scopes as readonly string[]).includes(claim['scope'] as string)
  )
}

function isClaimFile(value: unknown): value is ClaimFile {
  if (typeof value !== 'object' || value === null) return false
  const file = value as Record<string, unknown>
  return (
    file['protocol'] === CLAIMS_VERSION &&
    typeof file['sessionId'] === 'string' &&
    typeof file['updatedAt'] === 'number' &&
    Array.isArray(file['claims']) &&
    file['claims'].every(isClaim)
  )
}
