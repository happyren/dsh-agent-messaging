/**
 * Durable holding area for messages addressed to sessions that are not running.
 *
 * This is what a live-only transport cannot do: tell a session something now and
 * have it arrive when that session next starts. Retention is deliberately
 * bounded in both age and depth — stale context injected into a session resumed
 * days later is noise, not help.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parseEnvelope, type Envelope } from '../domain/envelope.ts'
import type { Logger, OutboxSpool } from '../ports/index.ts'

/** Retention bounds for spooled messages. */
export interface SpoolLimits {
  /** Discard a message older than this at drain time. */
  readonly maxAgeMs: number
  /** Most messages retained per recipient before the oldest is dropped. */
  readonly maxPerSession: number
}

/**
 * Encode a session id as a single safe path segment.
 *
 * Session ids are opaque and may contain separators, so they are never used as
 * a directory name directly.
 * @param sessionId - the recipient session id.
 * @returns a filesystem-safe segment.
 */
function segmentFor(sessionId: string): string {
  return Buffer.from(sessionId, 'utf8').toString('base64url')
}

/** File-backed implementation of {@link OutboxSpool}. */
export class FileOutboxSpool implements OutboxSpool {
  readonly #root: string
  readonly #limits: SpoolLimits
  readonly #logger: Logger

  constructor(options: { stateRoot: string; limits: SpoolLimits; logger: Logger }) {
    this.#root = join(options.stateRoot, 'spool')
    this.#limits = options.limits
    this.#logger = options.logger
  }

  /**
   * Retain one envelope until its addressee next starts.
   * @param envelope - the message to hold.
   */
  async hold(envelope: Envelope): Promise<void> {
    const dir = join(this.#root, segmentFor(envelope.to))
    await mkdir(dir, { recursive: true })

    // Sortable prefix so a directory listing is chronological without stat calls.
    const name = `${String(envelope.sentAt).padStart(16, '0')}-${envelope.id}.json`
    const target = join(dir, name)
    const staging = `${target}.${process.pid}.tmp`
    await writeFile(staging, JSON.stringify(envelope), 'utf8')
    await rename(staging, target)

    await this.#enforceDepth(dir)
  }

  /**
   * Remove and return the messages waiting for one session.
   * @param sessionId - the session that just became live.
   * @returns waiting envelopes, oldest first, excluding expired ones.
   */
  async drain(sessionId: string): Promise<readonly Envelope[]> {
    const dir = join(this.#root, segmentFor(sessionId))
    const names = await this.#list(dir)
    if (names.length === 0) return []

    const cutoff = Date.now() - this.#limits.maxAgeMs
    const delivered: Envelope[] = []

    for (const name of names) {
      const path = join(dir, name)
      const envelope = await this.#read(path)
      // Remove regardless of outcome: a spooled message is delivered at most once.
      await rm(path, { force: true })
      if (envelope && envelope.sentAt >= cutoff) delivered.push(envelope)
    }

    await rm(dir, { recursive: true, force: true })
    return delivered
  }

  async #list(dir: string): Promise<string[]> {
    try {
      const names = await readdir(dir)
      return names.filter((name) => name.endsWith('.json')).sort()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async #read(path: string): Promise<Envelope | undefined> {
    try {
      return parseEnvelope(JSON.parse(await readFile(path, 'utf8')))
    } catch {
      this.#logger.warn(`discarding unreadable spooled message ${path}`)
      return undefined
    }
  }

  async #enforceDepth(dir: string): Promise<void> {
    const names = await this.#list(dir)
    const excess = names.length - this.#limits.maxPerSession
    if (excess <= 0) return
    await Promise.all(names.slice(0, excess).map((name) => rm(join(dir, name), { force: true })))
  }
}
