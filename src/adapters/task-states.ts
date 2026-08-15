/**
 * On-disk task states, one per session.
 *
 * Like cards, a state has no expiry: it stands until the session replaces or
 * withdraws it. Unlike a claim, a stale `working` is not dangerous — the peer
 * directory already reports whether the session is live at all, and a state from
 * a session that has gone is filtered there.
 */

import { join } from 'node:path'

import type { TaskPhase, TaskState } from '../domain/task-state.ts'
import { TASK_PHASES } from '../domain/task-state.ts'
import type { Logger } from '../ports/index.ts'
import { SessionDocumentStore } from './session-documents.ts'

/** Task-state file format version. */
export const TASK_STATE_VERSION = 1

/** Reads and publishes task states under one state directory. */
export class TaskStateStore {
  readonly #store: SessionDocumentStore<TaskState>

  constructor(options: { stateRoot: string; logger: Logger }) {
    this.#store = new SessionDocumentStore<TaskState>({
      dir: join(options.stateRoot, 'task-states'),
      protocol: TASK_STATE_VERSION,
      label: 'task state',
      isEntry: isTaskState,
      logger: options.logger,
    })
  }

  /**
   * Replace one session's declared state.
   * @param state - the state to publish.
   */
  async publish(state: TaskState): Promise<void> {
    await this.#store.publish(state.sessionId, [state])
  }

  /**
   * Every declared state.
   * @returns one state per session that has declared one.
   */
  async readAll(): Promise<readonly TaskState[]> {
    return this.#store.readAll()
  }

  /**
   * One session's own state.
   * @param sessionId - the declaring session.
   * @returns its state, or undefined when it has declared none.
   */
  async readOwn(sessionId: string): Promise<TaskState | undefined> {
    return (await this.#store.readOwn(sessionId))[0]
  }

  /**
   * Drop one session's state. Called when its agent goes away.
   * @param sessionId - the departing session.
   */
  async withdraw(sessionId: string): Promise<void> {
    await this.#store.withdraw(sessionId)
  }
}

function isTaskState(value: unknown): value is TaskState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>
  const blockedOn = state['blockedOn']
  return (
    typeof state['sessionId'] === 'string' &&
    typeof state['name'] === 'string' &&
    typeof state['summary'] === 'string' &&
    typeof state['updatedAt'] === 'number' &&
    (TASK_PHASES as readonly string[]).includes(state['phase'] as TaskPhase) &&
    (blockedOn === undefined || typeof blockedOn === 'string')
  )
}
