/**
 * `peer_list` — which sessions this one can address.
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { MessageSender } from '../app/send-message.ts'
import type { PeerDescriptor } from '../domain/peer.ts'
import { requireCallerSessionId } from './caller.ts'

/** Reachability as the model should reason about it. */
function reachability(peer: PeerDescriptor): string {
  switch (peer.location.kind) {
    case 'local':
      return peer.status === 'running' ? 'running' : 'idle'
    case 'remote':
      return 'running (another host process)'
    case 'offline':
      return 'not running'
  }
}

/**
 * Build the `peer_list` tool.
 * @param sender - the send use case, which also owns discovery.
 * @returns the registry-ready definition.
 */
export function createPeerListTool(sender: MessageSender): ToolDefinition {
  return defineTool({
    name: 'peer_list',
    description: [
      'List the other agent sessions you can send a message to with peer_send.',
      'Use it before peer_send when you do not already know the exact name of the session you mean,',
      'or when an address was ambiguous. Sessions marked "not running" can still be sent to:',
      'the message is queued and delivered when that session next starts.',
      'This returns only session identities — never their conversation contents.',
    ].join(' '),
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'The address to pass to peer_send.' },
            session_id: { type: 'string', required: true },
            state: { type: 'string', required: true, description: 'running, idle, or not running.' },
            title: { type: 'string' },
            cwd: { type: 'string' },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.length === 0
              ? 'No other sessions are reachable.'
              : value
                  .map((peer) => {
                    const where = peer.cwd ? ` — ${peer.cwd}` : ''
                    const title = peer.title ? ` "${peer.title}"` : ''
                    return `${peer.name} [${peer.state}]${title}${where}`
                  })
                  .join('\n'),
        },
      ],
    },
    async execute(_args, exec) {
      const self = requireCallerSessionId(exec)
      const peers = await sender.peers(self, exec.signal)
      return peers.map((peer) => ({
        name: peer.name,
        session_id: peer.sessionId,
        state: reachability(peer),
        ...(peer.title === undefined ? {} : { title: peer.title }),
        ...(peer.cwd === undefined ? {} : { cwd: peer.cwd }),
      }))
    },
  })
}
