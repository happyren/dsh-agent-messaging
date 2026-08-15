# The coordination benchmark

Five scenarios that a pair of uncoordinated agent sessions gets wrong, scored on
whether the repository ended up correct and priced in the currency that is
actually scarce: model turns.

It exists because this project makes a claim — that coordinating costs turns and
saves more than it costs — and that claim was, until now, argued from runs whose
scoring was written by the same person who wanted them to pass.

## What makes it a benchmark rather than a counter

**It scores the world, not the plugin.** An oracle reads the files on disk after
the run and nothing else. No credit is given for sending a message, taking a
claim, or returning a verdict. Coordination that does not change the outcome is
pure cost, and the table says so.

That is also what makes it fair to run against something else: an arm is chosen
by *profile*, not by code. This plugin, a competing one, and no coordination at
all are all measured the same way, because none of them are asked anything — the
repository is.

**It has a control.** Every scenario is one an uncoordinated pair genuinely
fails. A scenario the baseline passes is measuring nothing, and is a bug in the
scenario.

**Cost is reported beside the result, never folded into it.** An arm that passes
everything at four times the turns has not obviously won, and the reader is the
one who should decide that.

## The scenarios

| id | the failure it reproduces | correct end state |
|---|---|---|
| `stale-contract` | FM-2.4 information withheld — B cannot know the contract moved | the client passes the field the API now requires |
| `collision` | FM-1.3 step repetition, 15.7% of observed multi-agent failures | both sessions' changes survive; neither was overwritten |
| `false-belief` | MAST's verification category, 24.5% of failures | a field survives a premise nobody checked |
| `mutual-wait` | FM-1.5 unaware of termination; FM-3.1 premature termination | somebody broke the wait and did the part they could |
| `stale-decision` | FM-1.4 loss of history; FM-2.1 conversation reset | a settled decision survives a session that never saw it |

Failure-mode codes are from the [MAST taxonomy](https://arxiv.org/abs/2503.13657).

## Running it

```bash
node bench/run.mjs --arm baseline --profile bench-baseline --workspace ~/dsh-bench
node bench/run.mjs --arm plugin   --profile web --reset-state ~/.dsh/agent-messaging --workspace ~/dsh-bench
```

`--profile` picks the arm. A baseline profile is a profile with no coordination
plugin in its bundle list:

```json
{
  "name": "dsh-profile-bench-baseline",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } }
}
```

## Isolation is a precondition, and the runner enforces it

**The workspace must contain nothing but the benchmark.** Peers are discovered
from the session corpus, so every session in that workspace is addressable by
every scenario.

The runner enforces this rather than trusting it. For the length of a run the
harness's workspace registry is replaced with one containing only the benchmark
workspace, and restored afterwards; sessions the benchmark creates are deleted
between scenarios. **Your own sessions are never touched** — only the registry
entry is swapped, never the corpus behind it — but the registry is real state, so
do not run this against a harness you are also using.

This is not a theoretical concern. The first result this benchmark produced was
invalid because of it. In the `plugin` arm of `stale-contract`, the client
session read the decision ledger, found the new `tenant_id` requirement — the
coordination worked perfectly — and then wrote:

> that's assigned to the client-update sessions (`update-client-for-tenant-id-requ`
> etc.), not part of my loyalty-points task, so I left it for them

Those sessions were leftovers from an earlier run of my own. The session
correctly identified peers, correctly read their titles, and correctly concluded
the work was somebody else's. The call site stayed broken, and what the benchmark
measured was my untidiness.

Two things follow. The result is recorded in `results/` with that explanation
rather than deleted, because a benchmark that hides its invalid runs is worth
nothing. And the finding itself is real: **a long-lived workspace full of stale
peers invites diffusion of responsibility**, which is now on the roadmap as a
problem for the plugin to solve rather than a problem for the benchmark to avoid.

Use a workspace you keep for the benchmark and nothing else, or point `DSH_HOME`
at a directory of its own.

## Results

DeepSeek-V4-Flash, reasoning effort high, one run per arm per scenario,
2026-08-15.

| scenario | baseline | plugin |
|---|---|---|
| `stale-contract` | fail · 2t | **pass** · 4t |
| `collision` | n/r · 2t | n/r · 3t |
| `false-belief` | fail · 2t | fail · 5t |
| `mutual-wait` | n/r · 2t | n/r · 8t |
| `stale-decision` | fail · 2t | **pass** · 2t |
| **passed** | **0/3** | **2/3** |
| **turns spent** | 10 | 22 |
| **… on scoring scenarios** | 6 | 11 |
| **turns per pass** | — | 5.5 |

Coordination turned 0 of 3 into 2 of 3, at roughly double the turns. That is the
claim this project makes, measured against a control for the first time, and it
is one run — an anecdote with a table around it, not a result.

**The `false-belief` failure is the one worth reading.** Coordination worked: the
peer reviewed the file, corrected the false premise, and the client recorded a
superseding decision. Then it removed the field anyway, reasoning that since
`createCharge` ignores `currency`, dropping it is behaviour-preserving. The
oracle scores the world, so it fails — the repository ended exactly where the
false premise pointed — but it is a different failure from the baseline's, which
dropped the field *because* it believed the claim. Verification changed the
session's beliefs and not its actions.

## Two scenarios that did not reproduce

`collision` and `mutual-wait` passed uncoordinated, which by the rule above means
they score for nobody. They are marked `n/r`, kept in the table, and excluded
from the totals.

The first time, that was a runner bug: prompts were dispatched one at a time, so
the sessions never overlapped, and neither failure can occur without overlap.
That is fixed — submission stays sequential because it is what claims a blank
session, but a scenario marked `concurrent: true` no longer waits.

Re-run with real overlap, both passed again, for two more interesting reasons:

- **`collision`** — DSH's editor patches by string replacement, re-reading the
  file at write time, so the second write lands on top of the first. A classic
  lost update is structurally prevented. Step repetition is still MAST's largest
  failure mode; it simply cannot take this shape here. In a patch-based harness
  it shows up as *duplicated effort* — two sessions doing the same work and
  paying twice — which is a cost failure, and needs a scenario built around turns
  rather than bytes.
- **`mutual-wait`** — told not to guess a value another session owns, these
  models do the part they can and document what is missing rather than blocking.
  Both moved even with real overlap and an explicit instruction. A deadlock this
  benchmark could measure needs a dependency a session genuinely cannot work
  around, not one it has merely been told not to.

Neither is dressed up as a pass. A benchmark whose author quietly counts free
passes is measuring its own suite length.

## Known limits

- **Small n.** One run per arm per scenario is an anecdote with a table around
  it. Repeat runs and report the spread before drawing conclusions.
- **Model-dependent.** Every number is specific to the model that produced it.
  Record which one.
- **The workspace must be pre-registered once.** The runner can isolate the
  registry but cannot add a workspace to it: that flow ends in a native directory
  picker. Add the benchmark directory through the UI once, then never open it by
  hand again.
- **`mutual-wait` scores movement, not insight.** It asks whether anybody broke
  the wait, which a session can do by ignoring the instruction as easily as by
  detecting the cycle. It is the weakest oracle here.
- **Turn counts come from the harness's own stats line**, read out of the UI —
  the only place every arm reports it identically.

## Files

- `scenarios.mjs` — fixtures, prompts, and the oracles. Plain JS, no build step,
  so any arm can be scored from a checkout.
- `score.mjs` — summarizing and the comparison table.
- `run.mjs` — the live runner: one harness process per scenario, one browser
  context per session, registry isolated for the duration.
- `compare.mjs` — lays result files side by side, including ones produced
  elsewhere (`--markdown` for a table to paste).
- `results/` — what each arm actually did, including the transcripts a verdict
  was drawn from.
- `../tests/bench-score.test.ts` — the oracles are unit-tested against
  hand-built end states, because a benchmark whose scoring is wrong is worse
  than no benchmark.
