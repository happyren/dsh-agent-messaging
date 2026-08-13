/**
 * `peer_inbox` — the messages this session is holding for its operator.
 *
 * Only meaningful under the `hold` inbound policy. Holding exists so a human
 * decides what reaches the agent, so releasing is gated on the operator asking
 * for it — the tool description says so, and a held message cannot itself ask,
 * because a held message is never delivered.
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { InboundRouter } from '../app/receive-message.ts'
import { requireCallerSessionId } from './caller.ts'

/**
 * Build the `peer_inbox` tool.
 * @param inbound - the router holding undelivered messages.
 * @returns the registry-ready definition.
 */
export function createPeerInboxTool(inbound: InboundRouter): ToolDefinition {
  return defineTool({
    name: 'peer_inbox',
    description: [
      'List messages from other sessions that are being held for your user rather than delivered.',
      'Use it when your user asks whether anything is waiting, or to report what is pending.',
      'Set release to true only when your user explicitly tells you to accept the held messages;',
      'holding exists so that they, not you, decide what reaches this session.',
    ].join(' '),
    parameters: {
      release: {
        type: 'boolean',
        default: false,
        description: 'Deliver the held messages. Only when your user asked you to.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          held: { type: 'integer', required: true },
          released: { type: 'integer', required: true },
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                from: { type: 'string', required: true },
                message_id: { type: 'string', required: true },
                sent_at: { type: 'string', required: true },
                preview: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.released > 0
              ? `Released ${value.released} held message(s).`
              : value.held === 0
                ? 'No messages are being held.'
                : [
                    `${value.held} message(s) held for your user:`,
                    ...value.messages.map((m) => `- ${m.from} (${m.sent_at}): ${m.preview}`),
                  ].join('\n'),
        },
      ],
    },
    async execute(args, exec) {
      const self = requireCallerSessionId(exec)

      if (args.release === true) {
        const released = inbound.release(self)
        return { held: 0, released, messages: [] }
      }

      const waiting = inbound.held(self)
      return {
        held: waiting.length,
        released: 0,
        messages: waiting.map((item) => ({
          from: item.envelope.from.name,
          message_id: item.envelope.id,
          sent_at: new Date(item.envelope.sentAt).toISOString(),
          preview: item.envelope.body.replace(/\s+/g, ' ').slice(0, 160),
        })),
      }
    },
  })
}
