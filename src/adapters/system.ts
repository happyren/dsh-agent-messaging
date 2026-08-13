/**
 * Platform primitives, behind ports so the use cases stay deterministic.
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import type { Clock, IdFactory } from '../ports/index.ts'

/** Wall-clock time. */
export const systemClock: Clock = {
  now: () => Date.now(),
}

/** Random message identity. */
export const uuidIdFactory: IdFactory = {
  next: () => randomUUID(),
}

/** Short, filesystem-safe identity for this host process. */
export function createHostId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

/**
 * Resolve the directory holding presence records and the offline spool.
 *
 * Defaults under `$DSH_HOME` so the plugin's state sits with the rest of the
 * harness's, and is overridable because a deployment may place it elsewhere.
 * @param configured - an operator-supplied absolute path, when set.
 * @returns the absolute state root.
 */
export function resolveStateRoot(configured?: string): string {
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error(`dsh-agent-messaging: stateRoot must be an absolute path, received "${configured}".`)
    }
    return configured
  }
  const dshHome = process.env['DSH_HOME']?.trim()
  const base = dshHome && isAbsolute(dshHome) ? dshHome : join(homedir(), '.dsh')
  return join(base, 'agent-messaging')
}
