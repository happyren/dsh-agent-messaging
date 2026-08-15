/**
 * A real HTTP server stands in for the external agent, so the request we send is
 * the request an A2A peer would actually receive.
 */

import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { A2AClient } from '../src/adapters/transport/a2a-client.ts'
import { createEndpoint, readA2AResponse, toA2ARequest, A2A_SEND_METHOD } from '../src/domain/a2a.ts'
import { createEnvelope, type Envelope } from '../src/domain/envelope.ts'
import { PeerError } from '../src/domain/errors.ts'

function envelope(overrides: Partial<Parameters<typeof createEnvelope>[0]> = {}): Envelope {
  return createEnvelope({
    id: 'msg-1',
    sentAt: 1_700_000_000_000,
    from: { sessionId: 'session-a', name: 'payments-api', cwd: '/repo' },
    to: 'a2a:reviewer',
    mode: 'followup',
    body: 'tenant_id is now required',
    ...overrides,
  })
}

describe('createEndpoint', () => {
  it('normalizes the alias and keeps the url', () => {
    const endpoint = createEndpoint({ alias: '  Reviewer ', url: 'https://example.test/a2a' })
    expect(endpoint.alias).toBe('reviewer')
    expect(endpoint.url).toBe('https://example.test/a2a')
  })

  it('rejects an unparseable url', () => {
    expect(() => createEndpoint({ alias: 'r', url: 'not a url' })).toThrow(PeerError)
  })

  it('refuses plaintext to a remote host, since bodies would be on the wire', () => {
    expect(() => createEndpoint({ alias: 'r', url: 'http://example.test/a2a' })).toThrowError(
      /must use https/,
    )
  })

  it('allows loopback plaintext, which is how anyone develops locally', () => {
    expect(createEndpoint({ alias: 'r', url: 'http://localhost:9999/a2a' }).alias).toBe('r')
    expect(createEndpoint({ alias: 'r', url: 'http://127.0.0.1:9999/a2a' }).alias).toBe('r')
  })

  it('drops a blank token rather than sending an empty header', () => {
    expect('token' in createEndpoint({ alias: 'r', url: 'https://x.test', token: '  ' })).toBe(false)
  })
})

describe('toA2ARequest', () => {
  it('builds a JSON-RPC message/send envelope', () => {
    const request = toA2ARequest(envelope())
    expect(request['jsonrpc']).toBe('2.0')
    expect(request['method']).toBe(A2A_SEND_METHOD)
    expect(request['id']).toBe('msg-1')
  })

  it('carries the body as a text part', () => {
    const params = toA2ARequest(envelope()) as { params: { message: { parts: { text: string }[] } } }
    expect(params.params.message.parts[0]?.text).toBe('tenant_id is now required')
  })

  it('carries reply correlation as contextId', () => {
    const params = toA2ARequest(envelope({ replyTo: 'msg-0' })) as {
      params: { message: { contextId?: string } }
    }
    expect(params.params.message.contextId).toBe('msg-0')
    const none = toA2ARequest(envelope()) as { params: { message: { contextId?: string } } }
    expect(none.params.message.contextId).toBeUndefined()
  })

  it('namespaces our metadata so a foreign agent can ignore it wholesale', () => {
    const params = toA2ARequest(envelope()) as {
      params: { message: { metadata: Record<string, string> } }
    }
    expect(Object.keys(params.params.message.metadata).every((k) => k.startsWith('dsh-agent-messaging/'))).toBe(
      true,
    )
  })
})

describe('readA2AResponse', () => {
  it('accepts a result', () => {
    expect(readA2AResponse({ jsonrpc: '2.0', id: '1', result: {} })).toEqual({ accepted: true })
  })

  it('treats a JSON-RPC error as a refusal, not a transport failure', () => {
    const outcome = readA2AResponse({ jsonrpc: '2.0', id: '1', error: { code: -32000, message: 'busy' } })
    expect(outcome).toEqual({ accepted: false, detail: 'busy' })
  })

  it('rejects a non-JSON-RPC body', () => {
    expect(() => readA2AResponse({ ok: true })).toThrow(PeerError)
    expect(() => readA2AResponse('nope')).toThrow(PeerError)
  })

  it('rejects a response with neither result nor error', () => {
    expect(() => readA2AResponse({ jsonrpc: '2.0', id: '1' })).toThrowError(/neither a result nor an error/)
  })
})

describe('A2AClient against a real server', () => {
  let server: Server
  let url: string
  let received: { body: unknown; auth?: string } | undefined
  let respond: (body: unknown, status?: number) => void

  beforeEach(async () => {
    received = undefined
    let reply: { body: unknown; status: number } = { body: { jsonrpc: '2.0', id: '1', result: {} }, status: 200 }
    respond = (body, status = 200) => {
      reply = { body, status }
    }

    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        received = {
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          ...(req.headers.authorization === undefined ? {} : { auth: req.headers.authorization }),
        }
        res.writeHead(reply.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(reply.body))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/a2a`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('delivers, and sends what an A2A peer expects', async () => {
    const client = new A2AClient({ timeoutMs: 2_000 })
    const receipt = await client.send(createEndpoint({ alias: 'reviewer', url }), envelope())

    expect(receipt).toEqual({ status: 'delivered' })
    const body = received?.body as { method: string; params: { message: { parts: { text: string }[] } } }
    expect(body.method).toBe('message/send')
    expect(body.params.message.parts[0]?.text).toBe('tenant_id is now required')
  })

  it('sends a bearer token when one is configured, and none when not', async () => {
    const client = new A2AClient({ timeoutMs: 2_000 })
    await client.send(createEndpoint({ alias: 'r', url, token: 'secret' }), envelope())
    expect(received?.auth).toBe('Bearer secret')

    await client.send(createEndpoint({ alias: 'r', url }), envelope())
    expect(received?.auth).toBeUndefined()
  })

  it('reports a JSON-RPC error as refused rather than throwing', async () => {
    respond({ jsonrpc: '2.0', id: '1', error: { code: -32000, message: 'at capacity' } })
    const receipt = await new A2AClient({ timeoutMs: 2_000 }).send(
      createEndpoint({ alias: 'r', url }),
      envelope(),
    )
    expect(receipt).toEqual({ status: 'refused', detail: 'at capacity' })
  })

  it('fails on a non-2xx status', async () => {
    respond({ error: 'nope' }, 503)
    await expect(
      new A2AClient({ timeoutMs: 2_000 }).send(createEndpoint({ alias: 'r', url }), envelope()),
    ).rejects.toThrowError(/answered 503/)
  })

  it('fails when nothing is listening', async () => {
    await expect(
      new A2AClient({ timeoutMs: 2_000 }).send(
        createEndpoint({ alias: 'r', url: 'http://127.0.0.1:1/a2a' }),
        envelope(),
      ),
    ).rejects.toThrow(PeerError)
  })

  it('honours a signal that was already aborted before the call', async () => {
    // Found by this test: an already-aborted signal never fires its event, so
    // the request went out and the message was delivered anyway.
    const controller = new AbortController()
    controller.abort()
    await expect(
      new A2AClient({ timeoutMs: 5_000 }).send(
        createEndpoint({ alias: 'r', url }),
        envelope(),
        controller.signal,
      ),
    ).rejects.toThrow(PeerError)
  })
})
