/**
 * `peer_card` — declare what this session is for, and what it owns.
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { explainSendFailure } from '../app/send-message.ts'
import { createCard, summarizeCard } from '../domain/card.ts'
import type { ClaimScope } from '../domain/claim.ts'
import type { CardStore } from '../adapters/cards.ts'
import { requireCallerSessionId } from './caller.ts'

/**
 * Build the `peer_card` tool.
 * @param cards - the card store.
 * @returns the registry-ready definition.
 */
export function createPeerCardTool(cards: CardStore): ToolDefinition {
  return defineTool({
    name: 'peer_card',
    description: [
      'Declare what this session is for and which parts of the workspace it is responsible for,',
      'so other agent sessions address you about the right things and route work correctly.',
      'Call it once early when your task has a clear scope — especially when several sessions',
      'are working the same repository — and again if your scope changes materially.',
      'Declare groups to be reachable as part of a set: a peer can then address everyone in',
      '"#backend" with one peer_send instead of messaging each session separately.',
      'Ownership here is standing responsibility, not a reservation: it does not stop anyone',
      'touching a file, and it never conflicts. Use peer_claim for the short-lived "I am editing',
      'this right now" signal. Declaring what you do NOT own is as useful as what you do,',
      'because it stops peers sending you work that is not yours.',
    ].join(' '),
    parameters: {
      alias: {
        type: 'string',
        description:
          'A short stable handle for this session, e.g. "tech-lead". Your display name is folded from your title and changes; an alias does not, so operators and peers can rely on it.',
      },
      role: {
        type: 'string',
        required: true,
        description: 'What this session is for, in one or two sentences.',
      },
      owns: {
        type: 'array',
        description: 'Paths or topics this session is responsible for.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            resource: { type: 'string', required: true, description: 'A workspace path, or a topic name.' },
            scope: {
              type: 'string',
              enum: ['path', 'topic'],
              default: 'path',
              description: 'Whether the resource is a workspace path or a free-form topic.',
            },
          },
        },
      },
      skills: {
        type: 'array',
        description: 'Short labels a peer can match a need against, e.g. "sql-migrations".',
        items: { type: 'string' },
      },
      groups: {
        type: 'array',
        description:
          'Groups this session belongs to, e.g. "backend". Peers can then address the whole group with peer_send to: "#backend".',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          detail: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `${value.status}: ${value.summary}${value.detail ? `\n${value.detail}` : ''}`,
        },
      ],
    },
    async execute(args, exec) {
      const selfSessionId = requireCallerSessionId(exec)
      try {
        const card = createCard({
          sessionId: selfSessionId,
          role: args.role,
          now: Date.now(),
          ...(args.owns === undefined
            ? {}
            : {
                owns: args.owns.map((entry) => ({
                  resource: entry.resource,
                  ...(entry.scope === undefined ? {} : { scope: entry.scope as ClaimScope }),
                })),
              }),
          ...(args.skills === undefined ? {} : { skills: args.skills }),
          ...(args.groups === undefined ? {} : { groups: args.groups }),
          ...(args.alias === undefined ? {} : { alias: args.alias }),
        })
        await cards.publish(card)
        return { status: 'published', summary: summarizeCard(card) }
      } catch (error) {
        return { status: 'failed', summary: args.role, detail: explainSendFailure(error) }
      }
    },
  })
}
