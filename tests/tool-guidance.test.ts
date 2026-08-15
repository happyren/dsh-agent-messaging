import { describe, expect, it } from 'vitest'

import { createPeerSendTool } from '../src/tools/peer-send.ts'
import type { MessageSender } from '../src/app/send-message.ts'

/**
 * Guidance that a live run proved load-bearing.
 *
 * These are one-sentence rules in a tool description, which is exactly the kind
 * of thing an edit removes without anyone noticing — and each one is here
 * because its absence produced a real failure in a real session.
 */
const sendTool = createPeerSendTool({} as MessageSender, async () => ({
  sessionId: 's',
  name: 'n',
}))

describe('peer_send guidance', () => {
  it('forbids acknowledgement traffic', () => {
    // Two sessions in a live run wound down an exchange with "Noted, thanks",
    // "Anytime", "Perfect — I'm here" — four turns spent on politeness, ended
    // only by the loop guard dropping a duplicate. Every message costs the
    // receiver a turn, and courtesy is the cheapest way to waste one.
    expect(sendTool.description).toMatch(/acknowledgements/i)
    expect(sendTool.description).toMatch(/costs the receiver a turn/i)
    expect(sendTool.description).toMatch(/stop replying/i)
  })

  it('keeps the sender from treating a reply as permission', () => {
    expect(sendTool.description).toMatch(/do not treat\s+its reply as permission/i)
  })

  it('still explains what each delivery mode costs', () => {
    expect(sendTool.description).toMatch(/steer.*interrupts/i)
    expect(sendTool.description).toMatch(/context.*without waking it/i)
  })
})
