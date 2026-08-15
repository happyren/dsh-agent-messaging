#!/usr/bin/env node
/**
 * Print the collaboration report.
 *
 * A command rather than a tool: the audience is the operator deciding whether
 * this plugin earns its turns, not the model. Adding an eleventh `peer_*` tool
 * would put that decision in front of the wrong reader and take attention from
 * the ten that do work.
 *
 * Reads the same JSON the plugin writes, with no build step and no dependency on
 * `lib/`, so it works against a state directory produced by any version.
 *
 * Usage:
 *   node scripts/report.mjs [--days N] [--state-root PATH]
 */

import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const METRICS_VERSION = 1

function parseArgs(argv) {
  const args = { days: 0, stateRoot: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--days') args.days = Number(argv[++i] ?? 0)
    else if (argv[i] === '--state-root') args.stateRoot = argv[++i]
  }
  return args
}

/** Mirrors `resolveStateRoot` in src/adapters/system.ts. */
function resolveStateRoot(configured) {
  if (configured) return configured
  const home = process.env.DSH_HOME?.trim()
  const base = home && isAbsolute(home) ? home : join(homedir(), '.dsh')
  return join(base, 'agent-messaging')
}

async function readEvents(stateRoot) {
  const dir = join(stateRoot, 'metrics')
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const events = []
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8'))
      if (parsed?.protocol === METRICS_VERSION && Array.isArray(parsed.events)) {
        events.push(...parsed.events)
      }
    } catch {
      // One unreadable host file must not hide the rest.
    }
  }
  return events.sort((a, b) => a.at - b.at)
}

const args = parseArgs(process.argv.slice(2))
const stateRoot = resolveStateRoot(args.stateRoot)
const since = args.days > 0 ? Date.now() - args.days * 86_400_000 : 0
const events = (await readEvents(stateRoot)).filter((event) => event.at >= since)

const count = (kind) => events.filter((event) => event.kind === kind).length

const window = args.days > 0 ? `last ${args.days} day(s)` : 'all recorded activity'
console.log(`Collaboration report — ${window}`)
console.log(`State: ${stateRoot}\n`)

if (events.length === 0) {
  console.log('No collaboration activity recorded.')
  console.log('If sessions have been messaging, check that `metrics` is enabled in your profile config.')
  process.exit(0)
}

const delivered = count('message-delivered')
const collisions = count('claim-conflict')
const refuted = count('verification-refuted')
const deadlocks = count('deadlock-detected')
const caught = collisions + refuted + deadlocks

const rows = [
  ['COST — turns this plugin caused a session to spend', null],
  ['  messages delivered', delivered],
  ['  dropped by loop control', count('message-dropped')],
  ['  held for operator', count('message-held')],
  ['  refused by policy', count('message-refused')],
  ['  spooled for later', count('message-spooled')],
  ['', null],
  ['CAUGHT — what would otherwise have gone wrong', null],
  ['  collisions avoided', collisions],
  ['  false claims caught', refuted],
  ['  deadlocks detected', deadlocks],
  ['', null],
  ['ACTIVITY', null],
  ['  claims taken', count('claim-granted')],
  ['  verifications requested', count('verification-sent')],
  ['  … confirmed', count('verification-confirmed')],
  ['  … unsettled', count('verification-unsettled')],
  ['  decisions recorded', count('decision-recorded')],
]

for (const [label, value] of rows) {
  console.log(value === null ? label : `${label.padEnd(34)}${value}`)
}

console.log(`\n${delivered} receiver turns spent, ${caught} problems caught.`)
console.log('Read this as evidence, not a verdict: a caught collision is a real save,')
console.log('but these counts cannot tell you whether the turns spent were worth it.')
