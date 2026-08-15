import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MetricsRecorder, readAllMetrics } from '../src/adapters/metrics.ts'
import { renderSummary, summarize, type MetricEvent } from '../src/domain/metrics.ts'

const silentLogger = { warn: () => {}, error: () => {} }

function event(kind: MetricEvent['kind'], at = 0): MetricEvent {
  return { kind, at }
}

describe('summarize', () => {
  it('reports nothing for no events', () => {
    const summary = summarize([])
    expect(summary.totalEvents).toBe(0)
    expect(summary.cost.receiverTurns).toBe(0)
  })

  it('separates cost from catch', () => {
    const summary = summarize([
      event('message-delivered'),
      event('message-delivered'),
      event('claim-conflict'),
      event('verification-refuted'),
      event('deadlock-detected'),
    ])
    expect(summary.cost.receiverTurns).toBe(2)
    expect(summary.catches.collisionsAvoided).toBe(1)
    expect(summary.catches.falseClaimsCaught).toBe(1)
    expect(summary.catches.deadlocksDetected).toBe(1)
  })

  it('counts a granted claim as activity, not as a catch', () => {
    // Taking a claim prevents nothing on its own; only a refusal is a save.
    const summary = summarize([event('claim-granted'), event('claim-conflict')])
    expect(summary.activity.claimsTaken).toBe(1)
    expect(summary.catches.collisionsAvoided).toBe(1)
  })

  it('counts a confirmed verification separately from a refuted one', () => {
    const summary = summarize([
      event('verification-confirmed'),
      event('verification-refuted'),
      event('verification-unsettled'),
    ])
    expect(summary.catches.falseClaimsCaught).toBe(1)
    expect(summary.catches.verificationsConfirmed).toBe(1)
    expect(summary.catches.verificationsUnsettled).toBe(1)
  })

  it('honours the window bound', () => {
    const events = [event('message-delivered', 100), event('message-delivered', 900)]
    expect(summarize(events, 500).cost.receiverTurns).toBe(1)
    expect(summarize(events, 0).cost.receiverTurns).toBe(2)
  })
})

describe('renderSummary', () => {
  it('says so when there is nothing', () => {
    expect(renderSummary(summarize([]))).toMatch(/No collaboration activity/)
  })

  it('leads with cost and states the honest limit', () => {
    const text = renderSummary(summarize([event('message-delivered'), event('claim-conflict')]))
    expect(text).toMatch(/COST/)
    expect(text).toMatch(/CAUGHT/)
    expect(text).toMatch(/1 receiver turns spent, 1 problems caught/)
    // The counts must not be presented as settling the question.
    expect(text).toMatch(/cannot tell you whether the turns spent were worth it/)
  })
})

describe('MetricsRecorder', () => {
  let stateRoot: string

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), 'dsh-am-metrics-'))
  })
  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true })
  })

  function recorder(hostId = 'host-a'): MetricsRecorder {
    return new MetricsRecorder({ stateRoot, hostId, logger: silentLogger, flushMs: 60_000 })
  }

  it('records nothing until flushed', async () => {
    const r = recorder()
    r.record('message-delivered')
    expect(await readAllMetrics(stateRoot)).toEqual([])
    await r.close()
    expect(await readAllMetrics(stateRoot)).toHaveLength(1)
  })

  it('accumulates across flushes rather than replacing', async () => {
    const r = recorder()
    r.record('message-delivered')
    await r.flush()
    r.record('claim-conflict')
    await r.flush()
    expect((await readAllMetrics(stateRoot)).map((e) => e.kind)).toEqual([
      'message-delivered',
      'claim-conflict',
    ])
  })

  it('merges across hosts in time order', async () => {
    const a = recorder('host-a')
    const b = recorder('host-b')
    a.record('message-delivered', 500)
    b.record('claim-conflict', 100)
    await a.close()
    await b.close()
    expect((await readAllMetrics(stateRoot)).map((e) => e.kind)).toEqual([
      'claim-conflict',
      'message-delivered',
    ])
  })

  it('is safe to flush when empty', async () => {
    await expect(recorder().flush()).resolves.toBeUndefined()
    expect(await readdir(stateRoot)).toEqual([])
  })

  it('never throws when the state directory cannot be written', async () => {
    // Recording sits inside delivery: it must degrade to missing numbers rather
    // than to a failed message.
    const broken = new MetricsRecorder({
      stateRoot: '/proc/nonexistent-for-test',
      hostId: 'host-a',
      logger: silentLogger,
      flushMs: 60_000,
    })
    broken.record('message-delivered')
    await expect(broken.close()).resolves.toBeUndefined()
  })

  it('ignores a foreign or damaged metrics file', async () => {
    const r = recorder()
    r.record('message-delivered')
    await r.close()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(stateRoot, 'metrics', 'broken.json'), '{ truncated')
    await writeFile(join(stateRoot, 'metrics', 'alien.json'), JSON.stringify({ protocol: 99, events: [] }))
    expect(await readAllMetrics(stateRoot)).toHaveLength(1)
  })

  it('returns nothing when no metrics were ever recorded', async () => {
    expect(await readAllMetrics(stateRoot)).toEqual([])
  })
})
