# Design note and roadmap

Why this plugin is shaped the way it is, what the research says about
agent-to-agent collaboration, and what gets built next.

Every roadmap item below names the failure mode it attacks and the evidence it
rests on. Items without evidence do not get built.

## The uncomfortable finding

Most published work on LLM multi-agent systems studies an **orchestrator with
worker clones reasoning about the same problem**. Measured honestly, that
topology usually loses:

- Multi-agent debate does not reliably beat a single agent at equal token
  budget, and most of the measured gain comes from **voting rather than from the
  debate** ([ICLR 2025 blogpost][mad-blog], [When and Why Does MAD
  Fail][mad-fail], [Talk Isn't Always Cheap][talk-cheap]).
- Under normalised compute, single-agent systems match or beat multi-agent ones
  across model families and architectures ([equal-budget study][equal-budget]).
- Self-correction — the single-agent analogue — has the same negative result
  ([Huang et al.][self-correct]).

Where multi-agent *does* win, the reason is structural rather than social.
Anthropic's research system improved on single-agent Opus by ~90% on their
internal eval, at roughly **15× the tokens**, with token usage alone explaining
about **80% of performance variance**; their stated lesson is that architecture
must follow task structure, and that multi-agent pays only when work decomposes
into genuinely independent threads with their own context windows
([writeup][anthropic]).

**The conclusion this plugin is built on:** the value of agent-to-agent
communication is not more brains on one problem. It is **information
asymmetry** — agents that are differently situated, holding different context,
looking at different files. Two sessions in one repository are asymmetric by
construction. Debate discards that asymmetry; exchange exploits it.

## What actually goes wrong

[MAST][mast] is the empirical grounding: 200+ tasks across 7 frameworks,
hand-annotated by six experts (κ = 0.88) into 14 failure modes.

| Category | Share | Largest modes |
|---|---|---|
| System design | 43.7% | step repetition **15.7%**, unaware of termination **12.4%**, disobey task spec 11.8% |
| Inter-agent misalignment | 32.3% | reasoning-action mismatch 13.2%, task derailment 7.4%, fail to ask for clarification 6.8% |
| Task verification | 24.5% | incorrect verification 9.1%, no/incomplete verification 8.2% |

Their own interventions: improving role specification gained **+9.4%**, and
adding verification of the high-level objective gained **+15.6%** — while
overall completion stayed low, which they read as needing redesign rather than
patches.

A third of failures are specifically *inter-agent*. Those are the ones a
messaging layer is positioned to remove, and they are what the roadmap targets.

## Where this plugin sits

Almost all of the literature studies orchestrator-worker trees. Long-lived
**peer** sessions, with a human in several loops at once, is the under-studied
quadrant — and the one developers actually work in.

| Axis | Studied heavily | This plugin |
|---|---|---|
| Topology | orchestrator → workers | peers, no coordinator |
| Lifetime | one task, then gone | long-lived, resumable |
| Context | clones of one prompt | genuinely different repos, files, history |
| Human | one, at the top | one, in several loops |

The subagent subsystem already covers the first column. This plugin covers the
second, and the roadmap should not drift back into the first.

## Principles

1. **Exploit asymmetry, never manufacture it.** No debate between clones, no
   voting panels. A message is worth its tokens when the sender knows something
   the receiver cannot see.
2. **Every message costs the receiver a turn.** Denser topologies are not better
   ([topology study][topology]); broadcast is a last resort.
3. **Prefer traces to conversations.** Coordination through marks left in a
   shared medium — stigmergy — avoids the N² chatter of negotiation
   ([CodeCRDT][codecrdt]).
4. **Common ground is durable, messages are not.** Shared understanding needs a
   record, not a transcript ([Klein et al.][klein]).
5. **Authority never travels in a message.** Enforcement stays with the
   receiving session's own permissions; see the security model in the README.
6. **If it cannot be measured, it cannot be steered.** Collaboration is
   expensive, and the only reason anyone knows Anthropic's system was worth 15×
   tokens is that they measured it.

## Roadmap

Ordered by impact-significance: the failure mass each item removes, weighted by
the evidence behind it.

Versioning is [semantic](https://semver.org): a new tool is a feature and takes a
minor bump, a behaviour fix takes a patch. The `0.0.x` line below `0.1.0` is
pre-correction history and is left as it shipped.

### The whole scenario, on a real host

`v0.9.1` was the point at which the storyline in
`tests/scenario.integration.test.ts` was also driven through a real `dsh web`
instance with real models, four sessions and real files — not simulated. It
produced the same numbers the deterministic test predicts:

```
3 receiver turns spent, 3 problems caught
  collisions avoided   1
  false claims caught  1
  deadlocks detected   1
```

Each was a real event: checkout was refused `api/` because payments held
`api/charges.ts` beneath it; payments read the file and refuted a false currency
claim; docs and checkout deadlocked and were told at the moment the cycle closed;
and a fourth session, told nothing about the history, found the deferral in the
ledger and declined to reopen it.

The run also found a bug the deterministic test could not: see `v0.9.1` below.

### Verified in a live host

`v0.0.3` and `v0.0.4` were exercised against two real sessions in one `dsh web`
host, not only against tests. Both behaved as designed — a claim on `api/` was
refused because a peer held `api/charges.ts` beneath it, and a verifier answered a
false claim by reading the file and refuting it with line references.

That run also produced the fix in `v0.0.5`: the verifier checked properly, then
answered with `peer_send` instead of `peer_verify_reply`, losing the typed
verdict. Tool wording is only testable against real models, which is why each
item ships with a live pass rather than tests alone.

### v0.0.3 — Work claims  ✅ shipped

Advisory claims on a path or topic, with a TTL, visible to every peer.

Attacks **FM-1.3 step repetition (15.7%)**, the largest single failure mode in
MAST. The concrete instance in coding is two sessions editing the same file, or
re-deriving a finding a sibling already has. Stigmergic by design: a claim is a
mark in a shared medium, not a negotiation, so it costs no model calls
([CodeCRDT][codecrdt]).

Not a lock. The plugin cannot enforce one, and pretending otherwise would be
worse than advisory honesty.

### v0.0.4 — Verification requests  ✅ shipped

Ask a peer to check a specific claim, with evidence pointers and a typed verdict.

Attacks **FC3 task verification (24.5%)**, and is the intervention with the
largest measured gain in MAST (**+15.6%**). Cross-session verification is
qualitatively different from self-verification — which is known to fail
([Huang et al.][self-correct]) — because the verifier holds different context and
did not produce the artefact.

### v0.1.0 — Capability and ownership cards  ✅ shipped

Each session declares what it owns and what it is for; peers read it before
addressing it.

Attacks **FM-1.2 disobey role specification** and **FM-2.3 task derailment**
(7.4%); role specification was MAST's other measured intervention (**+9.4%**).
Shaped after [A2A][a2a] Agent Cards, so the same declaration can later serve
cross-vendor discovery.

### v0.2.0 — Task-state signalling  ✅ shipped

Report *task* state — working, blocked-on-peer, done, abandoned — rather than
only the process state (`idle`/`running`) the agent registry exposes.

Attacks **FM-1.5 unaware of termination (12.4%)** and **FM-3.1 premature
termination (6.2%)**. This is common ground in Klein's sense: a teammate that
cannot signal completion or blockage cannot be coordinated with
([Klein et al.][klein]).

### v0.3.0 — Shared decision ledger  ✅ shipped

An append-only record of what was decided, by whom, on what evidence, readable
by any session at any time.

Attacks **FM-1.4 loss of conversation history** and **FM-2.1 conversation
reset**. Messages are ephemeral; common ground has to outlive them. Follows the
**transactive memory** direction in the MAS memory literature — share an index of
who knows what rather than replicating everyone's full memory
([MATM][matm], [memory survey][mem-survey]).

### v0.4.0 — Collaboration accounting  ✅ shipped

Turns caused by inbound messages, how many were acted on, duplicate work avoided.

Without this, nobody — including us — can tell whether any of the above helps.
Anthropic's 15× token result is the cautionary tale: collaboration is expensive,
and it was only known to be worthwhile because it was measured
([writeup][anthropic]).

### v0.5.0 — Groups and topology control  ✅ shipped

Named channels with an explicit shape: star through a lead, or mesh.

Communication topology measurably changes both efficiency and quality, and
denser is not automatically better ([topology study][topology]). Making the shape
explicit beats an implicit all-to-all that degrades as sessions multiply.

### v0.6.0 — A2A bridge (outbound)  ✅ shipped

Speak [Agent2Agent][a2a] so DSH sessions can reach agents outside DSH.

A2A is the interoperability standard worth building against — donated by Google
to the Linux Foundation with AWS, Cisco, Microsoft, Salesforce, SAP and
ServiceNow as founding members, using JSON-RPC over HTTP/SSE with Agent Cards for
discovery. Our envelope already carries identity, delivery semantics and reply
correlation, so the mapping is small.

Worth stating the known gap: these protocols still cannot express governance
constraints such as authority scope ([governance analysis][governance]) — which
is precisely what `peerAuthority` exists to keep outside the wire.

## Where this stops

Six of the eight items above shipped, each with a live pass in a real host. The
two that did not are recorded above as *not built* rather than as *next*, because
neither is a commitment.

The honest reason to stop here is that both **add surface**, and the last thing
this plugin needs is more of it. Ten `peer_*` tools already compete for a model's
attention against everything else in the harness, and nothing measures whether a
model reaches for the right one under load. Groups would add more tools; the A2A
bridge would add a second protocol whose
[governance model does not yet express](https://arxiv.org/pdf/2606.31498) the
authority boundary `peerAuthority` exists to hold.

The accounting in `v0.4.0` is what should decide whether either is worth
building: run the plugin on real work, read `npm run report`, and let the numbers
argue. That is the point of having measured anything at all.

## The transcript card (v0.10.0)

An arriving peer message used to render as a `Context injection` row — accurate,
but indistinguishable from a skill catalog or a reconciled instruction file, and
attributed to an opaque session id. A reader could not tell, without expanding
anything, that another agent had spoken.

The plugin now ships a **browser half**: a Conversation Node that recognizes its
own messages in the durable log, and a renderer registered against the harness's
keyed `conversation.chat.node` slot. The card names the sender, says how the
message arrived (`interrupted this step` / `next turn` / `delivered quietly`),
says what the receiving session was told it may do about it, and shows the
message itself rather than the framing around it.

**Two rows, deliberately.** The harness's own injected-context row stays directly
beneath the card, because the harness's projection claims that event too and no
plugin can suppress it. That turns out to be the right outcome rather than a
compromise: the card is the human-facing presentation, and the row beneath it
still holds the exact bytes the model read — untrusted-content notice and all.
The card never claims to be that text, and says so when it cannot parse it.

**A custom durable event was the design that did not survive contact.** Emitting
one would have given the card a row of its own with nothing beside it. But a
session log containing an event type outside `KNOWN_SESSION_EVENT_TYPES` is
*refused on reload* unless the envelope carries an `ignorable` marker, and
`Session.append` offers no way to set one — the harness's own comment records
that a registration surface for downstream plugin events is deferred until such
a consumer exists. Shipping it would have made a user's session unopenable. The
card is therefore derived from the `user/message` event the harness already
writes, and the plugin adds nothing to the log.

**Still not visible: tool presentation.** Tool calls declare
`presentCall`/`presentResult` — the harness's documented presentation vocabulary
— so a card could carry the verdict, the refusal, or the deadlock in its title
instead of a bare `peer_claim · api/charges.ts` row. Against the `rc` builds this
was developed on, the Web UI renders the generic row regardless; re-checked at
`v0.10.0` and still true. The declarations are correct against the published
types and cost nothing to carry, so they stay — but nobody should read them as a
UI improvement until a harness build renders them.

## What the accounting caught first (v0.10.1)

The accounting was built to answer whether collaboration pays for itself. The
first thing it actually caught was the plugin's own cost.

A five-session live run produced **20 delivered messages against 3 problems
caught**, with 2 more dropped by loop control. The transcripts said why: once the
work was finished, the sessions kept going — *"Noted, thanks."* → *"Anytime —
good luck."* → *"Thanks, will keep you posted."* → *"Perfect — I'm here."* Nothing
was wrong with any single message. Each one cost a receiver a turn.

The fix was one sentence in `peer_send`'s description telling models not to send
acknowledgements. Re-running the same scenario: **7 delivered, 0 dropped, the same
3 problems caught.** A 65% cut in cost with no loss of value, from a change that
touched no code path.

Two things worth taking from it. First, the instrument works: a prompt-level
regression in what collaboration costs is invisible in any transcript and obvious
in the counts. Second, guidance that a run proves load-bearing belongs under test
(`tests/tool-guidance.test.ts`) — a description is exactly the kind of thing an
edit trims without noticing.

## Found by the benchmark: stale peers diffuse responsibility

The first run of the coordination benchmark produced an invalid measurement and
a real finding at the same time.

In the `stale-contract` scenario, the client session read the decision ledger,
found the new `tenant_id` requirement, and then declined to act on it:

> that's assigned to the client-update sessions (`update-client-for-tenant-id-requ`
> etc.), not part of my loyalty-points task, so I left it for them

Every step of that reasoning is sound. It listed its peers, read their titles,
and inferred ownership from them. The sessions it deferred to were dead — leftovers
from an earlier run — and nothing in the listing said so loudly enough to matter.

The plugin currently reports liveness (`idle`, `running`, `not running`) and, since
v0.0.6, a declared task state. Neither was enough: a *title* is a strong signal and
an unreliable one, and a long-lived workspace accumulates titles that describe work
nobody is doing.

Candidate answers, none built yet:

- **Age out the listing.** A session with no activity for hours is not a colleague;
  say so, or drop it.
- **Make deferral explicit.** A peer that believes work belongs to another session
  could be required to address that session rather than infer from a listing —
  a `blocked_on` that must resolve to something live.
- **Report the corpus honestly.** "12 sessions, 2 live, 10 last active >6h ago" is a
  different prompt from twelve equal-looking names.

The measurement this invalidated is kept in `bench/results/` rather than deleted.

## Deliberately not building

- **Debate or voting among peers.** The evidence is against it at equal budget,
  and our peers are not clones — debate would discard the asymmetry that makes
  them useful.
- **A central orchestrator.** That is the subagent subsystem's job, and it is
  already well covered by the harness.
- **Automatic broadcast.** Every message costs the receiver a turn.

## References

**Failure modes and negative results**

- Cemri et al., [*Why Do Multi-Agent LLM Systems Fail?*][mast] — the MAST taxonomy this roadmap is scored against.
- [*Multi-LLM-Agents Debate — Performance, Efficiency, and Scaling Challenges*][mad-blog], ICLR 2025 blogposts.
- [*When and Why Does Multi-Agent Debate Fail, and Does It Really Underperform?*][mad-fail]
- [*Talk Isn't Always Cheap: Understanding Failure Modes in Multi-Agent Debate*][talk-cheap]
- [*Single-Agent LLMs Outperform Multi-Agent Systems Under Equal Thinking Token Budgets*][equal-budget]
- Huang et al., [*Large Language Models Cannot Self-Correct Reasoning Yet*][self-correct]

**What works, and what it costs**

- [*How Anthropic Built a Multi-Agent Research System*][anthropic] — ~90% gain, ~15× tokens, ~80% of variance explained by token usage.
- [*Information Propagation Effects of Communication Topologies in LLM-based Multi-Agent Systems*][topology], EMNLP 2025.
- [*CodeCRDT: Observation-Driven Coordination for Multi-Agent LLM Code Generation*][codecrdt] — stigmergic coordination for code agents.

**Teamwork and memory**

- Klein et al., [*Ten Challenges for Making Automation a "Team Player" in Joint Human-Agent Activity*][klein], IEEE Intelligent Systems, 2004.
- [*Multi-Agent Transactive Memory*][matm] — population-level experience reuse.
- [*Memory in LLM-based Multi-agent Systems: Mechanisms, Challenges, and Collective Intelligence*][mem-survey]

**Interoperability**

- [*Agent2Agent protocol*][a2a] — Google, donated to the Linux Foundation.
- [*Governance Gaps in Agent Interoperability Protocols*][governance] — what MCP, A2A and ACP cannot express.

[mast]: https://arxiv.org/abs/2503.13657
[mad-blog]: https://d2jud02ci9yv69.cloudfront.net/2025-04-28-mad-159/blog/mad/
[mad-fail]: https://arxiv.org/html/2510.20963v2
[talk-cheap]: https://arxiv.org/pdf/2509.05396
[equal-budget]: https://arxiv.org/html/2604.02460v1
[self-correct]: https://arxiv.org/pdf/2310.01798
[anthropic]: https://blog.bytebytego.com/p/how-anthropic-built-a-multi-agent
[topology]: https://aclanthology.org/2025.emnlp-main.623/
[codecrdt]: https://arxiv.org/pdf/2510.18893
[klein]: https://dl.acm.org/doi/abs/10.1109/MIS.2004.74
[matm]: https://arxiv.org/html/2606.19911v1
[mem-survey]: https://www.techrxiv.org/users/1007269/articles/1367390
[a2a]: https://en.wikipedia.org/wiki/Agent2Agent
[governance]: https://arxiv.org/pdf/2606.31498
