/**
 * The on-disk decision ledger.
 *
 * Append-only, but still one file per session — a session appends to its own log
 * and readers merge across all of them. That keeps the single-writer property
 * that makes every other store here lock-free: a shared append log would need
 * coordination between processes, and would corrupt under a torn write.
 *
 * Nothing is ever removed. Superseded decisions stay readable as history, and a
 * session's ledger outlives the session itself — which is the entire point,
 * since the failure being attacked is losing what was already settled.
 */

import { join } from 'node:path'

import type { Decision } from '../domain/decision.ts'
import type { ClaimScope } from '../domain/claim.ts'
import type { Logger } from '../ports/index.ts'
import { SessionDocumentStore } from './session-documents.ts'

/** Ledger file format version. */
export const DECISIONS_VERSION = 1

/**
 * Most decisions retained per session.
 *
 * A bound is necessary — the ledger is never pruned by anything else — and the
 * oldest go first, since a superseded decision from months ago is history a
 * reader is least likely to need.
 */
const MAX_PER_SESSION = 500

/** Reads and appends decisions under one state directory. */
export class DecisionStore {
  readonly #store: SessionDocumentStore<Decision>

  constructor(options: { stateRoot: string; logger: Logger }) {
    this.#store = new SessionDocumentStore<Decision>({
      dir: join(options.stateRoot, 'decisions'),
      protocol: DECISIONS_VERSION,
      label: 'decision',
      isEntry: isDecision,
      logger: options.logger,
    })
  }

  /**
   * Append one decision to its session's log.
   * @param decision - the decision to record.
   */
  async append(decision: Decision): Promise<void> {
    const own = await this.#store.readOwn(decision.sessionId)
    const next = [...own, decision].slice(-MAX_PER_SESSION)
    await this.#store.publish(decision.sessionId, next)
  }

  /**
   * Every recorded decision from every session.
   * @returns all decisions, oldest first.
   */
  async readAll(): Promise<readonly Decision[]> {
    const all = [...(await this.#store.readAll())]
    return all.sort((a, b) => a.decidedAt - b.decidedAt)
  }
}

function isDecision(value: unknown): value is Decision {
  if (typeof value !== 'object' || value === null) return false
  const decision = value as Record<string, unknown>
  const about = decision['about']
  const scopes: readonly ClaimScope[] = ['path', 'topic']

  if (about !== undefined) {
    if (typeof about !== 'object' || about === null) return false
    const subject = about as Record<string, unknown>
    if (
      typeof subject['resource'] !== 'string' ||
      !(scopes as readonly string[]).includes(subject['scope'] as string)
    ) {
      return false
    }
  }

  return (
    typeof decision['id'] === 'string' &&
    typeof decision['sessionId'] === 'string' &&
    typeof decision['name'] === 'string' &&
    typeof decision['statement'] === 'string' &&
    typeof decision['decidedAt'] === 'number' &&
    Array.isArray(decision['evidence'])
  )
}
