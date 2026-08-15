/**
 * Real files. The single-writer-per-session layout is the whole concurrency
 * design, so it is tested against a real filesystem rather than a fake.
 */

import { mkdtemp, readdir, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ClaimStore } from '../src/adapters/claims.ts'
import { WorkClaims } from '../src/app/claim-work.ts'
import { createClaim, type Claim } from '../src/domain/claim.ts'

const silentLogger = { warn: () => {}, error: () => {} }
const MINUTE = 60_000

let stateRoot: string
let clockValue = 0
const clock = { now: () => clockValue }

function store(): ClaimStore {
  return new ClaimStore({ stateRoot, logger: silentLogger })
}

function work(): WorkClaims {
  return new WorkClaims({ repository: store(), clock })
}

function claim(overrides: Partial<Parameters<typeof createClaim>[0]> = {}): Claim {
  return createClaim({
    sessionId: 'session-a',
    name: 'payments',
    scope: 'path',
    resource: 'api/charges.ts',
    intent: 'adding tenant_id',
    now: clockValue,
    ttlMs: 30 * MINUTE,
    ...overrides,
  })
}

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-am-claims-'))
  clockValue = 0
})

afterEach(async () => {
  await rm(stateRoot, { recursive: true, force: true })
})

describe('ClaimStore', () => {
  it('returns nothing before anything is published', async () => {
    expect(await store().readAll(0)).toEqual([])
  })

  it('round-trips a published claim', async () => {
    const s = store()
    const held = claim()
    await s.publish('session-a', [held])
    expect(await s.readAll(0)).toEqual([held])
  })

  it('gives each session its own file, so writers never contend', async () => {
    const s = store()
    await s.publish('session-a', [claim({ sessionId: 'session-a', resource: 'api' })])
    await s.publish('session-b', [claim({ sessionId: 'session-b', resource: 'client' })])

    expect((await readdir(join(stateRoot, 'claims'))).filter((n) => n.endsWith('.json'))).toHaveLength(2)
    expect((await s.readAll(0)).map((c) => c.resource).sort()).toEqual(['api', 'client'])
  })

  it('replaces a session\'s set rather than appending to it', async () => {
    const s = store()
    await s.publish('session-a', [claim({ resource: 'api' })])
    await s.publish('session-a', [claim({ resource: 'client' })])
    expect((await s.readAll(0)).map((c) => c.resource)).toEqual(['client'])
  })

  it('leaves no file behind when the set empties', async () => {
    const s = store()
    await s.publish('session-a', [claim()])
    await s.publish('session-a', [])
    expect(await s.readAll(0)).toEqual([])
    expect(await readdir(join(stateRoot, 'claims'))).toEqual([])
  })

  it('hides lapsed claims on read, since a crashed holder never releases', async () => {
    const s = store()
    await s.publish('session-a', [claim({ ttlMs: 5 * MINUTE })])
    expect(await s.readAll(4 * MINUTE)).toHaveLength(1)
    expect(await s.readAll(5 * MINUTE)).toHaveLength(0)
  })

  it('reads back only the asking session\'s own claims', async () => {
    const s = store()
    await s.publish('session-a', [claim({ sessionId: 'session-a' })])
    await s.publish('session-b', [claim({ sessionId: 'session-b', resource: 'client' })])
    expect((await s.readOwn('session-a', 0)).map((c) => c.sessionId)).toEqual(['session-a'])
  })

  it('withdraws a session entirely', async () => {
    const s = store()
    await s.publish('session-a', [claim()])
    await s.withdraw('session-a')
    expect(await s.readAll(0)).toEqual([])
  })

  it('handles a session id containing path separators', async () => {
    const s = store()
    const weird = '../../etc/passwd'
    await s.publish(weird, [claim({ sessionId: weird })])
    const segments = await readdir(join(stateRoot, 'claims'))
    expect(segments).toHaveLength(1)
    expect(segments[0]).not.toContain('..')
    expect(await s.readOwn(weird, 0)).toHaveLength(1)
  })

  it('ignores one damaged file without hiding healthy siblings', async () => {
    const s = store()
    await s.publish('session-a', [claim()])
    await mkdir(join(stateRoot, 'claims'), { recursive: true })
    await writeFile(join(stateRoot, 'claims', 'broken.json'), '{ truncated')
    expect(await s.readAll(0)).toHaveLength(1)
  })

  it('leaves no temp files behind', async () => {
    await store().publish('session-a', [claim()])
    const names = await readdir(join(stateRoot, 'claims'))
    expect(names.filter((n) => n.endsWith('.tmp'))).toHaveLength(0)
  })
})

describe('WorkClaims', () => {
  const holder = { sessionId: 'session-a', name: 'payments' }
  const other = { sessionId: 'session-b', name: 'checkout' }

  it('grants an unclaimed resource', async () => {
    const w = work()
    const outcome = await w.take(holder, {
      scope: 'path',
      resource: 'api/charges.ts',
      intent: 'adding tenant_id',
      ttlMs: 30 * MINUTE,
    })
    expect(outcome.granted).toBe(true)
    expect(outcome.conflicts).toEqual([])
  })

  it('refuses when a peer holds an overlapping parent directory', async () => {
    const w = work()
    await w.take(other, { scope: 'path', resource: 'client', intent: 'refactor', ttlMs: 30 * MINUTE })

    const outcome = await w.take(holder, {
      scope: 'path',
      resource: 'client/checkout.ts',
      intent: 'thread tenant_id',
      ttlMs: 30 * MINUTE,
    })
    expect(outcome.granted).toBe(false)
    expect(outcome.conflicts.map((c) => c.name)).toEqual(['checkout'])
    // Nothing was written for the refused caller.
    expect((await w.all()).map((c) => c.sessionId)).toEqual(['session-b'])
  })

  it('grants over a conflict when forced, still reporting it', async () => {
    const w = work()
    await w.take(other, { scope: 'path', resource: 'client', intent: 'refactor', ttlMs: 30 * MINUTE })

    const outcome = await w.take(holder, {
      scope: 'path',
      resource: 'client/checkout.ts',
      intent: 'agreed handover',
      ttlMs: 30 * MINUTE,
      force: true,
    })
    expect(outcome.granted).toBe(true)
    expect(outcome.conflicts).toHaveLength(1)
  })

  it('never conflicts with the caller\'s own claim, and refreshes it', async () => {
    const w = work()
    await w.take(holder, { scope: 'path', resource: 'api', intent: 'first', ttlMs: 10 * MINUTE })
    clockValue += MINUTE

    const outcome = await w.take(holder, { scope: 'path', resource: 'api', intent: 'second', ttlMs: 30 * MINUTE })
    expect(outcome.granted).toBe(true)

    const all = await w.all()
    expect(all).toHaveLength(1)
    expect(all[0]?.intent).toBe('second')
    expect(all[0]?.expiresAt).toBe(clockValue + 30 * MINUTE)
  })

  it('lets a lapsed claim be taken by someone else', async () => {
    const w = work()
    await w.take(other, { scope: 'path', resource: 'client', intent: 'refactor', ttlMs: 5 * MINUTE })
    clockValue += 5 * MINUTE

    const outcome = await w.take(holder, {
      scope: 'path',
      resource: 'client',
      intent: 'taking over',
      ttlMs: 30 * MINUTE,
    })
    expect(outcome.granted).toBe(true)
  })

  it('releases one claim while keeping the rest', async () => {
    const w = work()
    await w.take(holder, { scope: 'path', resource: 'api', intent: 'a', ttlMs: 30 * MINUTE })
    await w.take(holder, { scope: 'path', resource: 'docs', intent: 'b', ttlMs: 30 * MINUTE })

    expect(await w.release(holder.sessionId, { scope: 'path', resource: './api' })).toBe(1)
    expect((await w.all()).map((c) => c.resource)).toEqual(['docs'])
  })

  it('reports releasing a claim it never held', async () => {
    const w = work()
    await w.take(holder, { scope: 'path', resource: 'api', intent: 'a', ttlMs: 30 * MINUTE })
    expect(await w.release(holder.sessionId, { scope: 'path', resource: 'nowhere' })).toBe(0)
  })

  it('releases everything on teardown', async () => {
    const w = work()
    await w.take(holder, { scope: 'path', resource: 'api', intent: 'a', ttlMs: 30 * MINUTE })
    await w.take(holder, { scope: 'path', resource: 'docs', intent: 'b', ttlMs: 30 * MINUTE })
    await w.withdrawAll(holder.sessionId)
    expect(await w.all()).toEqual([])
  })
})
