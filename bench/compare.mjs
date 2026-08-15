#!/usr/bin/env node
/**
 * Put the arms side by side.
 *
 * Separate from the runner because comparing is not running: results are files,
 * and a reader with two result files from two machines, two models, or two
 * plugins should be able to lay them next to each other without re-running
 * anything.
 *
 * Usage:
 *   node bench/compare.mjs                       # every arm in bench/results
 *   node bench/compare.mjs baseline plugin       # in this order
 *   node bench/compare.mjs --markdown            # a table to paste
 */

import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderComparison, turnsPerPass } from './score.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, 'results')

const argv = process.argv.slice(2)
const markdown = argv.includes('--markdown')
const wanted = argv.filter((entry) => !entry.startsWith('--'))

const names =
  wanted.length > 0
    ? wanted
    : (await readdir(dir)).filter((name) => name.endsWith('.json')).map((name) => name.replace(/\.json$/, ''))

const arms = {}
for (const name of names) {
  arms[name] = JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8'))
}

if (!markdown) {
  console.log(renderComparison(arms))
  const noted = Object.entries(arms).filter(([, arm]) => arm.note !== undefined)
  if (noted.length > 0) {
    console.log('')
    for (const [name, arm] of noted) console.log(`  note · ${name}: ${arm.note}`)
  }
  process.exit(0)
}

const ids = arms[names[0]].rows.map((row) => row.id)
const cell = (arm, id) => {
  const row = arm.rows.find((entry) => entry.id === id)
  if (row === undefined) return '—'
  const mark = { pass: '**pass**', fail: 'fail', void: 'void' }[row.verdict]
  return `${mark} · ${row.turns ?? 0}t`
}

console.log(`| scenario | ${names.join(' | ')} |`)
console.log(`|---|${names.map(() => '---').join('|')}|`)
for (const id of ids) console.log(`| \`${id}\` | ${names.map((name) => cell(arms[name], id)).join(' | ')} |`)
console.log(`| **passed** | ${names.map((name) => `${arms[name].passed}/${arms[name].scored}`).join(' | ')} |`)
console.log(`| **turns spent** | ${names.map((name) => arms[name].turns).join(' | ')} |`)
console.log(
  `| **turns per pass** | ${names
    .map((name) => {
      const ratio = turnsPerPass(arms[name])
      return ratio === null ? '—' : ratio.toFixed(1)
    })
    .join(' | ')} |`,
)
