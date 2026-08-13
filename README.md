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
session "payments"                        session "checkout"
        │                                          │
        │  peer_send to:"checkout" mode:"steer"    │
        ├─────────────────────────────────────────►│  interrupts at the next step
        │  "tenant_id is now required on /charge"  │
```

## What it is not

The harness already covers the neighbouring cases, and this plugin deliberately
does not duplicate them:

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

The package ships a self-contained `prepare` script, and pnpm ≥10 blocks build
scripts from git dependencies until you allow them. The first `add` will fail and
print the package key; add it to the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-agent-messaging: true
```

then re-run the `add`. Pin a commit (`github:happyren/dsh-agent-messaging#<sha>`)
so a later push cannot change what runs on your machine.

Restart the profile afterwards. Verify the layer loaded:

```bash
dsh --profile web --dump-config
```

## Tools

### `peer_list`

Sessions this one can address — name, state, title, directory. Identities only;
never their contents.

### `peer_send`

Deliver one message. The sender's identity comes from the executing agent, so a
model cannot send a message claiming to be another session.

| `mode` | Arrives | Use for |
|---|---|---|
| `steer` | At the receiver's next step boundary, interrupting it | Something that makes its current work wrong |
| `followup` *(default)* | As its own later turn | The ordinary handoff |
| `context` | Folded into whatever it does next, without waking it | Background it should know but need not act on |

These map onto `Agent.steer()`, `Agent.followup()` and `Agent.inject()` — the
inbox boundaries the harness already owns.

A session that is **not running** still accepts messages: they are spooled and
delivered when it next starts, within the configured age and depth bounds.

### `peer_inbox`

Lists messages held for you under the `hold` policy, and releases them when your
operator asks. Empty under the default `accept`.

## How it reaches another process

One `dsh` host holds many sessions, so discovery and delivery split:

- **Discovery** reuses `ctx.sessionQuery`, which already merges the live store with
  the persistence backend. Names are derived from each session's folded title,
  falling back to its directory, then its id — and are collision-disambiguated, so
  an address you read in one listing resolves in the next.
- **Delivery** is a direct call when the recipient is a live agent in the same
  process; otherwise it crosses a per-host Unix domain socket, discovered through
  advisory presence records under `$DSH_HOME/agent-messaging/hosts/`. Records whose
  process or socket is gone are pruned on sight.

Both routes converge on the same admission path, so a receiver's policy cannot be
bypassed by happening to share a process with it.

## Configuration

Override in your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: agent-messaging
      name: dsh-agent-messaging
      config:
        inbound: accept
        spoolOffline: true
```

| Key | Default | Meaning |
|---|---|---|
| `inbound` | `accept` | `accept`, `hold` (await operator release), or `refuse` |
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

To stop receiving entirely, set `inbound: refuse`. To stop sending, deny the tools
in your permission rules.

## Security model

A peer is another agent, not your operator, and the plugin is built so that
distinction survives contact.

- **Inbound messages are framed as untrusted.** Every delivery carries a fixed
  warning that the text was written by another session, is information rather than
  instructions, and cannot approve an action or grant a permission. This follows
  the convention the harness established for cross-session references.
- **A body cannot forge its own frame.** The data region is JSON with every `<`
  emitted as the lossless escape `\u003c`, so no peer-supplied string can spell the
  surrounding tags and escape into the instruction area.
- **Senders cannot be impersonated.** Identity is read from the executing agent,
  never from tool arguments.
- **Loop control terminates runaways.** Per-sender rate limiting and duplicate
  suppression mean two agents that answer each other automatically stop on their
  own.
- **The inbox is owner-only.** The socket is `chmod 0600`; on a shared machine
  another user's processes cannot reach it.
- **Wire input is validated before it reaches policy.** Unknown protocol versions,
  wrong types, oversized bodies and oversized frames are rejected at the boundary.

Permission boundaries stay per-session: an arriving message never answers a pending
prompt, and anything it asks for is still subject to the receiving session's own
rules.

## Limitations

- **Same machine only.** Delivery is by Unix domain socket, so two sessions can
  reach each other only when they share a filesystem. A container and its host
  cannot; two sessions inside one container can.
- **Plain text only.** No structured payloads, no attachments.
- **Spooled messages are best-effort.** They expire, and the deepest ones are
  dropped first.
- **Presence is advisory.** A host that dies between publishing and delivery makes a
  session look reachable until the record is pruned.

## Development

```bash
npm install
npm run verify   # typecheck, tests, build
```

The layering keeps policy testable without a running harness: `src/domain` is pure
and imports no framework, `src/app` holds the use cases behind the interfaces in
`src/ports`, and `src/adapters` binds those to Cordis, the agent registry, sockets
and disk. Transport, presence and spool tests run against real sockets and real
files rather than mocks.

## Contributing

Code contributions are not being accepted, but questions, bug reports and ideas are
welcome in [Discussions](https://github.com/happyren/dsh-agent-messaging/discussions).
See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Kaixiang Ren
