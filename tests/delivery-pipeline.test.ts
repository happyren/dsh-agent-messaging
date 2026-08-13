/**
 * The send path end to end: MessageSender → RoutingTransport → InboundRouter
 * → sink, with only the harness edges faked.
 */

import { describe, expect, it } from 'vitest'

import { InboundRouter } from '../src/app/receive-message.ts'
import { MessageSender, type SenderIdentity } from '../src/app/send-message.ts'
import { RoutingTransport } from '../src/adapters/transport/routing-transport.ts'
import type { Envelope } from '../src/domain/envelope.ts'
import { PeerError } from '../src/domain/errors.ts'
import { LoopGuard, type InboundPolicy } from '../src/domain/policy.ts'
import type { PeerDescriptor } from '../src/domain/peer.ts'
import type {
  DeliveryReceipt,
  InboxSink,
  OutboxSpool,
  PeerDirectory,
} from '../src/ports/index.ts'
import type { InboxClient } from '../src/adapters/transport/inbox-client.ts'

const alice: SenderIdentity = { sessionId: 'session-a', name: 'alice', cwd: '/repo/a' }

function peer(overrides: Partial<PeerDescriptor> & Pick<PeerDescriptor, 'sessionId' | 'name'>): PeerDescriptor {
  return { createdAt: 0, live: true, location: { kind: 'local' }, ...overrides }
}

class FakeDirectory implements PeerDirectory {
  constructor(private readonly peers: readonly PeerDescriptor[]) {}
  list(): Promise<readonly PeerDescriptor[]> {
    return Promise.resolve(this.peers)
  }
}

class RecordingSink implements InboxSink {
  readonly delivered: Envelope[] = []
  deliver(envelope: Envelope): DeliveryReceipt {
    this.delivered.push(envelope)
    return { status: 'delivered' }
  }
}

class RecordingSpool implements OutboxSpool {
  readonly held: Envelope[] = []
  hold(envelope: Envelope): Promise<void> {
    this.held.push(envelope)
    return Promise.resolve()
  }
  drain(): Promise<readonly Envelope[]> {
    return Promise.resolve([])
  }
}

/** Stands in for a socket to another host. */
class RecordingClient {
  readonly sent: { socketPath: string; payload: unknown }[] = []
  receipt: DeliveryReceipt = { status: 'delivered' }
  send(socketPath: string, payload: unknown): Promise<DeliveryReceipt> {
    this.sent.push({ socketPath, payload })
    return Promise.resolve(this.receipt)
  }
}

interface Harness {
  sender: MessageSender
  sink: RecordingSink
  spool: RecordingSpool
  client: RecordingClient
  inbound: InboundRouter
}

function harness(
  peers: readonly PeerDescriptor[],
  options: { policy?: InboundPolicy; spoolOffline?: boolean } = {},
): Harness {
  const sink = new RecordingSink()
  const spool = new RecordingSpool()
  const client = new RecordingClient()

  const inbound = new InboundRouter({
    policy: options.policy ?? 'accept',
    guard: new LoopGuard({ maxPerWindow: 10, windowMs: 1_000, duplicateWindowMs: 100 }),
    sink,
    clock: { now: () => 0 },
    maxHeld: 10,
  })

  const sender = new MessageSender({
    directory: new FakeDirectory(peers),
    transport: new RoutingTransport({
      inbound,
      client: client as unknown as InboxClient,
      spool,
      spoolOffline: options.spoolOffline ?? true,
    }),
    clock: { now: () => 1_700_000_000_000 },
    ids: (() => {
      let n = 0
      return { next: () => `msg-${(n += 1)}` }
    })(),
  })

  return { sender, sink, spool, client, inbound }
}

describe('send pipeline', () => {
  const bob = peer({ sessionId: 'session-b', name: 'bob', cwd: '/repo/b' })

  it('delivers to a local peer', async () => {
    const h = harness([bob])
    const outcome = await h.sender.send(alice, { to: 'bob', body: 'rebase is safe', mode: 'followup' })

    expect(outcome.receipt.status).toBe('delivered')
    expect(h.sink.delivered).toHaveLength(1)
    expect(h.sink.delivered[0]?.body).toBe('rebase is safe')
  })

  it('stamps the sender from the caller identity, not from the request', async () => {
    const h = harness([bob])
    await h.sender.send(alice, { to: 'bob', body: 'hi', mode: 'followup' })
    expect(h.sink.delivered[0]?.from).toEqual({
      sessionId: 'session-a',
      name: 'alice',
      cwd: '/repo/a',
    })
  })

  it('returns a correlatable message id', async () => {
    const h = harness([bob])
    const outcome = await h.sender.send(alice, { to: 'bob', body: 'hi', mode: 'followup' })
    expect(outcome.envelope.id).toBe('msg-1')
  })

  it('carries the chosen delivery mode through to the receiver', async () => {
    const h = harness([bob])
    await h.sender.send(alice, { to: 'bob', body: 'stop', mode: 'steer' })
    expect(h.sink.delivered[0]?.mode).toBe('steer')
  })

  it('routes to another host over the transport client', async () => {
    const remote = peer({
      sessionId: 'session-r',
      name: 'remote',
      location: { kind: 'remote', hostId: 'h2', socketPath: '/tmp/h2.sock' },
    })
    const h = harness([remote])
    const outcome = await h.sender.send(alice, { to: 'remote', body: 'hello', mode: 'followup' })

    expect(outcome.receipt.status).toBe('delivered')
    expect(h.client.sent).toHaveLength(1)
    expect(h.client.sent[0]?.socketPath).toBe('/tmp/h2.sock')
    expect(h.sink.delivered).toHaveLength(0)
  })

  it('spools for a session that is not running', async () => {
    const offline = peer({ sessionId: 'session-o', name: 'offline', live: false, location: { kind: 'offline' } })
    const h = harness([offline])
    const outcome = await h.sender.send(alice, { to: 'offline', body: 'later', mode: 'followup' })

    expect(outcome.receipt.status).toBe('spooled')
    expect(h.spool.held.map((e) => e.body)).toEqual(['later'])
  })

  it('rejects an offline target when spooling is disabled', async () => {
    const offline = peer({ sessionId: 'session-o', name: 'offline', live: false, location: { kind: 'offline' } })
    const h = harness([offline], { spoolOffline: false })

    await expect(
      h.sender.send(alice, { to: 'offline', body: 'later', mode: 'followup' }),
    ).rejects.toThrowError(/not running/)
  })

  it('applies the receiver policy to a same-process delivery', async () => {
    // The guarantee: sharing a process with the recipient is not a way around
    // its inbound policy.
    const h = harness([bob], { policy: 'refuse' })
    const outcome = await h.sender.send(alice, { to: 'bob', body: 'hi', mode: 'followup' })

    expect(outcome.receipt.status).toBe('refused')
    expect(h.sink.delivered).toHaveLength(0)
  })

  it('applies loop control to a same-process delivery', async () => {
    const h = harness([bob])
    const first = await h.sender.send(alice, { to: 'bob', body: 'same', mode: 'followup' })
    const second = await h.sender.send(alice, { to: 'bob', body: 'same', mode: 'followup' })

    expect(first.receipt.status).toBe('delivered')
    expect(second.receipt.status).toBe('dropped')
    expect(h.sink.delivered).toHaveLength(1)
  })

  it('refuses to address the calling session, even by its own id', async () => {
    const self = peer({ sessionId: 'session-a', name: 'alice' })
    const h = harness([self, bob])
    await expect(
      h.sender.send(alice, { to: 'session-a', body: 'hi', mode: 'followup' }),
    ).rejects.toThrow(PeerError)
  })

  it('excludes the calling session from its own peer listing', async () => {
    const self = peer({ sessionId: 'session-a', name: 'alice' })
    const h = harness([self, bob])
    expect((await h.sender.peers('session-a')).map((p) => p.name)).toEqual(['bob'])
  })

  it('reports an unresolvable address', async () => {
    const h = harness([bob])
    await expect(
      h.sender.send(alice, { to: 'nobody', body: 'hi', mode: 'followup' }),
    ).rejects.toThrowError(/No session matches/)
  })

  it('preserves reply correlation end to end', async () => {
    const h = harness([bob])
    await h.sender.send(alice, { to: 'bob', body: 'answer', mode: 'followup', replyTo: 'msg-0' })
    expect(h.sink.delivered[0]?.replyTo).toBe('msg-0')
  })
})
