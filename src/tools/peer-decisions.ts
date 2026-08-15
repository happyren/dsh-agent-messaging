/**
 * `peer_decide` and `peer_decisions` — record what was settled, and read it back.
 *
 * Two tools because recording and consulting happen at different moments and by
 * different reasoning. Folding them into one with a mode flag would invite a
 * model to "record" when it meant to look something up.
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { DecisionStore } from '../adapters/decisions.ts'
import { explainSendFailure } from '../app/send-message.ts'
import type { ClaimScope } from '../domain/claim.ts'
import {
  createDecision,
  decisionsAbout,
  foldCurrent,
  renderDecisions,
} from '../domain/decision.ts'
import { toEvidence } from '../domain/evidence.ts'
import { noMetrics, type Clock, type IdFactory, type MetricsSink } from '../ports/index.ts'
import { presentDecideCall, presentDecisionsCall } from './presentation.ts'
import { requireCallerSessionId } from './caller.ts'
import type { SenderIdentityResolver } from './peer-send.ts'

const EVIDENCE_SCHEMA = {
  type: 'array',
  description: 'Where a reader can check this. Paths, commits, or commands.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      locator: { type: 'string', required: true, description: 'A workspace path, commit sha, command, or URL.' },
      at: { type: 'string', description: 'Line or range within the file.' },
      note: { type: 'string', description: 'Why this is relevant.' },
    },
  },
} as const

/**
 * Build the `peer_decide` tool.
 * @param decisions - the ledger.
 * @param identify - resolves the caller's own peer identity.
 * @param clock - injected time.
 * @param ids - injected identity.
 * @returns the registry-ready definition.
 */
export function createPeerDecideTool(
  decisions: DecisionStore,
  identify: SenderIdentityResolver,
  clock: Clock,
  ids: IdFactory,
  metrics: MetricsSink = noMetrics,
): ToolDefinition {
  return defineTool({
    name: 'peer_decide',
    description: [
      'Record a decision in the shared ledger, so other agent sessions — including ones that',
      'start later — can find out what was already settled instead of rediscovering or reversing it.',
      'Record the kind of decision someone would otherwise have to reconstruct from a transcript:',
      'a convention adopted, an approach rejected and why, a contract fixed, a tradeoff accepted.',
      'Do not record routine progress; that is what peer_status is for.',
      'State it so a peer can act on it without the discussion that produced it, and cite evidence',
      'so they can check it. If this reverses or refines an earlier decision, pass its id as',
      'supersedes — the ledger never edits or deletes, it supersedes, and a peer reading the',
      'current set should not have to work out which of two conflicting entries still holds.',
    ].join(' '),
    parameters: {
      statement: {
        type: 'string',
        required: true,
        description: 'What was decided, stated so a peer can act on it without the discussion.',
      },
      rationale: { type: 'string', description: 'Why, when it is not obvious from the statement.' },
      about: {
        type: 'string',
        description: 'What it concerns: a workspace path, or a topic name. Lets peers query by area.',
      },
      about_scope: {
        type: 'string',
        enum: ['path', 'topic'],
        default: 'path',
        description: 'Whether "about" is a workspace path or a free-form topic.',
      },
      evidence: EVIDENCE_SCHEMA,
      supersedes: {
        type: 'string',
        description: 'The id of a decision this one replaces.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          id: { type: 'string', required: true },
          detail: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.status === 'recorded'
              ? `recorded · id: ${value.id}`
              : `${value.status}${value.detail ? `: ${value.detail}` : ''}`,
        },
      ],
    },
    presentCall: (args) => presentDecideCall(args),
    async execute(args, exec) {
      const selfSessionId = requireCallerSessionId(exec)
      try {
        const self = await identify(selfSessionId, exec.signal)
        const decision = createDecision({
          id: ids.next(),
          sessionId: selfSessionId,
          name: self.name,
          statement: args.statement,
          now: clock.now(),
          evidence: toEvidence(args.evidence),
          ...(args.rationale === undefined ? {} : { rationale: args.rationale }),
          ...(args.supersedes === undefined ? {} : { supersedes: args.supersedes }),
          ...(args.about === undefined
            ? {}
            : { about: { resource: args.about, scope: (args.about_scope ?? 'path') as ClaimScope } }),
        })
        await decisions.append(decision)
        metrics.record('decision-recorded')
        return { status: 'recorded', id: decision.id }
      } catch (error) {
        return { status: 'failed', id: '', detail: explainSendFailure(error) }
      }
    },
  })
}

/**
 * Build the `peer_decisions` tool.
 * @param decisions - the ledger.
 * @returns the registry-ready definition.
 */
export function createPeerDecisionsTool(decisions: DecisionStore): ToolDefinition {
  return defineTool({
    name: 'peer_decisions',
    description: [
      'Read decisions other agent sessions have already recorded about this workspace.',
      'Call it before settling anything that another session plausibly settled first —',
      'a convention, an approach, a contract — and when you start work in an area that',
      'is new to you but not to the repository.',
      'By default it returns only decisions still in force; superseded ones are hidden',
      'so you do not act on a reversed decision. Pass include_superseded to see the history.',
      'Filter with "about" to ask what was decided regarding a specific path or topic.',
    ].join(' '),
    parameters: {
      about: {
        type: 'string',
        description: 'Only decisions concerning this path or topic. A directory covers what is beneath it.',
      },
      about_scope: {
        type: 'string',
        enum: ['path', 'topic'],
        default: 'path',
        description: 'Whether "about" is a workspace path or a free-form topic.',
      },
      include_superseded: {
        type: 'boolean',
        default: false,
        description: 'Include decisions that have been replaced. Off by default.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', required: true },
          rendered: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.rendered }],
    },
    presentCall: (args) => presentDecisionsCall(args),
    async execute(args) {
      const all = await decisions.readAll()
      const scoped = args.about
        ? decisionsAbout(all, {
            scope: (args.about_scope ?? 'path') as ClaimScope,
            resource: args.about,
          })
        : all
      const selected =
        args.include_superseded === true
          ? [...scoped].sort((a, b) => b.decidedAt - a.decidedAt)
          : foldCurrent(scoped)

      return { count: selected.length, rendered: renderDecisions(selected) }
    },
  })
}
