/**
 * Real Unix domain sockets, real files — no mocks for the transport itself.
 * This is the layer that cannot be reasoned about from types alone.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { InboxClient } from '../src/adapters/transport/inbox-client.ts'
import { InboxServer } from '../src/adapters/transport/inbox-server.ts'
import { createEnvelope, type Envelope } from '../src/domain/envelope.ts'
import { PeerError } from '../src/domain/errors.ts'
import type { DeliveryReceipt } from '../src/ports/index.ts'

const silentLogger = { warn: () => {}, error: () => {} }

let workDir: string
let socketPath: string
const started: InboxServer[] = []

function envelope(body = 'ping'): Envelope {
  return createEnvelope({
    id: `msg-${Math.random().toString(36).slice(2)}`,
    sentAt: Date.now(),
    from: { sessionId: 'session-a', name: 'alpha', cwd: '/repo/a' },
    to: 'session-b',
    mode: 'followup',
    body,
  })
}

async function serve(handle: (frame: unknown) => DeliveryReceipt | Promise<DeliveryReceipt>): Promise<InboxServer> {
  const server = new InboxServer({ socketPath, handle, logger: silentLogger })
  await server.listen()
  started.push(server)
  return server
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'dsh-am-test-'))
  // Short path: sun_path is capped near 104 bytes.
  socketPath = join(workDir, 's.sock')
})

afterEach(async () => {
  await Promise.all(started.splice(0).map((server) => server.close().catch(() => undefined)))
  await rm(workDir, { recursive: true, force: true })
})

describe('inbox socket round trip', () => {
  it('carries an envelope and returns the receipt', async () => {
    const received: unknown[] = []
    await serve((frame) => {
      received.push(frame)
      return { status: 'delivered' }
    })

    const client = new InboxClient({ timeoutMs: 2_000 })
    const sent = envelope('migration finished')
    const receipt = await client.send(socketPath, sent)

    expect(receipt).toEqual({ status: 'delivered' })
    expect(received).toHaveLength(1)
    expect((received[0] as Envelope).body).toBe('migration finished')
  })

  it('preserves every field across the wire', async () => {
    let seen: Envelope | undefined
    await serve((frame) => {
      seen = frame as Envelope
      return { status: 'delivered' }
    })

    const sent = createEnvelope({
      id: 'msg-1',
      sentAt: 1_700_000_000_000,
      from: { sessionId: 'session-a', name: 'alpha', cwd: '/repo/a' },
      to: 'session-b',
      mode: 'steer',
      body: 'stop — the schema changed',
      replyTo: 'msg-0',
    })
    await new InboxClient({ timeoutMs: 2_000 }).send(socketPath, sent)
    expect(seen).toEqual(sent)
  })

  it('relays a non-delivery receipt with its reason', async () => {
    await serve(() => ({ status: 'held', detail: 'operator release required' }))
    const receipt = await new InboxClient({ timeoutMs: 2_000 }).send(socketPath, envelope())
    expect(receipt).toEqual({ status: 'held', detail: 'operator release required' })
  })

  it('handles several sequential deliveries on one listener', async () => {
    const bodies: string[] = []
    await serve((frame) => {
      bodies.push((frame as Envelope).body)
      return { status: 'delivered' }
    })

    const client = new InboxClient({ timeoutMs: 2_000 })
    for (const body of ['one', 'two', 'three']) {
      await client.send(socketPath, envelope(body))
    }
    expect(bodies).toEqual(['one', 'two', 'three'])
  })

  it('handles concurrent deliveries', async () => {
    await serve(() => ({ status: 'delivered' }))
    const client = new InboxClient({ timeoutMs: 2_000 })
    const receipts = await Promise.all(
      Array.from({ length: 8 }, (_, i) => client.send(socketPath, envelope(`body-${i}`))),
    )
    expect(receipts.every((r) => r.status === 'delivered')).toBe(true)
  })

  it('rejects a malformed envelope at the socket, before the handler', async () => {
    let handlerCalls = 0
    await serve(() => {
      handlerCalls += 1
      return { status: 'delivered' }
    })

    const receipt = await new InboxClient({ timeoutMs: 2_000 }).send(socketPath, { protocol: 1, nonsense: true })
    expect(receipt.status).toBe('refused')
    expect(handlerCalls).toBe(0)
  })

  it('reports an unreachable socket rather than hanging', async () => {
    const client = new InboxClient({ timeoutMs: 2_000 })
    await expect(client.send(join(workDir, 'absent.sock'), envelope())).rejects.toThrow(PeerError)
  })

  it('times out when the peer accepts but never answers', async () => {
    const server = new InboxServer({
      socketPath,
      handle: () => new Promise<DeliveryReceipt>(() => {}),
      logger: silentLogger,
    })
    await server.listen()
    started.push(server)

    const client = new InboxClient({ timeoutMs: 150 })
    await expect(client.send(socketPath, envelope())).rejects.toThrowError(/did not answer within 150ms/)
  })

  it('honours caller cancellation', async () => {
    const server = new InboxServer({
      socketPath,
      handle: () => new Promise<DeliveryReceipt>(() => {}),
      logger: silentLogger,
    })
    await server.listen()
    started.push(server)

    const controller = new AbortController()
    const pending = new InboxClient({ timeoutMs: 5_000 }).send(socketPath, envelope(), controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrowError(/cancelled/i)
  })

  it('reclaims a socket file left behind by a crashed host', async () => {
    // A dead host leaves the path on disk; binding must succeed anyway.
    await writeFile(socketPath, '')
    await serve(() => ({ status: 'delivered' }))
    const receipt = await new InboxClient({ timeoutMs: 2_000 }).send(socketPath, envelope())
    expect(receipt.status).toBe('delivered')
  })

  it('refuses to steal a socket held by a live listener', async () => {
    await serve(() => ({ status: 'delivered' }))
    const intruder = new InboxServer({ socketPath, handle: () => ({ status: 'delivered' }), logger: silentLogger })
    await expect(intruder.listen()).rejects.toThrowError(/already in use by a live host/)
  })

  it('removes the socket file on close', async () => {
    const server = await serve(() => ({ status: 'delivered' }))
    await server.close()
    expect(await InboxClient.isListening(socketPath)).toBe(false)
  })
})
