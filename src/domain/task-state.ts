/**
 * Task state: what a session's *work* is doing, as opposed to what its process
 * is doing.
 *
 * The agent registry already reports `idle` / `running`, but that is a fact
 * about a driver, not about a task. A session can be `idle` because it finished,
 * or because it is waiting on a peer and has nothing to do until that peer
 * answers — indistinguishable from outside, and the difference is exactly what a
 * peer needs in order to decide whether to wait.
 *
 * This attacks two MAST failure modes: being unaware of termination conditions
 * (12.4%) and terminating prematurely (6.2%). It is common ground in Klein's
 * sense — a teammate that cannot signal completion or blockage cannot be
 * coordinated with.
 *
 * The `blocked` phase carries who it is blocked on, which makes a mutual wait
 * representable, and therefore detectable. A deadlock between two agents is
 * otherwise silent: both look idle, neither is finished, and nothing ever
 * reports it.
 */

import { PeerError } from './errors.ts'

/** Longest accepted summary. */
const MAX_SUMMARY_CHARS = 300

/** What a session's current task is doing. */
export type TaskPhase =
  /** Actively working. */
  | 'working'
  /** Cannot proceed until something else happens; often a peer. */
  | 'blocked'
  /** The task finished. */
  | 'done'
  /** The task was given up or superseded, and nobody should wait for it. */
  | 'abandoned'

/** Every {@link TaskPhase}. */
export const TASK_PHASES: readonly TaskPhase[] = ['working', 'blocked', 'done', 'abandoned']

/** One session's declared task state. */
export interface TaskState {
  readonly sessionId: string
  /** The declaring session's display name at declaration time. */
  readonly name: string
  readonly phase: TaskPhase
  /** What the task is, or what happened to it. */
  readonly summary: string
  /**
   * The session id this one is waiting on, when it is blocked on a peer.
   *
   * Absent when blocked on something that is not a session — a human decision, a
   * CI run, an external service.
   */
  readonly blockedOn?: string
  /** Unix epoch milliseconds of the declaration. */
  readonly updatedAt: number
}

/** Inputs for {@link createTaskState}; time is supplied, never read. */
export interface TaskStateDraft {
  readonly sessionId: string
  readonly name: string
  readonly phase: TaskPhase
  readonly summary: string
  readonly blockedOn?: string
  readonly now: number
}

/**
 * Validate a draft and freeze it into a {@link TaskState}.
 * @param draft - the declaration's facts.
 * @returns the frozen state.
 * @throws {PeerError} `invalid-body` when the phase or summary is unusable.
 * @throws {PeerError} `peer-self` when a session declares itself blocked on itself.
 */
export function createTaskState(draft: TaskStateDraft): TaskState {
  if (!TASK_PHASES.includes(draft.phase)) {
    throw new PeerError('invalid-body', `Unknown task phase "${draft.phase}".`)
  }
  const summary = draft.summary.trim()
  if (!summary) {
    throw new PeerError('invalid-body', 'A task state needs a summary, or it tells a peer nothing.')
  }
  if (summary.length > MAX_SUMMARY_CHARS) {
    throw new PeerError('invalid-body', `Summary exceeds ${MAX_SUMMARY_CHARS} characters.`)
  }

  const blockedOn = draft.blockedOn?.trim()
  if (blockedOn && blockedOn === draft.sessionId) {
    throw new PeerError('peer-self', 'A session cannot be blocked on itself.')
  }
  // `blockedOn` outside the blocked phase would be a contradiction a reader
  // would have to resolve, so it is dropped rather than stored.
  const carriesBlock = draft.phase === 'blocked' && Boolean(blockedOn)

  return Object.freeze({
    sessionId: draft.sessionId,
    name: draft.name,
    phase: draft.phase,
    summary,
    ...(carriesBlock ? { blockedOn: blockedOn as string } : {}),
    updatedAt: draft.now,
  })
}

/**
 * Whether a phase means nobody should keep waiting on this session.
 * @param phase - the declared phase.
 * @returns whether the task has settled.
 */
export function isSettled(phase: TaskPhase): boolean {
  return phase === 'done' || phase === 'abandoned'
}

/**
 * Find the wait cycle a session is part of, if any.
 *
 * Walks the `blockedOn` chain from one session. A cycle means every session in
 * it is waiting for another that is also waiting — nobody will ever proceed, and
 * because each looks merely idle, nothing else in the system reports it.
 *
 * Only `blocked` states participate: a session that is working or settled is not
 * waiting on anyone, so the chain ends there.
 * @param states - every known task state.
 * @param from - the session to walk from.
 * @returns the cycle in wait order beginning at `from`, or an empty array.
 */
export function findWaitCycle(states: readonly TaskState[], from: string): readonly TaskState[] {
  const byId = new Map(states.map((state) => [state.sessionId, state]))
  const path: TaskState[] = []
  const seen = new Set<string>()

  let cursor: string | undefined = from
  while (cursor !== undefined) {
    if (seen.has(cursor)) {
      // Only a cycle that returns to the starting session concerns this caller;
      // one further down the chain is someone else's deadlock to report.
      const start = path.findIndex((state) => state.sessionId === cursor)
      const cycle = path.slice(start)
      return cycle.some((state) => state.sessionId === from) ? cycle : []
    }
    seen.add(cursor)

    const state: TaskState | undefined = byId.get(cursor)
    if (!state || state.phase !== 'blocked' || state.blockedOn === undefined) return []
    path.push(state)
    cursor = state.blockedOn
  }
  return []
}

/**
 * Render a task state as one line for a peer listing.
 * @param state - the state to summarize.
 * @returns a compact description.
 */
export function summarizeTaskState(state: TaskState): string {
  const blocked = state.blockedOn ? ` on ${state.blockedOn}` : ''
  return `${state.phase}${blocked}: ${state.summary}`
}
