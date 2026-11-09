#!/usr/bin/env bun
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import type { ChannelInfo, ChatId, Event, Request } from "@ace/channel/protocol";

import { appUrl, token } from "./auth";
import { backup, restore } from "./backup";
import { exportSeed, importSeed } from "./seed";
import * as catalog from "./catalog";
import { Connection, request } from "./client";
import { config } from "./config";
import * as directory from "./directory";
import * as web from "./web";
import { serve } from "./gateway";
import type { GatewayClient, Watch } from "./gateway-client";
import { connectSubscription, forget, models as providers, store } from "./keys";
import { login } from "./login";
import { dir as logDir, failure, log, open as openLog } from "./log";
import { health, HostConflict } from "./health";
import { type Filter, follow, print } from "./logs";
import * as loopback from "./loopback";
import { preference } from "./preferences";
import * as projects from "./projects";
import {
	channelProject,
	type Diagnostics,
	githubRepo,
	type Hello,
	type HostRequest,
	type Listing,
	type Member,
	type Person,
	type Project,
	type ProjectAccess,
	projectId,
	TEAM,
	type TerminalShell,
	type WindowInfo,
} from "./protocol";
import { checkModel, setModel } from "./settings";
import {
	archive,
	defaultModel,
	fork,
	isRunning,
	kill,
	models,
	parseModel,
	project,
	remove,
} from "./manage";
import { move } from "./move";

const USAGE = `ace — channels on this host

  ace new [--project <dir>] [--name <name>] [--model <provider/id>]
  ace ls [--all] [--team]                        --team adds reachable teammates' channels
  ace info <channel>
  ace rename <channel> <name>                   rename without changing its lanes
  ace fork <channel>                             start a sibling channel from its summary and lane
  ace tabs [--port <port>] [--json]              list open windows and their current channel's tabs
  ace tab rename <window> <channel> <tab> <name>  rename one tab; an empty name restores its default
  ace backup <channel> <directory>              snapshot a local or hosted channel's data into a new directory
  ace restore <directory> [--project <dir>] [--name <name>]
                                                restore a backup as a new local channel
  ace export <channel> <file>                    save a channel's chats as an editable seed file
  ace import <file> [--project <dir>] [--name <name>] [--now]
                                                add a seed as a new local channel; --now moves its
                                                newest message to now
  ace say <channel> [--chat <id>] <text…>        post without invoking the agent
  ace ask <channel> [--chat <id>] [--model <provider/id>] [--detach] <text…>
                                                exits 1 if the run fails or is stopped
  ace watch <channel> [--chat <id>]
  ace answer <channel> [--chat <id>] <text…>     answer the chat's waiting question in writing
  ace chat <channel> [--model <provider/id>]     open another chat
  ace stop <channel> [--chat <id>]               stop the chat's current run
  ace kill <channel>                             stop all work in the channel now
  ace move <channel> --compute                   move an idle channel to a cloud workspace, which it
                                                can't leave
  ace move <channel> --local                     bring an idle channel back from a hosting service
  ace agents <channel> on|off                    let others invoke agents
  ace project access <project>                   who can see a project, by folder or owner/name
  ace project share|unshare <project> team|<github login>
                                                give the team or one person every channel in it
  ace desktop <channel> on|off                   let the channel's agents use native desktop tools
  ace models
  ace login openai                             sign in with an eligible ChatGPT subscription
  ace logout openai                            remove the saved subscription login
  ace model [provider/id|auto]                   show or set the model for a chat's first agent run
  ace key set <NAME>                             store a key in the OS keychain, read from stdin;
                                                 a running host saves it so it can read it unprompted
  ace key rm <NAME>
  ace directory [<url> | off]                    the team's directory, which lists every host's channels;
                                                 a running host checks it with ACE_SECRET first
  ace web [<url> | off]                          the deployed web app your devices may use with this host
  ace serve [--port ${config.port}] [--loopback] [--demo <script.json>]
                                                serve the app and its WebSocket gateway;
                                                 --loopback stays off the tailnet and the directory;
                                                 --demo runs scripted synthetic teammates (docs/demo.md)
  ace logs [--channel <ref>] [--trace <id>] [--level warn] [--since 10m] [--grep <text>]
           [-n 200] [--follow] [--json]              every process's logs, merged in time order
  ace open [--port ${config.port}]                          open this host's authenticated app
  ace archive <channel> | unarchive <channel> | delete <channel> [--yes]
                                                delete asks first while a run is in progress
  ace --version

info, say, ask, answer, watch, chat and stop also take a teammate's channel, by name or ID, through this
host's running gateway (open Ace or run ace serve). Their host decides who may invoke its agents.

Models are provider/id, such as openai/gpt-6-astra or anthropic/claude-opus-5-5.
A credential such as OPENAI_API_KEY comes from ACE_OPENAI_API_KEY, then OPENAI_API_KEY, then the
keychain. Store keys there for the desktop app, which starts without your shell's environment.`;

// The app installs the command under another name for Canary.
const HELP = USAGE.replace(/\bace\b/g, config.command);

const OPTIONS = {
	project: { type: "string" },
	name: { type: "string" },
	model: { type: "string" },
	hosted: { type: "string" },
	local: { type: "boolean" },
	compute: { type: "boolean" },
	chat: { type: "string" },
	port: { type: "string" },
	all: { type: "boolean" },
	team: { type: "boolean" },
	detach: { type: "boolean" },
	yes: { type: "boolean" },
	now: { type: "boolean" },
	channel: { type: "string" },
	trace: { type: "string" },
	level: { type: "string" },
	since: { type: "string" },
	grep: { type: "string" },
	lines: { type: "string", short: "n" },
	follow: { type: "boolean", short: "f" },
	json: { type: "boolean" },
	loopback: { type: "boolean" },
	demo: { type: "string" },
	help: { type: "boolean", short: "h" },
	version: { type: "boolean" },
} as const;

function parse() {
	try {
		return parseArgs({ allowPositionals: true, options: OPTIONS });
	} catch (error) {
		// Node's message goes on to explain `--` for positionals, which no command here takes.
		const [problem] = (error as Error).message.split(". ");
		console.error(`${problem}. Run ${config.command} --help for usage.`);
		process.exit(1);
	}
}

const { values: flags, positionals } = parse();
const [command, ref, ...rest] = positionals;

const model = parseModel;

function chat(): ChatId | undefined {
	return flags.chat === undefined ? undefined : Number(flags.chat);
}

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;

function clip(text: string, length: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}

/** Whether `(run ended)` already printed, so `ask` doesn't print a second ending. */
let ended = false;
/** Whether a reply failed or was stopped, so `ask` exits 1 for a script. */
let unanswered = false;

function render(event: Event, info: ChannelInfo) {
	const tag = event.chat === 1 && info.chats.length === 1 ? "" : dim(`[${event.chat}] `);
	switch (event.kind) {
		case "message":
			return console.log(`${tag}${bold(event.author)}: ${event.text}`);
		case "stopped":
			return console.log(dim(`${tag}Stopped by ${event.author}.`));
		case "reply": {
			if (event.error || event.stopped) unanswered = true;
			const ending = event.error
				? `\x1b[31m${event.text ? "\n" : ""}Run failed: ${event.error}\x1b[0m`
				: event.stopped
				? dim(`${event.text ? "\n" : ""}Stopped.`)
				: "";
			return console.log(`${tag}${bold(event.model)}: ${event.text}${ending}`);
		}
		case "tool": {
			if (event.unrun) return console.log(dim(`${tag}  → ${event.name} (not run)`));
			if (event.name !== "question") {
				return console.log(dim(`${tag}  → ${event.name} ${clip(JSON.stringify(event.args), 100)}`));
			}
			const { questions } = event.args as {
				questions: { question: string; options: { label: string }[] }[];
			};
			for (const item of questions) {
				console.log(`${tag}  ? ${item.question}`);
				console.log(dim(`${tag}    ${item.options.map((option) => option.label).join(" · ")}`));
			}
			const flag = event.chat === 1 ? "" : ` --chat ${event.chat}`;
			return console.log(dim(`${tag}  (answer with: ace answer ${info.name}${flag} <text…>)`));
		}
		case "result":
			return console.log(dim(`${tag}  ${event.error ? "✗" : "←"} ${clip(event.text, 100)}`));
		case "run":
			if (event.state !== "end") return;
			ended = true;
			return console.log(dim(`${tag}  (run ended)`));
	}
}

/** A channel's requests: its local worker, or a teammate's channel relayed by this host's gateway. */
type Session = { request<T = unknown>(request: Request, watch?: Watch): Promise<T>; close(): void };

/** Once watching; `ended` resolves when its channel or relaying host ends the watch. */
async function watch(session: Session, replay = true): Promise<{ ended: Promise<void> }> {
	const info = await session.request<ChannelInfo>({ op: "info" });
	let live = false;
	const ended = Promise.withResolvers<void>();
	await session.request({ op: "watch", chat: chat(), stops: true }, {
		event(event) {
			if (event.kind === "live") return void (live = true);
			if (live || replay) render(event, info);
		},
		closed: () => ended.resolve(),
	});
	return { ended: ended.promise };
}

function ago(at: number): string {
	const minutes = Math.round((Date.now() - at) / 6e4);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	return `${Math.round(minutes / 60)}h ago`;
}

/** `10m`, `2h`, `1d`, or an ISO time. */
function since(value: string): number {
	const match = /^(\d+)([smhd])$/.exec(value);
	if (!match) return Date.parse(value);
	const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[match[2] as "s" | "m" | "h" | "d"];
	return Date.now() - Number(match[1]) * unit;
}

function gateway(): Promise<GatewayClient> {
	return loopback.gateway(Number(flags.port || config.port));
}

function local<T>(request: HostRequest): Promise<T> {
	return loopback.local<T>(request, Number(flags.port || config.port));
}

/**
 * macOS asks before a host reads a keychain item another program saved, so this host's running
 * gateway (Ace Helper or ace serve) saves and removes keys, and joins the directory, for the CLI.
 */
async function isHostRunning(): Promise<boolean> {
	return (await health(Number(flags.port || config.port)))?.home === config.home;
}

/** The running host knows each owner's GitHub login, as the app shows it. */
async function roster(): Promise<Member[]> {
	return await isHostRunning() ? await local<Member[]>({ op: "team-roster" }) : [];
}

/** What a teammate can do in a channel from the app; everything else acts on this host's own. */
const SWITCH = new Set(["on", "off"]);

const participant = new Set(["info", "say", "ask", "answer", "watch", "chat", "stop"]);

/** What only a channel's owner can do, phrased for refusing a teammate's channel. */
/** A project by its folder on this host, by GitHub owner/name, or by the name it was opened as. */
async function projectRef(value: string): Promise<string> {
	let path = existsSync(value) ? value : undefined;
	if (!path) {
		const repo = githubRepo(value);
		if (repo) return projectId("", "", repo);
		const named = (await local<Project[]>({ op: "projects" })).filter((project) =>
			project.name.toLowerCase() === value.toLowerCase()
		);
		if (named.length > 1) {
			throw new Error(`More than one project is named ${value}; use its folder`);
		}
		if (!named[0]) {
			throw new Error(`${value} is neither a project, a folder here, nor a GitHub owner/name`);
		}
		path = named[0].path;
	}
	const { root, repo } = await projects.checkout(realpathSync(resolve(path)));
	const { host } = await local<Hello>({ op: "hello" });
	return projectId(host, root, repo);
}

function findPerson(people: Person[], login: string): Person {
	const lower = login.toLowerCase();
	const found = people.find((value) =>
		value.github?.toLowerCase() === lower || value.person.toLowerCase() === lower
	);
	if (!found) throw new Error(`No one on the team is ${login} yet; their Ace must be running`);
	return found;
}

const VIA: Record<NonNullable<Person["via"]>, string> = {
	github: "reads it on GitHub",
	folder: "their folder",
	team: "shared with the team",
	share: "shared with them",
};

function printAccess(access: ProjectAccess) {
	for (const value of access.people) {
		const name = value.github || value.person;
		console.log(`${name.padEnd(24)} ${value.via ? VIA[value.via] : dim("no access")}`);
	}
	if (!access.direct) {
		console.log(dim("Only people who read it on GitHub, or whose folder it is, can share it."));
	}
}

const owned: Record<string, string> = {
	backup: "back it up",
	export: "export it",
	rename: "rename it",
	fork: "fork it",
	kill: "kill it",
	move: "move it",
	agents: "change its agent access",
	desktop: "change its desktop tools",
	archive: "archive it",
	unarchive: "unarchive it",
	delete: "delete it",
};

function mine(ref: string): boolean {
	return catalog.list().some((record) => record.id === ref || record.name === ref);
}

/** The listing `ref` names, by ID before name. */
function listed(listings: Listing[], ref: string): Listing | undefined {
	const identified = listings.filter((listing) => listing.id === ref);
	const matches = identified.length ? identified : listings.filter((value) => value.name === ref);
	if (matches.length > 1) throw new Error(`More than one channel is named ${ref}; use its ID`);
	return matches[0];
}

/** A channel this host runs, or else one a reachable teammate's host runs, with that host's name. */
async function join(ref: string): Promise<{ name: string; host?: string; session: Session }> {
	if (mine(ref)) {
		const record = catalog.find(ref);
		return { name: record.name, session: await Connection.open(record.id) };
	}
	const client = await gateway();
	try {
		const listing = listed(
			await loopback.within(client.request<Listing[]>({ op: "channels" })),
			ref,
		);
		if (!listing) throw new Error(`No channel ${ref} here or on a reachable teammate's host`);
		const session: Session = {
			request: (request, watch) => client.channel(listing.id, request, watch),
			close: () => client.close(),
		};
		return { name: listing.name, host: listing.host, session };
	} catch (error) {
		client.close();
		throw error;
	}
}

/**
 * A channel this host runs, for an owner-only command. A teammate's channel the running host can
 * see is refused by its owner and host, since info, say, ask and watch accept the same name.
 */
async function own(ref: string, action: string): Promise<catalog.Listing> {
	if (mine(ref) || !(await isHostRunning())) return catalog.find(ref);
	const listing = listed(await local<Listing[]>({ op: "channels" }), ref);
	if (!listing) return catalog.find(ref);
	throw new Error(
		`${listing.name} is ${listing.owner}'s channel on ${listing.host}; only its owner can ${action}`,
	);
}

function printTabs(windows: WindowInfo[]): void {
	if (flags.json) return console.log(JSON.stringify(windows, null, 2));
	if (!windows.length) return console.log("No open channel windows");
	console.log("Window\tChannel\tTab\tType\tActive\tName");
	for (const window of windows) {
		for (const tab of window.tabs) {
			console.log([
				window.id,
				window.channel.id,
				tab.id,
				tab.type,
				tab.active ? "yes" : "no",
				JSON.stringify(tab.name),
			].join("\t"));
		}
	}
}

/** Another Ace's host keeps its port; this command reaches its own host on another one. */
function advice(conflict: HostConflict): string {
	if (conflict.reason === "owner") {
		return `Leave it running. Pass --port for this host, or set ACE_HOME=${conflict.home} to use that one.`;
	}
	// Two hosts must never share a data directory, so this ace gets its own home as well as a port.
	return "Leave it running. Use an ace from the same version, or give this ace its own host: set ACE_HOME and ACE_PORT to unused values and run ace serve --loopback.";
}

async function main() {
	if (flags.version) {
		return console.log(
			config.version
				? `${config.command} ${config.version}`
				: "Ace from source has no release version",
		);
	}
	if (flags.help || !command || command === "help") return console.log(HELP);
	// Shells start background jobs with SIGINT ignored and Bun keeps that, so `kill -INT` would not
	// end a backgrounded watch. A listener takes SIGINT back; serve shuts down with its own.
	if (command !== "serve" && command !== "login") {
		process.on("SIGINT", () => process.exit(130));
	}
	if (command !== "serve" && command !== "logs") {
		openLog("cli");
		log("info", "cli.command", { command, ...(ref ? { ref } : {}) });
	}
	switch (command) {
		case "tabs":
			if (positionals.length !== 1) throw new Error("ace tabs [--port <port>] [--json]");
			return printTabs(await local<WindowInfo[]>({ op: "windows" }));
		case "tab": {
			if (ref !== "rename" || rest.length !== 4) {
				throw new Error("ace tab rename <window> <channel> <tab> <name> [--port <port>] [--json]");
			}
			const [window, channel, tab, value] = rest as [string, string, string, string];
			const name = value.trim();
			if (name.length > 80) throw new Error("Tab names must be at most 80 characters");
			const updated = await local<WindowInfo>({ op: "tab-rename", window, channel, tab, name });
			return printTabs([updated]);
		}
		case "logs": {
			const filter: Filter = {};
			// Ids of channels this host doesn't know, such as a peer's, filter as given.
			if (flags.channel) {
				filter.channel = catalog.list().find((r) => r.name === flags.channel)?.id ?? flags.channel;
			}
			if (flags.trace) filter.trace = flags.trace;
			if (flags.level) filter.level = flags.level;
			if (flags.since) {
				filter.since = since(flags.since);
				if (Number.isNaN(filter.since)) {
					throw new Error("--since takes a duration such as 10m, 2h or 1d, or a date");
				}
			}
			if (flags.grep) filter.grep = flags.grep;
			if (flags.follow) return follow(filter, !!flags.json);
			print(filter, Number(flags.lines || 200), !!flags.json);
			if (!flags.json) console.error(`\x1b[2m${logDir}\x1b[0m`);
			return;
		}
		case "new": {
			const dir = await project(resolve(flags.project || "."));
			const model = flags.model ? parseModel(flags.model) : undefined;
			if (model) await checkModel(model);
			const record = catalog.create(dir, model, flags.name);
			return console.log(`${record.name}\t${record.id}`);
		}
		case "ls": {
			if (flags.team) {
				console.log(["NAME", "ID", "STATE", "HOST", "OWNER", "PROJECT"].join("\t"));
				for (const listing of await local<Listing[]>({ op: "channels" })) {
					if (listing.state === "archived" && !flags.all) continue;
					const { name, id, state, host, owner, project } = listing;
					console.log([name, id, state, host, owner, project].join("\t"));
				}
				return;
			}
			console.log(["NAME", "ID", "STATE", "MODEL", "PROJECT"].join("\t"));
			for (const record of catalog.list()) {
				if (record.archived && !flags.all) continue;
				const running = isRunning(record.id) ? "running" : "dormant";
				const state = record.archived ? "archived" : running;
				console.log(
					[
						record.name,
						record.id,
						state,
						record.model ? `${record.model.provider}/${record.model.modelId}` : "automatic",
						record.project,
					].join("\t"),
				);
			}
			return;
		}
		case "restore": {
			if (positionals.length !== 2) {
				throw new Error("ace restore <backup-directory> [--project <dir>] [--name <name>]");
			}
			const record = await restore(ref!, { dir: flags.project, name: flags.name });
			return console.log(`${record.name}\t${record.id}`);
		}
		case "import": {
			if (positionals.length !== 2) {
				throw new Error("ace import <seed-file> [--project <dir>] [--name <name>] [--now]");
			}
			const record = await importSeed(ref!, {
				dir: flags.project || process.cwd(),
				name: flags.name,
				now: flags.now,
			});
			return console.log(`${record.name}\t${record.id}`);
		}
		case "models": {
			for (const m of await models()) console.log(`${m.provider}/${m.modelId}`);
			return;
		}
		case "project": {
			const [value, who] = rest;
			if (!value || !["access", "share", "unshare"].includes(ref!)) {
				throw new Error("ace project access|share|unshare <project> [team|<github login>]");
			}
			const project = await projectRef(value);
			const access = await local<ProjectAccess>({ op: "project-access", project });
			if (ref === "access") return printAccess(access);
			if (!who) throw new Error(`ace project ${ref} <project> team|<github login>`);
			const person = who === "team" ? TEAM : findPerson(access.people, who).person;
			const shared = ref === "share";
			await local({ op: "project-share", project, person, shared });
			if (!shared) {
				return console.log(
					`${person === TEAM ? "The team" : who} no longer sees it through a share.`,
				);
			}
			const channels = await local<Listing[]>({ op: "channels" });
			const others = new Set(
				channels.filter((value) => channelProject(value) === project).map((value) => value.owner),
			);
			others.delete(catalog.user);
			others.delete(person);
			const names = [...others].map((owner) =>
				access.people.find((value) => value.person === owner)?.github || owner
			);
			return console.log(
				`${person === TEAM ? "The team" : who} can now see every channel in it${
					names.length ? `, including ${names.join(", ")}'s,` : ""
				} and any created later.`,
			);
		}
		case "directory": {
			const url = ref === "off" ? null : ref;
			const rejoined = !!url && directory.url() === directory.canonical(url);
			const running = await isHostRunning();
			if (ref && running) await local({ op: "directory-set", url });
			else if (ref) await directory.configure(url || undefined);
			if (!running) {
				const joined = directory.url();
				if (!joined) return console.log("No directory");
				console.log(joined);
				return console.log(dim("Ace isn't running here, so this Mac isn't syncing it."));
			}
			const { directory: status, tailscale } = await local<Diagnostics>({ op: "diagnostics" });
			if (!status.url) return console.log("No directory");
			console.log(
				rejoined ? `Already joined ${status.url}` : url ? `Joined ${status.url}` : status.url,
			);
			if (tailscale.loopback) {
				return console.log(dim("This host runs with --loopback, so it doesn't sync it."));
			}
			if (status.serving) console.log("This Mac serves it.");
			else if (status.server) console.log(`${status.server} serves it.`);
			if (status.error) {
				return console.log(`Last sync failed ${ago(status.failed!)}: ${status.error}`);
			}
			return console.log(status.synced ? `Synced ${ago(status.synced)}.` : "Not synced yet.");
		}
		case "web": {
			if (ref) web.configure(ref === "off" ? undefined : ref);
			return console.log(web.app() ?? "No web app");
		}
		case "model": {
			if (ref) await setModel(ref === "auto" ? null : parseModel(ref));
			const saved = preference();
			if (saved) console.log(`${saved.provider}/${saved.modelId}`);
			else {
				// Without a usable key Automatic has nothing to pick yet.
				const picked = await defaultModel().catch(() => undefined);
				console.log(picked ? `Automatic (${picked.provider}/${picked.modelId})` : "Automatic");
			}
			if (config.model) console.log(`Overridden by ACE_MODEL=${config.model}`);
			return;
		}
		case "open": {
			const port = Number(flags.port || config.port);
			const info = await health(port);
			if (!info || info.home !== config.home) {
				throw new Error("Start this host with ace serve first");
			}
			const url = appUrl(port);
			url.hash = new URLSearchParams({ token: token() }).toString();
			const result = Bun.spawnSync([process.platform === "darwin" ? "open" : "xdg-open", url.href]);
			if (!result.success) throw new Error("Could not open Ace in your browser");
			return console.log(`Opened ${url.origin} in your browser, signed in to this host.`);
		}
		case "serve":
			return serve(Number(flags.port || config.port), !!flags.loopback, flags.demo);
		case "login":
		case "logout": {
			if (ref !== "openai" || rest.length) throw new Error(`ace ${command} openai`);
			const running = await isHostRunning();
			if (command === "login") {
				return login((value) =>
					running
						? local({ op: "subscription-save", value })
						: connectSubscription(value)
				);
			}
			if (running) await local({ op: "subscription-remove" });
			else await providers().logout("openai");
			return console.log("Removed the ChatGPT subscription login. API keys are unchanged.");
		}
		case "key": {
			const name = rest[0];
			if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
				throw new Error("ace key set|rm <NAME>, such as OPENAI_API_KEY");
			}
			const running = await isHostRunning();
			if (ref === "rm") {
				const removed = running
					? await local<boolean>({ op: "key-forget", name })
					: await forget(name);
				return console.log(removed ? `Removed ${name}` : `No ${name} in the keychain`);
			}
			if (ref !== "set") throw new Error("ace key set|rm <NAME>");
			// From stdin so the key stays out of shell history and the process list.
			if (process.stdin.isTTY) process.stderr.write(`${name} (end with Ctrl-D): `);
			const value = (await new Response(Bun.stdin.stream()).text()).trim();
			if (!value) throw new Error("No key on stdin");
			if (running) await local({ op: "key-store", name, value });
			else await store(name, value);
			return console.log(
				`Stored ${name} in the keychain${running ? " through the running host" : ""}`,
			);
		}
	}

	if (!participant.has(command) && !owned[command]) {
		throw new Error(`Unknown command ${command}\n\n${HELP}`);
	}
	if (!ref) throw new Error(`ace ${command} needs a channel`);
	const text = rest.join(" ");
	if (participant.has(command)) {
		const { name, host, session } = await join(ref);
		try {
			switch (command) {
				case "info": {
					// docs/terms.md names it agent access, after `ace agents`; `shared` is the wire name.
					const { shared, owner, ...info } = await session.request<ChannelInfo>({ op: "info" });
					const members = await roster();
					const self = members.find((member) => member.self);
					return console.log(JSON.stringify(
						{
							...info,
							host: host || self?.host,
							owner: members.find((member) => member.login === owner)?.github || owner,
							agents: shared,
						},
						null,
						2,
					));
				}
				case "say":
					if (!text) throw new Error("Nothing to say");
					await session.request({ op: "say", chat: chat(), author: catalog.user, text });
					return console.log(`Posted to ${name}.`);
				case "ask": {
					if (!text) throw new Error("Nothing to ask");
					const body = {
						op: "ask",
						chat: chat(),
						author: catalog.user,
						text,
						model: flags.model ? model(flags.model) : undefined,
					} as const;
					// The channel refuses by the owner's Tailscale login; name them as the app does.
					const refused = async (error: Error): Promise<never> => {
						const { shared, owner } = await session.request<ChannelInfo>({ op: "info" });
						if (shared || owner === catalog.user) throw error;
						const github = (await roster()).find((member) => member.login === owner)?.github;
						throw github ? new Error(error.message.replace(owner, github)) : error;
					};
					if (flags.detach) {
						await session.request(body).catch(refused);
						return console.log(
							`Asked ${name}'s agent; the run continues. Follow it with: ace watch ${name}`,
						);
					}
					await watch(session, false);
					const { submission } = await session.request<{ submission: number }>(body).catch(
						refused,
					);
					process.prependListener("SIGINT", () => {
						console.log(dim(`\nDetached; the run continues. Stop it with: ace stop ${name}`));
						process.exit(130);
					});
					const status = await session.request<string>({ op: "wait", submission });
					if (status === "unanswered" && !ended) console.log(dim("  (stopped before answering)"));
					if (status === "unanswered" || unanswered) process.exit(1);
					return;
				}
				case "answer":
					if (!text) throw new Error("Nothing to answer");
					await session.request({ op: "answer", chat: chat(), author: catalog.user, text });
					return console.log(`Answered the question in ${name}.`);
				case "watch":
					return await (await watch(session)).ended;
				case "chat": {
					const body = {
						op: "chat",
						author: catalog.user,
						model: flags.model ? model(flags.model) : undefined,
					} as const;
					return console.log((await session.request<{ chat: number }>(body)).chat);
				}
				case "stop": {
					// Stopping settles either way, so the chat's state beforehand says whether a run ended.
					const { chats } = await session.request<ChannelInfo>({ op: "info" });
					const id = chat();
					const busy = chats.find((value) =>
						id === undefined ? value.parent === undefined : value.id === id
					)?.busy;
					await session.request({ op: "stop", chat: id, author: catalog.user });
					return console.log(
						busy ? `Stopped the run in ${name}.` : `Nothing was running in ${name}.`,
					);
				}
			}
		} finally {
			session.close();
		}
	}
	const record = await own(ref, owned[command]!);
	switch (command) {
		case "backup":
			if (rest.length !== 1) throw new Error("ace backup <channel> <new-directory>");
			console.log(await backup(record, rest[0]!));
			console.log("Channel data saved. Back up project files and lane worktrees separately.");
			return;
		case "export":
			if (rest.length !== 1) throw new Error("ace export <channel> <file>");
			return console.log(await exportSeed(record, rest[0]!));
		case "rename":
			if (rest.length !== 1) throw new Error("ace rename <channel> <name>");
			await request(record.id, { op: "rename", author: catalog.user, name: rest[0]! });
			return console.log(`Renamed ${record.name} to ${rest[0]}.`);
		case "fork":
			return console.log((await fork(record.id, catalog.user)).name);
		case "kill": {
			const work = record.busy ? "stopped its agent's run" : "no agent was working";
			// A running host owns the channel's terminals and closes them with it, as for the app.
			if (!await isHostRunning()) {
				await kill(record.id);
				return console.log(`Killed ${record.name}: ${work}.`);
			}
			const shells = await local<TerminalShell[]>({ op: "terminals", channel: record.id });
			await local({
				op: "channel",
				channel: record.id,
				request: { op: "kill", author: catalog.user },
			});
			const closed = shells.length
				? `closed ${shells.length} terminal${shells.length === 1 ? "" : "s"}`
				: "no terminals were open";
			return console.log(`Killed ${record.name}: ${work}; ${closed}.`);
		}
		case "move": {
			// `--hosted <url>` only finishes a move to a hosting service that an earlier version started.
			if ([flags.hosted, flags.local, flags.compute].filter(Boolean).length !== 1) {
				throw new Error("ace move <channel> --local | --compute");
			}
			await move(record.id, flags.local ? "local" : flags.compute ? "compute" : flags.hosted!);
			const moved = catalog.read(record.id);
			return console.log(
				`${moved.name} now runs ${
					moved.compute
						? "in a cloud workspace"
						: moved.hosted
						? `at ${moved.hosted}`
						: "on this host"
				}`,
			);
		}
		case "agents": {
			if (rest.length !== 1 || !SWITCH.has(rest[0]!)) {
				throw new Error("ace agents <channel> on|off");
			}
			const shared = rest[0] === "on";
			await request(record.id, { op: "share", author: catalog.user, shared });
			return console.log(
				shared
					? `Agent access is on for ${record.name}. Teammates can run commands as you on this machine.`
					: `Agent access is off for ${record.name}. Only you can ask its agents.`,
			);
		}
		case "desktop": {
			if (rest.length !== 1 || !SWITCH.has(rest[0]!)) {
				throw new Error("ace desktop <channel> on|off");
			}
			const enabled = rest[0] === "on";
			await request(record.id, { op: "desktop", author: catalog.user, enabled });
			return console.log(
				enabled
					? `Desktop tools are on for ${record.name}. Its agents can operate this machine's apps.`
					: `Desktop tools are off for ${record.name}. Its agents' new desktop calls are refused.`,
			);
		}
		case "archive":
		case "unarchive": {
			const archived = command === "archive";
			if (await isHostRunning()) await local({ op: "archive", channel: record.id, archived });
			else await archive(record.id, archived);
			return console.log(
				archived
					? `Archived ${record.name}. Resume it with: ace unarchive ${record.name}`
					: `Unarchived ${record.name}.`,
			);
		}
		case "delete":
			if (record.busy && !flags.yes) {
				const asked = `${record.name} has a run in progress. Delete it anyway?`;
				if (!process.stdin.isTTY) {
					throw new Error(`${asked} Stop it first, or run: ace delete ${record.name} --yes`);
				}
				if (!/^y(es)?$/i.test(prompt(`${asked} [y/N]`)?.trim() || "")) {
					return console.log(`Kept ${record.name}.`);
				}
			}
			if (await isHostRunning()) await local({ op: "delete", channel: record.id });
			else await remove(record.id);
			return console.log(`Deleted ${record.name}. Its lane branches remain in ${record.project}.`);
	}
}

main().then(
	() => process.exit(0),
	(error: Error) => {
		log("error", "cli.failed", { command, ...failure(error) });
		console.error(error.message);
		if (error instanceof HostConflict) console.error(advice(error));
		process.exit(1);
	},
);
