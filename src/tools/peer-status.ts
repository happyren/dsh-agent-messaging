/**
 * `peer_status` — say what your work is doing, and learn if you have deadlocked.
 *
 * Declaring `blocked` is the moment a mutual wait can first be detected, so the
 * check happens here rather than in a sweep nobody would run. A deadlock between
 * agents is otherwise silent: every participant looks merely idle.
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { TaskStateStore } from '../adapters/task-states.ts'
import { explainSendFailure } from '../app/send-message.ts'
import { createTaskState, findWaitCycle, TASK_PHASES, type TaskPhase } from '../domain/task-state.ts'
import { noMetrics, type MetricsSink } from '../ports/index.ts'
import { requireCallerSessionId } from './caller.ts'
import type { SenderIdentityResolver } from './peer-send.ts'

/** Resolves a peer address to its session id, so `blocked_on` may name either. */
export type SessionIdResolver = (address: string, signal?: AbortSignal) => Promise<string | undefined>

/**
 * Build the `peer_status` tool.
 * @param states - the task-state store.
 * @param identify - resolves the caller's own peer identity.
 * @param resolveSessionId - resolves a peer address to a session id.
 * @returns the registry-ready definition.
 */
export function createPeerStatusTool(
  states: TaskStateStore,
  identify: SenderIdentityResolver,
  resolveSessionId: SessionIdResolver,
  metrics: MetricsSink = noMetrics,
): ToolDefinition {
  return defineTool({
    name: 'peer_status',
    description: [
      'Tell other agent sessions what your work is doing: working, blocked, done, or abandoned.',
      'Their view of you is otherwise just "idle" or "running", which cannot distinguish',
      'a session that finished from one that is stuck waiting for someone.',
      'Declare "blocked" with blocked_on naming the session you are waiting for — that is what',
      'lets a mutual wait be detected, and this tool will warn you immediately if you have just',
      'created one, because a deadlock between agents is otherwise silent.',
      'Declare "done" when you finish so nobody keeps waiting on you, and "abandoned" if you',
      'stop without finishing — leaving a stale "working" behind is how peers end up waiting',
      'forever on work that is never coming.',
    ].join(' '),
    parameters: {
      phase: {
        type: 'string',
        required: true,
        enum: [...TASK_PHASES],
        description: 'working, blocked, done, or abandoned.',
      },
      summary: {
        type: 'string',
        required: true,
        description: 'What the task is, or what happened to it. One line a peer can act on.',
      },
      blocked_on: {
        type: 'string',
        description: 'The peer you are waiting for, by name or session id. Only with phase "blocked".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          phase: { type: 'string', required: true },
          detail: { type: 'string' },
          deadlock: {
            type: 'array',
            description: 'Sessions in a mutual wait including you, in wait order. Empty when there is none.',
            items: { type: 'string' },
          },
        },
      },
      render: (_args, value) => {
        const cycle = value.deadlock ?? []
        if (cycle.length > 0) {
          return [
            {
              type: 'text',
              text: [
                `${value.status}: ${value.phase}`,
                `DEADLOCK — you are in a mutual wait: ${cycle.join(' → ')} → ${cycle[0]}`,
                'Nobody in this cycle will proceed on their own. Break it: message one of them with',
                'peer_send, do the part you can without waiting, or ask your user to decide.',
              ].join('\n'),
            },
          ]
        }
        return [
          {
            type: 'text',
            text: `${value.status}: ${value.phase}${value.detail ? ` — ${value.detail}` : ''}`,
          },
        ]
      },
    },
    async execute(args, exec) {
      const selfSessionId = requireCallerSessionId(exec)
      try {
        const self = await identify(selfSessionId, exec.signal)
        const phase = args.phase as TaskPhase

        // `blocked_on` may name a peer the way a human would; store the id.
        let blockedOn: string | undefined
        if (phase === 'blocked' && args.blocked_on?.trim()) {
          blockedOn = (await resolveSessionId(args.blocked_on, exec.signal)) ?? args.blocked_on.trim()
        }

        const state = createTaskState({
          sessionId: selfSessionId,
          name: self.name,
          phase,
          summary: args.summary,
          now: Date.now(),
          ...(blockedOn === undefined ? {} : { blockedOn }),
        })
        await states.publish(state)

        const cycle = findWaitCycle([...(await states.readAll())], selfSessionId)
        if (cycle.length > 0) metrics.record('deadlock-detected')
        return {
          status: 'published',
          phase,
          deadlock: cycle.map((entry) => entry.name),
          ...(cycle.length === 0 ? {} : { detail: 'Mutual wait detected.' }),
        }
      } catch (error) {
        return { status: 'failed', phase: args.phase, deadlock: [], detail: explainSendFailure(error) }
      }
    },
  })
}
