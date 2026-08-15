/**
 * Turning runs into a table.
 *
 * The scoring is deliberately unkind to the thing being measured: an arm earns
 * a point only by leaving the repository correct, never by coordinating well.
 * Cost is counted in the currency that is actually scarce — model turns — and
 * reported beside the result rather than folded into it, because a arm that
 * passes everything at four times the turns has not obviously won.
 */

/** Verdicts an oracle can return, in reporting order. */
export const VERDICTS = ['pass', 'fail', 'void']

/**
 * Score one arm's runs.
 * @param runs - one entry per scenario: `{ id, verdict, why, turns }`.
 * @returns totals and the per-scenario rows.
 */
export function summarize(runs) {
  const scored = runs.filter((run) => run.verdict !== 'void')
  return {
    scenarios: runs.length,
    scored: scored.length,
    passed: scored.filter((run) => run.verdict === 'pass').length,
    failed: scored.filter((run) => run.verdict === 'fail').length,
    void: runs.length - scored.length,
    turns: runs.reduce((total, run) => total + (run.turns ?? 0), 0),
    rows: runs,
  }
}

/**
 * The cost of one correct outcome.
 *
 * The number a reader actually wants: not "how many turns did it spend" and not
 * "how many did it get right", but what one right answer cost. An arm that
 * passes nothing has no ratio, and saying so is more honest than dividing by
 * zero and printing infinity.
 * @param summary - one arm's summary.
 * @returns turns per passing scenario, or null when it passed none.
 */
export function turnsPerPass(summary) {
  return summary.passed === 0 ? null : summary.turns / summary.passed
}

/**
 * Render the comparison table.
 * @param arms - `{ [armName]: summary }`, in the order to display.
 * @returns the printable report.
 */
export function renderComparison(arms) {
  const names = Object.keys(arms)
  const width = Math.max(16, ...names.map((name) => name.length + 2))
  const lines = []

  lines.push('Coordination benchmark')
  lines.push('')
  lines.push(`${'scenario'.padEnd(18)}${names.map((name) => name.padEnd(width)).join('')}`)
  lines.push('─'.repeat(18 + width * names.length))

  const ids = arms[names[0]].rows.map((row) => row.id)
  for (const id of ids) {
    const cells = names.map((name) => {
      const row = arms[name].rows.find((entry) => entry.id === id)
      if (row === undefined) return 'not run'.padEnd(width)
      const mark = { pass: 'pass', fail: 'FAIL', void: 'void' }[row.verdict]
      return `${mark} (${row.turns ?? 0}t)`.padEnd(width)
    })
    lines.push(`${id.padEnd(18)}${cells.join('')}`)
  }

  lines.push('─'.repeat(18 + width * names.length))
  lines.push(
    `${'passed'.padEnd(18)}${names
      .map((name) => `${arms[name].passed}/${arms[name].scored}`.padEnd(width))
      .join('')}`,
  )
  lines.push(
    `${'turns spent'.padEnd(18)}${names.map((name) => String(arms[name].turns).padEnd(width)).join('')}`,
  )
  lines.push(
    `${'turns per pass'.padEnd(18)}${names
      .map((name) => {
        const ratio = turnsPerPass(arms[name])
        return (ratio === null ? '—' : ratio.toFixed(1)).padEnd(width)
      })
      .join('')}`,
  )

  lines.push('')
  for (const name of names) {
    for (const row of arms[name].rows) {
      if (row.verdict === 'fail') lines.push(`  ${name} · ${row.id}: ${row.why}`)
    }
  }

  return lines.join('\n')
}
