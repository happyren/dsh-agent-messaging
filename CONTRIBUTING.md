# Contributing

Thanks for your interest in this project.

## Code contributions

**Pull requests are not being accepted.** This is a single-maintainer project with
a deliberately narrow scope, and reviewing outside changes is not something I can
commit to right now. PRs opened against this repository are **closed
automatically, unread** — that is a statement about my capacity, not about the
work in them.

GitHub has no setting that turns pull requests off on a public repository, so the
close is done by [a workflow](.github/workflows/close-external-prs.yml) rather
than by a wall. Nothing personal is meant by it.

If you need different behaviour, the MIT licence lets you fork freely. You do not
need my permission, and you do not need to ask.

## Discussions are open

[Discussions](https://github.com/happyren/dsh-agent-messaging/discussions) are
the right place for everything else, and genuinely welcome:

- **Bug reports** — what you did, what happened, what you expected. Include your
  `dsh` version, your OS, and the plugin config from your profile's
  `cordis.patch.yml`.
- **Questions** about how the plugin behaves or how to configure it.
- **Ideas** for the roadmap. Concrete use cases are more useful than feature names:
  tell me what you were trying to do and where it broke down.
- **Design feedback** — especially on the wire protocol, the delivery modes, or the
  security model, which are the parts hardest to change later.

A good bug report in Discussions is worth more to me than a patch, because it tells
me something I could not have found alone.

## Security

Please do **not** open a public discussion for a security issue. Report it privately
through [GitHub's security advisory form](https://github.com/happyren/dsh-agent-messaging/security/advisories/new).

Things I consider security-relevant: anything that lets a peer message escape the
untrusted-content framing and be read as instructions, impersonate another session,
reach an inbox belonging to a different OS user, or bypass a receiver's inbound
policy.
