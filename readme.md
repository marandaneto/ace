# Ace

A collaborative coding environment where people and agents work together in channels that run on
your own machines.

## Prerequisites

- [Tailscale](https://tailscale.com), optional for local use: your tailnet is your team. Without a
  connected tailnet, Ace creates local-only channels and listens only on localhost.
- A model provider key: Anthropic or OpenAI, added in `Settings → Providers`.

## Security — read this first

> [!WARNING]
> Ace runs agents with the privileges of the user running the host. They can execute arbitrary
> shell commands and read, change, or delete files beyond the project directory. Channels and
> lanes are not security sandboxes.

**Your tailnet is your team and the sole authority for team membership and collaboration access.**
Ace has no separate accounts, invitations, or team access controls. Only allow people and machines
you trust with access to your host to reach Ace over your tailnet.

Read [the trust model](docs/architecture.md#the-team) before running or sharing Ace.

## Run

Install Ace or Ace Canary from [releases](https://github.com/githubnext/ace/releases), add a key in
`Settings → Providers`, and join your team's directory in `Settings → Team`. Press Cmd+O to
open a folder as a project, then start a channel from its dashboard.

From a checkout, with Bun 1.4 or later:

```sh
bun install
bun ace new --project ~/code/my-repo
bun ace ask <channel> "what does this repo do?"
```

[Setup](docs/setup.md) covers keys, the command line tool, other devices, development builds, and
deploying the team's services.

## Documentation

- [Terms](docs/terms.md): what Ace's words mean. Binding.
- [Setup](docs/setup.md): install, keys, and the team's services.
- [Architecture](docs/architecture.md): how channels, hosts, and shared services fit together.
- [Channel data](docs/data.md): where channels live, backups, and recovery.
- [Desktop plan](docs/desktop.md): packaging, settings, onboarding, and distribution.
- [Desktop updates](docs/updates.md): releases, Sparkle, and publishing.
- [Native desktop inspection](docs/desktop-tools.md): inspect macOS windows with Peekaboo.
- [Browser tools](docs/browser-tools.md): list, navigate, and inspect pages in a dedicated browser.
