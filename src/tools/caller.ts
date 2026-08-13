/**
 * The calling session's identity.
 *
 * Read from the execution the agent loop supplies, never from tool arguments —
 * a model must not be able to send a message that claims to come from another
 * session.
 */

import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import { PeerError } from '../domain/errors.ts'

/**
 * The session id on whose behalf a tool call is running.
 * @param exec - the tool execution context.
 * @returns the caller's session id.
 * @throws {PeerError} `transport-failed` when no agent owns the call.
 */
export function requireCallerSessionId(exec: ToolRunContext): string {
  const sessionId = exec.agent?.id
  if (!sessionId) {
    throw new PeerError(
      'transport-failed',
      'This tool must run on behalf of an agent session, but the call has no agent.',
    )
  }
  return sessionId
}
