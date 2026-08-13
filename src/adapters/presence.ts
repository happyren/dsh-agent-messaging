/**
 * On-disk presence: which host process currently hosts which sessions, and
 * where its inbox socket lives.
 *
 * This is the only part of the plugin that lets two separate `dsh` processes
 * find each other. Records are advisory — a reader always treats a record as a
 * hint and tolerates a socket that no longer answers.
 */

import { constants as fsConstants } from 'node:fs'
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Logger } from '../ports/index.ts'

/** Presence record format version. */
export const PRESENCE_VERSION = 1

/** One host process's advertised inbox. */
export interface PresenceRecord {
  readonly protocol: typeof PRESENCE_VERSION
  readonly hostId: string
  readonly pid: number
  readonly socketPath: string
  /** Unix epoch milliseconds of the most recent publish. */
  readonly updatedAt: number
  /** Session ids with a live agent in that process. */
  readonly sessions: readonly string[]
}

/**
 * Build the inbox socket path for one host.
 *
 * Sockets live in the temp directory rather than beside the presence records:
 * `sun_path` is capped near 104 bytes on macOS, and a home-relative state
 * directory can exceed that on its own.
 * @param hostId - the short host identifier.
 * @returns an absolute socket path.
 */
export function socketPathFor(hostId: string): string {
  return join(tmpdir(), `dsh-am-${hostId}.sock`)
}

/**
 * Whether a process id currently exists.
 *
 * Signal 0 performs the permission and existence check without delivering a
 * signal. `EPERM` means the process exists under another user, which still
 * counts as alive.
 * @param pid - the process id to probe.
 * @returns whether the process is running.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Reads and publishes host presence records under one state directory. */
export class PresenceStore {
  readonly #dir: string
  readonly #hostId: string
  readonly #socketPath: string
  readonly #logger: Logger

  constructor(options: { stateRoot: string; hostId: string; socketPath: string; logger: Logger }) {
    this.#dir = join(options.stateRoot, 'hosts')
    this.#hostId = options.hostId
    this.#socketPath = options.socketPath
    this.#logger = options.logger
  }

  /** The file this process publishes to. */
  get recordPath(): string {
    return join(this.#dir, `${this.#hostId}.json`)
  }

  /**
   * Publish the sessions this process currently hosts.
   *
   * Written to a sibling temp file and renamed, so a concurrent reader sees
   * either the previous record or the new one, never a partial write.
   * @param sessions - live session ids in this process.
   */
  async publish(sessions: readonly string[]): Promise<void> {
    const record: PresenceRecord = {
      protocol: PRESENCE_VERSION,
      hostId: this.#hostId,
      pid: process.pid,
      socketPath: this.#socketPath,
      updatedAt: Date.now(),
      sessions: [...sessions],
    }
    await mkdir(this.#dir, { recursive: true })
    const target = this.recordPath
    const staging = `${target}.${process.pid}.tmp`
    await writeFile(staging, JSON.stringify(record), 'utf8')
    await rename(staging, target)
  }

  /**
   * Read every other host's presence, pruning records that cannot be real.
   *
   * A record whose process has exited, or whose socket is gone, is removed on
   * sight: nothing else garbage-collects them, and a stale entry would make an
   * unreachable session look reachable.
   * @returns live presence records, excluding this process's own.
   */
  async readPeers(): Promise<readonly PresenceRecord[]> {
    let entries: string[]
    try {
      entries = await readdir(this.#dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const records: PresenceRecord[] = []
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map(async (entry) => {
          const path = join(this.#dir, entry)
          const record = await this.#readRecord(path)
          if (!record) return
          if (record.hostId === this.#hostId) return

          if (!isProcessAlive(record.pid) || !(await pathExists(record.socketPath))) {
            await this.#prune(path)
            return
          }
          records.push(record)
        }),
    )
    return records
  }

  /** Remove this process's record. Called on unload so peers stop seeing it. */
  async withdraw(): Promise<void> {
    await rm(this.recordPath, { force: true })
  }

  async #readRecord(path: string): Promise<PresenceRecord | undefined> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
      return isPresenceRecord(parsed) ? parsed : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      // A truncated or foreign file is not worth failing discovery over.
      this.#logger.warn(`ignoring unreadable presence record ${path}`)
      return undefined
    }
  }

  async #prune(path: string): Promise<void> {
    try {
      await rm(path, { force: true })
    } catch {
      // A racing prune from another host already removed it.
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function isPresenceRecord(value: unknown): value is PresenceRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record['protocol'] === PRESENCE_VERSION &&
    typeof record['hostId'] === 'string' &&
    typeof record['pid'] === 'number' &&
    typeof record['socketPath'] === 'string' &&
    typeof record['updatedAt'] === 'number' &&
    Array.isArray(record['sessions']) &&
    record['sessions'].every((entry) => typeof entry === 'string')
  )
}
