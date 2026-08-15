import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TaskStateStore } from '../src/adapters/task-states.ts'

import { PeerError } from '../src/domain/errors.ts'
import {
  createTaskState,
  findWaitCycle,
  isSettled,
  summarizeTaskState,
  TASK_PHASES,
  type TaskState,
  type TaskStateDraft,
} from '../src/domain/task-state.ts'

function state(overrides: Partial<TaskStateDraft> = {}): TaskState {
  return createTaskState({
    sessionId: 'session-a',
    name: 'payments',
    phase: 'working',
    summary: 'reworking validation',
    now: 1_000,
    ...overrides,
  })
}

describe('createTaskState', () => {
  it('accepts every declared phase', () => {
    for (const phase of TASK_PHASES) expect(state({ phase }).phase).toBe(phase)
  })

  it('rejects an unknown phase', () => {
    expect(() => state({ phase: 'thinking' as never })).toThrowError(/Unknown task phase/)
  })

  it('requires a summary, since a bare phase tells a peer nothing', () => {
    expect(() => state({ summary: '  ' })).toThrowError(/needs a summary/)
  })

  it('rejects an oversized summary', () => {
    expect(() => state({ summary: 'x'.repeat(301) })).toThrowError(/exceeds 300/)
  })

  it('keeps blockedOn only in the blocked phase', () => {
    expect(state({ phase: 'blocked', blockedOn: 'session-b' }).blockedOn).toBe('session-b')
    // Carrying it elsewhere would be a contradiction a reader must resolve.
    expect(state({ phase: 'working', blockedOn: 'session-b' }).blockedOn).toBeUndefined()
    expect(state({ phase: 'done', blockedOn: 'session-b' }).blockedOn).toBeUndefined()
  })

  it('refuses a session blocked on itself', () => {
    expect(() => state({ phase: 'blocked', blockedOn: 'session-a' })).toThrow(PeerError)
  })

  it('freezes the result', () => {
    expect(Object.isFrozen(state())).toBe(true)
  })
})

describe('isSettled', () => {
  it('treats done and abandoned as settled, and the rest as not', () => {
    expect(isSettled('done')).toBe(true)
    expect(isSettled('abandoned')).toBe(true)
    expect(isSettled('working')).toBe(false)
    expect(isSettled('blocked')).toBe(false)
  })
})

describe('findWaitCycle', () => {
  const blocked = (id: string, on: string): TaskState =>
    createTaskState({
      sessionId: id,
      name: id,
      phase: 'blocked',
      summary: `waiting on ${on}`,
      blockedOn: on,
      now: 0,
    })

  it('finds nothing when the session is not blocked', () => {
    expect(findWaitCycle([state()], 'session-a')).toEqual([])
  })

  it('finds nothing for a chain that terminates in working', () => {
    const states = [blocked('a', 'b'), state({ sessionId: 'b', phase: 'working' })]
    expect(findWaitCycle(states, 'a')).toEqual([])
  })

  it('detects a two-session mutual wait', () => {
    // The silent deadlock: both look merely idle from outside.
    const states = [blocked('a', 'b'), blocked('b', 'a')]
    expect(findWaitCycle(states, 'a').map((s) => s.sessionId)).toEqual(['a', 'b'])
  })

  it('detects a three-session cycle', () => {
    const states = [blocked('a', 'b'), blocked('b', 'c'), blocked('c', 'a')]
    expect(findWaitCycle(states, 'a').map((s) => s.sessionId)).toEqual(['a', 'b', 'c'])
  })

  it('reports the cycle in wait order starting from the asking session', () => {
    const states = [blocked('a', 'b'), blocked('b', 'c'), blocked('c', 'a')]
    expect(findWaitCycle(states, 'b').map((s) => s.sessionId)).toEqual(['b', 'c', 'a'])
  })

  it('ignores a downstream cycle the asking session is not part of', () => {
    // a waits on b; b and c deadlock with each other. That is their problem to
    // report, and a is genuinely waiting on progress that may still happen.
    const states = [blocked('a', 'b'), blocked('b', 'c'), blocked('c', 'b')]
    expect(findWaitCycle(states, 'a')).toEqual([])
  })

  it('finds nothing when the blocker is unknown', () => {
    expect(findWaitCycle([blocked('a', 'ghost')], 'a')).toEqual([])
  })

  it('finds nothing when the blocker has finished', () => {
    const states = [blocked('a', 'b'), state({ sessionId: 'b', phase: 'done', summary: 'shipped' })]
    expect(findWaitCycle(states, 'a')).toEqual([])
  })

  it('terminates on a long chain without looping forever', () => {
    const chain = Array.from({ length: 200 }, (_, i) => blocked(`s${i}`, `s${i + 1}`))
    expect(findWaitCycle(chain, 's0')).toEqual([])
  })
})

describe('summarizeTaskState', () => {
  it('names the phase and what is being waited on', () => {
    expect(summarizeTaskState(state({ phase: 'blocked', blockedOn: 'session-b', summary: 'need the schema' }))).toBe(
      'blocked on session-b: need the schema',
    )
  })

  it('omits the blocker when there is none', () => {
    expect(summarizeTaskState(state({ phase: 'done', summary: 'shipped' }))).toBe('done: shipped')
  })

  it('shows a wait by the address peers call that session, not by its id', () => {
    // The id is what makes a cycle walkable; it is not what a reader can act on.
    const blocked = state({ phase: 'blocked', blockedOn: 'session-b', summary: 'need the schema' })
    expect(summarizeTaskState(blocked, (id) => (id === 'session-b' ? 'payments-api' : undefined))).toBe(
      'blocked on payments-api: need the schema',
    )
  })

  it('shows an unresolvable wait as recorded rather than hiding it', () => {
    const blocked = state({ phase: 'blocked', blockedOn: 'session-gone', summary: 'need the schema' })
    expect(summarizeTaskState(blocked, () => undefined)).toBe('blocked on session-gone: need the schema')
  })
})

describe('TaskStateStore', () => {
  let stateRoot: string

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), 'dsh-am-task-'))
  })
  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true })
  })

  function store(): TaskStateStore {
    return new TaskStateStore({ stateRoot, logger: { warn: () => {}, error: () => {} } })
  }

  it('round-trips a declared state', async () => {
    const s = store()
    const declared = state({ phase: 'blocked', blockedOn: 'session-b', summary: 'need the schema' })
    await s.publish(declared)
    expect(await s.readAll()).toEqual([declared])
    expect(await s.readOwn('session-a')).toEqual(declared)
  })

  it('keeps one state per session, replacing on redeclare', async () => {
    const s = store()
    await s.publish(state({ phase: 'working', summary: 'first' }))
    await s.publish(state({ phase: 'done', summary: 'finished' }))
    const all = await s.readAll()
    expect(all).toHaveLength(1)
    expect(all[0]?.phase).toBe('done')
  })

  it('withdraws a session on teardown', async () => {
    const s = store()
    await s.publish(state())
    await s.withdraw('session-a')
    expect(await s.readAll()).toEqual([])
  })

  it('detects a deadlock across two published states', async () => {
    // The end-to-end shape: two sessions each declare themselves blocked on the
    // other, and the cycle is visible to either of them from disk.
    const s = store()
    await s.publish(
      createTaskState({ sessionId: 'a', name: 'a', phase: 'blocked', summary: 'w', blockedOn: 'b', now: 0 }),
    )
    await s.publish(
      createTaskState({ sessionId: 'b', name: 'b', phase: 'blocked', summary: 'w', blockedOn: 'a', now: 0 }),
    )
    expect(findWaitCycle([...(await s.readAll())], 'a').map((e) => e.sessionId)).toEqual(['a', 'b'])
  })
})

describe('an unresolved blocker breaks cycle detection', () => {
  it('finds no cycle when one side stored a name instead of a session id', () => {
    // Found in a live run: docs declared itself blocked on the alias
    // "checkout-client", which resolution did not recognise, so the string was
    // stored verbatim. Checkout blocked back correctly by id — and the chain
    // dead-ended at a session that does not exist, hiding a real deadlock.
    const docs = createTaskState({
      sessionId: 'session-docs',
      name: 'docs',
      phase: 'blocked',
      summary: 'waiting on the call signature',
      blockedOn: 'checkout-client',
      now: 0,
    })
    const checkout = createTaskState({
      sessionId: 'session-checkout',
      name: 'checkout',
      phase: 'blocked',
      summary: 'waiting on the docs',
      blockedOn: 'session-docs',
      now: 0,
    })
    expect(findWaitCycle([docs, checkout], 'session-checkout')).toEqual([])

    // Resolved to the id, the same declarations are a detectable mutual wait.
    const resolved = createTaskState({
      sessionId: 'session-docs',
      name: 'docs',
      phase: 'blocked',
      summary: 'waiting on the call signature',
      blockedOn: 'session-checkout',
      now: 0,
    })
    expect(findWaitCycle([resolved, checkout], 'session-checkout').map((s) => s.sessionId)).toEqual([
      'session-checkout',
      'session-docs',
    ])
  })
})
