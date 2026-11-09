# Channel data

Channel data is permanent from the first dogfood channel. Updating or replacing Ace must preserve
it. pi-durable owns the database format, messages, runs, tool results, chats, and their state.

## Locations

| Data                                         | Location                                              |
| -------------------------------------------- | ----------------------------------------------------- |
| Stable channel catalog, databases, and lanes | `~/.local/state/ace/channels/<id>/`                   |
| Canary channel catalog, databases, and lanes | `~/.local/state/ace-canary/channels/<id>/`            |
| Development channels                         | `~/.local/state/ace-dev/channels/<id>/`               |
| A checkout's development build               | `~/.local/state/ace-dev-<hash>/channels/<id>/`        |
| Opened projects                              | `<ACE_HOME>/projects.json`                            |
| Preferences on macOS                         | `~/Library/Application Support/Ace/settings.json`     |
| Team directory URL and services              | `<ACE_HOME>/directory.json`                           |
| Provider credentials and `ACE_SECRET`        | OS Keychain; never in channel metadata or preferences |

`ACE_HOME` overrides the host data directory. Canary and development preferences have the same
`-canary` and `-dev` suffixes. A source CLI uses the stable profile unless given `ACE_HOME`; target
the installed app's profile explicitly when backing it up. The command an app installs from
Settings → Ace Helper, `ace` for stable and `ace-canary` for Canary, already uses that app's profile.

Each channel directory holds `channel.json` and pi's `channel.sqlite`. Lanes are worktrees in the
project at `.lane/trees/<prefix>/<name>`, created by the lane CLI; a `lanes/` directory holds those
started before Ace used it. SQLite may have
committed data in `channel.sqlite-wal`, so copying only a live `channel.sqlite` is not a backup.
The socket, worker PID, and logs are process state, not durable channel content.

A host lists only channels whose `channel.json` names the tailnet it is on. Hidden channels stay on
disk, intact, and Ace does not back them up or delete them. A channel from another tailnet
reappears when the host starts on that tailnet; one from before Ace recorded tailnets has none and
never reappears. Without a connected tailnet, the host instead lists local-only channels, whose
existing `tailnet` field is `"local"`. These channels stay hidden on a connected tailnet and are
never published to a team. No existing records are rewritten or adopted as local-only channels.
`ace restore` adds a backup to the current tailnet, or to the local-only scope when disconnected.

## Back up a channel

Run `bun ace backup <channel> <new-directory>` from the checkout, or `ace backup` (`ace-canary backup`
for Canary) from the command the app installs. It works for local, hosted, and cloud compute
channels this host owns. The destination's parent must exist; the destination itself must be new.
Backups include archived channels and work without freezing the channel or stopping its work. Failed backups remove only their newly created
output, and the directory and files are private to the current OS user. Store backups with the
same care as the original chats and tool output.

Every backup writes:

- `channel.json`: the channel's catalog record: identity, owner, tailnet, project, optional initial model,
  a fork's starting lane,
  when its transcript last grew, and for a hosted channel its service URL.
- The channel's pi state at the snapshot point, if it has any (below).
- `backup.json`: format version, source paths, creation time, and SHA-256 checksums. This file is
  written last to mark a complete backup.

**Local channels.** The command uses SQLite's
[VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuum_with_an_into_clause) to capture a
consistent snapshot, including committed WAL entries, while a worker continues running. It opens
the source read-only, checks the output's integrity, and writes `channel.sqlite`. It needs no
provider credentials and does not start dormant workers.

**Hosted and cloud compute channels.** The host asks the hosting service for the channel's pi
state with `POST /channels/:id/transfer` `{ "action": "backup" }`, authenticated with the team's
`ACE_SECRET`, and writes the answer as `snapshot.json`. This is the same version 1 snapshot format
moves use: every pi table, with a SHA-256 digest of its canonical encoding, which `backup.json`
also records. The service reads it in one transaction on the channel's Durable Object, where all
pi reads and writes run one at a time, so the snapshot is consistent without freezing the channel;
clients stay connected and runs continue. A snapshot is limited to 32 MiB, and a larger channel is
refused with that reason. A service deployed before this action existed is reported as needing a
redeploy. Inactive copies left by an unfinished move are refused, since they are not the channel.

A backup taken during a run records the run as unfinished, as a local snapshot does.

Project files, lane worktrees (including uncommitted and untracked changes), repository Git data,
opened-project preferences, and Keychain items need their own backups. A cloud compute channel's
workspace files are in its container and are covered by its
[checkpoint](https://github.com/githubnext/ace/issues/413), not by `ace backup`. A channel snapshot
keeps the original working-directory paths; it is not a way to move lanes to another machine.

## Restore as a new channel

`ace restore <backup-directory> [--project <dir>] [--name <name>]` verifies every file against
`backup.json`, then adds the backup as a new local channel on this host, in the recorded project or
`--project`. A hosted snapshot is imported and checked against its digest; a local `channel.sqlite`
is copied. The copy has a new ID and a new lane branch prefix, so it can never run as the original
channel, which may still be live here or on its service. It takes `--name`, or the original's name
with `-1`, `-2`, … added while that name is taken. The backup itself is left unchanged, and a failed restore removes only the new
channel's directory.

The restored chats keep the original working-directory and lane paths. If the backup was taken
during a run, the copy resumes that run when it first opens, and pi reports interrupted tools that
cannot safely be rerun. Stop the original channel's work first if both would use the same lanes.

## Seeds

A seed is a channel's chats as editable JSON, for demos and fixtures rather than recovery.
`ace export <channel> <file>` writes a local channel's ownerless chats: people's messages by author
and ISO time, as they read now, and agents' replies and tool results as the pi messages their runs
committed, with reactions, captions, recaps, and each chat's model. Subagent chats, deleted
messages, run bookkeeping, and lanes stay behind.

`ace import <file> [--project <dir>] [--name <name>] [--now]` adds a seed as a new local channel in
the current directory's project or `--project`. It appends every item through pi, so the channel is
ordinary: its agents read the imported history as context, and later runs continue it. Authors are
any valid participant names, and `--now` moves every time so the newest message lands at import.
The first chat is the root chat. Agent items must be `pi.assistant` or `pi.tool-result` entries,
and tool calls and results must still pair up. A failed import removes the new channel's directory.

## Recover in place on the same machine

To return a local channel to a snapshot under its original ID:

1. Keep the backup untouched and verify its files against the SHA-256 values in `backup.json`.
2. Stop Ace Helper in Settings and stop any command-line host for this profile. Ensure the
   affected worker has exited. Quitting only the desktop window leaves the helper running.
3. Preserve the current channel directory and its lane worktrees before changing anything. Keep
   the repositories and lanes at the paths recorded by the channel.
4. In the original channel directory, move the current `channel.json`, `channel.sqlite`, and any
   `channel.sqlite-wal` or `channel.sqlite-shm` aside together. Copy the backup's catalog record
   and database into their place. A never-opened channel backup has no database. Do not restore
   sockets or worker PID files, or leave old SQLite sidecars next to the restored database.
5. Start the helper again and open the channel. An unfinished run in the snapshot can resume;
   pi reports interrupted tools that cannot safely be rerun. Do not run a second copy of the same
   snapshot against the same lane paths.

A hosted channel is not replaced in place; restore its backup as a new channel. Moving backups
across machines is not implemented.

## Upgrade contract

Keep existing channel IDs, entry kinds, document kinds, and path meanings stable. A format change
must include a versioned migration and a check using a copy of an existing channel. Preserve the
source backup until the new version has reopened its chats and resumed real model work.

pi-durable applies its SQLite schema migrations transactionally and refuses databases from a
newer schema. Ace must use those migrations rather than rewrite pi tables or replace a database.
For Ace-owned catalog or preference format changes, migrate old records explicitly before using
the new form. An unreadable or newer store must produce an actionable error, never an empty
replacement channel. Release validation must exercise existing data as well as fresh installs.

Catalog records and hosted-channel configurations use version 2. Readers migrate unversioned
(version 0) and version 1 records in memory, preserving their model, name, and all other fields.
The original name becomes an immutable lane branch prefix, and legacy names remain deliberate
names that agents preserve. Records are written as version 2 on the next save; unknown versions
are refused.

The channel's current name and rolling summary live in pi's version 1 `ace.metadata` session
document. Its first open seeds the name from the catalog without changing existing entries or
chats. Catalog names, summaries, and revision numbers are rebuildable listing projections; local
workers refresh them from committed metadata, and hosted channels send them to their workspace
on changes and reconnection. Renaming never moves an existing lane or changes its branch prefix.

Lanes live in pi's version 2 `ace.lanes` session document: each lane's chat, worktree path, and
base. A base is a full ref name, such as `refs/remotes/origin/main`, `refs/heads/release`, or
`refs/tags/v1`, or a commit when the requested base was an expression or a detached HEAD. A new
lane's starting base is also lane's own `lane.<branch>.base` Git setting, which `lane push` uses;
a later base change moves only the Diff. pi
migrates version 1 documents on read, keeping every lane's chat and path; the version 2 form is
written on the next lane change. Version 1 lanes have no base, so their Diff compares against the
locally known `origin/HEAD`, or the project's HEAD in a repository without origin, until a lane
switch names a base.

Channel access settings live in pi's version 2 `ace.settings` session document. `shared` controls
new collaborator agent invocations; `desktop` independently gates native desktop tools for every
chat and participant in the channel. New channels store the document at creation with `shared:
false`; an existing channel's missing document still means both are enabled. pi migrates
version 1 documents on read, preserving `shared` (including `false`) and adding `desktop: true`
for compatibility. The version 2 form is written on the next settings change. Neither migration
nor changing a setting rewrites chats, entries, or name/summary revisions; these gates are not a
shell security sandbox.

Message reactions and deletions live in pi's version 1 `ace.messages` conversation document:
each entry's reactions as `{ from, emoji }` in the order added, and the deleted entries. A deletion
also appends an `ace.deletion` entry whose context edit replaces the message for later model
requests; the original entry stays in the database and in backups. Both kinds are new, so existing
channels need no migration and read as having no reactions or deletions.

Message edits are `ace.edit` entries holding the author, the edited entry, the new text, and the
edit time, with a context edit that replaces the message for later model requests. They add no
document and do not change `ace.messages`, so existing channels need no migration and read as
having no edits. Replay folds each message's newest edit into it.

The October 3, 2026 credential-deferral check opened a backed-up version 0 channel with no keys:
its pi entries and selected model were unchanged. Fresh channels accepted human messages before
provider setup and retained their history through a worker restart. Adding a real Anthropic key
enabled the same worker to answer using the earlier human messages; removing it blocked only agent
invocation. The local Workers runtime also accepted new model-free hosted configurations and legacy
configurations with their original model.

The October 4, 2026 metadata check reopened isolated version 0 and version 1 copies of an existing
channel backup. All original pi entries remained byte-for-byte equivalent, both copies continued
with a real model, and renamed channels and rolling summaries survived worker restarts. The source
backup's checksums remained unchanged. Fresh-channel checks also confirmed that renaming leaves
existing lane branches intact and new lanes use the original branch prefix.

The October 6, 2026 lanes check opened an isolated copy of an archived Canary channel backup with
version 1 `ace.lanes` data. All three chats and their lanes resolved, and every original pi entry
stayed byte-for-byte equivalent. A lane switch stored version 2 without a base, and after a worker
restart the channel continued with a real model. The source backup's checksums remained unchanged.

The October 6, 2026 desktop-gate check reopened two isolated backups: an archived Canary channel
without settings, and a real-model channel whose version 1 sharing setting was turned off using
the old worker. They reopened with desktop tools enabled and their sharing choices preserved.
Changing desktop access persisted version 2 and survived a worker restart. Real Anthropic runs
confirmed desktop refusals in the owner's chat, a subagent, and an active collaborator run in a
second chat; re-enabling allowed a real native application inventory while sharing remained off.
All 175 original entries across both backups stayed byte-for-byte equivalent, both databases
passed integrity checks, and the source backup checksums stayed unchanged.

The October 14, 2026 unshared-default check created two channels with the previous build in an
isolated `ACE_HOME`: one never changed (no stored settings) and one turned unshared. With the new
build they reopened shared and unshared respectively, and the unshared channel's documents and
revisions matched its backup. Turning desktop tools off on the channel without stored settings
kept it shared across a worker restart. A new channel stored `shared: false` at creation, refused a
teammate's agent invocation, and kept the setting across a restart.

The October 15, 2026 hosted backup check ran local `wrangler dev` copies of `services/channel` and
`services/compute` (containers off) with a loopback source host. A hosted channel with this host's
workspace and a compute channel each held messages and real `openai/gpt-5-mini` runs, the hosted
one including a `bash` tool result. `ace backup` saved both while they were active; a third backup
taken mid-run kept the run's tasks as `waiting` and `running` while the live run finished and a
message posted during it was admitted. `ace restore` imported each as a new local channel whose
pi tables hashed to the backup digests. The restored copies replayed the same history and answered
from it with a real model, and the mid-run copy reported the interrupted tool and reran it. The live
channels kept answering afterwards, and a thaw request found both active, not frozen. With the
previous service build, `ace backup` reported that the service needs a redeploy and left no output.

The October 16, 2026 message-actions check backed up a channel created by the previous build in
an isolated `ACE_HOME` and restored it with the new build. Reacting, removing reactions, and
deleting a message through the gateway, the app, and a worker socket added only new entries and
documents: the original pi entries stayed byte-for-byte equivalent, the database passed an
integrity check, and the source backup's checksums remained unchanged. A pi harness over a copy
derived the deleted message as its author's "[deleted this message]" placeholder.

The October 16, 2026 message-edit check created a channel with the previous build in an isolated
`ACE_HOME`, gave it a human message and a real `openai/gpt-5-mini` run, backed it up, and restored
it with the new build. Editing that message twice through a worker socket, and another through the
gateway, added only `ace.edit` entries: the original entries stayed byte-for-byte equivalent, the
database passed an integrity check, and the source backup's checksums remained unchanged. Later
real runs answered from the newest edits while the earlier reply stayed, and deleting the edited
message replaced it in context with the deletion placeholder.
