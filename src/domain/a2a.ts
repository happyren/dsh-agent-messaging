/**
 * Agent2Agent interoperability.
 *
 * A2A is the agent-to-agent standard worth building against — donated by Google
 * to the Linux Foundation, with AWS, Cisco, Microsoft, Salesforce, SAP and
 * ServiceNow among the founding members — and it complements MCP rather than
 * competing with it: MCP connects an agent to tools, A2A connects agents to each
 * other.
 *
 * Speaking it turns "cross-session" into "cross-vendor": a DSH session can reach
 * an agent that is not DSH at all. This is the outbound half only — serving an
 * Agent Card so external agents can reach *in* needs an HTTP surface and a
 * separate authorization story, and is not implemented. The mapping is small because our envelope
 * already carries the same facts A2A does — identity, message content, and a
 * correlation id.
 *
 * One thing deliberately does *not* cross the wire. A2A cannot express authority
 * scope — researchers analysing MCP, A2A and ACP identify exactly this governance
 * gap — so `peerAuthority` stays local: an external agent is always `inform`,
 * whatever it claims about itself. Trust is a property of the receiver's
 * configuration, not of a protocol field a stranger can set.
 */

import { PeerError } from './errors.ts'
import type { Envelope } from './envelope.ts'

/** JSON-RPC version A2A rides on. */
const JSONRPC_VERSION = '2.0'

/** The A2A method for sending a message to an agent. */
export const A2A_SEND_METHOD = 'message/send'

/** An external agent this deployment can reach. */
export interface A2AEndpoint {
  /** Stable local handle, used as the peer's address. */
  readonly alias: string
  /** Absolute JSON-RPC endpoint URL. */
  readonly url: string
  /** Optional bearer token, supplied by the operator. */
  readonly token?: string
}

/**
 * Validate an operator-configured endpoint.
 * @param endpoint - the endpoint as configured.
 * @returns the frozen endpoint.
 * @throws {PeerError} `invalid-envelope` when the alias or URL is unusable.
 */
export function createEndpoint(endpoint: A2AEndpoint): A2AEndpoint {
  const alias = endpoint.alias.trim().toLowerCase()
  if (!alias) throw new PeerError('invalid-envelope', 'An A2A endpoint needs an alias.')

  let url: URL
  try {
    url = new URL(endpoint.url)
  } catch {
    throw new PeerError('invalid-envelope', `A2A endpoint "${alias}" has an unparseable URL.`)
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    // Plaintext to a remote host would put message bodies on the wire; loopback
    // is allowed because that is how anyone develops against a local agent.
    throw new PeerError(
      'invalid-envelope',
      `A2A endpoint "${alias}" must use https, or point at localhost.`,
    )
  }

  return Object.freeze({
    alias,
    url: url.toString(),
    ...(endpoint.token?.trim() ? { token: endpoint.token.trim() } : {}),
  })
}

/**
 * Project one envelope into an A2A `message/send` request.
 *
 * `messageId` and `contextId` carry our identity and reply correlation, which is
 * what lets an answer come back and be matched to the question.
 * @param envelope - the message to send.
 * @returns the JSON-RPC request body.
 */
export function toA2ARequest(envelope: Envelope): Record<string, unknown> {
  return {
    jsonrpc: JSONRPC_VERSION,
    id: envelope.id,
    method: A2A_SEND_METHOD,
    params: {
      message: {
        role: 'user',
        messageId: envelope.id,
        ...(envelope.replyTo === undefined ? {} : { contextId: envelope.replyTo }),
        parts: [{ kind: 'text', text: envelope.body }],
        metadata: {
          // Namespaced so a foreign agent can ignore it wholesale.
          'dsh-agent-messaging/from': envelope.from.name,
          'dsh-agent-messaging/fromSessionId': envelope.from.sessionId,
          'dsh-agent-messaging/mode': envelope.mode,
        },
      },
    },
  }
}

/**
 * Read an A2A response, distinguishing acceptance from refusal.
 * @param value - the parsed response body.
 * @returns whether the peer accepted, and any detail it gave.
 * @throws {PeerError} `transport-failed` when the body is not a JSON-RPC response.
 */
export function readA2AResponse(value: unknown): { accepted: boolean; detail?: string } {
  if (typeof value !== 'object' || value === null) {
    throw new PeerError('transport-failed', 'A2A peer returned a non-object response.')
  }
  const body = value as Record<string, unknown>
  if (body['jsonrpc'] !== JSONRPC_VERSION) {
    throw new PeerError('transport-failed', 'A2A peer returned a non-JSON-RPC response.')
  }

  const error = body['error']
  if (error !== undefined && error !== null) {
    const detail =
      typeof error === 'object' && typeof (error as Record<string, unknown>)['message'] === 'string'
        ? ((error as Record<string, unknown>)['message'] as string)
        : 'the peer reported an error'
    return { accepted: false, detail }
  }

  if (!('result' in body)) {
    throw new PeerError('transport-failed', 'A2A peer returned neither a result nor an error.')
  }
  return { accepted: true }
}
