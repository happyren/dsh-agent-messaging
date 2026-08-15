/**
 * `peer_verify` and `peer_verify_reply` — ask a peer to check a claim, and answer.
 *
 * Two tools rather than one because they are used by different sides at
 * different times, and a single tool with a mode flag would let a model conflate
 * "I am asking" with "I am answering".
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import { explainSendFailure, type MessageSender } from '../app/send-message.ts'
import {
  createRequest,
  createVerdict,
  renderRequest,
  renderVerdict,
  VERDICTS,
  type Evidence,
  type Verdict,
} from '../domain/verification.ts'
import { noMetrics, type MetricsSink } from '../ports/index.ts'
import { presentVerifyCall, presentVerifyReplyCall } from './presentation.ts'
import { requireCallerSessionId } from './caller.ts'
import type { SenderIdentityResolver } from './peer-send.ts'

/** Evidence as the model supplies it, before validation. */
interface RawEvidence {
  readonly locator?: string
  readonly at?: string
  readonly note?: string
}

/**
 * Narrow model-supplied evidence rows to the domain shape.
 * @param rows - whatever the model passed.
 * @returns evidence with a usable locator.
 */
function toEvidence(rows: readonly RawEvidence[] | undefined): readonly Evidence[] {
  return (rows ?? [])
    .filter((row): row is RawEvidence & { locator: string } => Boolean(row?.locator?.trim()))
    .map((row) => ({
      locator: row.locator,
      ...(row.at === undefined ? {} : { at: row.at }),
      ...(row.note === undefined ? {} : { note: row.note }),
    }))
}

const EVIDENCE_SCHEMA = {
  type: 'array',
  description: 'Where the verifier should look. Cheap to supply, and it is what makes checking fast.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      locator: {
        type: 'string',
        required: true,
        description: 'A workspace path, commit sha, command, or URL.',
      },
      at: { type: 'string', description: 'Line or range within the file, e.g. "12-30".' },
      note: { type: 'string', description: 'Why this is relevant to the claim.' },
    },
  },
} as const

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', required: true },
    to: { type: 'string', required: true },
    message_id: { type: 'string', required: true },
    detail: { type: 'string' },
  },
} as const

/**
 * Build the `peer_verify` tool.
 * @param sender - the send use case.
 * @param identify - resolves the caller's own peer identity.
 * @returns the registry-ready definition.
 */
export function createPeerVerifyTool(
  sender: MessageSender,
  identify: SenderIdentityResolver,
  metrics: MetricsSink = noMetrics,
): ToolDefinition {
  return defineTool({
    name: 'peer_verify',
    description: [
      'Ask another agent session to independently check a specific factual claim you are relying on.',
      'Use it when being wrong would be expensive and the other session is better placed to know —',
      'it owns the code in question, it just changed that area, or it has context you do not.',
      'State the claim so it could be proven false, and cite where to look; a verifier with',
      'file paths checks in seconds, one without them has to go searching.',
      'This is not a request for agreement or a second opinion on a judgement call.',
      'It is worth doing because you cannot reliably check your own reasoning, and a peer',
      'that did not produce the artefact has to actually look at it.',
    ].join(' '),
    parameters: {
      to: {
        type: 'string',
        required: true,
        description: 'The session to ask: a name from peer_list, or a session id.',
      },
      claim: {
        type: 'string',
        required: true,
        description: 'The exact proposition to check, stated so it could be shown false.',
      },
      evidence: EVIDENCE_SCHEMA,
      urgent: {
        type: 'boolean',
        default: false,
        description: 'Interrupt the verifier now rather than queueing. Only if their current work depends on it.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            `${value.status} → ${value.to}`,
            value.detail ?? '',
            value.message_id ? `messageId: ${value.message_id}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    },
    presentCall: (args) => presentVerifyCall(args),
    async execute(args, exec) {
      const selfSessionId = requireCallerSessionId(exec)
      try {
        const request = createRequest(args.claim, toEvidence(args.evidence))
        const self = await identify(selfSessionId, exec.signal)
        const outcome = await sender.send(self, {
          to: args.to,
          body: renderRequest(request),
          mode: args.urgent === true ? 'steer' : 'followup',
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        })
        metrics.record('verification-sent')
        return {
          status: outcome.receipt.status,
          to: outcome.peer.name,
          message_id: outcome.envelope.id,
          ...(outcome.receipt.detail === undefined ? {} : { detail: outcome.receipt.detail }),
        }
      } catch (error) {
        return { status: 'failed', to: args.to, message_id: '', detail: explainSendFailure(error) }
      }
    },
  })
}

/**
 * Build the `peer_verify_reply` tool.
 * @param sender - the send use case.
 * @param identify - resolves the caller's own peer identity.
 * @returns the registry-ready definition.
 */
export function createPeerVerifyReplyTool(
  sender: MessageSender,
  identify: SenderIdentityResolver,
  metrics: MetricsSink = noMetrics,
): ToolDefinition {
  return defineTool({
    name: 'peer_verify_reply',
    description: [
      'Answer a verification request you received from another agent session.',
      'Call this only after actually checking — open the cited files, run the command, read the code.',
      'Report what you found even when it contradicts the sender: a refutation delivered now is',
      'worth far more than agreement, because the sender is about to act on the claim.',
      'Use "inconclusive" when you looked and genuinely cannot tell, and "declined" when you',
      'lack the access or the standing to judge. Do not guess to be helpful.',
    ].join(' '),
    parameters: {
      to: {
        type: 'string',
        required: true,
        description: 'The session that asked: a name from peer_list, or its session id.',
      },
      verdict: {
        type: 'string',
        required: true,
        enum: [...VERDICTS],
        description: 'confirmed, refuted, inconclusive, or declined.',
      },
      rationale: {
        type: 'string',
        required: true,
        description: 'What you actually examined and what you found. Not a restatement of the claim.',
      },
      evidence: EVIDENCE_SCHEMA,
      reply_to: {
        type: 'string',
        description: 'The messageId of the verification request you are answering.',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [
        {
          type: 'text',
          text: [`${value.status} → ${value.to}`, value.detail ?? ''].filter(Boolean).join('\n'),
        },
      ],
    },
    presentCall: (args) => presentVerifyReplyCall(args),
    async execute(args, exec) {
      const selfSessionId = requireCallerSessionId(exec)
      try {
        const verdict = createVerdict(
          args.verdict as Verdict,
          args.rationale,
          toEvidence(args.evidence),
        )
        // A refutation is the outcome worth counting: it is a false premise
        // caught before the asker acted on it.
        metrics.record(
          verdict.verdict === 'refuted'
            ? 'verification-refuted'
            : verdict.verdict === 'confirmed'
              ? 'verification-confirmed'
              : 'verification-unsettled',
        )
        const self = await identify(selfSessionId, exec.signal)
        const outcome = await sender.send(self, {
          to: args.to,
          body: renderVerdict(verdict),
          // A refutation lands at the next step boundary: the asker is likely
          // acting on the claim right now, and a queued turn arrives too late.
          mode: verdict.verdict === 'refuted' ? 'steer' : 'followup',
          ...(args.reply_to === undefined ? {} : { replyTo: args.reply_to }),
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        })
        return {
          status: outcome.receipt.status,
          to: outcome.peer.name,
          message_id: outcome.envelope.id,
          ...(outcome.receipt.detail === undefined ? {} : { detail: outcome.receipt.detail }),
        }
      } catch (error) {
        return { status: 'failed', to: args.to, message_id: '', detail: explainSendFailure(error) }
      }
    },
  })
}
