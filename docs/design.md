# Design

Why this plugin exists, what it reuses, and which alternatives were rejected.

## The gap

DeepSeek Harness has most of the pieces for agent-to-agent messaging already, but
not the one that joins them.

| Piece | Status |
|---|---|
| Enumerating sessions, live and persisted | `ctx.sessionQuery.listSessions()` |
| Reading another session's surface | `ctx.sessionQuery.readSurface()` |
| Pulling that content into your own next message | `dsh-session-reference`, `form: 'recall'` |
| Delivering model-facing input into an agent | `Agent.steer()` / `followup()` / `inject()` |
| A vocabulary for "another agent addressed this to me" | `ContextForm: 'relay'` |
| **Addressing a session you do not own and pushing to it** | *missing* |

The delivery primitives take an `Agent` handle, and `ctx.agents.list()` stops at
the process boundary. `dsh-session-reference` is explicitly the other direction —
its design note calls it "read-only background for one target message, not identity
or lifecycle continuity", and rejects resuming or forking the source. The subagent
subsystem covers a coordinator and the children it spawns, not two sessions a human
started independently.

So the missing capability is narrow: **a directory, a transport, and an admission
policy**. Everything else is borrowed.

## Layering

Dependencies point inward. Nothing in `domain/` or `app/` imports a framework
module, which is what makes the admission and naming rules testable without a
running harness.

```
tools/          peer_list · peer_send · peer_inbox      (thin adapters)
   │
app/            MessageSender · InboundRouter           (use cases)
   │  ports/    PeerDirectory · PeerTransport · InboxSink · OutboxSpool
   │
domain/         Envelope · PeerDescriptor · LoopGuard · render  (pure)
   ▲
adapters/       sessionQuery · agent registry · UDS · presence · spool

client/         projection · card · styles              (browser half)
```

`index.ts` is the only file that knows about all of them: it builds the graph,
registers the tools, and hands every long-lived resource to the fiber that owns it.

`client/` is a second program, not a layer of the first: it is built separately,
runs in the Web UI, and shares nothing with the host half but the pure record
format they both read. It has no path back to the host — no RPC, no service, no
state of its own — because everything a transcript card needs is already in the
durable message it is presenting.

## The transcript card

An arriving peer message is a `user/message` event whose source this plugin
wrote. The harness projects that event into its generic injected-context row; the
browser half claims the same event and publishes a second, richer node anchored
just above it, dispatched through the harness's keyed `conversation.chat.node`
slot.

Two rows for one message is the deliberate outcome. Every registered projection
that matches an event contributes a node — the engine has no notion of one
definition claiming an event away from another — so the harness's row cannot be
suppressed by a plugin. That is the honest arrangement anyway: the card is the
human-facing presentation, while the row beneath it holds the exact model-facing
bytes, framing included.

The card carries no copy of the message. The body is read back out of the framed
text through the same tag vocabulary `render.ts` writes, and a body that does not
parse is shown verbatim and labelled as such — a card that quietly presented
harness framing as the sender's words would be worse than no card.

## Decisions

### Reuse `ctx.sessionQuery` for discovery

It already merges the live store with the persistence backend and reports `live`
and `persisted` independently. A private registry of "sessions this plugin has
seen" would drift from it, miss sessions created before the plugin loaded, and
duplicate the corpus logic. The adapter adds only the fact `sessionQuery` cannot
know — which *other host process* currently holds a session.

### One socket per host, not per session

A `dsh` host holds many agents. Per-session sockets would mean a bind, a file, and
an accept loop per session, churning as sessions come and go. A per-host socket
keeps that cost flat, and the envelope's `to` field selects the recipient once the
frame is decoded.

The cost is that a host is a single point of failure for its own sessions — but it
already is, since those sessions live in its memory.

### Sockets in the temp directory

`sun_path` is capped near 104 bytes on macOS. A socket under a home-relative state
directory can exceed that on its own, before a host id is appended. Presence
records live under `$DSH_HOME`; only the socket is relocated, and the record
carries its absolute path.

### Local delivery still goes through admission

`RoutingTransport` hands a same-process message to `InboundRouter`, not to the
agent. Calling the sink directly would be one hop shorter and would make inbound
policy depend on where the sender happened to run — a receiver set to `refuse`
would still be reachable from its own process. Policy is a property of the
receiver, so every route converges on it.

### Three delivery modes, chosen by the sender

The harness distinguishes three inbox boundaries, and the distinction is real: an
interruption that makes current work wrong is a different message from background
the receiver can fold in later. Collapsing them to one would either interrupt too
often or deliver too late. The sender knows which it is; the receiver cannot infer
it from text.

`SubagentReportDelivery` already models the `quiet`/`wakeup` half of this for child
reports, so the shape is the harness's, not an invention.

### Extend the existing `relay` form

`ContextForm` documents `'relay'` as "a message another agent addressed to this
one", and the subagent report path already emits it. A new form would fragment the
vocabulary and leave UI consumers with two things to special-case.

Messages are attributed `{ kind: 'plugin', plugin: 'dsh-agent-messaging', form:
'relay' }`, which is the merge-extensible source shape `MessageSourceMap` expects.

### Spool for sessions that are not running

The alternative — reject anything not currently live — is simpler and is what a
live-only transport gives you. But the case it fails is common: a headless run
between invocations, or a session you will resume tomorrow. Spooling is bounded in
both age and depth precisely because unbounded retention would inject stale context
into a session resumed days later, which is worse than not delivering at all.

Delivery happens on `agent/created`, which fires for a resume as well as a fresh
start.

### Untrusted framing copied from cross-session references

`dsh-session-reference` established the pattern for foreign content entering a
session: a fixed warning above a tag-delimited JSON region, with `<` escaped so the
content cannot spell the tags. The threat is identical here — arguably sharper,
since a peer message is *written* by another model rather than lifted from a log —
so the plugin follows the same shape rather than inventing a weaker one.

### Sender identity from `exec.agent`

`ToolExecutionInput.agent` is set by the agent loop. Taking the sender from a tool
argument instead would let a model address a message as any session it can name,
which defeats the attribution the receiver is shown.

## Rejected alternatives

- **A shared message file per session, polled by receivers.** No wake semantics: a
  message would only be noticed at the next turn, which is exactly the `context`
  mode and cannot express `steer`. Polling also burns a read per session per
  interval.
- **A central broker process.** Another daemon to supervise, start and garbage
  collect, for a peer-to-peer problem where both parties are already running.
- **TCP on loopback.** Reachable by any process on the machine, including other
  users. A Unix socket at mode 0600 restricts to the owner for free.
- **Routing through the session event log.** The log is durable conversation
  history; delivery state is neither durable nor conversation. Writing to another
  session's log would also mean writing to a store this process may not own.
- **Blocking request/reply in `peer_send`.** A tool call held open for however long
  the other agent takes to answer, with no upper bound. Correlation is exposed
  instead through `messageId` and `reply_to`, leaving the sender free to continue.
- **Per-session sockets, matching how other tools do it.** Rejected for the
  file-descriptor churn described above; the harness's own multi-session host makes
  a per-host inbox the natural unit.
- **A custom durable event behind the transcript card.** It would have given the
  card a row of its own with nothing beside it. But a log containing an event type
  outside the harness's known vocabulary is *refused on reload* unless the
  envelope is marked `ignorable`, and `Session.append` exposes no way to mark one —
  the harness records that a registration surface for downstream plugin events is
  deferred until a consumer exists. Shipping it would have made a user's session
  unopenable. The card is derived from the event the harness already writes, and
  this plugin adds nothing to the log.
- **Taking over the harness's `context` renderer.** One key, one occupant: a
  second registration for it throws. Claiming it would also mean re-implementing
  every other context presentation — instructions, catalogs, recalls — and owning
  that drift forever, to change one of them.

## What would change the design

- **A first-party cross-host transport in the harness.** The `PeerTransport` port
  exists so the Unix socket can be swapped without touching the use cases.
- **A session-title index.** Name derivation currently folds titles per listing;
  a dedicated index would make it cheaper without changing addresses.
- **Structured payloads.** The envelope is versioned (`protocol: 1`) so a future
  content type can be added without breaking existing peers.
