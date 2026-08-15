/**
 * Durable metric recording.
 *
 * Recording is strictly best-effort and never on the critical path: a delivery
 * must not fail, or even slow down, because accounting could not write. Every
 * call is fire-and-forget with its own error containment, and a full or
 * unwritable disk degrades to missing numbers rather than a broken plugin.
 *
 * Events are buffered and flushed on an interval so a busy session does not do
 * one file write per message.
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { METRIC_KINDS, type MetricEvent, type MetricKind } from '../domain/metrics.ts'
import type { Logger } from '../ports/index.ts'

/** Metrics file format version. */
export const METRICS_VERSION = 1

/** Most events retained per host file before the oldest are dropped. */
const MAX_EVENTS = 5_000

interface MetricsFile {
  readonly protocol: number
  readonly events: readonly MetricEvent[]
}

/**
 * Buffers metric events and flushes them to this host's file.
 *
 * Keyed by host rather than session: the interesting questions are about a
 * machine's collaboration as a whole, and per-session files would fragment a
 * count that only means anything when aggregated.
 */
export class MetricsRecorder {
  readonly #dir: string
  readonly #path: string
  readonly #logger: Logger
  #buffer: MetricEvent[] = []
  #timer: NodeJS.Timeout | undefined

  constructor(options: { stateRoot: string; hostId: string; logger: Logger; flushMs: number }) {
    this.#dir = join(options.stateRoot, 'metrics')
    this.#path = join(this.#dir, `${options.hostId}.json`)
    this.#logger = options.logger

    this.#timer = setInterval(() => void this.flush(), options.flushMs)
    // Accounting must never hold the process open.
    this.#timer.unref?.()
  }

  /**
   * Count one occurrence.
   *
   * Synchronous and allocation-light, because this sits inside delivery.
   * @param kind - what happened.
   * @param at - Unix epoch milliseconds.
   */
  record(kind: MetricKind, at: number = Date.now()): void {
    this.#buffer.push({ kind, at })
    if (this.#buffer.length >= 256) void this.flush()
  }

  /**
   * Write buffered events, merging with what is already on disk.
   *
   * Swallows its own failures: a missing count is a worse outcome than a broken
   * delivery only if you believe the numbers matter more than the feature.
   */
  async flush(): Promise<void> {
    if (this.#buffer.length === 0) return
    const pending = this.#buffer
    this.#buffer = []

    try {
      await mkdir(this.#dir, { recursive: true })
      const existing = await this.#read()
      const events = [...existing, ...pending].slice(-MAX_EVENTS)
      const staging = `${this.#path}.${process.pid}.tmp`
      await writeFile(staging, JSON.stringify({ protocol: METRICS_VERSION, events }), 'utf8')
      await rename(staging, this.#path)
    } catch (error) {
      this.#logger.warn(
        `could not record collaboration metrics: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** Stop the flush timer and write what is buffered. */
  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    await this.flush()
  }

  async #read(): Promise<readonly MetricEvent[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, 'utf8'))
      return isMetricsFile(parsed) ? parsed.events : []
    } catch {
      return []
    }
  }
}

/**
 * Read every host's recorded events.
 *
 * Used by the report command rather than by the plugin itself.
 * @param stateRoot - the plugin's state directory.
 * @returns all events, oldest first.
 */
export async function readAllMetrics(stateRoot: string): Promise<readonly MetricEvent[]> {
  const dir = join(stateRoot, 'metrics')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }

  const events: MetricEvent[] = []
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, name), 'utf8'))
      if (isMetricsFile(parsed)) events.push(...parsed.events)
    } catch {
      // One unreadable host file must not hide the rest.
    }
  }
  return events.sort((a, b) => a.at - b.at)
}

function isMetricsFile(value: unknown): value is MetricsFile {
  if (typeof value !== 'object' || value === null) return false
  const file = value as Record<string, unknown>
  return (
    file['protocol'] === METRICS_VERSION &&
    Array.isArray(file['events']) &&
    file['events'].every((event) => {
      if (typeof event !== 'object' || event === null) return false
      const entry = event as Record<string, unknown>
      return (
        typeof entry['at'] === 'number' &&
        (METRIC_KINDS as readonly string[]).includes(entry['kind'] as string)
      )
    })
  )
}
