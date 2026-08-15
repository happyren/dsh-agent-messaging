import { describe, expect, it } from 'vitest'

import { createIdentityResolver } from '../src/app/identity.ts'
import type { PeerDescriptor } from '../src/domain/peer.ts'
import type { PeerDirectory } from '../src/ports/index.ts'

function directory(...peers: PeerDescriptor[]): PeerDirectory {
  return { list: async () => peers }
}

const peer = (extra: Partial<PeerDescriptor> & Pick<PeerDescriptor, 'sessionId' | 'name'>): PeerDescriptor => ({
  createdAt: 0,
  live: true,
  location: { kind: 'local' },
  ...extra,
})

describe('createIdentityResolver', () => {
  it('calls a session by the alias it published', async () => {
    // Everything a peer reads this name in — a refused claim, a wait, a
    // delivered message — is a prompt to go and address that session. The
    // folded name here would be "ready-57a1", which says nothing.
    const identify = createIdentityResolver(
      directory(peer({ sessionId: 's1', name: 'ready-57a1', alias: 'payments-api', cwd: '/repo' })),
    )
    expect(await identify('s1')).toEqual({
      sessionId: 's1',
      name: 'payments-api',
      cwd: '/repo',
    })
  })

  it('falls back to the folded name when no card was published', async () => {
    const identify = createIdentityResolver(directory(peer({ sessionId: 's1', name: 'payments' })))
    expect(await identify('s1')).toEqual({ sessionId: 's1', name: 'payments' })
  })

  it('falls back to the session id when the directory does not know this session', async () => {
    const identify = createIdentityResolver(directory())
    expect(await identify('s1')).toEqual({ sessionId: 's1', name: 's1' })
  })
})
