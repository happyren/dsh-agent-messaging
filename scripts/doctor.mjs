#!/usr/bin/env node
/**
 * Check that this plugin can actually work here, and say what is wrong when it
 * cannot.
 *
 * Written to be run by an agent as much as by a person: one line per check,
 * a stable `OK/WARN/FAIL` prefix, a non-zero exit on any failure, and every
 * remedy stated in the line that reports the problem. A session that suspects
 * its messaging is broken can run this and read the answer.
 *
 * Reads the same JSON the plugin writes, with no build step and no dependency
 * on `lib/`, so it works against a state directory produced by any version.
 *
 * Usage:
 *   npx dsh-agent-messaging doctor [--state-root PATH] [--json]
 */

import { access, constants, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** Node versions this package declares support for. */
const MIN_NODE_MAJOR = 22

/** A presence record older than this with no live process is stale. */
const STALE_HOST_MS = 60 * 60 * 1000

function parseArgs(argv) {
  const args = { stateRoot: undefined, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--state-root') args.stateRoot = argv[++i]
    else if (argv[i] === '--json') args.json = true
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

const checks = []

/**
 * Record one check result.
 * @param level - ok, warn, or fail.
 * @param name - short check name.
 * @param detail - what was found, and what to do when it is wrong.
 */
function report(level, name, detail) {
  checks.push({ level, name, detail })
}

/** How many JSON documents live in one state subdirectory. */
async function countDocuments(stateRoot, kind) {
  try {
    const names = await readdir(join(stateRoot, kind))
    return names.filter((name) => name.endsWith('.json')).length
  } catch {
    return 0
  }
}

async function checkNode() {
  const major = Number(process.versions.node.split('.')[0])
  if (major >= MIN_NODE_MAJOR) return report('ok', 'node', `v${process.versions.node}`)
  report(
    'fail',
    'node',
    `v${process.versions.node}; this package needs Node ${MIN_NODE_MAJOR} or newer. Upgrade Node, or run dsh under a newer runtime.`,
  )
}

async function checkStateRoot(stateRoot) {
  try {
    await mkdir(stateRoot, { recursive: true })
    const probe = join(stateRoot, `.doctor-${process.pid}`)
    await writeFile(probe, 'ok')
    await rm(probe)
    report('ok', 'state-root', `${stateRoot} (writable)`)
    return true
  } catch (error) {
    report(
      'fail',
      'state-root',
      `${stateRoot} is not writable (${error.code ?? error.message}). Claims, cards, the decision ledger and the offline spool all live here; fix the permissions or set stateRoot in the plugin config.`,
    )
    return false
  }
}

async function checkHosts(stateRoot) {
  const dir = join(stateRoot, 'hosts')
  let names
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.json'))
  } catch {
    return report(
      'warn',
      'presence',
      'no host records yet. A session must have run with the plugin loaded for peers to be reachable across processes.',
    )
  }

  let live = 0
  let stale = 0
  let badMode = 0
  for (const name of names) {
    let record
    try {
      record = JSON.parse(await readFile(join(dir, name), 'utf8'))
    } catch {
      stale += 1
      continue
    }
    const running = typeof record.pid === 'number' && isProcessAlive(record.pid)
    if (running) live += 1
    else if (Date.now() - (record.updatedAt ?? 0) > STALE_HOST_MS) stale += 1

    if (running && typeof record.socketPath === 'string') {
      const mode = await socketMode(record.socketPath)
      if (mode !== undefined && (mode & 0o077) !== 0) badMode += 1
    }
  }

  report(
    live > 0 ? 'ok' : 'warn',
    'presence',
    `${live} live host${live === 1 ? '' : 's'}, ${stale} stale record${stale === 1 ? '' : 's'}${
      stale > 0 ? ' (pruned on sight; harmless)' : ''
    }`,
  )

  if (badMode > 0) {
    report(
      'fail',
      'socket-permissions',
      `${badMode} inbox socket is readable beyond its owner. On a shared machine another user's processes could deliver to your sessions. Check your umask and restart the host.`,
    )
  } else if (live > 0) {
    report('ok', 'socket-permissions', 'owner-only (0600)')
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function socketMode(path) {
  try {
    return (await stat(path)).mode & 0o777
  } catch {
    return undefined
  }
}

async function checkHarness() {
  const required = ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session-query', '@deepseek-ai/dsh-tools']
  const missing = []
  for (const name of required) {
    try {
      import.meta.resolve(name)
    } catch {
      missing.push(name)
    }
  }
  if (missing.length === 0) return report('ok', 'harness', 'agent, session-query and tools all resolve')
  report(
    'warn',
    'harness',
    `cannot resolve ${missing.join(', ')} from here. That is expected when running this command outside the profile the plugin is installed into; inside it, a missing package means the plugin will not load.`,
  )
}

async function checkBundle() {
  const url = new URL('../lib/index.js', import.meta.url)
  const clientUrl = new URL('../lib/client.js', import.meta.url)
  try {
    await access(url, constants.R_OK)
  } catch {
    return report('fail', 'build', 'lib/index.js is missing. Run `npm run build` before loading the plugin.')
  }
  try {
    await access(clientUrl, constants.R_OK)
    report('ok', 'build', 'host and browser bundles present')
  } catch {
    report(
      'warn',
      'build',
      'lib/client.js is missing, so arriving messages render as the harness context row instead of a card. Run `npm run build`.',
    )
  }
}

async function checkState(stateRoot) {
  const [cards, claims, decisions, states, spool] = await Promise.all([
    countDocuments(stateRoot, 'cards'),
    countDocuments(stateRoot, 'claims'),
    countDocuments(stateRoot, 'decisions'),
    countDocuments(stateRoot, 'task-states'),
    countDocuments(stateRoot, 'spool'),
  ])
  report(
    'ok',
    'state',
    `${cards} card${cards === 1 ? '' : 's'} · ${claims} claim file${claims === 1 ? '' : 's'} · ${decisions} ledger file${decisions === 1 ? '' : 's'} · ${states} task state${states === 1 ? '' : 's'} · ${spool} spooled`,
  )

  const metrics = await countDocuments(stateRoot, 'metrics')
  report(
    metrics > 0 ? 'ok' : 'warn',
    'accounting',
    metrics > 0
      ? `recording; run \`npm run report\` to see what this cost and caught`
      : 'no counts recorded yet. Either nothing has happened yet, or `metrics: false` is set.',
  )
}

const args = parseArgs(process.argv.slice(2))
const stateRoot = resolveStateRoot(args.stateRoot)

await checkNode()
await checkBundle()
const writable = await checkStateRoot(stateRoot)
if (writable) {
  await checkHosts(stateRoot)
  await checkState(stateRoot)
}
await checkHarness()

const failed = checks.filter((check) => check.level === 'fail')

if (args.json) {
  console.log(JSON.stringify({ stateRoot, checks, ok: failed.length === 0 }, null, 2))
} else {
  const label = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL' }
  console.log('dsh-agent-messaging doctor\n')
  for (const check of checks) {
    console.log(`${label[check.level]}  ${check.name.padEnd(19)} ${check.detail}`)
  }
  console.log(
    failed.length === 0
      ? '\nNo blocking problems found.'
      : `\n${failed.length} blocking problem${failed.length === 1 ? '' : 's'}. Messaging will not work until they are fixed.`,
  )
}

process.exit(failed.length === 0 ? 0 : 1)
