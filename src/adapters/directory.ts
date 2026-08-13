/**
 * The peer directory: one view over every session this process can name.
 *
 * Discovery reuses `ctx.sessionQuery`, which already merges the live store with
 * the persistence backend and reports both availabilities. This adapter adds
 * only what that service cannot know — which *other host process* currently
 * holds a session — and turns the result into addressable peers.
 */

import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionQueryService } from '@deepseek-ai/dsh-session-query'

import { assignPeerNames, type PeerDescriptor, type PeerLocation, type PeerNameSource } from '../domain/peer.ts'
import type { Logger, PeerDirectory } from '../ports/index.ts'
import type { PresenceStore } from './presence.ts'

/** Construction inputs for {@link SessionQueryPeerDirectory}. */
export interface PeerDirectoryOptions {
  readonly sessionQuery: SessionQueryService
  readonly agents: AgentRegistry
  readonly presence: PresenceStore
  readonly logger: Logger
  /** Whether sessions created as subagent children are addressable. */
  readonly includeSubagents: boolean
}

/** Builds {@link PeerDescriptor}s from the harness session corpus. */
export class SessionQueryPeerDirectory implements PeerDirectory {
  readonly #sessionQuery: SessionQueryService
  readonly #agents: AgentRegistry
  readonly #presence: PresenceStore
  readonly #logger: Logger
  readonly #includeSubagents: boolean

  constructor(options: PeerDirectoryOptions) {
    this.#sessionQuery = options.sessionQuery
    this.#agents = options.agents
    this.#presence = options.presence
    this.#logger = options.logger
    this.#includeSubagents = options.includeSubagents
  }

  /**
   * List every addressable peer, newest session first.
   * @param signal - optional cancellation for corpus reads.
   * @returns the peer set with names assigned and locations resolved.
   */
  async list(signal?: AbortSignal): Promise<readonly PeerDescriptor[]> {
    const [records, remoteHosts] = await Promise.all([
      this.#sessionQuery.listSessions(signal),
      this.#readPresence(),
    ])

    const visible = records.filter(
      (record) => this.#includeSubagents || record.header.origin !== 'subagent',
    )

    // One batched title read: per-session reads would be a round trip each.
    const titles = await this.#readTitles(visible.map((record) => record.header.id), signal)

    const sources: PeerNameSource[] = visible.map((record) => ({
      sessionId: record.header.id,
      ...(titles.get(record.header.id) === undefined ? {} : { title: titles.get(record.header.id) as string }),
      ...(record.header.cwd === undefined ? {} : { cwd: record.header.cwd }),
    }))
    const names = assignPeerNames(sources)

    /** Session id to the host advertising it. */
    const remoteBySession = new Map<string, { hostId: string; socketPath: string }>()
    for (const host of remoteHosts) {
      for (const sessionId of host.sessions) {
        remoteBySession.set(sessionId, { hostId: host.hostId, socketPath: host.socketPath })
      }
    }

    return visible.map((record) => {
      const sessionId = record.header.id
      const localAgent = this.#agents.get(sessionId as SessionId)
      const remote = remoteBySession.get(sessionId)
      const title = titles.get(sessionId)

      const location: PeerLocation = localAgent
        ? { kind: 'local' }
        : remote
          ? { kind: 'remote', hostId: remote.hostId, socketPath: remote.socketPath }
          : { kind: 'offline' }

      return {
        sessionId,
        name: names.get(sessionId) ?? sessionId,
        ...(title === undefined ? {} : { title }),
        ...(record.header.cwd === undefined ? {} : { cwd: record.header.cwd }),
        createdAt: record.header.createdAt,
        // `record.live` is this process's store; a remote host is live too.
        live: location.kind !== 'offline',
        ...(localAgent === undefined ? {} : { status: localAgent.status }),
        ...(record.header.origin === undefined ? {} : { origin: record.header.origin }),
        location,
      } satisfies PeerDescriptor
    })
  }

  async #readPresence(): Promise<readonly { hostId: string; socketPath: string; sessions: readonly string[] }[]> {
    try {
      return await this.#presence.readPeers()
    } catch (error) {
      // Discovery of local sessions must survive an unreadable presence directory.
      this.#logger.warn(
        `presence unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
      return []
    }
  }

  /**
   * Fold the latest title for each session, tolerating per-session failures.
   * @param ids - the sessions to read.
   * @param signal - shared cancellation.
   * @returns session id to title, omitting sessions without one.
   */
  async #readTitles(ids: readonly string[], signal?: AbortSignal): Promise<ReadonlyMap<string, string>> {
    const titles = new Map<string, string>()
    if (ids.length === 0) return titles

    try {
      const observations = await this.#sessionQuery.readTitleSnapshots(ids as readonly SessionId[], signal)
      for (const observation of observations) {
        if (observation.status !== 'fulfilled') continue
        const title = observation.value.title?.title
        if (title) titles.set(observation.value.session.id, title)
      }
    } catch (error) {
      // Names fall back to directory or id; an unavailable index is not fatal.
      this.#logger.warn(
        `title folding unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return titles
  }
}
