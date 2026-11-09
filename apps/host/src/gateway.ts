import { existsSync, mkdirSync, watch } from "node:fs";
import { isIP } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";

import type { Server, ServerWebSocket } from "bun";

import * as access from "./access";
import * as auth from "./auth";
import * as catalog from "./catalog";
import { Connection } from "./client";
import * as compute from "./compute";
import { config } from "./config";
import * as demo from "./demo";
import { diagnostics } from "./diagnostics";
import * as asks from "./asks";
import * as directory from "./directory";
import * as served from "./directory-server";
import { retryLoginShell, shell } from "./environment";
import type { GatewayClient, Watch } from "./gateway-client";
import * as github from "./github";
import { describe, health, HostConflict } from "./health";
import { connectSubscription, models as providers, seal } from "./keys";
import * as lobby from "./lobby";
import { failure, log, open as openLog } from "./log";
import { move, targets } from "./move";
import {
	archive,
	archiveInactive,
	fork,
	isRunning,
	isWorkerAlive,
	models,
	project,
	remove,
} from "./manage";
import * as peers from "./peers";
import { compute as computeSettings, folder } from "./preferences";
import * as projects from "./projects";
import {
	channelProject,
	HOST_PROTOCOL,
	type HostEnvelope,
	type HostFrame,
	type HostInfo,
	type HostRequest,
	type Listing,
	type Member,
	type People,
	type Presence,
	projectId,
	type WorkerRequest,
} from "./protocol";
import { type Machine, self, watch as tailscale, whois } from "./tailnet";
import {
	checkKey,
	forgetKey,
	invite,
	removeKey,
	setCompute,
	setDirectory,
	setFolder,
	setKey,
	setModel,
	settings,
	storeKey,
} from "./settings";
import { resume, shutdown } from "./shutdown";
import { deploy as deployTeam } from "./team";
import * as terminals from "./terminals";
import * as web from "./web";
import * as windows from "./windows";
import * as workspace from "./workspace";

type Client = {
	/** The participant this socket speaks for: the owner on loopback, a verified login on the tailnet. */
	user: string;
	/** Arrived over the tailnet. Peers act only on this host's channels, and never as its owner. */
	peer: boolean;
	/** The tailnet machine a peer connected from, as Tailscale named it. */
	machine?: string;
	local: boolean;
	channels: Map<string, Promise<Connection>>;
	/** This client's connections to peer hosts, opened when it first uses one of their channels. */
	remotes: Map<string, GatewayClient>;
	/** Detaches this client from the terminals it opened; the shells keep running. */
	terminals: Map<string, () => void>;
	/** A host's socket to a lobby of the directory this host serves, not a gateway client. */
	lobby?: served.Seat;
};

let name = hostname();
/** Where teammates reach the directory this host serves, once it's on the tailnet. */
let servedUrl: string | undefined;
let closing = false;
let updating = false;
let update = 0;
let suspending: Promise<unknown> | undefined;
const pending = new Set<Promise<unknown>>();
/** Deleting kills the worker first; the watches that ends must not start it again. */
const deleting = new Set<string>();
/** Moves under way here; a fence an interrupted move left behind is not one. */
const moves = new Set<string>();
/** Cloud compute starts and stops under way here; each freezes its hosted channel until it ends. */
const computing = new Map<string, "starting" | "stopping">();

async function local(): Promise<Listing[]> {
	const records = catalog.list();
	const checkouts = await Promise.all(records.map((record) => projects.checkout(record.project)));
	return records.map((record, index) => {
		const state = record.archived ? "archived" : isRunning(record.id) ? "running" : "dormant";
		const {
			id,
			name: channel,
			prefix,
			summary,
			revision,
			owner,
			project,
			model,
			created,
			active,
			ran,
			said,
			mentions,
			hosted,
		} = record;
		const listing: Listing = {
			id,
			host: name,
			name: channel,
			prefix,
			summary,
			revision,
			owner,
			project,
			model,
			created,
			state,
			busy: state === "running" && !!record.busy && (!hosted || workspace.isConnected(id)),
		};
		if (active) listing.active = active;
		if (ran) listing.ran = ran;
		if (said) listing.said = said;
		if (mentions) listing.mentions = mentions;
		const { root, repo } = checkouts[index]!;
		listing.root = root;
		if (repo) listing.repo = repo;
		if (hosted) listing.hosted = hosted;
		if (record.compute) listing.compute = true;
		if (record.stopped) listing.stopped = true;
		const transition = computing.get(id);
		if (transition) listing.computing = transition;
		if (record.moving && moves.has(id)) {
			const { to } = record.moving;
			listing.moving = to === "local"
				? name
				: to === "compute"
				? "cloud workspace"
				: new URL(to).host;
		}
		return listing;
	});
}

/**
 * Channels only the directory or a peer's last answer knows: their host is unreachable, unless they
 * are hosted. A reachable host's own listing leaves out what it no longer shares, which is not offline.
 */
function listed(seen: Set<string>): Listing[] {
	return [...directory.read().channels, ...peers.unreachable()]
		.filter((value) => {
			if (seen.has(value.id) || value.host === name) return false;
			if (!value.hosted && peers.isReachable(value.host)) return false;
			seen.add(value.id);
			return true;
		})
		.map((value) =>
			Object.assign({}, value, {
				state: value.state === "archived" || value.hosted ? value.state : "offline" as const,
				// The directory is a cache, not a live connection, even for hosted channels.
				busy: false,
			})
		);
}

/**
 * Every channel the owner's app lists: this host's, then reachable peers' and the directory's in
 * projects the owner can access. The directory, lobby events, and hosts from before project access
 * carry every channel, so the owner's host filters them too.
 */
async function everyone(own: Listing[]): Promise<Listing[]> {
	const reachable = peers.listings();
	const others = [
		...reachable,
		...listed(new Set([...own, ...reachable].map((value) => value.id))),
	];
	return [...own, ...await visible(others)];
}

async function visible(others: Listing[]): Promise<Listing[]> {
	const checks = await Promise.all(
		others.map((value) => access.canAccess(catalog.user, channelProject(value))),
	);
	return others.filter((_, index) => checks[index]);
}

/** A peer's person sees this host's channels in projects they can access; the owner sees all. */
async function allowed(user: string, own: Listing[]): Promise<Listing[]> {
	if (user === catalog.user) return own;
	const checks = await Promise.all(
		own.map((value) => access.canAccess(user, channelProject(value))),
	);
	return own.filter((_, index) => checks[index]);
}

async function listings(client: Client, own?: Listing[]): Promise<Listing[]> {
	own ||= await local();
	return client.peer ? allowed(client.user, own) : everyone(own);
}

async function projectOfChannel(channel: string): Promise<string> {
	const { root, repo } = await projects.checkout(catalog.read(channel).project);
	return projectId(name, root, repo);
}

async function mayOpen(client: Client, channel: string): Promise<boolean> {
	return !client.peer || client.user === catalog.user
		|| access.canAccess(client.user, await projectOfChannel(channel));
}

let shares = "";

/**
 * After a directory read: when shares changed, peers' listings follow and watches on projects their
 * person can no longer access end, as a closed channel's do.
 */
function sharesChanged(): Promise<void> {
	const current = JSON.stringify(directory.read().shares);
	if (current === shares) return ownersChanged();
	shares = current;
	return queue(async () => {
		await revoke();
		await deliver(await local());
	});
}

async function revoke(): Promise<void> {
	for (const socket of sockets) {
		for (const [channel, open] of socket.data.channels) {
			if (!catalog.owns(channel) || await mayOpen(socket.data, channel)) continue;
			socket.data.channels.delete(channel);
			log("info", "gateway.access.revoked", { user: socket.data.user, channel });
			void open.then((connection) => connection.close(), () => {});
		}
	}
}

const sockets = new Set<ServerWebSocket<Client>>();

let frames = Promise.resolve();

/**
 * Listings wait on Git, so frames go out in the order they were asked for: an older listing that
 * took longer must never replace a newer one. A failed frame is logged and never blocks later ones.
 */
function queue(send: () => Promise<void>): Promise<void> {
	frames = frames.then(send).catch((error) => log("error", "gateway.frame.failed", failure(error)));
	return frames;
}

/**
 * This host's channels changed. Peers receive only that, so their own broadcasts never echo back:
 * two hosts relaying each other's frames would loop forever, starving both event loops.
 */
function broadcast(): Promise<void> {
	return queue(async () => deliver(await local()));
}

/** Each peer's person gets the channels they can access, worked out once per person. */
async function deliver(own: Listing[]): Promise<void> {
	const frames = new Map<string, Promise<string>>();
	for (const socket of sockets) {
		if (!socket.data.peer) continue;
		const { user } = socket.data;
		let frame = frames.get(user);
		if (!frame) {
			frame = allowed(user, own).then((channels) =>
				JSON.stringify({ channels } satisfies HostFrame)
			);
			frames.set(user, frame);
		}
		socket.send(await frame);
	}
	await owners(own);
}

function ownersChanged(): Promise<void> {
	return queue(() => owners());
}

/** Peer and directory listings reach only the owner's app; peers never see them. */
async function owners(own?: Listing[]): Promise<void> {
	own ||= await local();
	let frame: string | undefined;
	for (const socket of sockets) {
		if (socket.data.peer) continue;
		frame ??= JSON.stringify({ channels: await listings(socket.data, own) } satisfies HostFrame);
		socket.send(frame);
	}
	peopleChanged();
	await lobbyProjects(own);
}

/**
 * Fresher sources win: peers' hellos, then the directory, which each host re-announces itself to
 * on every heartbeat while a hello is asked only on connect, then this host's own owner.
 */
function people(): People {
	const known: People = { ...peers.people() };
	for (const host of directory.read().hosts) if (host.github) known[host.login] = host.github;
	Object.assign(known, demo.people());
	const own = github.login(loginChanged);
	if (own) known[catalog.user] = own;
	return known;
}

let sent = "";

function peopleChanged(): void {
	const frame = JSON.stringify({ people: people() } satisfies HostFrame);
	if (frame === sent) return;
	sent = frame;
	for (const socket of sockets) if (!socket.data.peer) socket.send(frame);
	// Peers' GitHub logins decide which of this host's channels they see, and can arrive late.
	void broadcast();
}

function loginChanged(): void {
	peopleChanged();
	lobbyChanged();
}

/** Each listed channel's project, so presence can follow window changes without reading Git. */
let projectOf = new Map<string, string>();
/** Every project the owner's app lists; this host subscribes to each one's lobby. */
let known = new Set<string>();

async function lobbyProjects(own?: Listing[]): Promise<void> {
	if (!directory.url()) return;
	own ||= await local();
	projectOf = new Map((await everyone(own)).map((value) => [value.id, channelProject(value)]));
	known = new Set(projectOf.values());
	for (const value of await projects.list()) known.add(projectId(name, value.path, value.repo));
	lobbyChanged();
}

/**
 * Publish the owner's presence in each known project's lobby. This is where the owner's Tailscale
 * login becomes the GitHub login lobbies identify people by, from the same `gh` login `people`
 * maps it to; without one the owner is not here anywhere.
 */
function lobbyChanged(): void {
	const here = new Map<string, Presence>();
	const login = github.login(loginChanged);
	for (const window of login ? windows.list() : []) {
		const project = projectOf.get(window.channel.id);
		if (!project) continue;
		let found = here.get(project);
		if (!found) here.set(project, found = { login: login!, host: name, channels: [], away: true });
		if (!found.channels.includes(window.channel.id)) found.channels.push(window.channel.id);
		// Apps that predate focus reports cannot say they are away.
		if (window.focused !== false) found.away = false;
	}
	lobby.update(known, here);
	// A project the owner lost access to keeps its lobby until the next publication, but not its people.
	presenceChanged();
}

let presenceSent = "";

/** Lobby presence, with demo mode's synthetic people beside the real ones. */
function present(): Record<string, Presence[]> {
	const found = { ...lobby.presence() };
	for (const [project, people] of Object.entries(demo.presence())) {
		found[project] = [...found[project] || [], ...people];
	}
	return found;
}

/** Lobby presence reaches only the owner's app; peers never see it. */
function presenceChanged(): void {
	const frame = JSON.stringify({ presence: present() } satisfies HostFrame);
	if (frame === presenceSent) return;
	presenceSent = frame;
	for (const socket of sockets) if (!socket.data.peer) socket.send(frame);
}

function projectsChanged(): Promise<void> {
	return queue(async () => {
		const frame = JSON.stringify({ projects: await projects.list() } satisfies HostFrame);
		for (const socket of sockets) if (!socket.data.peer) socket.send(frame);
		await lobbyProjects();
	});
}

/** Only the local app can answer an ask, so only it is told about them. */
function asksChanged(): void {
	const frame = JSON.stringify({ asks: asks.list() } satisfies HostFrame);
	for (const socket of sockets) if (socket.data.local) socket.send(frame);
}

/**
 * A host joined or left the directory this one serves. This host reads it only on its heartbeat,
 * so it reads it now for its apps' People and In the directory.
 */
function directoryMembers(): void {
	void directory.refresh().then(settingsChanged);
}

function settingsChanged(): void {
	for (const socket of sockets) {
		if (!socket.data.peer) socket.send(JSON.stringify({ settings: true } satisfies HostFrame));
	}
}

function connection(client: Client, channel: string, hosted?: string): Promise<Connection> {
	if (deleting.has(channel)) return Promise.reject(new Error("The channel is being deleted"));
	let open = client.channels.get(channel);
	if (!open) {
		open = hosted ? Connection.hosted(hosted, channel) : Connection.open(channel);
		client.channels.set(channel, open);
		// A released connection can close after its replacement opened; never drop the replacement.
		const drop = () => {
			if (client.channels.get(channel) === open) client.channels.delete(channel);
		};
		open.then((connection) => connection.closed.then(drop), drop);
	}
	return open;
}

async function remote(client: Client, host: string): Promise<GatewayClient> {
	let open = client.remotes.get(host);
	if (!open) {
		const machine = peers.machine(host);
		if (!machine) throw new Error(`${host} is not reachable`);
		open = peers.relay(machine);
		client.remotes.set(host, open);
	}
	for (let waited = 0; open.status !== "open"; waited += 50) {
		if (waited >= 5000) throw new Error(`${host} is not reachable`);
		await Bun.sleep(50);
	}
	return open;
}

/**
 * The service refuses the channel's connections while it starts or stops, so the listing says so
 * beforehand and clients open the chat again once it ends.
 */
async function lifecycle(
	channel: string,
	transition: "starting" | "stopping",
	run: () => Promise<void>,
): Promise<void> {
	// A second request for the same channel waits behind the first at the service; only the first
	// may end the listing's transition.
	const first = !computing.has(channel);
	if (first) computing.set(channel, transition);
	await broadcast();
	try {
		await run();
	} finally {
		if (first) computing.delete(channel);
		await broadcast();
	}
}

const owned = new Set<HostRequest["op"]>(["archive", "archive-inactive", "delete", "fork"]);
const windowOps = new Set<HostRequest["op"]>([
	"window",
	"windows",
	"tab-rename",
	"tab-live",
	"tab-result",
]);
const moveOps = new Set<HostRequest["op"]>(["move-targets", "move"]);
const keychainOps = new Set<HostRequest["op"]>([
	"subscription-save",
	"subscription-remove",
	"key-store",
	"key-forget",
	"directory-set",
	"directory-serve",
	"team-deploy",
	"team-invite",
	"team-ask",
	"team-answer",
]);
const localOps = new Set<HostRequest["op"]>([
	"projects",
	"project-access",
	"project-share",
	"project-open",
	"project-remove",
	"project-init",
	"project-clone",
	"github-list",
	"github-detail",
	"github-files",
	"github-pull",
	"settings",
	"diagnostics",
	"key-set",
	"key-check",
	"key-remove",
	"preferences",
	"team-peers",
	"team-roster",
	"compute",
	"folder",
	"compute-start",
	"compute-stop",
	"update-prepare",
	"update-cancel",
	// A terminal is a shell as this host's user, so only its owner opens one.
	"terminal",
	"terminal-input",
	"terminal-resize",
	"terminal-close",
	"terminals",
]);

type ChannelRequest = Extract<HostRequest, { op: "channel" }>["request"];

/** Worker requests come from this host's own processes, never through the gateway. */
const WORKER = new Set<string>(["worker", "freeze", "export"] satisfies WorkerRequest["op"][]);

/** The verified person replaces any claimed author. Older clients send stop and kill without one. */
function authored(request: ChannelRequest, user: string): ChannelRequest {
	if (request.op === "stop" || request.op === "kill" || "author" in request) {
		return { ...request, author: user };
	}
	return request;
}

async function handle(
	socket: ServerWebSocket<Client>,
	request: HostRequest,
	send: (frame: HostFrame) => void,
	id: number,
	trace: string,
): Promise<unknown> {
	if (closing) throw new Error("Ace Helper is shutting down");
	const client = socket.data;
	if (windowOps.has(request.op) && (!client.local || client.user !== catalog.user)) {
		throw new Error("Tabs are only available through this host's authenticated local gateway");
	}
	if (moveOps.has(request.op) && (!client.local || client.user !== catalog.user)) {
		throw new Error("Only this host's owner can move channels, from its local app");
	}
	if (keychainOps.has(request.op) && (!client.local || client.user !== catalog.user)) {
		throw new Error("Only this host's owner can change its credentials, from its local app");
	}
	if (localOps.has(request.op) && (client.peer || client.user !== catalog.user)) {
		throw new Error("This action is only available from this host's local app");
	}
	if (!client.local && (request.op === "update-prepare" || request.op === "update-cancel")) {
		throw new Error("Desktop updates are only available from this host's local app");
	}
	if (updating && request.op !== "update-cancel") {
		throw new Error("Ace is pausing this machine's channels to install an update");
	}
	// A channel runs where it was created, so even its owner creates from that machine.
	if (client.peer && (request.op === "create" || request.op === "fork")) {
		throw new Error("Create channels from the host that will run them");
	}
	if (owned.has(request.op) && client.user !== catalog.user) {
		throw new Error("Only this host's owner can do that");
	}
	switch (request.op) {
		case "window": {
			const window = windows.publish(socket, request.value);
			lobbyChanged();
			return window;
		}
		case "windows":
			return windows.list();
		case "tab-rename":
			return windows.rename(request);
		case "tab-live":
			return windows.live(request);
		case "tab-result":
			return windows.result(socket, request.call, request.result);
		case "update-prepare": {
			if (!config.helper) throw new Error("Only Ace Helper can prepare a desktop update");
			const current = ++update;
			updating = true;
			// handle() starts before this request enters pending, so it cannot await itself.
			await Promise.allSettled(pending);
			// A timed-out desktop request can be canceled while an older request is still draining.
			if (current !== update) throw new Error("The update was canceled");
			const stopping = Promise.allSettled([workspace.close(), shutdown(), terminals.closeAll()]);
			suspending = stopping;
			try {
				const results = await stopping;
				const errors = results.filter((result) => result.status === "rejected");
				if (errors.length) {
					throw new AggregateError(
						errors.map((result) => result.reason),
						"Some work could not be paused for the update",
					);
				}
				if (current !== update) throw new Error("The update was canceled");
			} finally {
				suspending = undefined;
			}
			return { ready: true };
		}
		case "update-cancel":
			if (updating) {
				update++;
				if (suspending) await Promise.allSettled([suspending]);
				await resume();
				workspace.sync();
				updating = false;
			}
			return;
		case "hello": {
			const team = directory.url();
			return {
				user: client.user,
				host: name,
				github: github.login(loginChanged),
				...(team ? { team: new URL(team).host, directory: team } : {}),
			};
		}
		case "project-access":
			return access.describe(request.project);
		case "project-share":
			await access.share(request.project, request.person, request.shared);
			peers.sharesChanged();
			return sharesChanged();
		case "shares-changed":
			return directory.refresh();
		case "channels":
			return listings(client);
		case "projects":
			return projects.list();
		case "project-open": {
			const project = await projects.open(request.path);
			await projectsChanged();
			return project;
		}
		case "project-remove":
			projects.remove(request.path);
			return projectsChanged();
		case "project-init": {
			const project = await projects.init(request.path);
			await projectsChanged();
			return project;
		}
		case "project-clone": {
			const project = await projects.setup(request.repo, request.path);
			await projectsChanged();
			return project;
		}
		case "project-repo": {
			if (request.host && request.host !== name && !client.peer) {
				const repo = await (await remote(client, request.host)).request<string | null>(
					{
						op: "project-repo",
						project: request.project,
					},
					undefined,
					trace,
				);
				return repo && await github.found(repo) ? repo : null;
			}
			const known = client.peer
				? (await Promise.all(catalog.list().map((channel) => projects.checkout(channel.project))))
					.some(({ root }) => root === request.project)
				: (await projects.list()).some((project) => project.path === request.project);
			if (!known) throw new Error("Open this project in Ace first");
			const repo = await github.project(request.project);
			const id = projectId(name, request.project, repo || undefined);
			if (client.peer && client.user !== catalog.user && !await access.canAccess(client.user, id)) {
				throw new Error("You don't have access to this project");
			}
			// A peer's host answers only what the remote names; GitHub reads stay on the asking host.
			if (client.peer) return repo;
			return repo && await github.found(repo) ? repo : null;
		}
		case "github-list":
			return github.list(request);
		case "github-detail":
			return github.detail(request);
		case "github-files":
			return github.files(request.repo, request.number);
		case "github-pull":
			return github.pull(request.repo, request.branch);
		case "settings":
			return settings(request.fresh);
		case "diagnostics":
			return diagnostics(request.sync);
		case "subscription-save":
			await connectSubscription(request.value);
			return settingsChanged();
		case "subscription-remove":
			await providers().logout("openai");
			return settingsChanged();
		case "key-set":
			await setKey(request.provider, request.value);
			return settingsChanged();
		case "key-check":
			return checkKey(request.provider, settingsChanged);
		case "key-remove":
			await removeKey(request.provider);
			return settingsChanged();
		case "preferences":
			if (request.model !== undefined) await setModel(request.model);
			if (request.compute) await setCompute(request.compute);
			if (request.folder !== undefined) setFolder(request.folder);
			return settingsChanged();
		case "key-store":
			await storeKey(request.name, request.value);
			return settingsChanged();
		case "key-forget": {
			const removed = await forgetKey(request.name);
			settingsChanged();
			return removed;
		}
		case "directory-serve": {
			if (!request.serve) {
				served.remove();
				if (directory.url() === servedUrl) await setDirectory(null);
				return null;
			}
			if (!servedUrl) {
				throw new Error("Connect to Tailscale first: the directory serves your tailnet.");
			}
			served.create();
			await setDirectory(servedUrl);
			return servedUrl;
		}
		case "directory-set":
			return setDirectory(request.url, request.secret);
		case "team-deploy":
			return deployTeam((waiting) => send({ id, waiting }));
		case "team-invite":
			return invite();
		case "team-peers":
			return peers.teams();
		case "team-roster": {
			const roster: Member[] = [
				{ host: name, login: catalog.user, online: true, self: true },
				...peers.members(),
			];
			const seen = new Set(roster.map((member) => member.host));
			for (const { name: host, login } of directory.read().hosts) {
				if (!seen.has(host)) roster.push({ host, login, online: false });
			}
			const known = people();
			return roster.map((member) =>
				known[member.login] ? { ...member, github: known[member.login] } : member
			);
		}
		case "team-ask": {
			const team = await peers.ask(request.host);
			return setDirectory(team.url, team.secret);
		}
		case "team-request": {
			if (!client.peer || !client.machine) throw new Error("Ask from your own host");
			const asker = { login: client.user, host: client.machine };
			const login = people()[client.user];
			return asks.ask(socket, login ? { ...asker, github: login } : asker, asksChanged);
		}
		case "team-answer":
			return asks.answer(request.ask, request.approve, asksChanged);
		case "models":
			if (request.host && request.host !== name && !client.peer) {
				return (await remote(client, request.host)).request({ op: "models" });
			}
			return models();
		case "create": {
			const record = request.cloud
				? await compute.create(request.project, request.model, request.name || undefined)
				: catalog.create(await project(request.project), request.model, request.name || undefined);
			await broadcast();
			return record;
		}
		case "fork": {
			if (!catalog.owns(request.channel)) {
				throw new Error("Fork channels from the host that runs them");
			}
			const record = await fork(request.channel, client.user);
			await broadcast();
			return record;
		}
		case "compute":
			return computeSettings();
		case "folder":
			return folder();
		case "compute-start":
			return lifecycle(
				request.channel,
				"starting",
				() => compute.start(request.channel, (waiting) => send({ id, waiting })),
			);
		case "compute-stop":
			return lifecycle(request.channel, "stopping", () => compute.stop(request.channel));
		case "archive":
			if (request.archived) terminals.closeChannel(request.channel);
			await archive(request.channel, request.archived);
			return broadcast();
		case "archive-inactive": {
			const archived = await archiveInactive(request.project);
			for (const channel of archived) terminals.closeChannel(channel);
			await broadcast();
			return archived.length;
		}
		case "move-targets":
			return catalog.owns(request.channel) ? targets(request.channel, name) : [];
		case "move": {
			if (!catalog.owns(request.channel)) {
				throw new Error("Move channels from the host that runs them");
			}
			// A second request for the same channel is refused and must not end the first's progress.
			const first = !moves.has(request.channel);
			moves.add(request.channel);
			try {
				// A move to a cloud workspace ends by starting it, which the app must wait out like Run in
				// cloud before it opens the chat; the agent's lane push before it stays watchable.
				await move(
					request.channel,
					request.target,
					(waiting) => send({ id, waiting }),
					(run) => lifecycle(request.channel, "starting", run),
				);
			} finally {
				if (first) moves.delete(request.channel);
				// A failed move lifts its fence, which listings and reopened chats must see.
				await broadcast();
			}
			return;
		}
		case "delete":
			terminals.closeChannel(request.channel);
			deleting.add(request.channel);
			try {
				await remove(request.channel);
			} finally {
				deleting.delete(request.channel);
			}
			return broadcast();
		case "terminal": {
			if (!catalog.owns(request.channel)) throw new Error("Terminals open on the channel's host");
			if (catalog.read(request.channel).compute) {
				throw new Error("A cloud compute channel's shell is in its container, not on this host");
			}
			const { opened, attach } = await terminals.open(request);
			client.terminals.get(opened.terminal)?.();
			// After the reply, which is sent once this returns and its microtasks settle.
			setTimeout(() => {
				if (socket.readyState === 1) client.terminals.set(opened.terminal, attach(send));
			});
			return opened;
		}
		case "terminal-input":
			return terminals.input(request.terminal, request.data);
		case "terminal-resize":
			return terminals.resize(request.terminal, request.cols, request.rows);
		case "terminal-close":
			client.terminals.delete(request.terminal);
			return terminals.close(request.terminal);
		case "terminals":
			return catalog.owns(request.channel) ? terminals.list(request.channel) : [];
		case "channel": {
			if (WORKER.has(request.request.op)) throw new Error(`Unknown request ${request.request.op}`);
			// Only a watch streams; other requests must not leave watchers behind in relays.
			const watch: Watch | undefined = request.request.op === "watch"
				? {
					event: (event) => send({ id, event }),
					// After the accepted reply, a failure for the same id tells the client its watch ended.
					closed: (error) => {
						log("debug", "gateway.watch.closed", {
							trace,
							user: client.user,
							peer: client.peer,
							channel: request.channel,
							error,
						});
						send({ id, ok: false, error });
					},
				}
				: undefined;
			if (catalog.owns(request.channel)) {
				if (!await mayOpen(client, request.channel)) {
					throw new Error("You don't have access to this channel's project");
				}
				if (request.request.op === "kill") {
					if (client.user !== catalog.user) throw new Error("Only the channel's owner can kill it");
					terminals.closeChannel(request.channel);
				}
				const forwarded = authored(request.request, client.user);
				const target = await connection(client, request.channel);
				return target.request(forwarded, watch, trace);
			}
			// A hosted channel outlives its host's reachability, so connect to its service directly rather than
			// through the host. A reachable host's listing is current; otherwise the directory or that host's
			// last listing says where it runs.
			const known = !client.peer
				&& (peers.listings().find((value) => value.id === request.channel)
					|| [...directory.read().channels, ...peers.unreachable()].find((value) =>
						value.id === request.channel && value.hosted
					));
			const hosted = known && known.hosted ? known : undefined;
			if (hosted) {
				if (!(await visible([hosted])).length) {
					throw new Error("You don't have access to this channel's project");
				}
				if (request.request.op === "kill" && client.user !== hosted.owner) {
					throw new Error("Only the channel's owner can kill it");
				}
				const forwarded = authored(request.request, client.user);
				const target = await connection(client, request.channel, hosted.hosted);
				return target.request(forwarded, watch, trace);
			}
			const machine = !client.peer && peers.find(request.channel);
			if (!machine) throw new Error("No reachable host runs that channel");
			const listing = peers.listings().find((value) => value.id === request.channel)!;
			if (!(await visible([listing])).length) {
				throw new Error("You don't have access to this channel's project");
			}
			const target = await remote(client, machine.name);
			return target.channel(request.channel, request.request, watch, trace);
		}
		case "release": {
			const open = client.channels.get(request.channel);
			client.channels.delete(request.channel);
			if (open) return void (await open).close();
			const machine = peers.find(request.channel);
			const target = machine && client.remotes.get(machine.name);
			if (target?.status === "open") await target.request(request);
			return;
		}
	}
}

function websocket(): Bun.WebSocketHandler<Client> {
	return {
		// Past the limit Bun drops frames silently, and a watch that loses one, such as a run's end,
		// stays wrong; closing makes the client reconnect and re-watch. Screenshot-heavy chats replay
		// tens of megabytes to a renderer that reads slowly while it draws them.
		backpressureLimit: 128 * 1024 * 1024,
		closeOnBackpressureLimit: true,
		open(socket) {
			if (socket.data.lobby) return served.opened(socket);
			sockets.add(socket);
			log("info", "gateway.open", { user: socket.data.user, peer: socket.data.peer });
			if (socket.data.peer) return;
			void queue(async () => {
				socket.send(JSON.stringify({ projects: await projects.list() } satisfies HostFrame));
				socket.send(JSON.stringify({ people: people() } satisfies HostFrame));
				socket.send(JSON.stringify({ presence: present() } satisfies HostFrame));
				if (socket.data.local) {
					socket.send(JSON.stringify({ asks: asks.list() } satisfies HostFrame));
				}
			});
		},
		async message(socket, raw) {
			if (socket.data.lobby) return served.received(socket, raw);
			const { id, trace: given, ...request } = JSON.parse(String(raw)) as HostEnvelope;
			// A peer host's trace continues here, so one request reads across both machines' logs.
			const trace = given || crypto.randomUUID().slice(0, 8);
			const send = (frame: HostFrame) =>
				socket.readyState === 1 && socket.send(JSON.stringify(frame));
			const start = Date.now();
			const fields = {
				trace,
				user: socket.data.user,
				peer: socket.data.peer,
				op: request.op,
				...("channel" in request ? { channel: request.channel } : {}),
				...(request.op === "channel" ? { request: request.request.op } : {}),
			};
			// Listing and watching repeat constantly; everything else is a deliberate action.
			const quiet = request.op === "channels" || request.op === "projects"
				|| request.op === "window" || request.op === "windows" || request.op === "tab-result"
				|| request.op === "hello" || request.op === "models"
				|| request.op === "release" || request.op === "terminal-input"
				|| request.op === "terminal-resize"
				|| (request.op === "channel"
					&& ["watch", "info", "models", "typing"].includes(request.request.op));
			const handling = handle(socket, request, send, id, trace);
			pending.add(handling);
			try {
				const value = await handling;
				log(quiet ? "debug" : "info", "gateway.request", { ...fields, ms: Date.now() - start });
				send({ id, ok: true, value: value ?? null });
			} catch (error) {
				log("warn", "gateway.failed", { ...fields, ms: Date.now() - start, ...failure(error) });
				send({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
			} finally {
				pending.delete(handling);
			}
		},
		close(socket, code) {
			if (socket.data.lobby) return served.left(socket);
			sockets.delete(socket);
			windows.drop(socket);
			if (socket.data.peer) asks.drop(socket, asksChanged);
			if (!socket.data.peer) lobbyChanged();
			log("info", "gateway.close", { user: socket.data.user, peer: socket.data.peer, code });
			for (const open of socket.data.channels.values()) {
				open.then((connection) => connection.close(), () => {});
			}
			for (const remote of socket.data.remotes.values()) remote.close();
			for (const detach of socket.data.terminals.values()) detach();
		},
	};
}

function client(user: string, peer: boolean, local = false, machine?: string): Client {
	return {
		user,
		peer,
		local,
		machine,
		channels: new Map(),
		remotes: new Map(),
		terminals: new Map(),
	};
}

async function serveApp(url: URL): Promise<Response> {
	const dir = config.app;
	if (!existsSync(dir)) {
		return new Response("The app is not built; run bun app build", { status: 404 });
	}
	const file = Bun.file(join(dir, url.pathname));
	const headers = {
		"Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
	};
	if (url.pathname !== "/" && !url.pathname.includes("..") && await file.exists()) {
		return new Response(file, { headers });
	}
	return new Response(Bun.file(join(dir, "index.html")), { headers });
}

/** The owner's listener: loopback only, serving the app. */
function owner(port: number): Server<Client> {
	const access = auth.owner(port);
	return Bun.serve<Client>({
		port,
		hostname: "127.0.0.1",
		async fetch(request, server) {
			if (!access.accepts(request)) return new Response("Forbidden", { status: 403 });
			const url = new URL(request.url);
			if (url.pathname === "/health") {
				const challenge = request.headers.get("x-ace-challenge");
				if (challenge && !/^[a-f0-9]{64}$/.test(challenge)) {
					return new Response("Bad challenge", { status: 400 });
				}
				const info: HostInfo = {
					app: "ace",
					protocol: HOST_PROTOCOL,
					home: catalog.home,
					pid: process.pid,
					helper: config.helper,
					version: config.version,
				};
				return Response.json(info, {
					headers: challenge ? { "x-ace-proof": access.proof(info, challenge) } : undefined,
				});
			}
			if (url.pathname === "/ws") {
				// The body names this build's command, so a signed-out page can say what to run.
				if (!access.authorizes(request)) return new Response(config.command, { status: 401 });
				const protocols = request.headers.get("sec-websocket-protocol")?.split(",").map((value) =>
					value.trim()
				);
				return server.upgrade(request, {
						data: client(catalog.user, false, true),
						headers: {
							"set-cookie": access.cookie,
							...(protocols?.includes("ace") ? { "sec-websocket-protocol": "ace" } : {}),
						},
					})
					? undefined
					: new Response("Upgrade failed", { status: 400 });
			}
			return serveApp(url);
		},
		websocket: websocket(),
	});
}

/**
 * The team's listener on this machine's tailnet address. Tailscale names the person behind each
 * connection. Sockets without an Origin are peer hosts. Browser sockets are the owner's own
 * devices, and only from a page this host or the configured web app served (see web.ts).
 */
function team(machine: Machine, listener: web.Listener, tls?: Bun.TLSOptions): Server<Client> {
	const hosts = web.hosts(machine, listener);
	return Bun.serve<Client>({
		port: listener.port,
		hostname: machine.address,
		...(tls ? { tls } : {}),
		async fetch(request, server) {
			const url = new URL(request.url);
			const origin = request.headers.get("origin");
			if (url.pathname.startsWith("/directory/") && origin === null) {
				return directoryRequest(url.pathname.slice("/directory".length), request, server);
			}
			if (url.pathname !== "/ws") {
				if (request.method !== "GET" || !hosts.has(request.headers.get("host") ?? "")) {
					return new Response("Not found", { status: 404 });
				}
				return serveApp(url);
			}
			// A page asks over plain HTTP, without an Origin, why its socket was refused (host.ts).
			const socket = request.headers.get("upgrade")?.toLowerCase() === "websocket";
			if (
				origin === null ? socket && listener.secure : !web.origins(machine, listener).has(origin)
			) {
				return new Response("Forbidden", { status: 403 });
			}
			const ip = server.requestIP(request);
			if (!ip) return new Response("Forbidden", { status: 403 });
			let user: string;
			let from: string;
			try {
				({ login: user, host: from } = await whois(ip.address, ip.port));
			} catch (error) {
				log("warn", "gateway.whois", { address: ip.address, ...failure(error) });
				return new Response("Forbidden", { status: 403 });
			}
			const browser = origin !== null || !socket;
			if (browser && user !== catalog.user) {
				log("warn", "gateway.browser.refused", { user, origin });
				return new Response(`This is ${catalog.user}'s host. Open Ace from your own host.`, {
					status: 403,
				});
			}
			return server.upgrade(request, { data: client(user, !browser, false, from) })
				? undefined
				: new Response("Upgrade failed", { status: 400 });
		},
		websocket: websocket(),
	});
}

/** The directory this host may serve; only hosts reach it, named by Tailscale. */
async function directoryRequest(
	path: string,
	request: Request,
	server: Server<Client>,
): Promise<Response | undefined> {
	const ip = server.requestIP(request);
	if (!ip) return new Response("Forbidden", { status: 403 });
	let caller: served.Caller;
	try {
		caller = await whois(ip.address, ip.port);
	} catch (error) {
		log("warn", "directory.whois", { address: ip.address, ...failure(error) });
		return new Response("Forbidden", { status: 403 });
	}
	const project = served.lobbyOf(path);
	if (project === undefined) return served.handle(path, request, caller, directoryMembers);
	if (!served.isServing()) return new Response("This host serves no directory", { status: 404 });
	const data = {
		...client(caller.login, true, false, caller.host),
		lobby: { project, caller, presence: null },
	};
	return server.upgrade(request, { data })
		? undefined
		: new Response("Upgrade failed", { status: 400 });
}

/** A port already taken names its listener, so the person can tell which Ace holds it. */
async function listen(port: number): Promise<Server<Client>> {
	try {
		return owner(port);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
		const info = await health(port).catch((conflict: Error) => conflict);
		if (info instanceof HostConflict) {
			throw new Error(`${info.message} Leave it running and choose another --port.`, {
				cause: error,
			});
		}
		if (info instanceof Error) {
			throw new Error(`${info.message}. Choose another --port.`, { cause: error });
		}
		throw new Error(
			info
				? `Port ${port} already has this host's gateway (PID ${info.pid}).`
				: `Port ${port} is in use. Choose another --port.`,
			{ cause: error },
		);
	}
}

/** The port of the host serving this home, so a second host on another port finds it. */
const SERVED = () => join(config.home, "host.port");

/** Two hosts on one home would run the same channels' workers and stores twice; the first keeps it. */
async function claim(port: number) {
	const held = Number(await Bun.file(SERVED()).text().catch(() => ""));
	if (!held || held === port) return;
	const info = await health(held).catch((error) =>
		error instanceof HostConflict ? error : undefined
	);
	if (info?.home !== config.home) return;
	const listener = info instanceof HostConflict ? info.listener : describe(info);
	throw new Error(
		`${config.home} is already served by ${listener.text} on port ${held}. Stop it, or set ACE_HOME to give this host its own data directory.`,
	);
}

/**
 * `loopback` keeps a disposable host off the team: no tailnet listener, peer discovery, directory
 * entry, or lobby presence. A second host on this machine would otherwise publish under the
 * machine's tailnet name.
 */
export async function serve(port: number, loopback = false, script?: string): Promise<never> {
	config.port = port;
	loopback ||= !catalog.tailnet;
	config.loopback = loopback;
	// Channel workers and agent shells reach this listener for the owner's windows.
	process.env.ACE_PORT = String(port);
	// Hosted channels run tools in this process.
	seal();
	openLog("host");
	const scripted = script === undefined ? undefined : demo.read(script);
	await claim(port);
	await resume();
	const server = await listen(port);
	await Bun.write(SERVED(), String(server.port));
	log("info", "host.start", { port: server.port, user: catalog.user, bun: Bun.version });
	if (shell.state === "pending") {
		log("warn", "host.shell", { error: shell.error });
		void retryLoginShell(() => {
			// The shell's environment can carry credentials again; they must leave it before tools run.
			seal();
			log("info", "host.shell.adopted");
		}).then(() => {
			if (shell.state === "failed") log("error", "host.shell", { error: shell.error });
		});
	}
	const servers = [server];
	const cleanup: (() => void)[] = [];
	// A blocked event loop fails the desktop's health check, which then cannot tell a busy helper from a stopped one.
	let tick = performance.now();
	const stalls = setInterval(() => {
		const now = performance.now();
		if (now - tick > 2000) log("warn", "host.stall", { ms: Math.round(now - tick - 1000) });
		tick = now;
	}, 1000);
	cleanup.push(() => clearInterval(stalls));
	async function stop(code = 0) {
		if (closing) return;
		closing = true;
		log("info", "host.stop", { pending: pending.size });
		for (const close of cleanup) close();
		await Promise.allSettled(servers.map((server) => server.stop(true)));
		await Promise.allSettled(pending);
		const results = await Promise.allSettled([workspace.close(), shutdown(), terminals.closeAll()]);
		for (const result of results) {
			if (result.status === "rejected") {
				log("error", "host.shutdown.failed", failure(result.reason));
			}
		}
		process.exit(results.some((result) => result.status === "rejected") ? 1 : code);
	}
	process.on("SIGTERM", () => void stop());
	process.on("SIGINT", () => void stop());
	// The owner's login, the channels' tailnet, and every tailnet listener are read once at startup.
	cleanup.push(tailscale(catalog.tailnet, (tailnet) => {
		log("info", "host.tailnet.moved", { from: catalog.tailnet, to: tailnet });
		// launchd starts Ace Helper again after a failed exit, which picks up the new tailnet.
		if (config.helper) void stop(75);
		else console.log(`Tailscale is on ${tailnet} now. Restart ace serve to use it.`);
	}));
	console.log(`Ace on http://${server.hostname}:${server.port}`);
	// Ace Helper's console is its log file, which must not hold the token.
	if (!config.helper) {
		const signIn = auth.appUrl(server.port);
		signIn.hash = new URLSearchParams({ token: auth.token() }).toString();
		console.log(`Sign in at ${signIn.href}`);
	}
	if (loopback) {
		log("info", "host.tailnet", { loopback: true });
		console.log(
			"Loopback only: not listening on the tailnet, finding peers, or publishing to the directory",
		);
	}
	const machine = loopback ? undefined : await self();
	if (closing) return new Promise(() => {});
	if (machine) {
		name = machine.name;
		access.identify(name);
	}
	const address = machine ? { address: machine.address } : {};
	const publish = loopback ? undefined : directory.watch({
		self: () => ({ name, login: catalog.user, github: github.login(loginChanged), ...address }),
		channels: local,
		changed: () => void sharesChanged(),
		chose: settingsChanged,
		published: (before, after) => before && lobby.published(before, after),
		covered: lobby.isCovered,
	});
	if (publish) {
		log(
			"info",
			"host.tailnet",
			machine ? { name, address: machine.address } : { tailscale: false },
		);
		cleanup.push(publish.stop);
		cleanup.push(lobby.watch({
			host: () => name,
			changed: presenceChanged,
			listed: () => void ownersChanged(),
			resync: () => void publish.sync(),
		}));
		void queue(() => lobbyProjects());
	}
	if (machine) {
		servers.push(team(machine, { port, secure: false }));
		web.served(machine, { port, secure: false });
		const address = isIP(machine.address) === 6 ? `[${machine.address}]` : machine.address;
		servedUrl = `http://${address}:${port}/directory`;
		console.log(`Sharing with the tailnet on ${machine.address}:${port} as ${machine.login}`);
		console.log(`Your devices can open http://${machine.dns}:${port}`);
		cleanup.push(peers.watch(() => void ownersChanged()));
		const tls = await web.tls(machine);
		if (tls && !closing) {
			const listener = { port: config.webPort ?? port + 1000, secure: true };
			servers.push(team(machine, listener, tls));
			web.served(machine, listener);
			console.log(`and ${web.address}`);
		}
	} else if (!loopback) {
		console.log("Tailscale is not running; channels stay on this machine");
	}
	if (scripted) {
		cleanup.push(demo.start(scripted, script!, {
			project: projectOfChannel,
			changed: () => {
				peopleChanged();
				presenceChanged();
			},
		}));
	}
	mkdirSync(join(catalog.home, "channels"), { recursive: true });
	// Workers create and remove their sockets; tell clients when a channel starts or retires.
	const watcher = watch(join(catalog.home, "channels"), { recursive: true }, (_, file) => {
		if (closing || updating) return;
		if (file?.endsWith("channel.sock") || file?.endsWith("channel.json")) void broadcast();
		if (file?.endsWith("channel.json")) {
			void projectsChanged();
			workspace.sync();
			void publish?.sync();
		}
	});
	cleanup.push(() => watcher.close());
	// A crashed worker leaves its socket and projection behind without a filesystem event.
	// Probe only process liveness: sidebar observation must never attach to or wake a worker.
	let crashed = new Set<string>();
	const liveness = setInterval(() => {
		if (closing || updating) return;
		const current = new Set<string>();
		for (const record of catalog.list()) {
			if (!record.hosted && record.busy && !isWorkerAlive(record.id)) current.add(record.id);
		}
		// Do not overwrite a replacement worker's projection after observing its predecessor die.
		if (current.size !== crashed.size || [...current].some((id) => !crashed.has(id))) {
			void broadcast();
		}
		crashed = current;
	}, 5000);
	cleanup.push(() => clearInterval(liveness));
	workspace.sync();
	return new Promise(() => {});
}
