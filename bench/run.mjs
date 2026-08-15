#!/usr/bin/env node
/**
 * Run the benchmark against a real harness with real models.
 *
 * One `dsh web` process per scenario, launched with its working directory set to
 * that scenario's fixture, so each scenario gets its own workspace, its own
 * session list, and no state carried in from the last one. Sessions are driven
 * through the Web UI because that is the only surface every arm shares — this
 * runner never imports the plugin, and an arm is chosen by profile alone.
 *
 * Usage:
 *   node bench/run.mjs --arm plugin   --profile web
 *   node bench/run.mjs --arm baseline --profile bench-baseline
 *
 *   --scenarios a,b   run only these
 *   --port N          host port (default 3099)
 *   --keep            leave the fixture directories behind for inspection
 */

import { spawn } from 'node:child_process'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { SCENARIOS, scenario as byId } from './scenarios.mjs'
import { renderComparison, summarize } from './score.mjs'

const PLAYWRIGHT = '/Users/k/.npm/_npx/420ff84f11983ee5/node_modules/playwright-core/index.mjs'
const DSH = '/Users/k/.npm/_npx/1e7f6d9597241db0/node_modules/.bin/dsh'

/** How long one session may take before the runner gives up on its turn. */
const TURN_TIMEOUT_S = 300

function parseArgs(argv) {
  const args = {
    arm: 'plugin',
    profile: 'web',
    port: 3099,
    scenarios: undefined,
    keep: false,
    workspace: process.env.DSH_BENCH_WORKSPACE,
    resetState: undefined,
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--arm') args.arm = argv[++i]
    else if (argv[i] === '--profile') args.profile = argv[++i]
    else if (argv[i] === '--port') args.port = Number(argv[++i])
    else if (argv[i] === '--scenarios') args.scenarios = argv[++i].split(',')
    else if (argv[i] === '--keep') args.keep = true
    else if (argv[i] === '--workspace') args.workspace = argv[++i]
    else if (argv[i] === '--reset-state') args.resetState = argv[++i]
  }
  return args
}

/** A file under the harness's home. */
function dshPath(...parts) {
  const home = process.env.DSH_HOME?.trim()
  const base = home && isAbsolute(home) ? home : join(homedir(), '.dsh')
  return join(base, ...parts)
}

/** Where the harness keeps one workspace's sessions. */
function sessionCorpus(workspace) {
  return dshPath('sessions', `--${workspace.replaceAll('/', '-').replace(/^-+/, '')}--`)
}

/**
 * Make the benchmark workspace the only one the harness knows about.
 *
 * Isolation is a precondition of the method — peers come from the session
 * corpus, so a workspace with history in it lets a scenario address sessions
 * from an earlier run, which is exactly how this benchmark's first result came
 * out invalid. Selecting a workspace through the UI turned out to be
 * undrivable, and the registry is the same decision expressed as data.
 *
 * The operator's registry is backed up and restored; their sessions are never
 * touched, because only the registry entry is removed, not the corpus behind it.
 */
async function isolateRegistry(workspace) {
  const path = dshPath('storages', 'workspace.json')
  const backup = `${path}.bench-backup`
  const cache = dshPath('storages', 'session_projcache.json')
  const cacheBackup = `${cache}.bench-backup`

  let store
  try {
    store = JSON.parse(await readFile(path, 'utf8'))
    await copyFile(path, backup)
  } catch {
    store = { unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [], archivedSessionIds: [] }, tables: { workspaces: {} } }
  }
  await copyFile(cache, cacheBackup).catch(() => {})

  const id = 'bench-0000-0000-0000-000000000000'
  const stamp = new Date().toISOString()
  const isolated = {
    unit: store.unit ?? { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [id], archivedSessionIds: [] },
    tables: {
      workspaces: {
        [id]: {
          path: workspace,
          title: basename(workspace),
          createdAt: stamp,
          updatedAt: stamp,
          sessionIds: [],
        },
      },
    },
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(isolated, null, 1)}\n`)
  // The cache indexes sessions by id; leaving it beside a registry that no
  // longer mentions them is how the harness ends up failing to boot.
  await rm(cache, { force: true })

  return async () => {
    await copyFile(backup, path).catch(() => {})
    await rm(backup, { force: true })
    await copyFile(cacheBackup, cache).catch(() => rm(cache, { force: true }))
    await rm(cacheBackup, { force: true })
  }
}

/**
 * Drop the sessions the benchmark itself created.
 *
 * Safe to delete outright: this corpus belongs to the benchmark workspace, which
 * the method requires be used for nothing else.
 */
async function clearBenchSessions(workspace) {
  const corpus = sessionCorpus(workspace)
  for (const name of await readdir(corpus).catch(() => [])) {
    await rm(join(corpus, name), { recursive: true, force: true })
  }
  await rm(dshPath('storages', 'session_projcache.json'), { force: true })
}

/** Write a scenario's fixture into the benchmark workspace. */
async function materialize(fixture, root) {
  for (const [path, content] of Object.entries(fixture)) {
    const full = join(root, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content)
  }
  // A project marker, so the harness and the plugin both see one workspace.
  await mkdir(join(root, '.git'), { recursive: true })
}

/** Read every fixture path back off disk. */
async function readWorld(fixture, root) {
  const files = {}
  for (const path of Object.keys(fixture)) {
    try {
      files[path] = await readFile(join(root, path), 'utf8')
    } catch {
      files[path] = ''
    }
  }
  return files
}

/** Start a harness on `port` with its cwd inside the fixture. */
async function startHost({ profile, port, cwd }) {
  // `--profile x` boots that profile and hands the rest to its app; the `web`
  // subcommand is an alias for `--profile web` and refuses to take both.
  const child = spawn(DSH, ['--profile', profile, '--port', String(port)], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Kept: when a host refuses to boot, its own output is the only thing that
  // says why, and a benchmark that swallows it wastes the run.
  let log = ''
  child.stdout.on('data', (chunk) => (log += chunk))
  child.stderr.on('data', (chunk) => (log += chunk))
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      if (response.ok) return child
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  child.kill()
  throw new Error(`harness did not start on port ${port}:\n${log.slice(-1500)}`)
}

/** Drive one scenario's sessions and report the turns each spent. */
async function driveSessions({ chromium, port, prompts, workspace, concurrent }) {
  const browser = await chromium.launch({ headless: true })
  const turns = {}
  try {
    for (const [label, prompt] of Object.entries(prompts)) {
      // A context per session: the harness hands every client the same reusable
      // blank session, so a session must be claimed before the next is opened.
      const context = await browser.newContext({ viewport: { width: 1180, height: 1000 } })
      const page = await context.newPage()
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(2500)
      // Explicitly in THIS scenario's workspace. A plain "New session" lands in
      // whichever workspace the harness last had selected, which is remembered
      // across hosts — the first version of this runner scored an untouched
      // fixture while the sessions edited a directory from a previous run.
      // Dispatched rather than clicked: the per-workspace opener is revealed on
      // hover, so it is absent from the accessibility tree and a role query
      // never sees it.
      const opened = await page.evaluate((label) => {
        const button = [...document.querySelectorAll('button')].find(
          (candidate) => candidate.getAttribute('aria-label') === label,
        )
        if (button === undefined) return false
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        return true
      }, `New session in ${workspace}`)
      if (!opened) throw new Error(`no workspace opener for "${workspace}"`)
      await page.waitForTimeout(1800)

      // Opening a session does not select its workspace: the composer stays
      // read-only, reading "Choose a workspace to start", until one is picked.
      const needsWorkspace = await page.evaluate(() => document.querySelector('textarea')?.readOnly === true)
      if (needsWorkspace) {
        await page.getByRole('button', { name: /choose workspace/i }).first().click()
        await page.waitForTimeout(1200)
        const picked = await page.evaluate((title) => {
          const candidates = [...document.querySelectorAll('[role="menuitem"], [role="option"], li, button')]
          const match = candidates.find((node) => node.textContent?.trim() === title)
          if (match === undefined) return false
          match.dispatchEvent(new MouseEvent('click', { bubbles: true }))
          return true
        }, workspace)
        if (!picked) throw new Error(`workspace "${workspace}" is not offered in the chooser`)
        await page.waitForTimeout(2500)
      }

      await page.waitForFunction(
        () => {
          const box = document.querySelector('textarea')
          return box !== null && !box.disabled && !box.readOnly
        },
        undefined,
        { timeout: 60_000 },
      )
      const box = page.locator('textarea').first()
      await box.click()
      await box.fill(prompt)
      await page.waitForTimeout(250)
      await page.keyboard.press('Enter')

      // Submitting is what claims the reusable blank session, so prompts are
      // always submitted one at a time. Whether the runner then WAITS is the
      // scenario's call: a collision and a mutual wait only exist while two
      // sessions overlap in time, and serialising them scored two of five
      // scenarios as passes for the baseline — which means they measured
      // nothing at all.
      if (concurrent === true) {
        await page.waitForTimeout(2500)
      } else {
        let started = false
        for (let i = 0; i < TURN_TIMEOUT_S; i += 1) {
          await page.waitForTimeout(1000)
          const running = await page.evaluate(() =>
            Boolean(document.querySelector('button[aria-label*="Stop" i]')),
          )
          if (running) started = true
          else if (started && i > 2) break
        }
        await page.waitForTimeout(2000)
      }
      turns[label] = { page, context }
    }

    // Peers wake each other, so a session can still be working after its own
    // prompt settled. Let the whole set go quiet before counting.
    await settleAll(Object.values(turns).map((entry) => entry.page))

    const counted = {}
    const transcripts = {}
    for (const [label, entry] of Object.entries(turns)) {
      counted[label] = await readTurnCount(entry.page)
      // Kept because a verdict without the run behind it is unfalsifiable: the
      // tail of each transcript is how a reader checks the oracle was fair.
      transcripts[label] = (await entry.page.evaluate(() => document.body.innerText)).slice(-4000)
    }
    return { turns: counted, transcripts }
  } finally {
    await browser.close()
  }
}

/** Wait until no session in the set is running a turn. */
async function settleAll(pages) {
  for (let i = 0; i < TURN_TIMEOUT_S; i += 1) {
    const running = await Promise.all(
      pages.map((page) =>
        page.evaluate(() => Boolean(document.querySelector('button[aria-label*="Stop" i]'))),
      ),
    )
    if (!running.some(Boolean)) {
      // Two quiet samples, because a woken session takes a moment to start.
      await new Promise((resolve) => setTimeout(resolve, 4000))
      const again = await Promise.all(
        pages.map((page) =>
          page.evaluate(() => Boolean(document.querySelector('button[aria-label*="Stop" i]'))),
        ),
      )
      if (!again.some(Boolean)) return
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
}

/**
 * Read one session's turn count from the harness's own stats line.
 *
 * The UI is the only place every arm reports this the same way; the durable log
 * is compressed per-frame and its shape is the harness's business, not a
 * benchmark's.
 */
async function readTurnCount(page) {
  const text = await page.evaluate(() => document.body.innerText)
  const match = text.match(/(\d+)\s+turns?\s+·/)
  return match === null ? 0 : Number(match[1])
}

const args = parseArgs(process.argv.slice(2))
const { chromium } = await import(PLAYWRIGHT)
const chosen = args.scenarios === undefined ? SCENARIOS : args.scenarios.map(byId)

if (args.workspace === undefined) {
  throw new Error(
    'pass --workspace PATH (or set DSH_BENCH_WORKSPACE). It must be a directory you have already added as a workspace in the harness — see bench/README.md.',
  )
}

// Isolation is a precondition, not a nicety: peers are discovered from the
// session corpus, so a workspace with history in it lets a scenario address
// sessions that belong to an earlier run. The first result this benchmark
// produced was invalid for exactly that reason — see bench/README.md.
process.stderr.write(
  `\nworkspace: ${args.workspace}\nprofile:   ${args.profile}\nDSH_HOME:  ${process.env.DSH_HOME ?? '(default)'}\n` +
    `\nEvery session already in this workspace is addressable by every scenario.\n` +
    `Run against a workspace you keep for the benchmark and nothing else.\n`,
)

const restoreRegistry = await isolateRegistry(args.workspace)

const runs = []
try {
for (const scenario of chosen) {
  await clearBenchSessions(args.workspace)
  const root = args.workspace
  // Each scenario starts from the same fixture in the same workspace: a
  // registered workspace is state the harness owns, and a benchmark that
  // rewrites somebody's registry to get isolation is trading a real risk for a
  // cosmetic one.
  await materialize(scenario.fixture, root)
  // The plugin arm carries claims, cards and a ledger between scenarios unless
  // they are cleared; the baseline arm has nothing to clear.
  if (args.resetState !== undefined) await rm(args.resetState, { recursive: true, force: true })
  process.stderr.write(`\n▶ ${args.arm} · ${scenario.id}\n  ${root}\n`)

  const host = await startHost({ profile: args.profile, port: args.port, cwd: root })
  let driven = { turns: {}, transcripts: {} }
  try {
    driven = await driveSessions({
      chromium,
      port: args.port,
      prompts: scenario.sessions,
      workspace: basename(root),
      concurrent: scenario.concurrent === true,
    })
  } finally {
    host.kill()
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  const files = await readWorld(scenario.fixture, root)
  const result = scenario.score({ files, turns: driven.turns })
  const total = Object.values(driven.turns).reduce((sum, count) => sum + count, 0)
  runs.push({
    id: scenario.id,
    ...result,
    turns: total,
    perSession: driven.turns,
    transcripts: driven.transcripts,
    files,
  })
  process.stderr.write(`  ${result.verdict.toUpperCase()} · ${total} turns · ${result.why}\n`)
}
} finally {
  await restoreRegistry()
}

// A partial re-run replaces the scenarios it ran and leaves the rest alone:
// scenarios get fixed one at a time, and re-running the whole matrix to correct
// one of them costs an hour of model time for no new information.
const out = join(dirname(new URL(import.meta.url).pathname), 'results', `${args.arm}.json`)
let previous = []
try {
  previous = JSON.parse(await readFile(out, 'utf8')).rows ?? []
} catch {
  // First run for this arm.
}
const replaced = new Set(runs.map((run) => run.id))
const merged = [...previous.filter((row) => !replaced.has(row.id)), ...runs]
const order = SCENARIOS.map((entry) => entry.id)
merged.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))

const summary = summarize(merged)
await mkdir(dirname(out), { recursive: true })
await writeFile(out, `${JSON.stringify({ arm: args.arm, profile: args.profile, ...summary }, null, 2)}\n`)

process.stderr.write(`\n${renderComparison({ [args.arm]: summary })}\n`)
process.stderr.write(`\nwrote ${out}\n`)
