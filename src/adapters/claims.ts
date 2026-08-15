/**
 * On-disk work claims, shared by every session on the machine.
 *
 * The per-session file mechanics live in {@link SessionDocumentStore}; this adds
 * only what is specific to claims — the entry shape, and the fact that expiry is
 * evaluated on read because it is the only release signal that survives a
 * crashed holder.
 */

import { join } from 'node:path'

import { isExpired, type Claim, type ClaimScope } from '../domain/claim.ts'
import type { Logger } from '../ports/index.ts'
import { SessionDocumentStore } from './session-documents.ts'

/** Claim file format version. */
export const CLAIMS_VERSION = 1

/** Reads and publishes work claims under one state directory. */
export class ClaimStore {
  readonly #store: SessionDocumentStore<Claim>

  constructor(options: { stateRoot: string; logger: Logger }) {
    this.#store = new SessionDocumentStore<Claim>({
      dir: join(options.stateRoot, 'claims'),
      protocol: CLAIMS_VERSION,
      label: 'claim',
      isEntry: isClaim,
      logger: options.logger,
    })
  }

  /**
   * Replace one session's published claims.
   * @param sessionId - the owning session.
   * @param claims - its complete current claim set.
   */
  async publish(sessionId: string, claims: readonly Claim[]): Promise<void> {
    await this.#store.publish(sessionId, claims)
  }

  /**
   * Every live claim on this machine.
   * @param now - current Unix epoch milliseconds.
   * @returns unexpired claims from every session.
   */
  async readAll(now: number): Promise<readonly Claim[]> {
    return (await this.#store.readAll()).filter((claim) => !isExpired(claim, now))
  }

  /**
   * One session's own live claims.
   * @param sessionId - the owning session.
   * @param now - current Unix epoch milliseconds.
   * @returns that session's unexpired claims.
   */
  async readOwn(sessionId: string, now: number): Promise<readonly Claim[]> {
    return (await this.#store.readOwn(sessionId)).filter((claim) => !isExpired(claim, now))
  }

  /**
   * Drop one session's claims entirely. Called when its agent goes away.
   * @param sessionId - the owning session.
   */
  async withdraw(sessionId: string): Promise<void> {
    await this.#store.withdraw(sessionId)
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
