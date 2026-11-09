# Terms

These definitions are binding for code, docs, issues, and conversation. When someone uses a term
differently, correct the usage or change this file first.

## Places

**Team**:
The people and machines on one tailnet. The tailnet is the sole authority for team membership:
Ace has no separate accounts or invitations. Being on the team does not give access to every
project; see Access.
_Avoid_: org, workspace

**Host**:
One machine running Ace's host process. It owns and runs its channels.
_Avoid_: server, node, VM

**Hosted channel**:
A channel that lives in a cell deployed by the team instead of on a host. Its tools run on its
workspace. Hosted describes where the channel runs; Ace does not operate a hosting service.
Ace no longer moves channels to a channel service; a cloud workspace's channel is the one hosted
channel it creates, and earlier hosted channels keep running and can move back to a host.

**Workspace**:
The execution environment that runs a hosted channel's tools, from lanes on its filesystem.
Today this is a host; the hosted-compute pilot also runs one in a team-deployed Linux container.
It connects out to the channel. While it is offline, the channel's tools wait for it; chat and
model-only runs continue. Stop compute checkpoints a cloud workspace and removes its container; the
workspace is then stopped until Start compute resumes it from that checkpoint. This is not Stop,
which aborts a run.
Not a project or a checkout.

**Project**:
A named set of one or more repositories or local folders that a team works on. Many hosts can
hold checkouts of the same project. Today a project is a single repository or folder; channels
start in it once it is a Git repository with a commit.
_Avoid_: repo (when you mean the project), workspace

**Access**:
Being able to see a project and its channels and to read and post in them. A person has direct
access to a project backed by a GitHub repository their GitHub login can read, and to a local
folder on their own host; anyone else needs a share. Access has one level; who may invoke a
channel's agent is the channel's agent access setting.
_Avoid_: permission, role

**Share**:
A grant of access to a whole project, to the team or to one person, covering every person's
channels in it, now and later. Only people with direct access share or unshare a project, and
access from a share cannot be passed on. Forking a channel into another project keeps work out
of a share.
_Avoid_: invite; share (for a channel's agent access)

**Agent access**:
A channel owner's setting for whether teammates with access may invoke the channel's agent, set
from the channel header or with `ace agents <channel> on|off`.
_Avoid_: sharing a channel

**Directory**:
The team's shared list of its projects, hosts, and where each channel lives, served by one host
on the tailnet or deployed as a cell. It holds no channel content. A team works without one;
it adds offline listings, shares, and presence.
_Avoid_: relay, hub

**Lobby**:
A project's shared cell for presence, notifications, and channel lifecycle. A lobby is not a
channel.
_Avoid_: lobby channel, lobby session

**Cell**:
A named Durable Object (isolated code with private SQLite) run by Cloudflare or celld. Cells hold
shared objects such as the directory and lobbies, and hosted channels. A deployment of cells
serves one tailnet, fixed when it is deployed; another tailnet needs new cells.

## Channels

**Channel**:
The durable unit shown in the sidebar, backed by one pi Session and containing one or more chats.
A local channel runs as one worker process on its host; a hosted channel runs in a team-deployed
cell. A channel created on a tailnet belongs to that tailnet. Without a connected tailnet, a host
creates local-only channels, accessible only on that machine. A host shows its current tailnet's
channels, or its local-only channels when no tailnet is connected; it never shares local-only
channels with a team. The UI calls it a channel.
_Avoid_: session, room, thread

**Chat**:
One conversation inside a channel, with its own transcript. Most channels have one chat. A chat
can be the child of another chat in the same channel; killing a parent kills its children.
_Avoid_: session, thread, conversation (except for pi's conversation record)

**Tab**:
A view inside a channel: Chat, Diff, or Terminal. A new tab starts blank until one is chosen. A
Chat tab shows one chat; other tabs are views, not durable units. File
([#22](https://github.com/githubnext/ace/issues/22)) and Browser Preview
([#16](https://github.com/githubnext/ace/issues/16)) tabs are planned.

**Lane**:
An isolated Git worktree for one unit of work, such as "implement auth". A chat may start or
switch to another lane for a new piece of work, and another chat may continue an existing lane.
At most one chat writes to a lane at a time. Lanes are the lane CLI's lanes: `lane new` creates
them and `lane push` lands them.
_Avoid_: task (pi's term for a durable state machine), workspace, branch (a lane has one)

**Participant**:
A human or an agent in a channel.

**Person**:
A human on the team. Ace shows and names people by GitHub login; the tailnet still authenticates
them by Tailscale login, and messages record that login as their author. Each host converts its
own owner's Tailscale login to a GitHub login, the same way for avatars and presence.
_Avoid_: user (outside code), account

**Message**:
What participants see in a chat. Messages are stored as pi entries.

**Entry**:
pi's immutable transcript record. Use it only when discussing storage or model context.

## Agents

**Agent**:
A model-driven participant in a chat: a model, instructions, and tools, run by a harness.
_Avoid_: bot, Codex/Ace (as a generic name)

**Model**:
A specific provider model, such as `claude-opus-5-5` or `gpt-6-astra`. A chat may use a different
model for each run.
_Avoid_: agent, provider

**Harness**:
The code that runs an agent's loop. The native harness is pi-durable; Claude Code and Codex are
external harnesses.
_Avoid_: runtime, provider

**Turn**:
One model response and the tool calls it makes.

**Run**:
Everything from one input to its final answer: one or more turns. "Use Opus for this message"
selects the model for a run.
_Avoid_: turn (when you mean a run)

**Subagent**:
An agent working in a child chat of the same channel. Agents in different channels coordinate
only by messaging each other, never by owning each other's work.
_Avoid_: child channel, delegation

## States and actions

**Stop**:
Abort the current run. The chat stays usable.

**Kill**:
Stop all work in a chat or channel now, including child chats and processes. Nothing is
deleted.

**Archive**:
Put a channel away. An archived channel keeps its history and can be resumed.

**Delete**:
Remove a channel permanently.

**Delete a message**:
Replace your own message with "Message deleted" for everyone and for agents' later runs. Runs that
already read it keep what they learned, and the channel's data keeps the original.

**Edit a message**:
Change your own message's text for everyone and for agents' later runs. It shows as edited, and
replies that answered the earlier text stay. The channel's data keeps the original.

**Reaction**:
An emoji anyone in the channel adds to a person's message or an agent's reply.

**Dormant**:
A channel whose worker is not running while its host is reachable. Opening it wakes it.
_Avoid_: idle, asleep, offline

**Offline**:
A host, and therefore its channels, that cannot be reached.

## Presence

**Here**:
A person with a channel open in an Ace window right now: here in a chat while that chat is open,
here in a channel while any of its views is, and here in a project while any of its channels is.
It ends when the window closes or moves to another channel, or their host leaves the project's
lobby. Here is never stored.
_Avoid_: online (when you mean here), viewing, joined

**Away**:
Here, but without a focused Ace window on any of the project's channels.
_Avoid_: idle (a dormant channel's avoided term), offline

**Lifecycle event**:
A lobby's ordered record that a channel was created, renamed, summarized, archived, resumed,
moved, or deleted, or that its run ended. Hosts emit them after publishing to the directory; they
speed up listings but never replace them, since catalogs and listings stay authoritative.
_Avoid_: channel event (a channel's own watch events)
