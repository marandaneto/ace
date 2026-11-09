# Architecture

Ace is a collaborative coding environment that runs on the team's own machines. Old Ace ran one
process per channel inside a cloud VM; most of its pain was the VM and cloud infrastructure, not
the per-channel process. Ace keeps the process and drops the infrastructure.

Words in this document have the meanings in [terms](terms.md).

Ace is open source software that teams clone, fork, and operate on their own machines and in
their own infrastructure or cloud accounts. Ace will not operate a hosted service. The tailnet
is the sole authority for team membership, and each project is visible only to people with
access to it; see [the team](#the-team).

## Layout

| Path                 | Runs                    | Owns                                                                 |
| -------------------- | ----------------------- | -------------------------------------------------------------------- |
| `packages/channel`   | inside a channel worker | The channel: chats, agents, lanes, and the client protocol types     |
| `apps/host`          | on every machine (Bun)  | The `ace` CLI, channel workers, the channel catalog, local transport |
| `apps/desktop`       | on macOS                | The desktop client and packaging for Ace Helper                      |
| `services/channel`   | Cloudflare or celld     | Hosted channels: one Durable Object per channel                      |
| `services/directory` | Cloudflare or celld     | The team's list of hosts and where each channel lives, and lobbies   |

Clients (the CLI and desktop app) attach to channels; a channel is not a client.

The app's Issues and PRs pages read the selected project's GitHub repository through the host's
GitHub CLI account. A peer can resolve the Git remote of a project already exposed by its channels;
the app's own host performs authenticated GitHub reads. The app caches GitHub responses in
IndexedDB, scoped to its host connection. It refreshes in the background at startup and every
three hours, keeping cached content visible while requests run or fail. GitHub content stays
outside channel history. Issues and PRs share the Channels sidebar and project picker, with
Open, Closed, and All filters in the sidebar. Items open on GitHub; a row's "Open in a channel"
action creates a channel in the selected project and invokes its agent with the item's title and URL.
A project's dashboard derives its sections without storing anything new. Needs you lists the
viewer's runs that failed or wait on their answer (the attention hints) and open pull requests
requesting their review. Pick back up ranks, as old Ace did, the viewer's open pull requests and
assigned issues, read with `@me` searches through the same account; a pull request whose head
branch starts with a channel's original name is that channel's lane, so its row continues the
channel, including a teammate's, and other rows offer Open in a channel. Team pulse shows each
teammate who is here, their active channels, and runs they asked for, in anyone's channel, that
ended since this browser last opened the project's dashboard.
The shared project picker also offers All Projects, which opens Channels with collapsible sections
named for each project and its ten most recently active, non-archived channels. Opening a channel
keeps that grouped view; channel creation and GitHub pages retain a concrete project selection.

The app identifies a project with a GitHub remote by its repository, compared case-insensitively,
so checkouts of it on any host are one project; a folder without one is its host and main checkout.
A project keeps every known checkout. A GitHub project shows its name wherever it is checked out;
a folder without one on another host is labeled with that host. Projects that would show the same
label add the fewest trailing parent folders that tell them apart, or a GitHub project its owner, and
the project picker shows each checkout's full path on hover. Creating channels and archiving
inactive ones use this host's checkout. A GitHub project checked out only on teammates' hosts lists
their channels, and its channel creation entry points first offer to set it up on this machine:
the person confirms or edits a destination, `<projects folder>/<repo>` by default, before anything is cloned.
A creation that led to setup continues here with its initial text once the project is added;
standalone setup only adds the project. The dashboard draft belongs to the project, so it
survives setup until a channel admits it. Channels never start on the other host. Its Channels sidebar shows the person's own channels, then one
section per teammate across all of their hosts, with that teammate's archived channels in a folded
section of their own. Saved host-and-checkout selections from earlier versions resolve to the
merged project. This is client navigation only; channel records and listings are unchanged.

A channel's details sidebar shows the root chat's changes and branch, the newest pull request from
that branch with its checks, subagents and links from the transcript, and the channel's usage.
The pull request is read through the same GitHub CLI account while the sidebar is open, again when
the branch moves and every minute, and is not cached. A channel can work on many lanes and pull
requests over time; the sidebar follows the chat's current lane.

Avatars come from GitHub logins. Each host resolves its owner's login with `gh api user`, returns
it from `hello` to peers, and publishes it to the directory. The app maps message authors'
Tailscale logins to GitHub avatars and shows initials when no login is known. People are named by
GitHub login everywhere else: a host converts its own owner's Tailscale login with that same `gh`
login before publishing presence (`lobbyChanged` in `apps/host/src/gateway.ts`), and an owner
without one is not shown as here.

## Channel

A channel owns one [pi-durable](https://github.com/earendil-works/pi) Session. A local channel runs
as one worker process over one SQLite file; a hosted channel runs in a team-deployed cell. A chat
is one pi conversation in that Session.

- **Durable state is pi's.** Messages, runs, tool calls, and child chats are pi entries, tasks,
  and conversations. A crash resumes unfinished work from its last checkpoint; tools that are not
  safe to rerun report an interruption to the model instead.
- **The model sees the whole room.** A human message that does not invoke an agent is a pi
  `write`: it enters the transcript without starting a run. Invoking an agent is a pi `input`.
- **Providers are optional until invocation.** Creating a channel or chat, posting human messages,
  and using its workspace require no model or provider credentials. A chat without a model resolves
  its runtime's default on its first invocation: the local host's current preference, or an available
  model on the hosting service. Availability is checked before admitting the input, so a rejected
  invocation queues no work and leaves its draft editable.
- **Model and effort per run.** The chat's model and reasoning effort are set when a run is
  admitted, stored in pi's agent configuration. Changing either while a run is active is rejected
  rather than changing its later turns. Admissions are serialized per chat. The composer lists
  levels from the channel's model catalog; Default leaves reasoning to always-thinking providers,
  while Off disables it where supported. Switching models resets the composer's effort to that
  model's default until a level is chosen.
- **Queued messages are pi's inbox.** Clients opt into queue events on the chat watch. The channel
  projects the built-in conversation view's inbox into complete queue snapshots on attachment and
  committed changes, including passive human writes but excluding internal writes. The app shows
  these messages above the composer until pi consumes or withdraws them; reconnect reads pi again.
  There is no additional queue store or change to admission and steering behavior.
- **Stop returns queued messages to their authors.** pi's abort withdraws every queued invoked
  message, settles it `unanswered`, and keeps none of its content, so nothing runs after Stop. The
  queue event of that change carries them as `withdrawn`, once and live, and each author's app
  puts its own back into that chat's saved draft, ahead of any unsent text, with a notice; the
  timeline says whose were returned. Another channel's agent has no composer: its message stays
  withdrawn, and the notice names that channel. An author whose app isn't watching the chat at
  Stop does not get the draft back.
- **Handoffs stop shell commands.** While another channel's agent's invoked message waits in a
  chat's inbox, that chat's shell commands stop, and new ones don't start, each with a result
  naming the sender. Pi then places the message as a steer after the tool round, so the run
  continues with it and reruns nothing. Other tools may be mid-change and are left to finish; a
  person's messages never interrupt, since they have Stop. Agents wait for another channel by
  ending their run, not by polling in the shell.
- **Questions wait in pi.** The `question` tool records its questions in a conversation document
  keyed by call and waits for an answer there, so a rerun after a restart finds the question or
  its answer instead of asking again. The app shows the pending call's card above the composer;
  an `answer` request from anyone who may invoke the agent writes the answer once, and the first
  wins. Stop and Kill abort the wait. An invoked message queued in the chat dismisses the
  question, so the run reads it instead of blocking it. Subagents' chats have no question tool.
- **Reactions and deletions keep entries.** pi entries are immutable, so a conversation document
  keyed by entry holds each message's reactions and which messages were deleted. Anyone who may
  write to the chat reacts to a person's message or an agent's reply; only a message's author
  deletes it, and an archived channel refuses both. Deleting appends an entry whose pi context
  edit replaces the message with "[deleted this message]" under its author, so later model
  requests omit the text (unless a compaction summary already holds it) while runs that read it
  keep what they learned. Watches that opt in receive `deleted` and complete `reactions`
  snapshots; every watch replays a deleted message without its text.
- **Edits keep entries too.** Only a message's author edits it, and an archived channel or a
  deleted message refuses it. Editing appends an `ace.edit` entry with the new text, whose pi
  context edit replaces the message under its author, keeping its images and files; the newest
  edit or deletion of an entry wins. Agent replies to the earlier text stay in the transcript
  and in later context, and an edit never reruns the agent. Watches that opt in receive `edited`
  live; every watch replays a message with its newest text and when it was edited.
- **Attachments live in the message.** Images and files travel on `say` and `ask` and are stored
  in the human message's pi entry, so every model, channel placement, and teammate reads them
  without a second store or a workspace. Files are text: `<attachment name="...">` blocks after
  the message's own text. The app sends a PDF as its pages' text, extracted with pdf.js before
  sending, because pi's messages carry no provider document input; scanned PDFs and other binary
  files are refused. A message's images and file text share a 1.5 MB budget under the Durable
  Object row cap, and the app opens a sent file's text from its timeline block. The budget is
  bytes, not tokens: a file that alone exceeds the model's context fails the run, and later runs,
  until its message is deleted.
- **Tool progress is live only.** Watches that opt in receive `progress` events: the bounded tail
  of each running call's output from pi's live tool slots, at most every half second per watch,
  each replacing the last. Attachment rebuilds them from pi's snapshot, and the call's durable
  result, with its truncation notice and full-output path, supersedes them. Nothing else stores them.
- **Subagents are child chats.** A subagent's chat is owned by the parent's tool task, so killing
  the parent kills the child. Agents in different channels only exchange messages.
- **Lanes are Git worktrees** created by the chat's agent for each unit of work. A chat's working
  directory is its current lane. A new lane starts from origin's advertised default branch, fetched
  first, from the project's HEAD in a repository without origin, or from an explicit base, without
  changing the project checkout. Each lane records that
  base as a ref or commit, and its Diff shows what a pull request into that base would, totaled
  apart from uncommitted and untracked files. An untracked directory of more than 100 files shows
  only its file count. An explicit
  base for an existing lane changes only that comparison. The
  [lane CLI](https://lane.lukeed.com/usage/), which Ace ships, creates each new lane at
  `.lane/trees/<prefix>/<name>` with ignored files cloned by reference, records the starting base
  that `lane push` rebases onto, and owns removal through `lane prune` and `lane rm`. Lanes started
  before Ace used lane stay in the channel's directory.
- **Kill is durable.** Killing records pi's abort marks before the worker exits, so reopening the
  channel does not resume the killed work.
- **Usage comes from pi's ledger.** A chat reports cumulative model and tool usage from
  `UsageDoc`, including compaction. The app shows input, output, cache tokens, and estimated USD
  at model catalog prices. Reopening the chat reads the same totals; Ace keeps no second ledger.
- **Agent work has captions and recaps.** After an agent's assistant message or the end of its
  run, the channel captions each group of consecutive tool calls in the newest two segments of work
  after a human message, with a fast model from the chat's provider when it has one. A running
  group's caption is a present participle, refreshed when the group doubles; a finished group
  gets a final past-tense caption. Once a segment ends, a stronger model writes its recap, which
  the app shows on the folded turn. Both live in a conversation document keyed by first call, their
  spend is the `caption` tool bucket in `UsageDoc`, and watches that opt in receive `caption` and
  `recap` events. Without an available model, the app shows tool counts.
- **Names and summaries are durable metadata.** The owner can rename a channel. The root chat's
  agent names a randomly named channel and keeps a short summary as work progresses, preserving
  deliberate names unless asked to rename. Metadata lives in a pi session document and is
  projected into host listings. Watch events update open clients; the details sidebar shows the
  full summary. Lane paths and branch prefixes keep the channel's original name, and so does the
  `agent@<prefix>` author of messages its agent sends other channels. The app, the agents that
  receive them, and handoff results name that sender by its current name, `#name`, when they read
  it; stored authors never change.
- **Forks are sibling channels.** Fork channel creates a new channel in the source's project on its
  host, named `fork-of-<name>` until its agent names it. It does not copy history: a message from
  the person who forked it names the source as `#name` with its ID and carries the source's summary.
  The source's root chat lane continues as a lane of the same name from its current commit, created
  by the host before the fork's first open and recorded in pi when the fork's root chat is created;
  uncommitted work stays in the source. The source is only read. Cloud compute channels can't be
  forked yet, since their lanes are in the container. Forking from a message into a chat of the
  same channel waits for multiple chats in the UI.
- **Busy is a live listing projection.** A channel is busy while any chat, including a child chat,
  has a run in pi's `LiveDoc`. Opening takes an initial snapshot before scheduling resumes;
  committed live-document changes maintain the aggregate and `onBusy` publishes only transitions.
  Streaming transcript watches are not needed for sidebar rows. Pi remains authoritative: the
  optional catalog and listing `busy` field is rebuildable, not a second run store or history format.
- **Run ends are a listing hint for attention.** When a chat's run ends, the channel reads the
  settlement pi commits with it (answered, stopped, or failed) and the newest human input the run
  answered. Runs only agents invoked, such as subagents' chats, publish nothing. `onRun` projects
  the latest end into the catalog record and listing as `ran`, carried over the workspace socket
  for hosted channels. A run that starts waiting on a question publishes `question` the same way,
  before it ends. Losing it loses only a pending hint; pi keeps the runs.

`packages/channel` must stay runtime-neutral: no `node:*`, `bun:*`, or Workers imports. The host
injects storage, models, and the execution environment. This keeps hosted channels (a channel
inside a Durable Object, with tools served from a team machine) an adapter rather than a rewrite.

Process per channel gives isolation and instant kill, and lets thousands of channels exist as
files: a dormant channel is a closed SQLite file with no process. It is process isolation, not a
security boundary: every worker runs as the host's user and can read the others' files. Agents
have full access to that user's execution environment by design. Collaborator invocation is
controlled separately from the channel-wide native desktop tools gate. Neither switch is a shell
security sandbox: shell commands keep the macOS permissions granted to Ace, such as Screen Recording.

## Host

`apps/host` keeps channels under `$ACE_HOME/channels/<id>/` (default `~/.local/state/ace`). Each
directory holds `channel.json` and `channel.sqlite`; lanes live in the project. `channel.json`
records the tailnet (MagicDNS suffix) the channel was created on, and the host lists, opens,
serves, and publishes only channels of the tailnet it found when it started. Other tailnets'
channels and records from before tailnets were recorded stay on disk, hidden. Without a connected
tailnet, a host creates and shows local-only channels, marked with `"local"` in the existing
`tailnet` field. This scope is not a Tailscale identity: the host stays on authenticated loopback
with no peers, directory publication, or lobbies. Local-only channels are hidden when the host
starts on a tailnet, never adopted or shared automatically. Existing records are not rewritten,
and missing tailnets remain hidden. Names stay unique across the host's channels,
hidden ones included, whose lane branches share the projects. Creation and renames check and write
a name under the host-wide `names.lock`; a person's taken name is refused, and an agent's is
numbered (`name-2`). Hosted channels' renames are not checked yet. Clients start a
channel's worker on demand and talk to it over `channel.sock` with newline-delimited JSON. A worker
retires when it has no clients and no live work.

The app owns its transcript watches. A gateway or peer host relaying a watch reports its end with a
failure frame after the accepted reply, whether it was released or its worker, hosted connection,
or peer gateway closed; relays then drop it and never re-watch on their own. The app ignores the
end of a watch it released, restarts others with a fresh replay and channel info, which wakes a
killed channel's worker as reopening it would, and stops after three quick ends with an error.
A rejected watch retries only when asked, or once when an offline channel's host becomes reachable.
Deleting a channel kills its worker and keeps the worker lock, then removes the record before its
directory. Workers read the record only after taking the lock, so a watch recovering during the
delete cannot start a worker over storage being removed.

Workers clear the busy projection on startup and normal exit. Listings suppress it for archived
or dormant channels, and check the worker PID as well as the socket path. A five-second host
liveness sweep broadcasts when a crashed worker's busy projection becomes stale, without writing
back over a replacement worker's projection, connecting to channels, or waking them.
Reachable peers forward the live listing; directory-only fallback listings clear busy rather than
animating from a stale cache, even for hosted channels.

Channel data survives app replacement and upgrades. `ace backup` takes a verified SQLite snapshot
of a local channel while it runs, or a hosted or compute channel's transfer snapshot from its
service without freezing it, alongside its catalog record. `ace restore` adds a backup as a new
local channel with a new ID. Project files and lane worktrees have their own repository backup. Stored format changes require migrations; see [data](data.md).

Opening a folder adds a project to the host's `projects.json`, independently of channel creation
or model credentials. Clone from URL takes a GitHub URL, SSH remote, or `owner/name`, which
`githubRepo` in the host protocol reads for both the app's suggested folder and the host's clone,
and clones into `<projects folder>/<repo>` unless the person edits it. The projects folder is a host
setting in `settings.json`, `~/code` by default, kept unexpanded since the host expands `~`. This is a list of local folders, not channel history. Channels start only in
a Git repository with a commit, since lanes are worktrees of one. Until then the app offers to
initialize the folder in place of starting a channel: the host runs `git init` and commits the
folder's current files under a `.gitignore` it writes to exclude common secrets, dependencies, and
build output. A folder that already has a `.gitignore` is refused, so the person commits it. Existing catalog
channels also contribute their project paths. Remove project, from a project header's context menu, takes the folder
off the list and leaves its files and lanes; the host refuses while it has channels there, archived
ones included, since those would list it again. Only local owner connections can read or change
the opened-project list; teammates see the project information already present in channel listings.
Setting up a known GitHub project is a local-only operation on that list: the host validates the
`owner/name`, expands `~`, and runs `git clone` of `https://github.com/<owner>/<name>.git` with
argument arrays. Public repositories therefore need no GitHub account, and an organization's SSO
policy on the gh token cannot block them; private ones use the host's existing Git credential
helpers. A destination that already holds a complete checkout of that repository is opened instead;
any other non-empty folder is refused, and Ace never removes what a failed clone leaves behind.

A channel's project path is the checkout it works in: its agents' working directory and the base
of its lanes. That checkout may be a Git worktree, such as a lane or another tool's worktree. The
host groups every worktree under its repository's main checkout and labels it with the GitHub
remote, so the app shows one project per repository across hosts without rewriting channel
records. Opening a worktree adds its main checkout.

Model credentials come from `ACE_<NAME>`, `<NAME>`, then the OS keychain, for each name pi-ai asks
for, such as `OPENAI_API_KEY`. Agent shells inherit the process environment. Participants allowed
to invoke an agent can use its shell tools, so processes that run tools first move credential-like
variables out of the environment; only the key lookup can read them.

Local hosts can also use OpenAI\'s provider-owned ChatGPT subscription OAuth flow with `ace login
openai`. The access and refresh tokens stay in Keychain; `subscription.json` beside preferences
holds only a versioned installation ID and connected flag. The injected pi-ai credential store
holds a kernel-managed SQLite lock across the refresh and Keychain write, so workers cannot
rotate the same token concurrently. A running host saves and removes subscription credentials
through owner-only local gateway requests. Settings uses the same nonblocking Keychain reads as
API keys. A stored subscription owns OpenAI authentication until logout; a failed refresh does
not fall back to separately billed API keys.

Workers resolve Keychain credentials on each model request, so adding, replacing, or removing a
key through the app or CLI takes effect without restarting workers. Keychain access errors are
distinct from missing keys. Settings exposes provider status and environment overrides, never
stored key values; it validates new keys against the provider before saving them. Settings never
waits on a keychain prompt: it reads keychain names one at a time, so the names model availability
asks for raise at most one prompt at a time, and while a read waits it shows each key's last
finished read, marked as waiting for keychain access, and polls until the read lands. A key whose
read waited on a prompt is read again only on Refresh. Workers keep waiting for each read.

The default model for a chat's first agent run is a nonsecret preference in `settings.json` under
`~/Library/Application Support/Ace` on macOS, or `$XDG_CONFIG_HOME/ace` on Linux. The app and CLI
read the same preference; `ACE_MODEL` and an explicit per-channel model still take precedence.
Existing chats keep their chosen model. Adding credentials later makes an unconfigured channel's
agent available without recreating the channel or restarting its worker.

Host configuration is captured before credential cleanup. A worker receives the host's launch
environment, then seals credentials again before running tools. Source workers disable automatic
`.env` loading, so an unrelated working directory cannot change their credentials or configuration.

Stopping the host closes listeners and workspace links, then closes active local workers and their
tool processes without writing durable abort marks. Shutdown identifies workers through their live
Unix sockets; a stale PID file must never cause an unrelated process to be signaled or a dormant
worker to start. A receipt of suspended worker IDs lets the next host startup resume unfinished
work through pi without waiting for a client to reopen a channel.

### Logs

Every host process writes JSON lines to `$ACE_HOME/logs/<process>.jsonl`: `host` (gateway, peers,
directory, workspace links), `channel-<id>` (one per worker), and `cli`. Each process owns its file,
writes synchronously so the lines before a crash survive, and rotates at 10 MB keeping four files.
`ace logs` merges them in time order and filters by `--channel`, `--trace`, `--level`, `--since`,
and `--grep`; `--follow` tails them.

Ids tie lines together: `channel` and `chat` on everything a channel does, `trace` on each
gateway request as it passes through peer hosts and into a worker, `submission` from a request to
its outcome, and `task` and `call` on model responses and tool calls. Channels log requests, model
responses with usage and provider errors, and tool calls with durations; message text is not
logged, but tool arguments are, clipped to 2,000 characters. `debug` lines (listings, watches,
directory syncs, workspace calls) are written only with `ACE_DEBUG=1`. Hosted services log the same
records to Workers Logs on Cloudflare, or to the node's output on celld.

## Desktop

One `Ace.app` carries the desktop UI and **Ace Helper**, an independently running host executable.
The helper compiles with Bun 1.4 or newer and dispatches channel workers through the same executable.
The UI keeps Electrobun's bundled Bun version to match its native FFI callbacks. The helper resolves web
assets from its application bundle and writes its log under the channel data directory. Closing a
window or quitting the desktop leaves the helper running; reopening the UI verifies the host's
protocol, data directory, and a fresh proof of ownership before attaching. When another Ace
answers on the port, errors name it from its PID (app, version, and bundle path, or a command-line
host's command) and say what this caller can do. Only this app's own helper is ever offered a restart.

The host stores a private owner token in `host.token` with mode 0600. The native UI supplies it only
to its local webview; `ace open` supplies it in a URL fragment that the app immediately removes.
The first WebSocket handshake authenticates with this token and sets an HttpOnly, SameSite cookie
for page reloads. The loopback listener checks Host and Origin, and Settings requests are forbidden
on the tailnet listener, including requests from the owner's other machines. A health challenge
binds discovery to the owner token, listening port, and process before the desktop or CLI opens
the app. As with channels, this does not isolate Ace from tools running as the same OS user.

Local app windows report their current channel, tabs, and focus to the host while connected. The
owner can list these windows and rename one tab through the CLI. A channel worker's agent does the
same for windows showing its channel, as the owner over loopback; these tools are not native
desktop tools and do not depend on that setting. A rename targets a window, channel,
and tab ID, so switching channels before the request arrives rejects it. The host returns success
after the target window applies the change. Tab names stay in that window's layout state;
they do not rename channels, chats, or another participant's tabs. The window registry is transient,
and these operations use the authenticated loopback connection, never a tailnet peer.

On macOS, a bundled LaunchAgent runs Ace Helper as the logged-in user. A small native bridge calls
`SMAppService` to register it after first-launch consent and expose its approval status. Registration
starts the helper immediately and at subsequent logins. A disabled background item is left for the
user to enable in System Settings. The stable service identifier is `dev.ace.desktop.helper`; the
executable and desktop controls are named Ace Helper.
macOS groups the background permission under the parent app's name, Ace.

The desktop owns the native project picker and helper controls. Its webview uses a typed native
bridge, authenticates each request with the owner token, and restricts navigation to the local app
origin. Web links that open a new window go to the default browser. Settings exposes Start, Stop,
and Restart through this bridge, and its controls remain available while the host is disconnected.
Stopping unregisters login hosting until the user enables it again. An authenticated command-line
host can serve the UI, but the desktop does not manage that process as Ace Helper.

Git, shell, Tailscale, and directory diagnostics come from the host through the same local-only
boundary as provider settings. They never wait on a keychain prompt: the team secret's state is
the host's last finished read, marked as waiting for keychain access while one read is under way,
and Settings polls until that read lands. The project picker selects a local folder; project creation
errors remain in the form so the person can fix the path or provider setup.

Agents inspect and operate native windows through an injected desktop capability. The desktop embeds
[desktop-tools](https://github.com/githubnext/desktop-tools), a standalone package carrying a pinned,
patched Peekaboo bridge, its signed client, and the request/result contract, inside Ace's UI process,
which owns macOS Accessibility, Screen
Recording, and Event Synthesizing permissions. The host invokes a bundled client over a local Unix socket. The bridge
accepts only the client's exact identifier signed by Ace's team; the client verifies the host's
signing team. Tools expose application and window inventories, observation, element or screenshot
clicks, scrolling, atomic drags, replacement of editable field values, text selection/insertion, and keys or shortcuts. Screenshot
points are normalized and mapped through the snapshot's native capture geometry. Control input uses background delivery bound to a
snapshot's exact process, window, and controls; every dispatched action requires a new observation.
Read-only menu inventory uses signed native responses and application inventories before and after
the read to bind one observed process generation. Its possible native cache and unknown completeness
remain explicit; an optional exact literal title path filters the returned subtree before channel
history without granting input authority. The native traversal still reads the full menu and may
trigger application population callbacks. Native menu traversal is currently
synchronous and can delay GUI responsiveness or cancellation. Menu commands use a separate
literal-array native operation: fresh bounded AX reads select one enabled leaf, followed by one
press without opening ancestors or making a separate activation request; the app or macOS may
bring it forward in response. The signed result binds the original
application generation. Commands targeting the native Ace process itself are unsupported and
refused before input; its menu inventory remains available. Detached AX work retains the existing
process mutation lane until the
actual call returns, including after cancellation; ambiguous native timeout remains unsafe to
repeat. Command delivery is distinct from its application effect, and no automatic follow-up
observation changes that outcome.
Separate activation, quit, close, focus, minimize, restore, move, and resize tools accept generation-bound inventory targets, with exact
window bounds where applicable. The native service revalidates those receipts before dispatch;
activation and focus explicitly change the foreground desktop. Inspection never activates a target
implicitly. App-only action receipts refresh inventories without inventing a selected window.
Normal quit reports completion only after native termination confirmation; an accepted request that
leaves the app running stays uncertain. It never retries, force-quits, or chooses a dialog response.
Exact-window close selects one supported background Accessibility route before input and never
falls through after dispatch. Confirmed disappearance survives later inventory failure; an accepted
close that remains open is uncertain with unsafe retry and fresh inventory when available.
Explicit launch accepts an absolute app path or bundle ID and deliberately requests foreground
launch/readiness through the native global mutation lane. The signed response binds the selector
to the resulting process generation; later inventory failure preserves that result. Launch exposes
no document/URL, extra-instance, or relaunch options. The app may still open after caller timeout
or interruption, so uncertain launch is never replayed and native ownership lasts until it settles.
Explicit item opening reuses that signed native launch route for one existing absolute path or
complete URL, optionally selecting an app. Otherwise macOS chooses the default handler; no app
is assumed before dispatch. The signed request includes the item URL and binds the returned
process generation. Accepted delivery remains unverified item effect, including after successful
readiness and activation. Later app/window inventory cannot prove document loading or navigation,
and failures after native submission remain uncertain without retry or dialog handling.
Minimize verifies native window state and returns fresh inventory without capturing the minimized
window; restoring it remains an explicit action with a refreshed target.
Move and resize use native background Accessibility, verify resulting geometry, and return refreshed
window targets; the original bounds remain part of the pre-mutation identity check.
Literal insertion uses one GUI-owned temporary plain-text paste, with the existing native mutation
lane and clipboard transaction gate held through delivery and cleanup. The GUI preserves bounded
prior clipboard contents privately and restores them only when no paste key was sent or the expected
edit was observed in the same control. Uncertain consumption leaves the replacement or preserves newer contents; no
restore journal or automatic retry is created. Clipboard read policy is reported in Settings → Computer use.
The same clipboard gate retains a content-free reservation while a dispatched paste is unresolved.
Later automated writes require observed consumption or termination of the exact receiver process
generation. The reservation survives GUI restart; clipboard contents and comparison state do not.
Explicit clipboard tools read complete bounded plain text, an image preview, or advertised local
file references, or persistently replace text, an image, or file references; they do not paste. Reads use the existing silent permission policy and require
a stable generation, without entering or releasing the mutation gate. The GUI copies one bounded
image representation, renders an oriented preview off its main actor, and verifies the generation
again. Source and preview metadata stay distinct; the bounded preview uses the existing image
result and durable history without clipboard files or a second store. File reads return exact
advertised URLs and decoded paths without filesystem access; macOS may filter references before
exposing them to Ace. Image writes take an execution-host path: the host alone reads a bounded
regular file, and the GUI decodes its immutable copy before publishing the original representation.
Only source metadata is returned. File-reference writes check path metadata on the host without
reading contents or resolving links. The GUI prepares one file URL item per literal path, preserving
order and duplicates, then publishes the complete bounded list with generation checks. Result metadata
describes requested references and native publication, not a receiving application's eventual copy.
Writes enter the same gate,
including pending-paste admission, and expose content-free native outcomes without window inspection.
Explicitly read content enters ordinary tool history as observed data; no permission layer is added.
Pi records their intent and never automatically replays an interrupted action. Results distinguish
completed operations, refusals before dispatch, and uncertain delivery. The host bounds
accessibility text and resizes screenshots before returning them. Explicit pixel inspection preserves
exact-target capture checks and publishes a screenshot-only snapshot whose stored capture authorizes
only coordinate input in that exact window; failed observations retain their
error and report later target availability when it can be read. Quitting Ace stops desktop tools;
Ace Helper can keep channels running. Hosted channels forward the capability to their workspace.
Pi stores the result; channel clients project its images into the existing tool output. Peekaboo
coordinates concurrent native operations. An independent owner-controlled channel setting gates
native desktop tool dispatch for every chat, including the owner's agents and subagents. See
[native desktop tools](desktop-tools.md) for setup, supported actions, and interruption behavior.

Agents list, navigate, and inspect web pages through an injected browser capability. The host talks
to a dedicated development browser directly over the Chrome DevTools Protocol on loopback. It finds
the browser only through `DevToolsActivePort` in the profile at `$ACE_HOME/browser`, so personal
browsers and other debugging sessions are never reached; Ace does not launch or own that browser.
A tab target is the browser ID from Chrome's endpoint path plus Chrome's target ID. Every call
reconnects and refuses a replaced browser or closed tab instead of choosing another tab by URL,
title, or position. Inspection returns the main document's bounded accessibility tree and a viewport
JPEG with loader IDs before and after, keeping partial evidence when one part fails. Navigation is
unsafe and sequential: it reports Chrome's answer (started, same document, download, or failed)
without claiming readiness, and a navigation whose dispatch or answer is uncertain stays unknown. Hosted channels forward the
capability to their workspace, and pi stores the result like any other tool output. See
[browser tools](browser-tools.md) for setup, limits, and outcomes.

The installed development app uses `dev.ace.desktop.dev`, port 4141, and `~/.local/state/ace-dev`,
keeping it separate from stable and Canary. Its preferences live under `Ace-dev`, and its Keychain
service is `ace-dev`. It is signed locally for `SMAppService`; distribution signing and
notarization are handled by the release pipeline. All development builds share that fixed app
identity and local signing identity, so macOS grants one Ace-dev permission entry. A separate
profile in the signed bundle derives each checkout's port, data, preferences, Keychain service,
native client identifier, and persistent WebKit partition from the checkout path, and only
uses the host that `bun run dev` starts from the same checkout. It never registers Ace Helper.
Source dev builds can run alongside Canary, but must not coexist with a registered installed
Ace-dev helper: macOS can resolve that shared service identity from another dev bundle. The dev runner opens the exact app
through LaunchServices so macOS attributes permission checks to Ace-dev rather than its parent
terminal or coding app, and tracks that instance for shutdown. `ACE_CONFIG_HOME` and
`ACE_KEYCHAIN_SERVICE` can target an isolated profile for other smoke checks. Sparkle checks for updates while Ace is open;
installation explicitly pauses and unregisters the helper before replacing the application. The
relaunched app restores hosting and resumes interrupted workers. See [updates](updates.md) for
the handoff, signed feeds, hosting, and release credentials.

## Hosted channels

Teams deploy `services/channel` to run the same `packages/channel` core in a Durable Object,
one per channel. Hosted describes channel placement, not an Ace-operated service. Ace no longer
creates hosted channels with a host as their workspace (`ace new --hosted` and Move to hosted are
gone); cloud workspaces still run on this service, and earlier hosted channels keep running and
move back with `ace move <channel> --local`.
The object provides what the host's worker provides locally (single ownership of the store,
isolation, and routing by channel ID) and adds hibernation and placement off any one machine.
pi's portable SQLite core runs on the object's own SQL through `storage.ts`.

A Durable Object has no file system or shell, so a hosted channel's tools run on a **workspace**:
the host that created it. That host dials out to the object and serves each chat's file and shell
calls from its lanes, using the same execution environment as a local worker
(`packages/channel/src/workspace.ts`). The project checkout stays the source of truth. While the
workspace is disconnected, the channel stays reachable for chat, tools report the workspace as
offline, and a call in flight when it drops is reported to the model as failed.

- The workspace socket hibernates, so an idle hosted channel costs nothing while its host stays
  connected. Client sockets carry live pi event streams and keep the object awake.
- While any chat is busy, a pending timer keeps the object resident: hibernating would drop
  in-flight workspace calls whose processes keep running on the workspace. Idle objects hibernate.
  An alarm still re-wakes an object the runtime resets during a run, so it resumes the run.
- Hosts authenticate with the team's secret scoped to the service's tailnet (see
  [The team](#the-team)) and state each message's author. They verify their own users over the
  tailnet, so the service trusts hosts, not individual people.
- Model keys are Worker secrets.
- Busy transitions share the metadata/activity projection path over the workspace socket. Every
  workspace reconnect gets a current busy snapshot, including when the object was already open.
  The workspace host clears busy on disconnect and accepts it only while that link is connected;
  this listing hint is intentionally suppressed when the workspace is unavailable, even if the
  hosted channel can still run model-only work. It adds no client transcript subscriptions or
  keepalive timers to dormant hosted objects.

### Cloud compute (beta)

With Settings → Beta → Cloud compute on and a service URL saved, or no saved choice and a team
directory that names the service as `COMPUTE` when it is deployed, a new channel in a GitHub project
can **Run in cloud** on the team's [compute service](../services/compute/README.md). The host calls
`init` with the project's GitHub repository, its owner as the channel owner, and the project's Git
`user.name` and `user.email` as the author; it then saves the record with `hosted` set to the
service and `compute`. The app calls `start` through the host, which waits for `runner.connected`
in `status`, and invokes the agent only after that. Starting again is the retry after a failure.
The record and listing carry `stopped` from creation until a start succeeds and again after a
stop, so the channel's row and tab show it stopped and its menu offers only Start compute or Stop
compute (`stop`, which checkpoints first). Only this host's start and stop change it: a container
the service stops for inactivity still lists as running, and records from before `stopped` list
as running until their next start or stop. A start reads `status` first and says it is resuming
when the service has a checkpoint to restore; only a workspace without one clones the repository.
The service freezes the hosted channel for a whole start or stop and refuses its connections, so
the host's listing reports `computing` while one runs; the app opens the chat and reads its models
only after it ends, and offers neither compute action until then. Deleting the channel calls the
service's `DELETE /workspaces/:id`, which removes the container, checkpoint, and hosted channel; if
the service refuses, the host keeps the record so deleting can be retried.
The service's settings live in `settings.json` beside the default model; its secrets are the team's
`ACE_SECRET` and `TAILNET`. The runner receives the derived credential, never `ACE_SECRET`.

The container serves the workspace, so the host opens no workspace link for a `compute` record,
refuses to move it out, and opens no terminal for it. Busy and rename projections arrive only over the
workspace link, so for the beta the listing shows a cloud channel idle and keeps its created name
until the channel's own metadata is read.

### Moving channels

The owner moves an idle channel between its host and a hosting service with `ace move` or the
channel's Move to menu, which asks for confirmation first. The menu offers the hosting service the
team's directory names as `HOSTED` when it is deployed, plus services this host already uses; a
busy channel offers none. The channel keeps its ID, lanes, and workspace; only where pi runs changes.
The pi store travels as one snapshot (`@ace/channel/transfer`): an allowlist of pi's tables at the
current schema, at most 32 MiB, with a SHA-256 digest that import verifies before it commits.
Export refuses unfinished tasks or queued submissions, so a move never carries an active run.

The host reads `ACE_SECRET` before anything else, since a keychain prompt can hold that read for
as long as nobody answers it. Until then the channel stays usable; after a second the app's move
notice says Ace Helper is waiting for keychain access, and after two minutes the move fails. The
host then fences the channel's record with `moving`: no worker starts and no client connects
through this host. A hosted channel keeps its workspace link until the service freezes it, so a run
admitted before the freeze is refused rather than interrupted. A running worker stops admitting requests, lets admitted ones finish, and
exits only if the channel is idle. The service's `POST /channels/:id/transfer` takes `import`
(stored inactive), `activate` (only for the imported digest), `freeze`, `export` (only while frozen),
and `thaw`. Inactive and frozen objects persist that state and answer every other request with 409.

Moving out exports the parked local store, imports it, then activates it; the local file stays in
place. Moving back freezes the hosted object, exports it, and verifies it into a new local file that
atomically replaces the parked one; the frozen object remains. A later move out re-imports into it.
A failed step before activation lifts the fence. An unanswered activation keeps it, and repeating
the same move retries activation. Watches on the old placement end and clients reattach.

When Cloud compute is available for the project, a local channel's menu, or a hosted channel's
whose workspace is this host, also offers Move to cloud workspace (`ace move <channel> --compute`).
Its workspace starts from a fresh clone, so lanes travel only as pushed branches. When any lane has
uncommitted or unpushed work, the host first asks the channel's agent, in its first chat as the
owner, to commit each one and `lane push` it, without opening a pull request or removing lanes. The
move's progress waits for that run while the chat stays open, then the host checks the lanes again.
A stopped run or a lane still unready ends the move with the channel where it was, naming the lanes
left. A lane with no branch has nothing to push, so the move refuses it for the person to remove,
and a busy channel is refused before any of this. Only then does the host fence the channel, and
the listing reports `computing` from the fence until the workspace starts. The host imports the
snapshot through the compute service's `import`, which stores the channel inactive with this host's
project path and the lanes' branches, activates it, saves the record as a stopped `compute`
channel, and starts it. A local channel's
snapshot comes from its parked store. A hosted channel's comes straight from its service, frozen and
exported as in a move back, never through local storage; a failure before activation thaws it, and
after activation the frozen object remains. The runner links that project path to its clone and
checks each lane's branch out at its old path, so the channel's records keep naming real paths. A
start failure after activation leaves the channel moved and stopped, for Start compute to retry.

## Shared services

Shared state that must outlive any one machine lives in cells: Durable Objects deployed to
the team's Cloudflare account, or celld on a team machine. The team deploys and operates these
services. Each service is named for its job.

The directory holds the team's hosts and where each channel lives. One host can serve it on its
tailnet listener at `/directory` (`directory-server.ts`, on `bun:sqlite`), with the same API and
lobbies as `services/directory`. Tailscale names each caller there, so it needs no team secret: a
host publishes only under its own machine name and owner, and shares only as its owner. Each
host's hello names its directory, and a host that never joined or left one joins a peer's when
it answers without a secret, so a team on a host-served directory needs no invite. A deployed
directory still needs `ACE_SECRET` and a join from Settings.

`services/directory` is the deployed directory. Every host publishes its
whole channel set on each change and every 30 seconds, then reads everyone's; project lobbies
below make that poll slower once they push changes. It answers lookups
only: channel traffic goes to the channel's host over the tailnet, or to the hosted channel. So a
channel stays listed while its host is asleep. The app shows a local channel whose host is
unreachable as offline, and reaches a hosted channel directly. Hosts find the directory through
Settings or `ace directory <url>` and authenticate with the team's `ACE_SECRET`, scoped to the
directory's tailnet. A running host
checks a new URL and secret against the directory before saving them, and it saves Keychain items
for the CLI too: macOS lets the program that saved an item read it without asking, so a secret
saved by another program would make Ace Helper wait on a Keychain prompt.

The same Worker runs one lobby per project: a `Lobby` Durable Object named by the project ID
the app selects projects by (`@ace/host/protocol` `projectId`), at `GET /lobbies/<project>`
behind the same `ACE_SECRET`. Lobbies require this deployed cell; a team without it has no
project presence. Hosts are the only lobby clients and keep one WebSocket per project; the wire
types live in `@ace/directory/protocol`. The `Directory` object and its contract are unchanged.

- **Presence is never stored.** Each host replaces its owner's presence in the project (GitHub
  login, the project's channels open in their windows, and whether all of them are unfocused) and
  the lobby keeps it in the socket's hibernation attachment, sending everyone the whole list on
  each change. The attachment holds 2 KiB, so the lobby drops open channels beyond what fits.
  Hosts ping every 30 seconds; the lobby answers without waking and an alarm every 5 minutes
  closes sockets silent for 90 seconds, so a host that slept without closing TCP stops being here
  within about 6.5 minutes. Re-arming that alarm is the lobby's only steady write: 288 billed row
  writes a day while any host is connected, and none for pings or presence. A host process's
  reconnect replaces its own stale socket; two processes on one machine each keep theirs.
- **Lifecycle events are a resume buffer.** Hosts send channel lifecycle events and the lobby
  numbers them with one `seq` per project. A host reconnects with the newest `seq` it applied and
  receives the events after it; when those are gone (pruned, older than the lobby's storage, or a
  first visit) it is told to read listings again. Events are pruned 30 days after the lobby
  received them, by its own clock, and beyond the newest 2,000. Listings and catalogs stay
  authoritative; losing the log loses only promptness.
- **Hosts subscribe to every project their owner's app lists**: opened projects and every
  listed channel's project. A host derives its owner's presence from the window registry (each
  window's channel and whether it is focused and visible) and relays everyone's presence to its own
  app's sockets only, never to peers. The sidebar shows who is here in each channel, and the
  project header shows who is here in the project, each person once and marked away only when
  every one of their hosts says so. The viewer is left out. A host reports its owner away only
  after 3 seconds without a focused window, so switching between Ace windows never reaches the
  lobby.
- **Lifecycle pushes replace the poll.** After each successful publish to the directory, a host
  compares its channels with its previous publication in this process and sends each change
  (created, renamed, summarized, archived, resumed, moved, deleted, or a run's end, with the new
  listing) to that project's lobby. It keeps the latest per channel until the lobby echoes it
  back, resending after a reconnect, since a socket can die unnoticed. A lobby the host no longer
  needs stays until the next publication, so a project's last deletion still reaches it. Hosts
  apply teammates' events to their directory listings at once and rebuild listings once per
  burst; a directory read already in flight reapplies them, and a `resync` reads the directory
  again. While every project a host subscribes to has a live lobby, its 30-second directory poll
  slows to every five minutes. Changes that send no event (activity alone: `active`, `busy`,
  running or idle), changes made while a host's process was down, and changes from hosts too old
  to send events reach teammates through that read or their peer connections.
- **An absent lobby is harmless.** Without a directory, `ACE_SECRET`, or a Worker deployed with
  lobbies (which answers 404), each subscription retries from 5 seconds up to every 10 minutes,
  logging only at debug level, the app shows nobody here, and the directory poll stays at 30
  seconds.
- **Schema versions** are counted in the object's `version` key, because Durable Object SQLite
  refuses `PRAGMA user_version`. Migrations run in order inside one transaction.

Notifications are not built. Each app notices its own person's
finished and failed runs, and runs waiting on a question, from listings: it keeps the run ends it has shown or announced per host
and participant in browser storage, starting from its first visit. A run end that arrives while
another channel is open pulses the window's glow; one that arrives while the window is unfocused
sends a desktop notification. The channel's row keeps a dot (finished) or attention mark (failed)
until the person opens it in a focused window. A run waiting on a question keeps its attention mark
until the host publishes that it was answered, so every browser and phone shows it, even one first
opened after the question was asked. Stopped runs need no attention.

## The team

The tailnet is the team and the sole authority for team membership. Its identities and access
rules decide which people and machines can reach each other. Ace has no separate accounts,
invitations, or roles. On a tailnet, every human author is a Tailscale login, so a person is the
same participant on every host. Without a connected tailnet, the OS account names the local owner;
local-only channels do not establish team membership.

Within the team, a project is visible only to people with access to it
([#506](https://github.com/githubnext/ace/issues/506), being built). A person has direct access
to a GitHub-backed project whose repository their GitHub login can read, and to a local folder on
their own host. A share gives the team or one person access to the whole project, including every
person's channels in it. Shares live in the directory, so every host applies them to its own
channels, and only people with direct access change them. Existing projects become private on
upgrade. The host that runs a channel names each caller with `tailscale whois` and refuses
callers without access, and each host shows its owner only the projects the owner can access.

`apps/host/src/access.ts` decides access. A host's owner always reaches its own channels, from any
of their machines. GitHub access is checked with the deciding host's `gh` account and kept for five
minutes: a public repository is open to everyone, its own account reads the repository, and
anyone else needs a collaborator permission other than `none`. GitHub shows those only to
accounts that can push, so a host whose owner can only read a private repository cannot confirm
teammates' access and they need a share. A check GitHub could not answer refuses access for a
minute. The directory keeps shares in its `shares` table; `GET /` returns them and
`POST /shares` adds or removes one. Hosts check direct access before writing, then tell every
reachable peer (`shares-changed`) to read the directory again, since a lobby can't reach someone
who just got access. After each directory read, a host whose shares changed resends each peer
the channels its person can access and ends their watches on channels they no longer can. Each
peer's listing is filtered for its person, and is resent when a peer's GitHub login arrives late.
The owner's host also filters everything else it shows its app, since the directory, lobby
events, and hosts from before project access carry every channel: peers' and the directory's
listings, lobby subscriptions and their presence, and hosted or relayed channels it would open.
A project the owner loses access to leaves the sidebar and project picker on the next listing.

People with direct access share from **Share project…** in the project's channel header menus, or
with `ace project share|unshare <project> team|<github login>`; `ace project access <project>`
lists who can see it and why. Granting asks first and names whose channels the share exposes.

**Known limitation: project access is cooperative.** It holds between hosts running unmodified
Ace, not against a teammate who tampers with theirs. The team services accept one credential
derived from `ACE_SECRET`, which every host holds, so anyone with that secret can read every
listing (names, summaries, absolute paths), join any lobby, watch and post in any hosted channel,
and read and rewrite shares. Hosts report their owner's GitHub login from their own `gh` CLI
unverified, so GitHub read access trusts that claim; shares name Tailscale logins, which `whois`
verifies. Hosts from before project access serve their channels to every peer. Per-person
credentials verified by the services would close this
([#511](https://github.com/githubnext/ace/issues/511)).

The channel owner can turn collaborator agent invocation on or off with `ace agents <channel> on|off`
or the channel header's agent-access toggle. (The channel protocol's op is still `share`.) New channels start unshared; channels created before
that keep their stored setting, and those without one stay shared. Turning sharing on states that
teammates can run commands as the owner on this host. Turning it off prevents new collaborator
invocations; active work continues until stopped or killed, and teammates with access to the
project keep reading and posting human messages. The teammate composer holds an invoking draft instead of sending it while sharing
is off. An agent's invoked message from another channel on the same host is not a collaborator
invocation: that agent already runs as the owner's user, so it starts the target chat's agent with
sharing off. Gateways rewrite every client's author, so only a local worker can send an agent author.

A separate owner-controlled desktop-tools toggle gates native desktop tool dispatch for the entire
channel: owner and collaborator runs, all chats, and subagents. New channels start with it off;
existing channels keep their stored setting, and those without one stay enabled. A refused call
tells the agent to ask the owner to turn it on from the channel header or with
`ace desktop <channel> on`. Disabling it refuses subsequent native desktop calls, even within active runs;
it does not cancel or undo calls already dispatched. Agent invocation and non-desktop tools remain
available according to the sharing setting. This is a native tools gate, not a shell security
sandbox: agents still run as the host's user and shell commands can access that user's environment,
including the macOS permissions granted to Ace, so `screencapture` still works with the toggle off.
There are no per-participant desktop grants or per-call approval policies.

Both settings live in pi's `ace.settings` session document. Watch metadata events carry their
current values on every watch and committed change; name/summary revisions do not version these
settings. Clients send owner-only `{ op: "desktop", author, enabled: boolean }` to change the desktop
gate; `info` and metadata watch events expose it as `desktop: boolean`. Older hosts omit it and
continue their existing desktop behavior; the header shows an unknown, disabled control until a
host reports the setting.

Local owner tokens and browser-origin checks authenticate local connections. Team-deployed
services authenticate hosts and trust the participant identities those hosts supply. These
mechanisms carry the team's existing trust and do not define another way for a participant to
join the team.

Each deployment of the services serves one tailnet, set as the `TAILNET` Worker secret (its
MagicDNS suffix, such as `tail1234ab.ts.net`) when the services are deployed. Hosts present
HMAC-SHA256(`ACE_SECRET`, tailnet) using the suffix `tailscale status` reports
(`@ace/directory/credential`), so a host on another tailnet is refused even with the right
secret, and the 401 names the service's tailnet. A deployment missing either secret refuses
everything. Moving a team to another tailnet means deploying new services; there is no migration
yet.

**Known limitation: the tailnet scope is not a security boundary.** The services are public
Worker URLs and never see the tailnet. The MagicDNS suffix is public (certificate transparency
logs list it), so anyone holding `ACE_SECRET` can derive the credential and call the services
from anywhere. `ACE_SECRET` remains the only secret; protect and rotate it as a credential with
that reach. Ace keeps this for easy setup. A fork that needs the services reachable only from its
tailnet can route them through a Tailscale app connector and allowlist its egress IPs in a
Cloudflare WAF rule on a custom domain, or have hosts present tailnet-issued tokens from tsidp
and verify them in the Workers.

Each host's gateway serves its owner's app over loopback. Its tailnet listeners name each caller
with `tailscale whois` and accept peer hosts or the owner's browser from an allowed origin: the
host's own pages and the team's web app. The web app is the host's `ace web` setting, or else the
`APP` the team's directory names when it is deployed, so joining the directory is the only setup.
Teammates use their own host to reach shared channels. Local-only settings remain on loopback.
Keep the gateway on loopback or the tailnet; never expose it to the public internet through
Tailscale Funnel, port forwarding, or a public reverse proxy.
`ace serve --loopback`, which `bun desktop dev` uses, has no tailnet listeners, peers, or directory
entry, since another host on the same machine would publish under its tailnet name.
Hosts find online, untagged peers through `tailscale status`. A host shows its app the peer channels
its owner can access and proxies their requests; the peer that runs a channel stamps every author. Only a
channel's host creates it; only the host's owner, from any of their machines, archives, deletes,
or kills.

## Not yet built

Terminals and previews, attachments, lobby notifications, and external harnesses (Claude Code, Codex).
Hosted channels cannot message other channels yet. Projects without a GitHub remote are still keyed
by a host's main checkout, so a teammate's copy of the same folder shows as a separate project.
