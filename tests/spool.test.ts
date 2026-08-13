import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FileOutboxSpool } from '../src/adapters/spool.ts'
import { createEnvelope, type Envelope } from '../src/domain/envelope.ts'

const silentLogger = { warn: () => {}, error: () => {} }
const DAY = 24 * 60 * 60 * 1000

let stateRoot: string

function envelope(body: string, sentAt: number, to = 'session-b'): Envelope {
  return createEnvelope({
    id: `msg-${body}`,
    sentAt,
    from: { sessionId: 'session-a', name: 'alpha' },
    to,
    mode: 'followup',
    body,
  })
}

function spool(limits = { maxAgeMs: DAY, maxPerSession: 5 }): FileOutboxSpool {
  return new FileOutboxSpool({ stateRoot, limits, logger: silentLogger })
}

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-am-spool-'))
})

afterEach(async () => {
  await rm(stateRoot, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('FileOutboxSpool', () => {
  it('returns nothing for a session with no spooled messages', async () => {
    expect(await spool().drain('session-b')).toEqual([])
  })

  it('holds a message and returns it on drain', async () => {
    const store = spool()
    const held = envelope('deploy finished', Date.now())
    await store.hold(held)
    expect(await store.drain('session-b')).toEqual([held])
  })

  it('delivers a spooled message at most once', async () => {
    const store = spool()
    await store.hold(envelope('once', Date.now()))
    expect(await store.drain('session-b')).toHaveLength(1)
    expect(await store.drain('session-b')).toHaveLength(0)
  })

  it('returns messages oldest first', async () => {
    const store = spool()
    const now = Date.now()
    await store.hold(envelope('third', now + 2))
    await store.hold(envelope('first', now))
    await store.hold(envelope('second', now + 1))
    expect((await store.drain('session-b')).map((e) => e.body)).toEqual(['first', 'second', 'third'])
  })

  it('keeps recipients isolated', async () => {
    const store = spool()
    await store.hold(envelope('for-b', Date.now(), 'session-b'))
    await store.hold(envelope('for-c', Date.now(), 'session-c'))
    expect((await store.drain('session-b')).map((e) => e.body)).toEqual(['for-b'])
    expect((await store.drain('session-c')).map((e) => e.body)).toEqual(['for-c'])
  })

  it('contains a session id containing path separators', async () => {
    const store = spool()
    const traversal = '../../etc/passwd'
    await store.hold(envelope('safe', Date.now(), traversal))

    // The id became one encoded segment: nothing escaped the spool root.
    const segments = await readdir(join(stateRoot, 'spool'))
    expect(segments).toHaveLength(1)
    expect(segments[0]).not.toContain('..')
    expect(segments[0]).not.toContain('/')

    expect((await store.drain(traversal)).map((e) => e.body)).toEqual(['safe'])
  })

  it('drops a message older than the retention bound', async () => {
    const store = spool({ maxAgeMs: 1_000, maxPerSession: 5 })
    await store.hold(envelope('stale', Date.now() - 5_000))
    await store.hold(envelope('fresh', Date.now()))
    expect((await store.drain('session-b')).map((e) => e.body)).toEqual(['fresh'])
  })

  it('bounds depth per recipient, discarding the oldest', async () => {
    const store = spool({ maxAgeMs: DAY, maxPerSession: 2 })
    const now = Date.now()
    for (const [i, body] of ['one', 'two', 'three'].entries()) {
      await store.hold(envelope(body, now + i))
    }
    expect((await store.drain('session-b')).map((e) => e.body)).toEqual(['two', 'three'])
  })

  it('discards an unreadable spooled file without failing the drain', async () => {
    const store = spool()
    await store.hold(envelope('good', Date.now()))
    const dir = join(stateRoot, 'spool', Buffer.from('session-b', 'utf8').toString('base64url'))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '0000000000000000-corrupt.json'), '{ not json')

    const drained = await store.drain('session-b')
    expect(drained.map((e) => e.body)).toEqual(['good'])
  })

  it('leaves no temp files behind', async () => {
    const store = spool()
    await store.hold(envelope('one', Date.now()))
    const dir = join(stateRoot, 'spool', Buffer.from('session-b', 'utf8').toString('base64url'))
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toHaveLength(0)
  })
})
