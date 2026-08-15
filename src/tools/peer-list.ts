/**
 * `peer_list` — which sessions this one can address.
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { CardStore } from '../adapters/cards.ts'
import type { TaskStateStore } from '../adapters/task-states.ts'
import type { WorkClaims } from '../app/claim-work.ts'
import type { MessageSender } from '../app/send-message.ts'
import { summarizeCard } from '../domain/card.ts'
import type { PeerDescriptor } from '../domain/peer.ts'
import { summarizeTaskState } from '../domain/task-state.ts'
import { requireCallerSessionId } from './caller.ts'

/** Reachability as the model should reason about it. */
function reachability(peer: PeerDescriptor): string {
  switch (peer.location.kind) {
    case 'local':
      return peer.status === 'running' ? 'running' : 'idle'
    case 'remote':
      return 'running (another host process)'
    case 'a2a':
      return 'external agent (A2A)'
    case 'offline':
      return 'not running'
  }
}

/**
 * Build the `peer_list` tool.
 * @param sender - the send use case, which also owns discovery.
 * @param claims - live work claims, so a caller sees who is on what.
 * @param cards - capability cards, so a caller sees what each peer is for.
 * @param states - declared task states, so a caller sees what each peer's work is doing.
 * @returns the registry-ready definition.
 */
export function createPeerListTool(
  sender: MessageSender,
  claims: WorkClaims,
  cards: CardStore,
  states: TaskStateStore,
): ToolDefinition {
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
            role: {
              type: 'string',
              description: "What this peer says it is for, and what it owns. Its own words, not a guess from its title.",
            },
            task: {
              type: 'string',
              description:
                "What this peer's work is doing, in its own words: working, blocked, done or abandoned. More informative than the process state.",
            },
            working_on: {
              type: 'array',
              description: 'Resources this peer has claimed. Do not edit these without talking to them.',
              items: { type: 'string' },
            },
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
                    const head = `${peer.name} [${peer.state}]${title}${where}`
                    const held = peer.working_on ?? []
                    const lines = [head]
                    if (peer.task) lines.push(`    task: ${peer.task}`)
                    if (peer.role) lines.push(`    ${peer.role}`)
                    if (held.length > 0) lines.push(`    working on: ${held.join(', ')}`)
                    return lines.join('\n')
                  })
                  .join('\n'),
        },
      ],
    },
    async execute(_args, exec) {
      const self = requireCallerSessionId(exec)
      const [peers, held, published, declared] = await Promise.all([
        sender.peers(self, exec.signal),
        claims.all(),
        cards.readAll(),
        states.readAll(),
      ])
      const cardBySession = new Map(published.map((card) => [card.sessionId, card]))
      const stateBySession = new Map(declared.map((state) => [state.sessionId, state]))

      /** Claimed resources by holding session, so a caller sees who is on what. */
      const byHolder = new Map<string, string[]>()
      for (const claim of held) {
        const list = byHolder.get(claim.sessionId) ?? []
        list.push(`${claim.resource} (${claim.intent})`)
        byHolder.set(claim.sessionId, list)
      }

      return peers.map((peer) => {
        const working = byHolder.get(peer.sessionId) ?? []
        const card = cardBySession.get(peer.sessionId)
        const task = stateBySession.get(peer.sessionId)
        return {
          name: peer.name,
          session_id: peer.sessionId,
          state: reachability(peer),
          ...(peer.title === undefined ? {} : { title: peer.title }),
          ...(peer.cwd === undefined ? {} : { cwd: peer.cwd }),
          ...(task === undefined ? {} : { task: summarizeTaskState(task) }),
          ...(card === undefined ? {} : { role: summarizeCard(card) }),
          ...(working.length === 0 ? {} : { working_on: working }),
        }
      })
    },
  })
}
