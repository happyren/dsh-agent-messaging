/**
 * How this plugin's calls render in a UI.
 *
 * Without these, every call collapses to a bare `peer_send · checkout-client`
 * row and the reader has to expand it to learn anything. The tools deal in
 * facts a card can carry usefully — who, what mode, what verdict, which
 * resource — so the presenters put those in the title and leave the body for
 * what genuinely needs reading.
 *
 * Pure by contract: presenters run on replayed history as well as live calls, so
 * they read only their arguments and result, never a clock or the filesystem.
 * They are also `undefined`-tolerant, because a replayed call may carry
 * arguments from an older version of the tool.
 */

import type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools'

/** Longest fragment of a message body shown in a card title. */
const TITLE_BODY_CHARS = 60

/**
 * Shorten text for a single-line card title.
 * @param text - the text to shorten.
 * @param max - the budget.
 * @returns the text, ellipsized when over budget.
 */
function clip(text: string, max = TITLE_BODY_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

/** How each delivery mode reads in a card. */
const MODE_LABEL: Record<string, string> = {
  steer: 'interrupt',
  followup: 'next turn',
  context: 'quiet',
}

/**
 * Card for a `peer_send` call.
 * @param args - the call's arguments.
 * @returns the pending-call view.
 */
export function presentSendCall(args: { to?: string; message?: string; mode?: string }): ToolCallView {
  const mode = MODE_LABEL[args.mode ?? 'followup'] ?? args.mode ?? 'next turn'
  const target = args.to ?? 'a peer'
  return {
    card: 'generic',
    kind: 'other',
    title: `Message ${target} (${mode})`,
    ...(args.message ? { content: [{ type: 'text', text: args.message }] } : {}),
  }
}

/**
 * Card for a completed `peer_send`.
 * @param _args - the call's arguments.
 * @param result - the model-facing result.
 * @returns the completed view.
 */
export function presentSendResult(
  _args: unknown,
  result: { content?: { type: string; text?: string }[] },
): ToolResultView {
  const text = firstText(result)
  // A refusal or drop is the outcome a reader must not miss, so it leads.
  const status = text.split('\n')[0] ?? ''
  return { card: 'generic', title: status ? clip(status, 80) : 'Message sent' }
}

/**
 * Card for a `peer_claim` call.
 * @param args - the call's arguments.
 * @returns the pending-call view.
 */
export function presentClaimCall(args: {
  resource?: string
  intent?: string
  release?: boolean
}): ToolCallView {
  const resource = args.resource ?? 'a resource'
  return {
    card: 'generic',
    kind: 'other',
    title: args.release === true ? `Release ${resource}` : `Claim ${resource}`,
    ...(args.intent ? { rawInput: args.intent } : {}),
    // A path claim is about a file, so a capable UI can follow along.
    ...(args.resource && !args.resource.includes(' ') ? { locations: [{ path: args.resource }] } : {}),
  }
}

/**
 * Card for a completed `peer_claim`.
 * @param _args - the call's arguments.
 * @param result - the model-facing result.
 * @returns the completed view.
 */
export function presentClaimResult(
  _args: unknown,
  result: { content?: { type: string; text?: string }[] },
): ToolResultView {
  const text = firstText(result)
  if (text.startsWith('refused')) {
    // The refusal names the holder, which is the whole value of the call.
    return { card: 'generic', title: 'Claim refused — a peer holds it', content: [{ type: 'text', text }] }
  }
  return { card: 'generic', title: clip(text.split('\n')[0] ?? 'Claimed', 80) }
}

/**
 * Card for a `peer_verify` call.
 * @param args - the call's arguments.
 * @returns the pending-call view.
 */
export function presentVerifyCall(args: {
  to?: string
  claim?: string
  evidence?: { locator?: string }[]
}): ToolCallView {
  const locations = (args.evidence ?? [])
    .map((item) => item.locator)
    .filter((locator): locator is string => typeof locator === 'string' && !locator.includes(' '))
    .map((path) => ({ path }))

  return {
    card: 'generic',
    kind: 'read',
    title: `Ask ${args.to ?? 'a peer'} to verify`,
    ...(args.claim ? { content: [{ type: 'text', text: args.claim }] } : {}),
    ...(locations.length > 0 ? { locations } : {}),
  }
}

/**
 * Card for a `peer_verify_reply` call.
 *
 * The verdict is the entire point, so it is the title rather than something a
 * reader has to expand the card to find.
 * @param args - the call's arguments.
 * @returns the pending-call view.
 */
export function presentVerifyReplyCall(args: {
  to?: string
  verdict?: string
  rationale?: string
}): ToolCallView {
  const verdict = (args.verdict ?? 'answer').toUpperCase()
  return {
    card: 'generic',
    kind: 'read',
    title: `${verdict} — answering ${args.to ?? 'a peer'}`,
    ...(args.rationale ? { content: [{ type: 'text', text: args.rationale }] } : {}),
  }
}

/**
 * Card for a `peer_status` call.
 * @param args - the call's arguments.
 * @returns the pending-call view.
 */
export function presentStatusCall(args: {
  phase?: string
  summary?: string
  blocked_on?: string
}): ToolCallView {
  const blocked = args.phase === 'blocked' && args.blocked_on ? ` on ${args.blocked_on}` : ''
  return {
    card: 'generic',
    kind: 'other',
    title: `Status: ${args.phase ?? 'unknown'}${blocked}`,
    ...(args.summary ? { rawInput: args.summary } : {}),
  }
}

/**
 * Card for a completed `peer_status`.
 * @param _args - the call's arguments.
 * @param result - the model-facing result.
 * @returns the completed view.
 */
export function presentStatusResult(
  _args: unknown,
  result: { content?: { type: string; text?: string }[] },
): ToolResultView {
  const text = firstText(result)
  // A deadlock must be visible without expanding anything.
  return text.includes('DEADLOCK')
    ? { card: 'generic', title: 'DEADLOCK — mutual wait detected', content: [{ type: 'text', text }] }
    : { card: 'generic', title: clip(text.split('\n')[0] ?? 'Status published', 80) }
}

/**
 * Card for a `peer_card` call.
 * @param args - the call's arguments.
 * @returns the pending-call view.
 */
export function presentCardCall(args: { alias?: string; role?: string }): ToolCallView {
  return {
    card: 'generic',
    kind: 'other',
    title: args.alias ? `Declare identity: ${args.alias}` : 'Declare identity',
    ...(args.role ? { rawInput: args.role } : {}),
  }
}

/**
 * Card for a `peer_decide` call.
 * @param args - the call's arguments.
 * @returns the pending-call view.
 */
export function presentDecideCall(args: {
  statement?: string
  about?: string
  supersedes?: string
}): ToolCallView {
  const scope = args.about ? ` [${args.about}]` : ''
  return {
    card: 'generic',
    kind: 'other',
    title: args.supersedes ? `Supersede a decision${scope}` : `Record a decision${scope}`,
    ...(args.statement ? { content: [{ type: 'text', text: args.statement }] } : {}),
  }
}

/**
 * Card for a `peer_decisions` call.
 * @param args - the call's arguments.
 * @returns the pending-call view.
 */
export function presentDecisionsCall(args: { about?: string }): ToolCallView {
  return {
    card: 'generic',
    kind: 'search',
    title: args.about ? `Decisions about ${args.about}` : 'Decisions on record',
  }
}

/**
 * Card for a `peer_list` call.
 * @returns the pending-call view.
 */
export function presentListCall(): ToolCallView {
  return { card: 'generic', kind: 'search', title: 'List reachable sessions' }
}

/**
 * Pull the first text block out of a tool result.
 * @param result - the model-facing result.
 * @returns the text, or an empty string.
 */
function firstText(result: { content?: { type: string; text?: string }[] }): string {
  return result.content?.find((block) => block.type === 'text')?.text ?? ''
}
