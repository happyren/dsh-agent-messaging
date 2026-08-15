/**
 * `peer_claim` — say what you are working on, and find out who else is.
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { WorkClaims } from '../app/claim-work.ts'
import type { ClaimScope } from '../domain/claim.ts'
import { explainSendFailure } from '../app/send-message.ts'
import type { SenderIdentityResolver } from './peer-send.ts'
import { presentClaimCall, presentClaimResult } from './presentation.ts'
import { requireCallerSessionId } from './caller.ts'

/** Minutes a claim lasts when the caller does not say. */
const DEFAULT_TTL_MINUTES = 30

/**
 * Build the `peer_claim` tool.
 * @param claims - the claim use case.
 * @param identify - resolves the caller's own peer identity.
 * @returns the registry-ready definition.
 */
export function createPeerClaimTool(
  claims: WorkClaims,
  identify: SenderIdentityResolver,
): ToolDefinition {
  return defineTool({
    name: 'peer_claim',
    description: [
      'Announce that you are working on a file, directory, or topic, so other agent sessions',
      'do not duplicate or collide with your work — and find out whether one of them is already on it.',
      'Call this BEFORE starting a substantial edit to a shared file, or before beginning work',
      'another session in this workspace could plausibly also be doing.',
      'If a peer already holds an overlapping claim, the claim is refused and you are told who has it',
      'and what they are doing; talk to them with peer_send rather than working in parallel.',
      'Claims are advisory hints, not locks: they do not prevent anyone writing anything.',
      'They expire on their own, so release yours when you are done rather than leaving it to lapse.',
    ].join(' '),
    parameters: {
      resource: {
        type: 'string',
        required: true,
        description: 'What you are working on: a workspace-relative path, or a topic name.',
      },
      intent: {
        type: 'string',
        description: 'What you are doing to it, so a peer can decide whether to wait or ask. Required when claiming.',
      },
      scope: {
        type: 'string',
        enum: ['path', 'topic'],
        default: 'path',
        description: 'Whether the resource is a workspace path (claims nest into directories) or a free-form topic.',
      },
      release: {
        type: 'boolean',
        default: false,
        description: 'Give up this claim instead of taking it.',
      },
      minutes: {
        type: 'integer',
        default: DEFAULT_TTL_MINUTES,
        description: `How long the claim should last. Defaults to ${DEFAULT_TTL_MINUTES}.`,
      },
      force: {
        type: 'boolean',
        default: false,
        description: 'Take the claim despite a conflict. Only after agreeing it with the holder.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, description: 'granted, refused, released, or failed.' },
          resource: { type: 'string', required: true },
          detail: { type: 'string' },
          expires_in_minutes: { type: 'integer' },
          conflicts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                holder: { type: 'string', required: true },
                holder_session_id: { type: 'string', required: true },
                resource: { type: 'string', required: true },
                intent: { type: 'string', required: true },
                expires_in_minutes: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.status === 'refused') {
          const lines = value.conflicts.map(
            (c) =>
              `${c.holder} holds "${c.resource}" — ${c.intent} (expires in ~${c.expires_in_minutes} min)`,
          )
          return [
            {
              type: 'text',
              text: [
                `refused: "${value.resource}" overlaps a claim held by another session.`,
                ...lines,
                'Message the holder with peer_send instead of working in parallel.',
              ].join('\n'),
            },
          ]
        }
        const suffix =
          value.expires_in_minutes === undefined ? '' : ` (expires in ${value.expires_in_minutes} min)`
        return [
          {
            type: 'text',
            text: `${value.status}: "${value.resource}"${suffix}${value.detail ? ` — ${value.detail}` : ''}`,
          },
        ]
      },
    },
    presentCall: (args) => presentClaimCall(args),
    presentResult: (args, result) => presentClaimResult(args, result),
    async execute(args, exec) {
      const selfSessionId = requireCallerSessionId(exec)
      const scope = (args.scope ?? 'path') as ClaimScope

      try {
        if (args.release === true) {
          const released = await claims.release(selfSessionId, { scope, resource: args.resource })
          return {
            status: released > 0 ? 'released' : 'failed',
            resource: args.resource,
            conflicts: [],
            ...(released > 0 ? {} : { detail: 'You did not hold that claim.' }),
          }
        }

        if (!args.intent?.trim()) {
          return {
            status: 'failed',
            resource: args.resource,
            conflicts: [],
            detail: 'Claiming needs an intent, so a peer can decide whether to wait for you.',
          }
        }

        const self = await identify(selfSessionId, exec.signal)
        const minutes = args.minutes ?? DEFAULT_TTL_MINUTES
        const outcome = await claims.take(
          { sessionId: selfSessionId, name: self.name },
          {
            scope,
            resource: args.resource,
            intent: args.intent,
            ttlMs: minutes * 60_000,
            ...(args.force === undefined ? {} : { force: args.force }),
          },
        )

        const now = Date.now()
        const conflicts = outcome.conflicts.map((c) => ({
          holder: c.name,
          holder_session_id: c.sessionId,
          resource: c.resource,
          intent: c.intent,
          expires_in_minutes: Math.max(0, Math.round((c.expiresAt - now) / 60_000)),
        }))

        return {
          status: outcome.granted ? 'granted' : 'refused',
          resource: outcome.claim?.resource ?? args.resource,
          conflicts,
          ...(outcome.granted ? { expires_in_minutes: minutes } : {}),
          ...(outcome.granted && conflicts.length > 0
            ? { detail: 'Taken despite an existing claim, because force was set.' }
            : {}),
        }
      } catch (error) {
        return {
          status: 'failed',
          resource: args.resource,
          conflicts: [],
          detail: explainSendFailure(error),
        }
      }
    },
  })
}
