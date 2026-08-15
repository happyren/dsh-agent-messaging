/**
 * On-disk capability cards, one per session.
 *
 * Cards have no expiry, unlike claims. A card describes standing responsibility
 * rather than a temporary reservation, so it lives until its session withdraws
 * it — and a session that has gone away is filtered out by the peer directory,
 * which already knows who is live.
 */

import { join } from 'node:path'

import type { CapabilityCard } from '../domain/card.ts'
import type { ClaimScope } from '../domain/claim.ts'
import type { Logger } from '../ports/index.ts'
import { SessionDocumentStore } from './session-documents.ts'

/** Card file format version. */
export const CARDS_VERSION = 1

/** Reads and publishes capability cards under one state directory. */
export class CardStore {
  readonly #store: SessionDocumentStore<CapabilityCard>

  constructor(options: { stateRoot: string; logger: Logger }) {
    this.#store = new SessionDocumentStore<CapabilityCard>({
      dir: join(options.stateRoot, 'cards'),
      protocol: CARDS_VERSION,
      label: 'card',
      isEntry: isCard,
      logger: options.logger,
    })
  }

  /**
   * Replace one session's card.
   * @param card - the card to publish.
   */
  async publish(card: CapabilityCard): Promise<void> {
    await this.#store.publish(card.sessionId, [card])
  }

  /**
   * Every published card.
   * @returns one card per session that has published one.
   */
  async readAll(): Promise<readonly CapabilityCard[]> {
    return this.#store.readAll()
  }

  /**
   * One session's own card.
   * @param sessionId - the owning session.
   * @returns its card, or undefined when it has not published one.
   */
  async readOwn(sessionId: string): Promise<CapabilityCard | undefined> {
    return (await this.#store.readOwn(sessionId))[0]
  }

  /**
   * Drop one session's card. Called when its agent goes away.
   * @param sessionId - the departing session.
   */
  async withdraw(sessionId: string): Promise<void> {
    await this.#store.withdraw(sessionId)
  }
}

function isCard(value: unknown): value is CapabilityCard {
  if (typeof value !== 'object' || value === null) return false
  const card = value as Record<string, unknown>
  const scopes: readonly ClaimScope[] = ['path', 'topic']
  return (
    typeof card['sessionId'] === 'string' &&
    typeof card['role'] === 'string' &&
    typeof card['updatedAt'] === 'number' &&
    Array.isArray(card['skills']) &&
    card['skills'].every((skill) => typeof skill === 'string') &&
    Array.isArray(card['owns']) &&
    card['owns'].every((owned) => {
      if (typeof owned !== 'object' || owned === null) return false
      const entry = owned as Record<string, unknown>
      return (
        typeof entry['resource'] === 'string' &&
        (scopes as readonly string[]).includes(entry['scope'] as string)
      )
    })
  )
}
