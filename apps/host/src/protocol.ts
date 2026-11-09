/** The host gateway's wire contract: JSON messages over one WebSocket per client. */
import type {
	ChannelInfo,
	Event,
	GithubFilter,
	GithubKind,
	ModelRef,
	Request,
	RunEnd,
} from "@ace/channel/protocol";
import type { Presence, Share } from "@ace/directory/protocol";

export type { Share };

/** A share's `person` when it gives the whole team access. */
export const TEAM = "*";

export const HOST_PROTOCOL = 10;

/** A watch's `closed` reason when the channel's worker or hosting service ended it, as a restart does. */
export const CHANNEL_CLOSED = "The channel closed the connection";

export type HostInfo = {
	app: "ace";
	protocol: number;
	home: string;
	pid: number;
	helper: boolean;
	/** Ace Helper's app version; outside the proof, so older listeners and clients stay compatible. */
	version?: string;
};

/** A place a channel can move to: "local" for this host, or a hosting service's base URL. */
export type MoveTarget = { target: string; label: string; place: "local" | "hosted" | "cloud" };

export type WorkerInfo = { id: string; pid: number };
/** `freeze` drains admitted requests and exits the worker for a move, or fails if work remains. */
/** Only this host's own processes send these; the gateway refuses them from clients. */
export type WorkerRequest = { op: "worker" } | { op: "freeze" } | { op: "export" };

export type Diagnostics = {
	tools: { name: string; path?: string; version?: string; account?: string; error?: string }[];
	tailscale: {
		state: "missing" | "offline" | "running" | "error";
		name?: string;
		error?: string;
		/** Served with ace serve --loopback: no tailnet listener, peers, or directory entry. */
		loopback?: boolean;
		/**
		 * Tailscale runs on a tailnet the host did not start on, often none: the host reads its tailnet
		 * once, so it needs a restart before it can create or show that tailnet's channels.
		 */
		restart?: boolean;
	};
	/**
	 * `error` is the last directory sync's failure and `failed` when it happened; a successful sync
	 * clears both. `secret` is the team's ACE_SECRET, which also authenticates hosted channels.
	 */
	directory: {
		url?: string;
		/** The Mac serving a tailnet directory, by its tailnet name; unset for a deployed one. */
		server?: string;
		synced?: number;
		error?: string;
		failed?: number;
		secret: CredentialStatus;
		/** The team services the directory named in its last answer; an unnamed one is not set up. */
		services: { hosted?: string; app?: string; compute?: string };
		/** This host serves the team's directory on the tailnet. */
		serving: boolean;
		/** The project shares in the directory this host serves, which stopping it deletes. */
		shares: Share[];
		/** Hosts in the directory's last answer, and when each last published to it; older hosts omit it. */
		hosts?: DirectoryHost[];
		/** A directory a teammate's host names while this host has none, such as after leaving it. */
		offered?: { url: string; host: string };
	};
	/** Whether the helper loaded the login shell's environment; `pending` while it retries. */
	shell: { state: "adopted" | "pending" | "failed"; error?: string };
	/** This host's HTTPS address on the tailnet; unset without a tailnet certificate. */
	web?: string;
	/** This host's plain HTTP address on the tailnet; unset off the tailnet. */
	http?: string;
};

/** A host in the team's directory; `seen` is when it last published there. */
export type DirectoryHost = { name: string; login: string; github?: string; seen: number };

/** `offline`: the channel's host is unreachable. Hosted channels are never offline. */
export type ChannelState = "running" | "dormant" | "archived" | "offline";

export type Listing = {
	id: string;
	/** The machine running the channel, by its tailnet name. */
	host: string;
	name: string;
	/**
	 * The channel's original name, which stays unique on its host across renames. Messages its agent
	 * sends other channels are authored `agent@<prefix>`. Older hosts omit it.
	 */
	prefix?: string;
	summary?: string;
	/** Revision of the channel's projected name and summary. */
	revision?: number;
	owner: string;
	/** The checkout the channel works in, which may be a Git worktree of its project. */
	project: string;
	/** The project `project` belongs to: its repository's main checkout on the channel's host. */
	root?: string;
	/** The project's GitHub repository as owner/name. */
	repo?: string;
	model?: ModelRef;
	created: number;
	/** When the transcript last grew; hosts on older builds omit it. */
	active?: number;
	/** Live channel-wide run projection; absent on older hosts, never authoritative. */
	busy?: boolean;
	/** The latest invoked run's end; absent on older hosts and before a channel's first one. */
	ran?: RunEnd;
	/** The latest message a person or another channel's agent wrote; absent on older hosts. */
	said?: { at: number; author: string };
	/** How many messages have @mentioned each lowercased name; absent on older hosts. */
	mentions?: Record<string, number>;
	state: ChannelState;
	/** The hosting service's base URL, for a hosted channel; `host` is then its workspace. */
	hosted?: string;
	/** The hosting service is the cloud compute beta's, whose container is the workspace. */
	compute?: true;
	/** A cloud compute start or stop under way here; the service refuses the channel until it ends. */
	computing?: "starting" | "stopping";
	/** The cloud compute workspace is stopped; the chat stays readable. Absent on older hosts. */
	stopped?: true;
	/**
	 * Where a move under way is taking the channel: a hosting service's host, "cloud workspace", or
	 * this host's name.
	 */
	moving?: string;
	/** Its peer host stopped answering while relaying a request or watch here; absent on older hosts. */
	stalled?: boolean;
};

/** Hosts before project roots list each checkout as its own project. */
export const root = (channel: Pick<Listing, "project" | "root">) => channel.root || channel.project;

/** Also the project ID that earlier app versions saved for every project. */
export const checkoutId = (host: string, path: string) => JSON.stringify([host, path]);

/**
 * GitHub repository names are case-insensitive and hosts already strip `.git`, so every checkout
 * of one repository is one project. A folder without a GitHub remote belongs to its host. Apps
 * select projects by this ID and hosts name the project's lobby with it, so both must agree.
 */
export const projectId = (host: string, path: string, repo?: string) =>
	repo ? `github:${repo.toLowerCase()}` : checkoutId(host, path);

export const channelProject = (channel: Pick<Listing, "host" | "project" | "root" | "repo">) =>
	projectId(channel.host, root(channel), channel.repo);

/** What the host and the app say about a repository `githubRepo` doesn't recognize. */
export const NOT_GITHUB =
	"Ace clones GitHub repositories. Enter one such as https://github.com/owner/name or owner/name.";

/**
 * The owner/name a GitHub URL, SSH remote, or owner/name names, or undefined for anything else.
 * The app reads it to suggest a clone's folder and the host to clone, so both agree on the name.
 */
export function githubRepo(value: string): string | undefined {
	const text = value.trim();
	const url =
		/^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([^/?#]+)\/([^/?#]+)/i
			.exec(text);
	if (url) return `${url[1]}/${url[2]!.replace(/\.git$/i, "")}`;
	if (/^[^/:@\s]+\/[^/:@\s]+$/.test(text)) return text.replace(/\.git$/i, "");
}

/** Channels idle this long are inactive until their transcript grows again. */
const INACTIVE_AFTER = 6 * 60 * 60_000;

/** The sidebar's Inactive group and the host's Archive inactive share this definition. */
export function isInactive(
	channel: Pick<Listing, "busy" | "active" | "created">,
	now: number,
): boolean {
	return !channel.busy && now - (channel.active || channel.created) > INACTIVE_AFTER;
}

/** `github` is the host owner's GitHub login, when its GitHub CLI is signed in. */
/** `team` is the host of the directory this host joined, never its secret, so peers can ask to join. */
/** `directory` is the joined directory's URL, which a host without one joins if it needs no secret. */
export type Hello = {
	user: string;
	host: string;
	github?: string;
	team?: string;
	directory?: string;
};

/** What joining a team takes: its directory URL and the team secret. */
export type Invite = { url: string; secret: string };

/** A peer whose host is in a team, which this host can ask to join. */
/** A host on the team, by tailnet machine name and owner. */
export type Member = {
	host: string;
	login: string;
	github?: string;
	online: boolean;
	self?: boolean;
};

export type TeamPeer = { host: string; login: string; github?: string; team: string };

/**
 * Long enough to notice the prompt; an unanswered ask then fails instead of waiting forever. The
 * asker's app names when it lapses from this.
 */
export const TEAM_ASK_EXPIRES = 5 * 60_000;

/** Someone on the tailnet asking this host's owner to let them into the team. */
export type TeamAsk = { id: string; login: string; host: string; github?: string; expires: number };

/** GitHub logins by participant (Tailscale login), from this host, its peers, and the directory. */
export type People = Record<string, string>;

/** Tabs belong to a connected client's layout, not the durable channel. */
export type Tab = {
	id: string;
	name: string;
	type: "blank" | "chat" | "diff" | "terminal" | "live";
	/** Selected in its pane; split layouts can show several active tabs. */
	active: boolean;
};

/** `focused` is false while the window is hidden or unfocused; older apps omit it. */
export type WindowState = {
	channel: { id: string; name: string };
	tabs: Tab[];
	focused?: boolean;
};
export type WindowInfo = WindowState & { id: string };
export type TabRename = {
	call: string;
	channel: string;
	tab: string;
	name: string;
	expires: number;
	/** Opens a new tab showing this native window (a CGWindowID) live; `tab` is then empty. */
	live?: number;
};
export type TabResult = { ok: true; value: WindowState } | { ok: false; error: string };

/**
 * Someone on the team and how they can see a project: through GitHub read access or their own
 * folder, which lets them share it, or through a share with the team or with them. No `via` means
 * they can't see it.
 */
export type Person = {
	/** Tailscale login. */
	person: string;
	github?: string;
	via?: "github" | "folder" | "team" | "share";
};

/** `direct` is whether this host's owner can share and unshare the project. */
export type ProjectAccess = { direct: boolean; shares: Share[]; people: Person[] };

/** A folder opened on this host, independent of its channels and provider setup. */
export type Project = {
	/** The repository's main checkout, or the folder itself outside Git. */
	path: string;
	name: string;
	/** The GitHub repository as owner/name. */
	repo?: string;
	/** False until the folder is a Git repository with a commit, which lanes start from. */
	git?: false;
	/** The folder is already a Git repository and needs only its first commit. */
	empty?: true;
	/** The folder without a commit already has a `.gitignore`, so Ace leaves initializing it to its owner. */
	ignored?: true;
};

export type ProviderId = "anthropic" | "openai";

/** Beta: new channels in GitHub projects can run on the team's compute service at `url`. */
export type Compute = { enabled: boolean; url: string | null };

export type CredentialStatus = {
	source: "keychain" | "environment" | "missing" | "unavailable";
	stored: boolean | null;
	override?: string;
	error?: string;
	/** A keychain read is still under way, usually on a macOS prompt; the rest is the last finished read. */
	waiting?: string;
};

export type ProviderSettings = CredentialStatus & {
	id: ProviderId;
	name: string;
	subscription?: true;
	/** The provider rejected the key at its last check, and the key hasn't changed since. */
	rejected?: true;
};

export type Settings = {
	providers: ProviderSettings[];
	model: ModelRef | null;
	modelOverride?: ModelRef;
	models: ModelRef[];
	/** What a new chat on Automatic runs: `modelOverride`, a usable `model`, or Ace's pick. */
	automatic?: ModelRef;
	/** Some keychain reads behind `models` are still under way; `models` uses their last finished reads. */
	waiting?: string;
	error?: string;
};

export type HostRequest =
	| { op: "hello" }
	/** Publish this local client's current channel layout, or unregister it. */
	| { op: "window"; value: WindowState | null }
	/** Connected channel windows on the owner's local gateway. */
	| { op: "windows" }
	| { op: "tab-rename"; window: string; channel: string; tab: string; name: string }
	| { op: "tab-live"; window: string; channel: string; target: number; name: string }
	/** Only the window that received a rename can acknowledge it. */
	| { op: "tab-result"; call: string; result: TabResult }
	| { op: "channels" }
	| { op: "projects" }
	| { op: "project-open"; path: string }
	/** Forget an opened folder; refused while this host has channels in it. */
	| { op: "project-remove"; path: string }
	/** Initialize Git in an opened folder and commit its current files. */
	| { op: "project-init"; path: string }
	/**
	 * Clone a GitHub repository into `path` on this host, or open the matching checkout already
	 * there, then add it like `project-open`. `repo` is anything `githubRepo` reads; the host
	 * expands `~`.
	 */
	| { op: "project-clone"; repo: string; path: string }
	/** Who can see a project by its ID, and whether this host's owner can share it. */
	| { op: "project-access"; project: string }
	/**
	 * Share a project with a person by Tailscale login, or with the team as `TEAM`, or unshare it.
	 * Only someone with direct access can, and peers hear at once so their listings follow.
	 */
	| { op: "project-share"; project: string; person: string; shared: boolean }
	/** From a peer whose owner changed shares: read the directory again. */
	| { op: "shares-changed" }
	/** Resolve a known project's GitHub remote on the machine that holds its checkout. */
	| { op: "project-repo"; project: string; host?: string }
	/** GitHub reads use the local owner's GitHub CLI credentials, never a peer's account. */
	| {
		op: "github-list";
		repo: string;
		kind: GithubKind;
		state: GithubFilter;
		search: string;
		limit: number;
	}
	| { op: "github-detail"; repo: string; kind: GithubKind; number: number }
	| { op: "github-files"; repo: string; number: number }
	| { op: "github-pull"; repo: string; branch: string }
	/** These settings belong to the local owner and are never forwarded to peers. */
	/** `fresh` reads again keys whose last read waited on a prompt; polls leave it out. */
	| { op: "settings"; fresh?: boolean }
	/** `sync` syncs the team directory first, so the answer shows that attempt. */
	| { op: "diagnostics"; sync?: boolean }
	| { op: "key-set"; provider: ProviderId; value: string }
	| { op: "key-check"; provider: ProviderId }
	| { op: "key-remove"; provider: ProviderId }
	/** The cloud compute beta's settings, which hold no secret and so never wait on Keychain. */
	| { op: "compute" }
	/** The projects folder, where a clone by URL goes unless the person picks another folder. */
	| { op: "folder" }
	/** Each field present is saved; the others keep their saved values. */
	| { op: "preferences"; model?: ModelRef | null; compute?: Compute; folder?: string }
	/**
	 * Only this host's loopback clients save or remove keychain items and join or leave the
	 * directory: Ace Helper saves them so it can read them back without a macOS prompt.
	 */
	| { op: "key-store"; name: string; value: string }
	| { op: "key-forget"; name: string }
	| { op: "subscription-save"; value: string }
	| { op: "subscription-remove" }
	/** Join after the directory accepts the URL and secret, or keep the saved secret; null leaves. */
	| { op: "directory-set"; url: string | null; secret?: string }
	/**
	 * Serve the team's directory from this host on the tailnet and join it, or stop serving it.
	 * Answers with its URL; teammates' hosts join it from this host's hello.
	 */
	| { op: "directory-serve"; serve: boolean }
	/**
	 * Deploy the tailnet's directory to the owner's Cloudflare account, then join it. Answers with
	 * the directory URL and the secret to send teammates.
	 */
	| { op: "team-deploy" }
	/** The joined directory's URL and the saved team secret, for the owner to invite a teammate. */
	| { op: "team-invite" }
	/** Peers whose hosts are in a team, for a host that isn't in one yet. */
	| { op: "team-peers" }
	/** This host, hosts running Ace on the tailnet, and hosts the directory lists while offline. */
	| { op: "team-roster" }
	/**
	 * Ask a peer's owner to let this host into their team; on approval it answers with the
	 * directory and secret over the tailnet, and this host joins as with `directory-set`.
	 */
	| { op: "team-ask"; host: string }
	/** Sent by an asking peer host. Answers with the directory URL and secret once the owner approves. */
	| { op: "team-request" }
	| { op: "team-answer"; ask: string; approve: boolean }
	/** Quiesce this helper before replacing its application, or recover a canceled update. */
	| { op: "update-prepare" }
	| { op: "update-cancel" }
	/** Models with credentials on a host; this host when omitted. */
	| { op: "models"; host?: string }
	/** Owner actions; tailnet peers create, archive, and delete channels on their own hosts. */
	/**
	 * `cloud` creates the channel on the cloud compute beta's service, with its workspace there;
	 * `compute-start` then starts that workspace and answers once it is connected, and
	 * `compute-stop` checkpoints and stops it.
	 */
	| { op: "create"; project: string; name?: string; model?: ModelRef; cloud?: true }
	/** A new sibling channel seeded from one this host runs, which resolves to its listing. */
	| { op: "fork"; channel: string }
	| { op: "compute-start"; channel: string }
	| { op: "compute-stop"; channel: string }
	| { op: "archive"; channel: string; archived: boolean }
	/** Archive the project's channels on this host that have no work in progress. */
	| { op: "archive-inactive"; project: string }
	| { op: "delete"; channel: string }
	/** Where the owner can move one of this host's idle channels: "local" or a hosting service URL. */
	| { op: "move-targets"; channel: string }
	/** Resolves once the channel runs at `target`; its watches end and reattach there. */
	| { op: "move"; channel: string; target: string }
	/**
	 * Forward a request to a channel on this host or a peer, starting its worker if dormant. The
	 * channel's host sets every author field to the participant it verified. A `watch` streams
	 * events until a failure frame for its id follows the accepted reply: after `release`, or when
	 * the channel's worker or a relaying host closes. Clients that predate this frame drop it.
	 */
	| { op: "channel"; channel: string; request: Request }
	/**
	 * Open a terminal in a chat's working directory, or reattach to `terminal` and replay its recent
	 * output. Only for channels whose workspace is this host. Output arrives as terminal frames; a
	 * terminal outlives its clients until closed, its shell exits, or it sits unattached too long.
	 */
	| {
		op: "terminal";
		channel: string;
		chat?: number;
		terminal?: string;
		cols: number;
		rows: number;
	}
	/** Keystrokes and pasted text, as UTF-8. */
	| { op: "terminal-input"; terminal: string; data: string }
	| { op: "terminal-resize"; terminal: string; cols: number; rows: number }
	| { op: "terminal-close"; terminal: string }
	/** A channel's running shells on this host, so a window can show those no tab shows. */
	| { op: "terminals"; channel: string }
	/** Drop this client's connection to a channel, ending its watches. */
	| { op: "release"; channel: string };

/** `trace` follows a request through every host and worker that relays it. */
export type HostEnvelope = { id: number; trace?: string } & HostRequest;

export type HostFrame =
	| { id: number; ok: true; value: unknown }
	| { id: number; ok: false; error: string }
	| { id: number; event: Event }
	/** What a pending request waits on, such as keychain access; null once it no longer waits. */
	| { id: number; waiting: string | null }
	| { rename: TabRename }
	/**
	 * Local settings or the joined directory changed; clients reload model availability and the
	 * directory's state without receiving secrets.
	 */
	| { settings: true }
	/** Opened projects belong to the local owner and are never sent to tailnet peers. */
	| { projects: Project[] }
	/** Asks to join the team that wait for the owner, sent to the local app only. */
	| { asks: TeamAsk[] }
	/** Sent to local clients when known GitHub logins change. */
	| { people: People }
	/**
	 * Everyone here in each project whose lobby this host is subscribed to, by project ID. Sent to
	 * local clients on every change; tailnet peers never receive lobby frames.
	 */
	| { presence: Record<string, Presence[]> }
	/**
	 * Pushed when any reachable host's catalog changes. A local client sees every reachable host's
	 * channels; a tailnet peer sees only this host's.
	 */
	| { channels: Listing[] }
	| TerminalFrame;

/**
 * Terminal output as base64, since a chunk can split a UTF-8 sequence; then its exit code. A
 * reattach starts with one `replay` frame of earlier output, whose queries must not be answered.
 */
export type TerminalFrame =
	| { terminal: string; data: string; replay?: true }
	| { terminal: string; exit: number };

export type TerminalOpened = { terminal: string; cwd: string };

/** `attached` while some client shows the shell. */
export type TerminalShell = {
	terminal: string;
	chat?: number;
	cwd: string;
	attached: boolean;
	/** What the shell is running, when a command is in progress. */
	command?: string;
};

export type { ChannelInfo, Event, ModelRef, Presence, Request };
