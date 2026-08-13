import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PresenceStore, socketPathFor, type PresenceRecord } from '../src/adapters/presence.ts'

const silentLogger = { warn: () => {}, error: () => {} }

let stateRoot: string
let hostsDir: string

function store(hostId: string, socketPath: string): PresenceStore {
  return new PresenceStore({ stateRoot, hostId, socketPath, logger: silentLogger })
}

/** Write a foreign host's record directly, as another process would. */
async function writeForeignRecord(record: Partial<PresenceRecord> & { hostId: string }): Promise<void> {
  await mkdir(hostsDir, { recursive: true })
  const full: PresenceRecord = {
    protocol: 1,
    pid: process.pid,
    socketPath: join(stateRoot, `${record.hostId}.sock`),
    updatedAt: Date.now(),
    sessions: ['session-x'],
    ...record,
  }
  // A record is only considered live when its socket file exists.
  await writeFile(full.socketPath, '')
  await writeFile(join(hostsDir, `${full.hostId}.json`), JSON.stringify(full))
}

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-am-presence-'))
  hostsDir = join(stateRoot, 'hosts')
})

afterEach(async () => {
  await rm(stateRoot, { recursive: true, force: true })
})

describe('socketPathFor', () => {
  it('stays inside the platform sun_path budget', () => {
    // macOS caps sun_path near 104 bytes; a home-relative path can exceed it.
    expect(Buffer.byteLength(socketPathFor('abcdef123456'))).toBeLessThan(100)
  })
})

describe('PresenceStore', () => {
  it('reports no peers before any record exists', async () => {
    expect(await store('self', '/tmp/self.sock').readPeers()).toEqual([])
  })

  it('publishes this host and its live sessions', async () => {
    const self = store('self', '/tmp/self.sock')
    await self.publish(['session-a', 'session-b'])

    const written = JSON.parse(await readFile(self.recordPath, 'utf8')) as PresenceRecord
    expect(written.hostId).toBe('self')
    expect(written.sessions).toEqual(['session-a', 'session-b'])
    expect(written.pid).toBe(process.pid)
  })

  it('replaces the record on republish rather than accumulating', async () => {
    const self = store('self', '/tmp/self.sock')
    await self.publish(['session-a'])
    await self.publish(['session-b'])

    const written = JSON.parse(await readFile(self.recordPath, 'utf8')) as PresenceRecord
    expect(written.sessions).toEqual(['session-b'])
    expect((await readdir(hostsDir)).filter((n) => n.endsWith('.json'))).toHaveLength(1)
  })

  it('leaves no temp file behind', async () => {
    await store('self', '/tmp/self.sock').publish(['session-a'])
    expect((await readdir(hostsDir)).filter((n) => n.endsWith('.tmp'))).toHaveLength(0)
  })

  it('sees another live host but never itself', async () => {
    const self = store('self', '/tmp/self.sock')
    await self.publish(['session-a'])
    await writeForeignRecord({ hostId: 'other', sessions: ['session-z'] })

    const peers = await self.readPeers()
    expect(peers.map((p) => p.hostId)).toEqual(['other'])
    expect(peers[0]?.sessions).toEqual(['session-z'])
  })

  it('prunes a record whose process is gone', async () => {
    const self = store('self', '/tmp/self.sock')
    // PID 1 exists; a huge unallocated pid does not.
    await writeForeignRecord({ hostId: 'dead', pid: 0x7ffffffe })

    expect(await self.readPeers()).toEqual([])
    expect(await readdir(hostsDir)).not.toContain('dead.json')
  })

  it('prunes a record whose socket file is gone', async () => {
    const self = store('self', '/tmp/self.sock')
    await mkdir(hostsDir, { recursive: true })
    await writeFile(
      join(hostsDir, 'ghost.json'),
      JSON.stringify({
        protocol: 1,
        hostId: 'ghost',
        pid: process.pid,
        socketPath: join(stateRoot, 'never-created.sock'),
        updatedAt: Date.now(),
        sessions: ['session-z'],
      } satisfies PresenceRecord),
    )

    expect(await self.readPeers()).toEqual([])
    expect(await readdir(hostsDir)).not.toContain('ghost.json')
  })

  it('ignores an unparseable or foreign record without failing discovery', async () => {
    const self = store('self', '/tmp/self.sock')
    await mkdir(hostsDir, { recursive: true })
    await writeFile(join(hostsDir, 'broken.json'), '{ truncated')
    await writeFile(join(hostsDir, 'alien.json'), JSON.stringify({ protocol: 99, hostId: 'alien' }))
    await writeForeignRecord({ hostId: 'good' })

    expect((await self.readPeers()).map((p) => p.hostId)).toEqual(['good'])
  })

  it('withdraws its own record on unload', async () => {
    const self = store('self', '/tmp/self.sock')
    await self.publish(['session-a'])
    await self.withdraw()
    expect(await readdir(hostsDir)).not.toContain('self.json')
  })

  it('tolerates withdrawing twice', async () => {
    const self = store('self', '/tmp/self.sock')
    await self.publish(['session-a'])
    await self.withdraw()
    await expect(self.withdraw()).resolves.toBeUndefined()
  })
})
