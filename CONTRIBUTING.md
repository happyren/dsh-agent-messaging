# Contributing

Thanks for your interest in this project. Pull requests are welcome.

This was a closed repository for its first ten releases, which was the wrong call:
it suppressed exactly the outside evidence the project runs on. Every significant
fix so far came from watching real sessions fail — the alias nobody could address,
the deadlock that went undetected, the courtesy loop that cost thirteen turns.
Those all came from one person's runs. Yours will be different.

## What I am looking for most

**Bug reports from real use, with the numbers.** Run
`npx dsh-agent-messaging report` and paste what it says. A run where coordination
cost more than it caught is more valuable to me than a feature request, because
it is the thing I cannot generate alone.

**Failure transcripts.** If two of your sessions talked past each other, deadlocked,
or spent turns on nothing, the transcript is the bug.

## Pull requests

Open one. A few things will make it land faster:

- **Run `npm run verify`** — typecheck (host and browser), tests, build. All three
  must pass.
- **Test the behaviour, not the implementation.** The tests here are written to say
  *why* a rule exists; a test whose failure message explains the consequence is worth
  more than one that pins a shape.
- **Match the surrounding prose.** Comments explain reasons rather than mechanics,
  and every exported symbol carries a JSDoc block. If a change needs a paragraph to
  justify, put the paragraph in the code.
- **Keep the tool surface flat.** Nine tools already compete for a model's attention.
  A change that adds a tenth needs to argue why it cannot be an argument on an
  existing one — see the capability flags in `src/config.ts` for the shape that
  argument usually takes.
- **Small and separable beats large and coupled.** One reason per pull request.

If you are planning something substantial, open a
[Discussion](https://github.com/happyren/dsh-agent-messaging/discussions) first so
neither of us wastes the effort. I will say plainly if something is out of scope,
and [`docs/roadmap.md`](docs/roadmap.md) records what is deliberately *not* being
built, and why.

## Discussions

[Discussions](https://github.com/happyren/dsh-agent-messaging/discussions) are open
for everything that is not a patch:

- **Bug reports** — what you did, what happened, what you expected. Include your
  `dsh` version, your OS, the output of `npx dsh-agent-messaging doctor`, and the
  plugin config from your profile's `cordis.patch.yml`.
- **Questions** about how the plugin behaves or how to configure it.
- **Ideas** for the roadmap. Concrete use cases are more useful than feature names:
  tell me what you were trying to do and where it broke down.
- **Design feedback** — especially on the wire protocol, the delivery modes, or the
  security model, which are the parts hardest to change later.

## Security

Please do **not** open a public discussion or pull request for a security issue.
Report it privately through
[GitHub's security advisory form](https://github.com/happyren/dsh-agent-messaging/security/advisories/new).

Things I consider security-relevant: anything that lets a peer message escape the
untrusted-content framing and be read as instructions, impersonate another session,
reach an inbox belonging to a different OS user, or bypass a receiver's inbound
policy.

## Licence

By contributing you agree that your contributions are licensed under the
[MIT licence](LICENSE), the same terms as the rest of the project.
