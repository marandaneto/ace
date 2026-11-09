# Setup

Tailscale is optional for local use. Without a connected tailnet, Ace creates local-only channels
and serves its authenticated app only on localhost, without peers, directory sync, or lobbies.
Start Tailscale before Ace Helper to use team channels. Restart Ace Helper after connecting or
switching tailnets: it then shows that tailnet's channels instead of local-only channels. Local-only
channels remain on disk and reappear when Ace starts without a connected tailnet; they are never
published to a team.

## Provider keys

Add Anthropic or OpenAI keys in `Settings → Providers`, which stores them in Keychain. Provider keys
are never returned to the UI, and running workers read changes on their next model request.

From a checkout, Ace reads a key such as `OPENAI_API_KEY` from `ACE_OPENAI_API_KEY`, then
`OPENAI_API_KEY`, then the OS keychain (`bun ace key set OPENAI_API_KEY`). Environment overrides
take priority and Settings identifies them.

### ChatGPT subscription

For a local host, sign in with an eligible ChatGPT subscription instead of an OpenAI API key:

```sh
bun ace login openai
bun ace models
```

Open the printed authorization URL in Brave and approve the sign-in. The localhost callback
finishes the login; if it cannot, paste the full redirect URL into the terminal. Refresh the UI
or reload it after signing in. Subscription-authenticated OpenAI models appear in the existing
model picker. Restart an already running source host once after applying this patch.

OAuth tokens stay in Keychain. Only a stable installation ID and a connected flag are stored in
`subscription.json` beside the host preferences. CLI and channel workers serialize token refresh
across processes, and a running host saves the login so it owns its Keychain item. A subscription
login takes priority over OpenAI API keys; a refresh failure never silently falls back to API
billing. `bun ace logout openai` removes the subscription login without deleting API keys.
Subscription eligibility and usage limits are controlled by OpenAI.

## Command line tool

`Settings → Ace Helper` installs the command line tool. It links `ace` for stable, or `ace-canary`
for Canary, in `~/.local/bin` to the app's own Ace Helper, so it uses that app's channels and port
and stays current with app updates. Settings says whether your shell finds it and, if not, what to
add to your `PATH`.

## From a checkout

Ace requires Bun 1.4 or later.

```sh
bun install
bun ace new --project ~/code/my-repo
bun ace ask <channel> "what does this repo do?"
bun app build && bun ace serve   # start the local host
bun ace open                     # in another terminal: open its authenticated browser app
bun desktop dev                  # desktop UI and the independent Ace Helper
```

Development builds use their own catalog, settings, and Keychain service; see
[desktop](desktop.md#ui-testing). If `bun desktop dev` or `build` exits silently, macOS killed
Electrobun's downloaded CLI for an invalid signature. Re-sign it once with
`codesign --force -s - apps/desktop/node_modules/electrobun/bin/electrobun`.

## Other devices

On your phone or another of your devices, with Tailscale on, open the address the host prints
(`http://<machine>.<tailnet>.ts.net:4140`). Only the host's owner is served. Teammates open their
own host, which shows your channels.

When the tailnet has HTTPS certificates, hosts also listen on HTTPS (port + 1000) and the team's
deployed web app can reach them: open it, enter `<machine>.<tailnet>.ts.net:5140`, and add it to the
home screen to use it as an app.

## Team directory

Everyone on your tailnet who runs Ace is on your team, with or without a directory; without one,
teammates see each other's channels only while their Mac is online. The team's directory lists
every host's channels, so they stay listed while their host is offline, and keeps project shares
and presence.

Create it in the app: the sidebar's Team directory card, an offline channel, or `Settings → Team`
offers **Create directory**. **This Mac** serves it from this host on the tailnet, with no account
or secret; a Mac that stays on (a Mac mini) is the best place for it. Every other host on the
tailnet finds it in this host's hello and joins it on its own, unless it left a directory before.
**Stop serving…** in `Settings → Team` turns it off and deletes its shares. `Settings → Team` and
**Team setup** list the hosts in the directory and when each last synced; when the Mac serving it is
offline or stops serving, teammates' sync errors name that Mac.

### Deployed directory

Teams that set up a directory before can keep it deployed as a cell. Whoever sets up the team
deploys the services once from a checkout; everyone else joins in `Settings → Team` (Join…) with
the directory's URL and the team's secret, shared privately, or uses **Ask to join** next to a
teammate's host in **Team setup** (at the bottom of the sidebar, or `Settings → Team → Set up…`),
which their owner approves in their Ace. Refresh in `Settings → Team` syncs at once. From a
checkout, `printf %s "$SECRET" | bun ace key set ACE_SECRET` then `bun ace directory <url>` does
the same.

The services are cells, so they run on Cloudflare Workers, or on [celld](#on-celld) on machines the
team runs or on [Fly.io](#on-flyio). To deploy them to your Cloudflare account, give the Workers the
same secret and your tailnet's MagicDNS suffix. The services then serve only that tailnet; see
[the team](architecture.md#the-team) for what that scope does and doesn't protect.

One command does every step below for Cloudflare or Fly.io, signed in to `wrangler` or `fly`,
with Tailscale on. It names the services for your tailnet (`ace-directory-tail1234` for
`tail1234.ts.net`), deploys the directory with a new team secret, and prints the directory's URL
and the secret to join with.

```sh
bun services/deploy.ts <cloudflare|fly>
```

By hand, on Cloudflare:

```sh
SECRET=$(openssl rand -hex 32)
TAILNET=$(tailscale status --json | jq -r .MagicDNSSuffix)
cd services/directory && bunx wrangler deploy && printf %s "$SECRET" | bunx wrangler secret put ACE_SECRET && printf %s "$TAILNET" | bunx wrangler secret put TAILNET
```

Then name the other services in the directory, from `services/directory`, so every host that joins
picks them up. `Settings → Team → Team services` shows which ones a host's directory names:

- `HOSTED`: the channel service that earlier hosted channels run on. Ace no longer moves channels
  there, but a host still moves an idle one back with `ace move <channel> --local`.
- `APP`: the web app, deployed with `bun --filter @ace/app deploy`. A host without a directory uses
  `bun ace web <url>` instead.
- `COMPUTE`: the [compute service](../services/compute/README.md), which turns on `Run in cloud`
  for every host that hasn't saved its own `Settings → Beta` choice.

```sh
printf %s https://ace-app.<your-subdomain>.workers.dev | bunx wrangler secret put APP
```

### From the app

**Team setup**, at the bottom of the sidebar or `Settings → Team → Set up…`, can deploy to
Cloudflare for you, with no checkout: choose **Get your team started**, then a hosted directory on
Cloudflare. For Fly.io it shows the command to run from a checkout and joins with what it prints.
**Deploy** does this, and nothing else:

- Signs in with your own `wrangler login`. If you aren't signed in, it opens Cloudflare's sign-in
  page in your browser. Ace never sees a Cloudflare password or token.
- Creates `ace-directory-<tailnet>` in that account, named for the first label of your tailnet's
  MagicDNS name (`tail1234` in `tail1234.ts.net`). It is a Worker with SQLite-backed Durable Objects, served at
  `https://<name>.<your-subdomain>.workers.dev`, with Workers Logs on.
- Gives the Worker a new random team secret and your tailnet's name.
- Saves the secret in this Mac's Keychain and joins the directory. It shows the URL and the secret
  once, for you to send teammates privately.

The Workers answer only hosts on your tailnet that hold the secret. Ace changes nothing else in the
account. To undo it, leave the directory in `Settings → Team`, then delete the Workers:

```sh
bunx wrangler delete --name ace-directory-<tailnet>   # and ace-channel-<tailnet>
```

### On celld

celld runs the same services on any machine with an S3, R2, GCS, Tigris, or Azure Blob bucket.
Until [denoland/celld#277](https://github.com/denoland/celld/issues/277) lands, install the
[githubnext/celld](https://github.com/githubnext/celld) build, which fixes runs failing with
"Session is poisoned":

```sh
curl -fsSL https://celld.dev/install.sh | CELLD_RELEASES_URL=https://github.com/githubnext/celld/releases sh
```

Put each service's vars in a file (`ACE_SECRET`, `TAILNET`, model keys for `channel`, and `HOSTED`,
`APP`, or `COMPUTE` for `directory`), deploy each under its own prefix, and run a node per prefix.
celld has no secret store: the vars sit in the bucket as plain text, so restrict who can read it.

```sh
bun services/celld.ts channel deploy channel.env --bucket s3://my-bucket/channel
bun services/celld.ts directory deploy directory.env --bucket s3://my-bucket/directory
celld --bucket s3://my-bucket/channel --listen 127.0.0.1:8788      # one node per service
celld --bucket s3://my-bucket/directory --listen 127.0.0.1:8787
tailscale serve --bg --https 8443 http://127.0.0.1:8788            # celld serves no TLS
tailscale serve --bg --https 443 http://127.0.0.1:8787
```

Hosts then use `https://<machine>.<tailnet>.ts.net` as the directory and
`https://<machine>.<tailnet>.ts.net:8443` as `HOSTED`. Redeploying updates running nodes without a
restart. Compute still needs Cloudflare.

### On Fly.io

[`services/fly.toml`](../services/fly.toml) runs one celld node per service on Fly.io, with a
Tigris bucket each. Tigris needs a card on the Fly account. Pick app names (`ace-directory-<team>`
and `ace-channel-<tailnet>` below), then create the apps and buckets. `fly storage create` prints the
bucket's keys once; keep them to deploy from a checkout.

```sh
for s in directory channel; do
	fly apps create ace-$s-<team>
	fly storage create -a ace-$s-<team> -n ace-$s-<team>
	fly secrets set -a ace-$s-<team> --stage CELLD_BUCKET=s3://ace-$s-<team>
done
```

Deploy each service's code to its bucket with that bucket's keys, then start its node. Set `HOSTED`
in `directory.env` to `https://ace-channel-<team>.fly.dev`.

```sh
export S3_ENDPOINT=https://fly.storage.tigris.dev AWS_REGION=auto
AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… bun services/celld.ts channel deploy channel.env --bucket s3://ace-channel-<team>
AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… bun services/celld.ts directory deploy directory.env --bucket s3://ace-directory-<team>
fly deploy -c services/fly.toml -a ace-channel-<team> --ha=false
fly deploy -c services/fly.toml -a ace-directory-<team> --ha=false
```

Hosts then use `https://ace-directory-<team>.fly.dev` as the directory. The URLs are public, like
`workers.dev`, and refuse requests without the team's credential.

To try the services locally, put `ACE_SECRET`, `TAILNET`, and a model key in
`services/channel/.dev.vars`, then:

```sh
bun --filter @ace/channel-service dev                     # http://localhost:8787
bun --filter @ace/directory dev --port 8788               # point hosts at http://localhost:8788
printf %s "$SECRET" | bun ace key set ACE_SECRET          # the value in .dev.vars
```

`bun services/celld.ts <channel|directory> dev --port <port>` runs a service on celld instead, reading
its `.dev.vars`.
