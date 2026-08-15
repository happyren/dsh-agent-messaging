/**
 * The whole plugin, working, on one realistic storyline.
 *
 * Every other test proves a part. This proves the claim the README actually
 * makes: that a team of sessions collaborating through this plugin avoids
 * specific, nameable failures — and that the accounting reports them honestly.
 *
 * Nothing here is mocked except the two edges the plugin does not own: the agent
 * inbox (there is no live DSH agent in a unit test) and the session corpus. The
 * stores, the sockets, the loop control, the admission path and the metrics are
 * all real, writing to a real temporary directory.
 *
 * Each step names the MAST failure mode it exercises, and the final assertions
 * pin the exact numbers the report produces. If a change makes collaboration
 * quieter or noisier, these numbers move and this test says so.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CardStore } from '../src/adapters/cards.ts'
import { ClaimStore } from '../src/adapters/claims.ts'
import { DecisionStore } from '../src/adapters/decisions.ts'
import { MetricsRecorder, readAllMetrics } from '../src/adapters/metrics.ts'
import { TaskStateStore } from '../src/adapters/task-states.ts'
import { InboxClient } from '../src/adapters/transport/inbox-client.ts'
import { InboxServer } from '../src/adapters/transport/inbox-server.ts'
import { RoutingTransport } from '../src/adapters/transport/routing-transport.ts'
import { WorkClaims } from '../src/app/claim-work.ts'
import { InboundRouter } from '../src/app/receive-message.ts'
import { MessageSender, type SenderIdentity } from '../src/app/send-message.ts'
import { createCard } from '../src/domain/card.ts'
import { createDecision, decisionsAbout, foldCurrent } from '../src/domain/decision.ts'
import { parseEnvelope, type Envelope } from '../src/domain/envelope.ts'
import { renderSummary, summarize } from '../src/domain/metrics.ts'
import type { PeerDescriptor } from '../src/domain/peer.ts'
import { LoopGuard } from '../src/domain/policy.ts'
import { createTaskState, findWaitCycle } from '../src/domain/task-state.ts'
import { createVerdict, renderVerdict } from '../src/domain/verification.ts'
import type { DeliveryReceipt, InboxSink, OutboxSpool, PeerDirectory } from '../src/ports/index.ts'

const silentLogger = { warn: () => {}, error: () => {} }
const MINUTE = 60_000

/** The three sessions in the storyline. */
const PAYMENTS: SenderIdentity = { sessionId: 's-payments', name: 'payments-api', cwd: '/repo' }
const CHECKOUT: SenderIdentity = { sessionId: 's-checkout', name: 'checkout-client', cwd: '/repo' }
const DOCS: SenderIdentity = { sessionId: 's-docs', name: 'docs', cwd: '/repo' }
const ALL = [PAYMENTS, CHECKOUT, DOCS]

/** Stands in for live agents: records what each session's inbox received. */
class Mailboxes implements InboxSink {
  readonly received = new Map<string, Envelope[]>()

  deliver(envelope: Envelope): DeliveryReceipt {
    const box = this.received.get(envelope.to) ?? []
    box.push(envelope)
    this.received.set(envelope.to, box)
    return { status: 'delivered' }
  }

  countFor(sessionId: string): number {
    return (this.received.get(sessionId) ?? []).length
  }

  bodiesFor(sessionId: string): string[] {
    return (this.received.get(sessionId) ?? []).map((envelope) => envelope.body)
  }
}

let stateRoot: string
let clockValue: number
const clock = { now: () => clockValue }

let mailboxes: Mailboxes
let claims: WorkClaims
let cards: CardStore
let taskStates: TaskStateStore
let decisions: DecisionStore
let recorder: MetricsRecorder
let inbound: InboundRouter
let sender: MessageSender

/** Every session is local except where a step says otherwise. */
function directoryOf(overrides: Record<string, PeerDescriptor['location']> = {}): PeerDirectory {
  return {
    list: () =>
      Promise.resolve(
        ALL.map((identity) => ({
          sessionId: identity.sessionId,
          name: identity.name,
          cwd: identity.cwd as string,
          createdAt: 0,
          live: true,
          location: overrides[identity.sessionId] ?? { kind: 'local' as const },
        })),
      ),
  }
}

const noSpool: OutboxSpool = {
  hold: () => Promise.resolve(),
  drain: () => Promise.resolve([]),
}

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-am-scenario-'))
  clockValue = 1_700_000_000_000

  mailboxes = new Mailboxes()
  cards = new CardStore({ stateRoot, logger: silentLogger })
  taskStates = new TaskStateStore({ stateRoot, logger: silentLogger })
  decisions = new DecisionStore({ stateRoot, logger: silentLogger })
  recorder = new MetricsRecorder({ stateRoot, hostId: 'host-a', logger: silentLogger, flushMs: 60_000 })

  claims = new WorkClaims({
    repository: new ClaimStore({ stateRoot, logger: silentLogger }),
    clock,
    metrics: recorder,
  })

  inbound = new InboundRouter({
    policy: 'accept',
    guard: new LoopGuard({ maxPerWindow: 10, windowMs: MINUTE, duplicateWindowMs: 30_000 }),
    sink: mailboxes,
    clock,
    maxHeld: 50,
    metrics: recorder,
  })

  let issued = 0
  sender = new MessageSender({
    directory: directoryOf(),
    transport: new RoutingTransport({
      inbound,
      client: new InboxClient({ timeoutMs: 2_000 }),
      spool: noSpool,
      spoolOffline: false,
      metrics: recorder,
    }),
    clock,
    ids: { next: () => `msg-${(issued += 1)}` },
  })
})

afterEach(async () => {
  await recorder.close()
  await rm(stateRoot, { recursive: true, force: true })
})

describe('a three-session team ships a breaking contract change', () => {
  it('avoids the failures it claims to, and accounts for them honestly', async () => {
    // ---- 1. The team declares who is responsible for what -----------------
    // MAST FM-1.2 disobey role specification, FM-2.3 task derailment.
    await cards.publish(
      createCard({
        sessionId: PAYMENTS.sessionId,
        alias: 'payments-api',
        role: 'Owns the charge API.',
        owns: [{ resource: 'api' }],
        groups: ['backend'],
        now: clockValue,
      }),
    )
    await cards.publish(
      createCard({
        sessionId: CHECKOUT.sessionId,
        alias: 'checkout-client',
        role: 'Owns the checkout client.',
        owns: [{ resource: 'client' }],
        groups: ['backend'],
        now: clockValue,
      }),
    )
    expect((await cards.readAll()).map((card) => card.alias).sort()).toEqual([
      'checkout-client',
      'payments-api',
    ])

    // ---- 2. Payments reserves the file it is about to change --------------
    const taken = await claims.take(
      { sessionId: PAYMENTS.sessionId, name: PAYMENTS.name },
      { scope: 'path', resource: 'api/charges.ts', intent: 'adding tenant_id', ttlMs: 30 * MINUTE },
    )
    expect(taken.granted).toBe(true)

    // ---- 3. Checkout is stopped from duplicating that work -----------------
    // MAST FM-1.3 step repetition, 15.7% — the largest single failure mode.
    // Checkout asks for the whole directory; the nested claim beneath it holds.
    const blocked = await claims.take(
      { sessionId: CHECKOUT.sessionId, name: CHECKOUT.name },
      { scope: 'path', resource: 'api', intent: 'also adding tenant_id', ttlMs: 30 * MINUTE },
    )
    expect(blocked.granted).toBe(false)
    expect(blocked.conflicts.map((conflict) => conflict.name)).toEqual([PAYMENTS.name])

    // ---- 4. Payments interrupts checkout with the breaking news ------------
    clockValue += MINUTE
    const notice = await sender.send(PAYMENTS, {
      to: 'checkout-client',
      body: 'tenant_id is now required on ChargeRequest; your call site will not compile.',
      mode: 'steer',
    })
    expect(notice.receipt.status).toBe('delivered')
    expect(mailboxes.countFor(CHECKOUT.sessionId)).toBe(1)

    // ---- 5. A false premise is caught before it is acted on ----------------
    // MAST FC3 task verification, 24.5%; their own intervention gained +15.6%.
    clockValue += MINUTE
    await sender.send(CHECKOUT, {
      to: 'payments-api',
      body: 'VERIFICATION REQUEST — does createCharge reject an unsupported currency?',
      mode: 'followup',
    })
    recorder.record('verification-sent', clockValue)

    const verdict = createVerdict(
      'refuted',
      'Read api/charges.ts: currency is declared on ChargeRequest but never referenced in the body.',
      [{ locator: 'api/charges.ts', at: '5' }],
    )
    recorder.record('verification-refuted', clockValue)
    clockValue += MINUTE
    const answer = await sender.send(PAYMENTS, {
      to: 'checkout-client',
      body: renderVerdict(verdict),
      mode: 'steer',
      replyTo: notice.envelope.id,
    })
    expect(answer.receipt.status).toBe('delivered')
    expect(mailboxes.bodiesFor(CHECKOUT.sessionId).at(-1)).toMatch(/did not survive checking/)

    // ---- 6. Loop control stops two agents thanking each other forever ------
    clockValue += 1_000
    const repeated = await sender.send(PAYMENTS, {
      to: 'checkout-client',
      body: renderVerdict(verdict),
      mode: 'followup',
    })
    expect(repeated.receipt.status).toBe('dropped')

    // ---- 7. What was settled is recorded, and found later ------------------
    // MAST FM-1.4 loss of history, FM-2.1 conversation reset.
    clockValue += MINUTE
    await decisions.append(
      createDecision({
        id: 'dec-1',
        sessionId: PAYMENTS.sessionId,
        name: PAYMENTS.name,
        statement: 'currency stays hardcoded to usd; multi-currency is deferred.',
        rationale: 'billing does not support it yet',
        about: { resource: 'api/charges.ts' },
        evidence: [{ locator: 'api/charges.ts' }],
        now: clockValue,
      }),
    )
    recorder.record('decision-recorded', clockValue)

    // A session that never saw the discussion asks about the area and finds it.
    const found = decisionsAbout(foldCurrent(await decisions.readAll()), {
      scope: 'path',
      resource: 'api/charges.ts',
    })
    expect(found).toHaveLength(1)
    expect(found[0]?.statement).toMatch(/multi-currency is deferred/)

    // ---- 8. A reversal supersedes rather than contradicts ------------------
    clockValue += MINUTE
    await decisions.append(
      createDecision({
        id: 'dec-2',
        sessionId: CHECKOUT.sessionId,
        name: CHECKOUT.name,
        statement: 'multi-currency is now in scope for Q3.',
        supersedes: 'dec-1',
        about: { resource: 'api/charges.ts' },
        now: clockValue,
      }),
    )
    recorder.record('decision-recorded', clockValue)
    const current = foldCurrent(await decisions.readAll())
    expect(current.map((decision) => decision.id)).toEqual(['dec-2'])

    // ---- 9. A mutual wait is detected the moment it closes -----------------
    // MAST FM-1.5 unaware of termination, FM-3.1 premature termination.
    clockValue += MINUTE
    await taskStates.publish(
      createTaskState({
        sessionId: DOCS.sessionId,
        name: DOCS.name,
        phase: 'blocked',
        summary: 'waiting for the final contract',
        blockedOn: CHECKOUT.sessionId,
        now: clockValue,
      }),
    )
    await taskStates.publish(
      createTaskState({
        sessionId: CHECKOUT.sessionId,
        name: CHECKOUT.name,
        phase: 'blocked',
        summary: 'waiting for the docs example',
        blockedOn: DOCS.sessionId,
        now: clockValue,
      }),
    )
    const cycle = findWaitCycle([...(await taskStates.readAll())], DOCS.sessionId)
    expect(cycle.map((entry) => entry.name)).toEqual([DOCS.name, CHECKOUT.name])
    recorder.record('deadlock-detected', clockValue)

    // ---- 10. The accounting reports cost and catch, and is checkable -------
    await recorder.flush()
    const summary = summarize(await readAllMetrics(stateRoot))

    // Cost: three deliveries reached an inbox, one repeat was dropped.
    expect(summary.cost.receiverTurns).toBe(3)
    expect(summary.cost.dropped).toBe(1)
    expect(mailboxes.countFor(CHECKOUT.sessionId)).toBe(2)
    expect(mailboxes.countFor(PAYMENTS.sessionId)).toBe(1)

    // Catch: one collision avoided, one false claim caught, one deadlock found.
    expect(summary.catches.collisionsAvoided).toBe(1)
    expect(summary.catches.falseClaimsCaught).toBe(1)
    expect(summary.catches.deadlocksDetected).toBe(1)

    expect(summary.activity.claimsTaken).toBe(1)
    expect(summary.activity.verificationsRequested).toBe(1)
    expect(summary.activity.decisionsRecorded).toBe(2)

    const report = renderSummary(summary)
    expect(report).toMatch(/3 receiver turns spent, 3 problems caught/)
    // The report must never overclaim what the numbers establish.
    expect(report).toMatch(/cannot tell you whether the turns spent were worth it/)
  })

  it('carries the same storyline across a real socket between two hosts', async () => {
    // The cross-process leg, which the in-process test cannot exercise: a
    // message from another `dsh` process must land in the same admission path.
    const socketPath = join(stateRoot, 'h.sock')
    const server = new InboxServer({
      socketPath,
      handle: (frame) => inbound.accept(parseEnvelope(frame)),
      logger: silentLogger,
    })
    await server.listen()

    try {
      const remoteSender = new MessageSender({
        directory: directoryOf({
          [CHECKOUT.sessionId]: { kind: 'remote', hostId: 'host-b', socketPath },
        }),
        transport: new RoutingTransport({
          inbound,
          client: new InboxClient({ timeoutMs: 2_000 }),
          spool: noSpool,
          spoolOffline: false,
          metrics: recorder,
        }),
        clock,
        ids: { next: () => 'msg-remote' },
      })

      const outcome = await remoteSender.send(PAYMENTS, {
        to: 'checkout-client',
        body: 'tenant_id is now required.',
        mode: 'followup',
      })

      expect(outcome.receipt.status).toBe('delivered')
      expect(mailboxes.bodiesFor(CHECKOUT.sessionId)).toEqual(['tenant_id is now required.'])

      await recorder.flush()
      expect(summarize(await readAllMetrics(stateRoot)).cost.receiverTurns).toBe(1)
    } finally {
      await server.close()
    }
  })

  it('refuses to let a receiver policy be bypassed by any route', async () => {
    // The guarantee the whole admission design rests on: local and socket
    // delivery converge, so `refuse` means refuse however the message arrived.
    const strict = new InboundRouter({
      policy: 'refuse',
      guard: new LoopGuard({ maxPerWindow: 10, windowMs: MINUTE, duplicateWindowMs: 30_000 }),
      sink: mailboxes,
      clock,
      maxHeld: 10,
      metrics: recorder,
    })

    const socketPath = join(stateRoot, 'strict.sock')
    const server = new InboxServer({
      socketPath,
      handle: (frame) => strict.accept(parseEnvelope(frame)),
      logger: silentLogger,
    })
    await server.listen()

    try {
      for (const location of [
        { kind: 'local' as const },
        { kind: 'remote' as const, hostId: 'host-b', socketPath },
      ]) {
        const routed = new MessageSender({
          directory: directoryOf({ [CHECKOUT.sessionId]: location }),
          transport: new RoutingTransport({
            inbound: strict,
            client: new InboxClient({ timeoutMs: 2_000 }),
            spool: noSpool,
            spoolOffline: false,
            metrics: recorder,
          }),
          clock,
          ids: { next: () => `msg-${location.kind}` },
        })

        const outcome = await routed.send(PAYMENTS, {
          to: 'checkout-client',
          body: `arriving via ${location.kind}`,
          mode: 'followup',
        })
        expect(outcome.receipt.status).toBe('refused')
      }
      expect(mailboxes.countFor(CHECKOUT.sessionId)).toBe(0)
    } finally {
      await server.close()
    }
  })
})
