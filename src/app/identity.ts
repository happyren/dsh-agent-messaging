/**
 * How a session refers to itself when it addresses a peer.
 *
 * Every record another session will read — a claim, a decision, a wait, the
 * attribution on a delivered message — carries this name, and each of those is
 * read by someone deciding who to talk to next. So it has to be an address, not
 * a label.
 */

import { peerAddress } from '../domain/peer.ts'
import type { PeerDirectory } from '../ports/index.ts'
import type { SenderIdentity } from './send-message.ts'

/**
 * Build the resolver that answers "who am I, as a peer?".
 *
 * A published alias wins over the name folded from a session title. Both
 * resolve, but only one was chosen: a folded name reads like an accident
 * (`ready-57a1`), moves when the title is refolded, and tells a reader nothing
 * about what that session is for.
 * @param directory - the shared peer listing, so a session's name of itself is
 * the same name every peer sees for it.
 * @returns a resolver from session id to peer identity.
 */
export function createIdentityResolver(
  directory: PeerDirectory,
): (sessionId: string, signal?: AbortSignal) => Promise<SenderIdentity> {
  return async (sessionId, signal) => {
    const peers = await directory.list(signal)
    const self = peers.find((peer) => peer.sessionId === sessionId)
    return {
      sessionId,
      name: self === undefined ? sessionId : peerAddress(self),
      ...(self?.cwd === undefined ? {} : { cwd: self.cwd }),
    }
  }
}
