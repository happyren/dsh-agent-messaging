/**
 * Per-session document files, shared across every process on the machine.
 *
 * The concurrency design is the whole point and is deliberately boring: each
 * session owns exactly one file and is its only writer, so sessions never
 * contend and no lock is needed. Publishing is a whole-file atomic replace;
 * reading merges across files. Extracted because claims and capability cards
 * need precisely this and nothing more.
 *
 * Every record is a hint. A reader tolerates a file whose owner has crashed, and
 * one damaged file never hides a healthy sibling's contents.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Logger } from '../ports/index.ts'

/** Envelope written to disk for one session. */
interface DocumentFile<T> {
  readonly protocol: number
  readonly sessionId: string
  readonly updatedAt: number
  readonly entries: readonly T[]
}

/** Construction inputs for {@link SessionDocumentStore}. */
export interface SessionDocumentStoreOptions<T> {
  /** Absolute directory holding one file per session. */
  readonly dir: string
  /** Format version; a file declaring anything else is ignored. */
  readonly protocol: number
  /** What this store is called in log lines. */
  readonly label: string
  /** Narrows an untrusted parsed value to an entry. */
  readonly isEntry: (value: unknown) => value is T
  readonly logger: Logger
}

/**
 * Encode a session id as a single safe path segment.
 * @param sessionId - the owning session id.
 * @returns a filesystem-safe segment.
 */
function segmentFor(sessionId: string): string {
  return Buffer.from(sessionId, 'utf8').toString('base64url')
}

/** Reads and publishes one document list per session. */
export class SessionDocumentStore<T> {
  readonly #options: SessionDocumentStoreOptions<T>

  constructor(options: SessionDocumentStoreOptions<T>) {
    this.#options = options
  }

  /**
   * Replace one session's entries.
   *
   * An empty list removes the file rather than writing an empty one, so a
   * withdrawn set leaves no residue for a reader to skip past.
   * @param sessionId - the owning session.
   * @param entries - its complete current set.
   */
  async publish(sessionId: string, entries: readonly T[]): Promise<void> {
    const target = this.#pathFor(sessionId)
    if (entries.length === 0) {
      await rm(target, { force: true })
      return
    }

    await mkdir(this.#options.dir, { recursive: true })
    const file: DocumentFile<T> = {
      protocol: this.#options.protocol,
      sessionId,
      updatedAt: Date.now(),
      entries: [...entries],
    }
    const staging = `${target}.${process.pid}.tmp`
    await writeFile(staging, JSON.stringify(file), 'utf8')
    await rename(staging, target)
  }

  /**
   * Every session's entries, merged.
   * @returns all entries, in no guaranteed order.
   */
  async readAll(): Promise<readonly T[]> {
    let names: string[]
    try {
      names = await readdir(this.#options.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const entries: T[] = []
    await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          const file = await this.#read(join(this.#options.dir, name))
          if (file) entries.push(...file.entries)
        }),
    )
    return entries
  }

  /**
   * One session's own entries.
   * @param sessionId - the owning session.
   * @returns that session's entries, or an empty list.
   */
  async readOwn(sessionId: string): Promise<readonly T[]> {
    const file = await this.#read(this.#pathFor(sessionId))
    return file ? file.entries : []
  }

  /**
   * Remove one session's file entirely.
   * @param sessionId - the departing session.
   */
  async withdraw(sessionId: string): Promise<void> {
    await rm(this.#pathFor(sessionId), { force: true })
  }

  #pathFor(sessionId: string): string {
    return join(this.#options.dir, `${segmentFor(sessionId)}.json`)
  }

  async #read(path: string): Promise<DocumentFile<T> | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      return this.#isFile(parsed) ? parsed : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      this.#options.logger.warn(`ignoring unreadable ${this.#options.label} file ${path}`)
      return undefined
    }
  }

  #isFile(value: unknown): value is DocumentFile<T> {
    if (typeof value !== 'object' || value === null) return false
    const file = value as Record<string, unknown>
    return (
      file['protocol'] === this.#options.protocol &&
      typeof file['sessionId'] === 'string' &&
      typeof file['updatedAt'] === 'number' &&
      Array.isArray(file['entries']) &&
      file['entries'].every(this.#options.isEntry)
    )
  }
}
