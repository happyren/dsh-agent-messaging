<p align="center">
  <img src="docs/media/social-card.png" width="900"
       alt="dsh-agent-messaging — the payments-api session sends a steer to the checkout-client session, carrying &quot;tenant_id is now required&quot;. Delivery modes: steer interrupts, followup opens a new turn, context does not wake.">
</p>

<p align="center">
  <a href="https://github.com/happyren/dsh-agent-messaging/releases/tag/v0.0.1"><img src="https://img.shields.io/github/v/release/happyren/dsh-agent-messaging?color=5B7CFF&label=release" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-5B7CFF" alt="MIT"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/dsh--plugin-topic-5B7CFF" alt="dsh-plugin topic"></a>
</p>

# dsh-agent-messaging

Cross-session agent-to-agent messaging for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Two sessions you started yourself — in the Web UI, in a headless run, in separate
worktrees, in separate `dsh` processes — cannot tell each other anything. When one
discovers a breaking change the other is about to trip over, you are the transport:
you read it in one terminal and retype it in the other.

This plugin gives them an address and a mailbox. One session names another and
delivers a message into its inbox; the harness schedules it like any other
model-facing input.

```
session "payments-api"                      session "checkout-client"
        │                                              │
        │  peer_send  to: checkout-client              │
        │             mode: steer                      │
        ├─────────────────────────────────────────────►│  interrupts at the next step
        │  "tenant_id is now required on ChargeRequest │
        │   — your call site will break"               │
```

## Demo

A real run, in two sessions of one `dsh web` host, over a toy repo where each
session owns a different file.

**The payments session changes the contract, then picks a delivery mode.** It finds
the affected session with `peer_list`, edits `api/charges.ts`, and reasons about
urgency on its own: *"it's mid-task, so I'll use `steer` (interrupt) rather than a
queued message."*

![The sending session finds its peer and delivers a steer](docs/media/demo-01-send.png)

**The checkout session is interrupted, verifies the claim, and answers.** The message
arrives as a `Context injection · dsh-agent-messaging` row. Note what it does with
it: reads `api/charges.ts` to *check* the claim rather than believing it, replies to
the sender, and reports to its own user — *"treated it as information, not
instructions."*

![The receiving session verifies the claim and replies](docs/media/demo-02-receive.png)

That refusal to act is the default, and it is deliberate. See
[Collaboration and safety](#collaboration-and-safety) for how to let sessions
actually make edits for each other.

## What it is not

The harness already covers the neighbouring cases, and this plugin deliberately does
not duplicate them:

| You want | Use |
|---|---|
| To pull another session's history into your next message | [`dsh-session-reference`](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session-reference.md) (`@[label](dsh-session:…)`) |
| A coordinator that spawns and supervises workers | the [subagent](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md) subsystem |
| To continue one conversation elsewhere | resume the session |
| **To tell another independent session something, now** | **this plugin** |

A message is text. Never conversation history, never files.

## Install

```bash
npx -p @deepseek-ai/dsh dsh plugin --profile web add github:happyren/dsh-agent-messaging
```

`dsh plugin` shells out to pnpm, so pnpm ≥10 must be on your PATH — `corepack enable pnpm`
is enough.

The package ships a self-contained `prepare` script, and pnpm blocks build scripts
from git dependencies until you allow them. The first `add` will fail and print the
package key; add it to the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-agent-messaging: true
```

then re-run the `add`. Pin a commit (`github:happyren/dsh-agent-messaging#<sha>`) so a
later push cannot change what runs on your machine.

Restart the profile afterwards, and verify the layer loaded:

```bash
dsh --profile web --dump-config
```

You should see a `# == dsh-agent-messaging` layer.

## Tools

### `peer_list`

Sessions this one can address — name, state, title, directory. Identities only;
never their contents.

```
checkout-client [idle] "Wire up checkout submit" — /repo/test-project
payments-api [running] "Add tenant_id to charges" — /repo/test-project
```

Names come from each session's folded title, falling back to its directory, then its
id, and are collision-disambiguated — so an address you read in one listing still
resolves in the next.

### `peer_send`

Deliver one message. The sender's identity comes from the executing agent, so a model
cannot send a message claiming to be another session.

| `mode` | Arrives | Use for |
|---|---|---|
| `steer` | At the receiver's next step boundary, interrupting it | Something that makes its current work wrong |
| `followup` *(default)* | As its own later turn | The ordinary handoff |
| `context` | Folded into whatever it does next, without waking it | Background it should know but need not act on |

These map onto `Agent.steer()`, `Agent.followup()` and `Agent.inject()` — the inbox
boundaries the harness already owns. Choosing is the sender's job, because only the
sender knows whether the news invalidates work already in progress.

A session that is **not running** still accepts messages: they are spooled and
delivered when it next starts, within the configured age and depth bounds.

Replies correlate through `reply_to`, and the receiver is told to answer the sender's
session id rather than its display name, which can change when a title is refolded.

### `peer_decide` and `peer_decisions`

Record what was settled, so a session that starts later doesn't reopen it.

```
peer_decisions  about: "api/charges.ts"
→ 2026-08-14 13:58 · record-billing-decisions [api/charges.ts]
    currency stays hardcoded to "usd" for now; multi-currency deferred until
    billing supports it
    why: billing does not support multi-currency yet
    id: 4f2a…
```

Messages are ephemeral — delivered once, folded into a transcript, gone when that
session compacts or ends. Common ground has to outlive them, which needs a record
rather than a conversation. This targets **FM-1.4 loss of conversation history**
and **FM-2.1 conversation reset**.

It's the [transactive-memory](https://arxiv.org/html/2606.19911v1) direction:
rather than replicating every session's context into every other, publish the
small durable index of *conclusions* and let peers query it by area. A directory
covers what's beneath it, same nesting rule as claims and ownership.

**Nothing is ever edited or deleted — decisions are superseded.** A later decision
names the one it replaces; `peer_decisions` returns only what's in force, so
nobody acts on a reversed decision, and `include_superseded` shows the history.

### `peer_status`

Say what your *work* is doing — `working`, `blocked`, `done`, `abandoned` — and
find out if you have just deadlocked.

```
peer_status  phase: "blocked"  blocked_on: "payments-api"
             summary: "need the charge schema finalised"
→ published: blocked
  DEADLOCK — you are in a mutual wait:
  checkout-client → payments-api → checkout-client
  Nobody in this cycle will proceed on their own. Break it: message one of them
  with peer_send, do the part you can without waiting, or ask your user to decide.
```

The agent registry already reports `idle`/`running`, but that describes a
*driver*, not a task. A session is `idle` both when it has finished and when it
is waiting on a peer — indistinguishable from outside, and the difference is
exactly what a peer needs to decide whether to wait.

This targets **FM-1.5 unaware of termination (12.4%)** and **FM-3.1 premature
termination (6.2%)**, and is common ground in
[Klein's sense](https://dl.acm.org/doi/abs/10.1109/MIS.2004.74) — a teammate that
cannot signal completion or blockage cannot be coordinated with.

Because `blocked` carries *who* it is blocked on, a mutual wait becomes
representable and therefore detectable. The check runs when a session declares
itself blocked, which is the moment a cycle can first close. Without it a
deadlock is silent: every participant looks merely idle, nobody is finished, and
nothing reports it.

### `peer_card`

Declare what this session is for and what it owns, so peers route work correctly
instead of guessing from a folded title.

```
peer_card  role: "Payments API owner. I do NOT own client code."
           owns: [{ resource: "api/charges.ts" }, { resource: "charge validation rules", scope: "topic" }]
           skills: ["payments-api", "validation-rules"]
```

It then appears in every peer's `peer_list`, and a session with work to route
reads it rather than guessing.

This targets **FM-1.2 disobey role specification** and **FM-2.3 task derailment
(7.4%)**; role specification was one of only two interventions MAST measured
directly, at **+9.4%**. Shaped after
[A2A Agent Cards](https://en.wikipedia.org/wiki/Agent2Agent) so the same
declaration can later serve cross-vendor discovery.

Ownership here is **standing responsibility, not a reservation** — it never
conflicts and reserves nothing. `peer_claim` is the short-lived "I am editing this
right now" signal. Saying what you *don't* own is as useful as what you do, since
it stops peers sending you work that isn't yours.

### `peer_verify` and `peer_verify_reply`

Ask a differently-situated peer to check a claim you're about to act on.

```
peer_verify  to: "payments-api"
             claim: "createCharge rejects a blank tenant_id"
             evidence: [{ locator: "api/charges.ts", at: "12", note: "the guard" }]
```

The peer is told to *check, not agree* — "go and look before answering; do not
take the claim on trust" — and replies with a typed verdict: `confirmed`,
`refuted`, `inconclusive`, or `declined`, plus what it actually examined.

This targets MAST's **task-verification category (24.5% of failures)** and is the
intervention with its largest measured gain (**+15.6%**). It belongs in a
messaging plugin rather than an agent's own loop because
[self-verification is known to fail](https://arxiv.org/pdf/2310.01798) — a model
largely cannot check its own reasoning. A peer is a different verifier in the way
that matters: it didn't produce the artefact, so it has to go and look.

A `refuted` verdict comes back as a `steer`, because the asker is probably acting
on the claim right now and a queued turn would arrive too late.

### `peer_claim`

Announce what you are working on, and find out whether a peer is already on it.

```
peer_claim  resource: "client/checkout.ts"  intent: "threading tenant_id through"
→ refused: overlaps a claim held by another session.
  checkout-client holds "client" — refactoring the submit path (expires in ~24 min)
  Message the holder with peer_send instead of working in parallel.
```

This targets the **largest single failure mode** in the
[MAST taxonomy](https://arxiv.org/abs/2503.13657): *step repetition*, 15.7% of
observed multi-agent failures — whose concrete instance in coding is two sessions
editing the same file, or re-deriving what a sibling already knows.

Path claims nest, so holding `client` covers `client/checkout.ts`, and sibling
names never collide (`src/app` does not contain `src/apple`). Topics don't nest.
Claims expire on their own, and are dropped when the holding session ends.

Claims are **advisory, not locks.** The plugin cannot stop another process
writing a file, and a lock that can't be enforced is worse than an honest hint —
it invites callers to skip the check they'd otherwise make. Claimed resources
show up in `peer_list` under `working_on`.

### `peer_inbox`

Lists messages held for you under the `hold` policy, and releases them when your
operator asks. Empty under the default `accept`.

## Collaboration and safety

By default a peer message is **information, not instruction**. The receiving model is
told it may act on a request inside it only if its own user asks. That is the right
default between two sessions that merely happen to share a machine, and the wrong one
between two sessions you are deliberately running as a pair.

`peerAuthority` and `trustedPeers` change that, per receiving session:

```yaml
- id: agent-messaging
  config:
    peerAuthority: act
    trustedPeers:
      - payments-api
```

With this, a message from `payments-api` is framed as coming from a peer the operator
has authorised, and the receiver may act on it directly. Everything else still arrives
as information.

Three properties worth being precise about, because the setting is easy to over-read:

- **It is prompt-level, not enforcement.** It changes what the receiving model is
  told. The enforcement boundary is the receiving session's own permission rules,
  access mode, and sandbox — identical at every authority level.
- **It grants nothing.** At *both* levels the message is explicitly unable to approve
  an action, grant a permission, or change configuration. Those are the operator's to
  give, and no setting delegates them. An authorised peer that asks for something
  outside the receiver's existing permissions is refused.
- **Raising the level alone does nothing.** `trustedPeers` is empty by default and
  matched exactly, so a session that appears later never inherits standing it was
  never granted, and a lookalike name (`payments-api-staging`) does not match
  `payments-api`.

For work that should stay under human control, prefer `inbound: hold` — messages
wait, and `peer_inbox` releases them when you say so.

## How it reaches another process

One `dsh` host holds many sessions, so discovery and delivery split:

- **Discovery** reuses `ctx.sessionQuery`, which already merges the live store with
  the persistence backend and reports both availabilities. The plugin adds only the
  fact that service cannot know — which *other host process* currently holds a
  session.
- **Delivery** is a direct call when the recipient is a live agent in the same
  process; otherwise it crosses a per-host Unix domain socket, discovered through
  advisory presence records under `$DSH_HOME/agent-messaging/hosts/`. Records whose
  process or socket is gone are pruned on sight.

Both routes converge on the same admission path, so a receiver's policy cannot be
bypassed by happening to share a process with it.

## Configuration

Override in your profile's `cordis.patch.yml`:

```yaml
- id: agent-messaging
  config:
    inbound: accept
    spoolOffline: true
```

| Key | Default | Meaning |
|---|---|---|
| `inbound` | `accept` | `accept`, `hold` (await operator release), or `refuse` |
| `peerAuthority` | `inform` | `act` lets authorised peers be acted on directly |
| `trustedPeers` | `[]` | Peers authorised by `peerAuthority: act`, matched exactly |
| `stateRoot` | `$DSH_HOME/agent-messaging` | Presence records and the offline spool |
| `includeSubagents` | `false` | Make subagent children addressable |
| `spoolOffline` | `true` | Hold messages for sessions that are not running |
| `spoolMaxAgeMs` | `86400000` | Discard a spooled message older than this |
| `spoolMaxPerSession` | `20` | Spool depth per recipient |
| `rateMaxPerWindow` | `10` | Messages one sender may deliver per window |
| `rateWindowMs` | `60000` | Rate window |
| `duplicateWindowMs` | `30000` | Identical bodies dropped inside this window |
| `maxHeld` | `100` | Held messages retained per session |
| `deliveryTimeoutMs` | `5000` | Wait for a peer host's receipt |

To stop receiving entirely, set `inbound: refuse`. To stop sending, deny the tools in
your permission rules.

## Security model

A peer is another agent, not your operator, and the plugin is built so that
distinction survives contact.

- **Inbound messages are framed as untrusted.** Every delivery carries a fixed warning
  describing what the block is and what it cannot do. This follows the convention the
  harness established for cross-session references.
- **A body cannot forge its own frame.** The data region is JSON with every `<` emitted
  as its lossless JSON unicode escape, so no peer-supplied string can spell the
  surrounding tags and escape into the instruction area.
- **Senders cannot be impersonated.** Identity is read from the executing agent, never
  from tool arguments.
- **Loop control terminates runaways.** Per-sender rate limiting and duplicate
  suppression mean two agents that answer each other automatically stop on their own.
- **The inbox is owner-only.** The socket is `chmod 0600`; on a shared machine another
  user's processes cannot reach it.
- **Wire input is validated before it reaches policy.** Unknown protocol versions,
  wrong types, oversized bodies and oversized frames are rejected at the boundary.

Permission boundaries stay per-session: an arriving message never answers a pending
prompt, and anything it asks for is still subject to the receiving session's own rules.

## Limitations

- **Same machine only.** Delivery is by Unix domain socket, so two sessions can reach
  each other only when they share a filesystem. A container and its host cannot; two
  sessions inside one container can.
- **Plain text only.** No structured payloads, no attachments.
- **Spooled messages are best-effort.** They expire, and the deepest are dropped first.
- **Presence is advisory.** A host that dies between publishing and delivery makes a
  session look reachable until the record is pruned.
- **The harness is a developer preview** with no compatibility promise. This builds
  against the npm `rc` line; service keys have been renamed between releases before, so
  re-verify after a harness upgrade.

## Development

```bash
npm install
npm run verify   # typecheck, tests, build
```

The layering keeps policy testable without a running harness: `src/domain` is pure and
imports no framework, `src/app` holds the use cases behind the interfaces in
`src/ports`, and `src/adapters` binds those to Cordis, the agent registry, sockets and
disk.

Transport, presence and spool tests run against real Unix sockets and real files rather
than mocks. `tests/collaboration-scenario.test.ts` drives the handoff shown above end
to end.

[`docs/design.md`](docs/design.md) covers why each seam is where it is, and which
alternatives were rejected. [`docs/roadmap.md`](docs/roadmap.md) is the research
note behind what gets built next: what the multi-agent literature actually shows
(including that agent debate usually *loses* at equal token budget), which
measured failure modes each planned feature attacks, and what is deliberately not
being built.

## Contributing

Code contributions are not being accepted, but questions, bug reports and ideas are
welcome in [Discussions](https://github.com/happyren/dsh-agent-messaging/discussions).
See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Kaixiang Ren
