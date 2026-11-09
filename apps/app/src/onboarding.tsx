import { useEffect, useState, useSyncExternalStore } from "react";

import { Button, Dialog, DialogContent, Input } from "@ace/ui";
import { IconCheck, IconDatabase, IconLaptop, IconLoader, IconX } from "@ace/ui/icons";
import type { Diagnostics, Member, ProviderId, Settings } from "@ace/host/protocol";

import { host } from "./host";
import { Checks, Choice, Copyable, Footer, Header, Link, Pill } from "./team-setup";

const DOWNLOAD = "https://ace.githubnext.com";
const TAILSCALE_USERS = "https://login.tailscale.com/admin/users";
/** Opens Create directory from anywhere: the sidebar card, an offline channel, or Settings. */
export const CREATE_DIRECTORY = "ace:create-directory";

/**
 * The directory as this host last reported it; undefined until the host answers. The host tells
 * its apps when it joins or leaves one, whether from this app, another window, the CLI, or an
 * approved ask.
 */
export function useDirectory(): Diagnostics["directory"] | undefined {
	const status = useSyncExternalStore(host.subscribe, () => host.status);
	const version = useSyncExternalStore(host.subscribe, () => host.settingsVersion);
	const [directory, setDirectory] = useState<Diagnostics["directory"]>();
	useEffect(() => {
		if (status !== "open") return;
		let live = true;
		host.request<Diagnostics>({ op: "diagnostics" }).then(
			(value) => live && setDirectory(value.directory),
			() => {},
		);
		return () => {
			live = false;
		};
	}, [status, version]);
	return directory;
}

/** This host and everyone else running Ace on the tailnet, asked again while shown. */
export function useRoster(): Member[] | undefined {
	// The host sends listings when a peer comes or goes and settings when the directory changes, so
	// People turns Offline with the sidebar and lists a host that joins the directory this one serves.
	const channels = useSyncExternalStore(host.subscribe, () => host.channels);
	const version = useSyncExternalStore(host.subscribe, () => host.settingsVersion);
	const [roster, setRoster] = useState<Member[]>();
	useEffect(() => {
		let live = true;
		const load = () =>
			host.request<Member[]>({ op: "team-roster" }).then(
				(value) => live && setRoster(value),
				() => {},
			);
		void load();
		// Peers are found every 15 seconds, so a teammate opening Ace shows up while this is open.
		const timer = setInterval(load, 15_000);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [channels, version]);
	return roster;
}

function Person({ member }: { member: Member }) {
	return (
		<span className="relative size-7 shrink-0">
			{member.github
				? (
					<img
						src={`https://github.com/${member.github}.png?size=56`}
						alt=""
						className="size-7 rounded-full bg-muted"
					/>
				)
				: (
					<span className="grid size-7 place-items-center rounded-full bg-muted text-xs font-medium uppercase">
						{member.login[0]}
					</span>
				)}
			<span
				className={`absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background ${
					member.online ? "bg-primary" : "bg-muted-foreground/50"
				}`}
			/>
		</span>
	);
}

function name(member: Member): string {
	return member.github || member.login.split("@")[0]!;
}

export function People({ roster, status }: {
	roster: Member[] | undefined;
	status?: (member: Member) => string;
}) {
	if (!roster) return <p className="text-xs text-muted-foreground">Looking for your team…</p>;
	return (
		<ul className="flex flex-col divide-y divide-border/60 rounded-lg border bg-card">
			{roster.map(member => (
				<li key={member.host} className="flex items-center gap-3 px-3.5 py-2.5">
					<Person member={member} />
					<div className="flex min-w-0 flex-1 flex-col">
						<span className="truncate text-sm font-medium">{name(member)}</span>
						<span className="truncate text-xs text-muted-foreground">{member.host}</span>
					</div>
					<span className="text-xs text-muted-foreground">
						{status?.(member) || (member.self ? "This Mac" : member.online ? "Online" : "Offline")}
					</span>
				</li>
			))}
		</ul>
	);
}

const PROVIDERS: { id: ProviderId; label: string; placeholder: string }[] = [
	{ id: "anthropic", label: "Anthropic", placeholder: "sk-ant-…" },
	{ id: "openai", label: "OpenAI", placeholder: "sk-…" },
];

/** First run: the checks and a model key, then the team the tailnet already is. */
export function Welcome({ github, onClose }: { github?: string; onClose: () => void }) {
	const [step, setStep] = useState<"key" | "team">("key");
	const [provider, setProvider] = useState<ProviderId>("anthropic");
	const [value, setValue] = useState("");
	const [saving, setSaving] = useState<{
		busy?: boolean;
		error?: string;
		saved?: ProviderId;
		environment?: boolean;
		subscription?: boolean;
	}>({});
	const roster = useRoster();

	useEffect(() => {
		host.request<Settings>({ op: "settings" }).then((settings) => {
			const found = settings.providers.find(({ source, subscription }) =>
				subscription || source === "keychain" || source === "environment"
			);
			if (found) {
				setSaving({
					saved: found.id,
					environment: found.source === "environment",
					subscription: found.subscription,
				});
			}
		}, () => {});
	}, []);

	async function save() {
		setSaving({ busy: true });
		try {
			await host.request({ op: "key-set", provider, value: value.trim() });
			setValue("");
			setSaving({ saved: provider });
		} catch (error) {
			setSaving({ error: (error as Error).message });
		}
	}

	const label = (id: ProviderId) => PROVIDERS.find(entry => entry.id === id)!.label;
	return (
		<Dialog open onOpenChange={next => next || onClose()}>
			<DialogContent className="gap-4 sm:max-w-[34rem]">
				{step === "key" && (
					<>
						<Checks github={github} />
						<Header
							title="Welcome to Ace"
							description="Agents in your channels run on this Mac with your own model credentials."
						/>
						<form
							className="flex flex-col gap-2 rounded-lg border bg-card px-3.5 py-3"
							onSubmit={(event) => {
								event.preventDefault();
								void save();
							}}
						>
							<div className="flex gap-1.5">
								{PROVIDERS.map(({ id, label }) => (
									<Button
										key={id}
										type="button"
										size="sm"
										variant="outline"
										aria-pressed={provider === id}
										className={`border ${provider === id ? "border-primary text-primary" : ""}`}
										onClick={() => setProvider(id)}
									>
										{label}
									</Button>
								))}
							</div>
							<div className="flex gap-2">
								<Input
									type="password"
									autoComplete="new-password"
									spellCheck={false}
									aria-label={`${label(provider)} API key`}
									className="font-mono text-xs"
									placeholder={saving.saved
										? `${label(saving.saved)} configured. Paste an API key to save it`
										: PROVIDERS.find(entry => entry.id === provider)!.placeholder}
									value={value}
									disabled={saving.busy}
									onChange={(event) => setValue(event.target.value)}
								/>
								<Button type="submit" variant="outline" disabled={saving.busy || !value.trim()}>
									{saving.busy ? "Checking…" : "Save"}
								</Button>
							</div>
							{saving.error && (
								<p role="alert" className="text-xs text-destructive">{saving.error}</p>
							)}
							{saving.saved && !saving.error && (
								<span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
									<IconCheck className="size-3.5 text-primary" aria-hidden />
									{saving.subscription
										? "Using your ChatGPT subscription."
										: saving.environment
										? `Using the ${label(saving.saved)} key from Ace Helper's environment.`
										: `${label(saving.saved)} key works. Saved in Keychain.`}
								</span>
							)}
						</form>
						<Footer
							back={!saving.saved && (
								<Button variant="ghost" onClick={() => setStep("team")}>Chat only for now</Button>
							)}
							next={
								<Button disabled={!saving.saved} onClick={() => setStep("team")}>Continue</Button>
							}
						/>
					</>
				)}
				{step === "team" && (
					<>
						<Header
							title="Your team is your tailnet"
							description="Everyone on your tailnet who runs Ace is on your team. There's nothing to join."
						/>
						<People roster={roster} />
						<p className="text-xs leading-5 text-muted-foreground">
							Add people in the{" "}
							<Link href={TAILSCALE_USERS}>Tailscale admin console</Link>, and they show up here
							when they open Ace.
						</p>
						<Footer
							back={<Button variant="ghost" onClick={() => setStep("key")}>Back</Button>}
							next={<Button onClick={onClose}>Start</Button>}
						/>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

/**
 * Sidebar footer while this host has no directory: rejoin the one it still serves, join the one a
 * teammate's host names, or create one when nobody has.
 */
export function DirectoryCard(
	{ serving, offered, onDismiss, onChange }: {
		serving: boolean;
		offered?: { url: string; host: string };
		onDismiss: () => void;
		onChange: () => void;
	},
) {
	const [joining, setJoining] = useState(false);
	const [error, setError] = useState("");

	async function join(url?: string) {
		setJoining(true);
		setError("");
		try {
			await host.request(
				url ? { op: "directory-set", url } : { op: "directory-serve", serve: true },
			);
		} catch (error) {
			setError((error as Error).message);
		} finally {
			setJoining(false);
		}
	}

	return (
		<div className="m-2 flex shrink-0 flex-col gap-2 rounded-lg border bg-card p-3">
			<div className="flex items-center gap-2">
				<IconDatabase className="size-3.5 shrink-0 text-primary" aria-hidden />
				<span className="flex-1 text-xs font-medium">Team directory</span>
				<button
					type="button"
					aria-label="Dismiss"
					className="text-muted-foreground hover:text-foreground"
					onClick={onDismiss}
				>
					<IconX className="size-3.5" aria-hidden />
				</button>
			</div>
			{/* `ace directory off` leaves the directory this Mac still serves; Join serves it again. */}
			{serving || offered
				? (
					<>
						<p className="text-xs leading-5 text-muted-foreground">
							{serving
								? "This Mac serves your team's directory but isn't in it"
								: `${offered?.host} serves your team's directory. This Mac isn't in it`}, so its
							channels aren't listed while it's offline.
						</p>
						{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
						<div className="flex gap-2">
							<Button
								size="sm"
								className="flex-1"
								disabled={joining}
								onClick={() => void join(serving ? undefined : offered?.url)}
							>
								{joining ? "Joining…" : "Join"}
							</Button>
							<Button
								size="sm"
								variant="outline"
								className="flex-1 border"
								disabled={joining}
								onClick={onChange}
							>
								Change…
							</Button>
						</div>
					</>
				)
				: (
					<>
						<p className="text-xs leading-5 text-muted-foreground">
							Keep channels listed while Macs are offline, and share projects.
						</p>
						<Button
							size="sm"
							variant="outline"
							className="border"
							onClick={() => window.dispatchEvent(new Event(CREATE_DIRECTORY))}
						>
							Create directory
						</Button>
					</>
				)}
		</div>
	);
}

/** A channel whose host is offline; without a directory, why it can't be listed reliably. */
export function OfflineHost({ name, host: machine }: { name: string; host: string }) {
	const directory = useDirectory();
	return (
		<div
			className="grid h-full place-content-center justify-items-center gap-5 px-6 text-center"
			role="status"
		>
			<div className="flex flex-col items-center gap-2">
				<IconLaptop className="size-6 text-muted-foreground" aria-hidden />
				<p className="text-base font-medium">{machine} is offline</p>
				<p className="max-w-sm text-sm text-muted-foreground">
					{name} runs on that Mac. Its chat opens here when the Mac is back.
				</p>
			</div>
			{directory && !directory.url && !directory.offered && (
				<div className="flex max-w-sm flex-col gap-3 rounded-lg border bg-card p-4 text-left">
					<div className="flex items-start gap-2.5">
						<IconDatabase className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
						<p className="text-xs leading-5 text-muted-foreground">
							<span className="font-medium text-foreground">Your team has no directory.</span>{" "}
							Ace only knows channels it saw while their Mac was online. A directory keeps every
							channel listed while Macs are offline.
						</p>
					</div>
					<Button size="sm" onClick={() => window.dispatchEvent(new Event(CREATE_DIRECTORY))}>
						Create directory
					</Button>
				</div>
			)}
		</div>
	);
}

/** Where the directory runs; teammates' hosts find it through their peers, with nothing to send. */
export function CreateDirectory({ onAdd, onClose }: { onAdd: () => void; onClose: () => void }) {
	const [step, setStep] = useState<"where" | "machine" | "done">("where");
	const [where, setWhere] = useState<"here" | "machine">("here");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [url, setUrl] = useState("");
	const roster = useRoster();

	async function serve() {
		setBusy(true);
		setError("");
		try {
			setUrl(await host.request<string>({ op: "directory-serve", serve: true }));
			setStep("done");
		} catch (error) {
			setError((error as Error).message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open onOpenChange={next => next || busy || onClose()}>
			<DialogContent className="gap-4 sm:max-w-[34rem]">
				{step === "where" && (
					<>
						<Header
							title="Create your team's directory"
							description="It lists every channel, shares projects, and shows who's around. It runs on your tailnet, so only your team can reach it."
						/>
						<div role="radiogroup" className="flex flex-col gap-2">
							<Choice
								selected={where === "here"}
								onSelect={() => setWhere("here")}
								title="This Mac"
							>
								Nothing to deploy. Pauses while this Mac is offline.
							</Choice>
							<Choice
								selected={where === "machine"}
								onSelect={() => setWhere("machine")}
								title={
									<>
										A machine that stays on <Pill recommended>Best for teams</Pill>
									</>
								}
							>
								A Mac mini or server on your tailnet that runs Ace.
							</Choice>
						</div>
						{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
						<Footer
							back={<Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>}
							next={
								<Button
									disabled={busy}
									onClick={() => where === "here" ? void serve() : setStep("machine")}
								>
									{busy
										? <IconLoader className="size-3.5 animate-spin" aria-hidden />
										: where === "here"
										? "Create"
										: "Continue"}
								</Button>
							}
						/>
					</>
				)}
				{step === "machine" && (
					<>
						<Header
							title="Run it on a machine that stays on"
							description="Any Mac on your tailnet can serve the directory for everyone."
						/>
						<ol className="flex list-decimal flex-col gap-3 pl-5 text-sm marker:text-muted-foreground">
							<li>
								<div>
									Install Ace on that machine and sign it in to your tailnet
									<div className="mt-2">
										<Copyable value={DOWNLOAD} />
									</div>
								</div>
							</li>
							<li>On it, open Ace and choose Create directory → This Mac</li>
						</ol>
						<p className="text-xs leading-5 text-muted-foreground">
							This Mac joins it on its own once that machine is on the tailnet.
						</p>
						<Footer
							back={<Button variant="ghost" onClick={() => setStep("where")}>Back</Button>}
							next={<Button onClick={onClose}>Done</Button>}
						/>
					</>
				)}
				{step === "done" && (
					<>
						<Header
							title="Your team's directory is running"
							description="Teammates' Macs find it on the tailnet. There's nothing to send."
						/>
						<Copyable value={url} />
						<People
							roster={roster}
							status={(member) =>
								member.self ? "Serving" : member.online ? "Joins now" : "Joins when online"}
						/>
						<Footer
							back={<Button variant="ghost" onClick={onAdd}>Add a teammate</Button>}
							next={<Button onClick={onClose}>Done</Button>}
						/>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** Getting someone onto the team is getting them onto the tailnet. */
export function AddTeammate({ onClose }: { onClose: () => void }) {
	return (
		<Dialog open onOpenChange={next => next || onClose()}>
			<DialogContent className="gap-4 sm:max-w-[30rem]">
				<Header
					title="Add a teammate"
					description="Anyone on your tailnet who runs Ace is on your team."
				/>
				<ol className="flex list-decimal flex-col gap-3 pl-5 text-sm marker:text-muted-foreground">
					<li>
						Add them in the <Link href={TAILSCALE_USERS}>Tailscale admin console</Link>
					</li>
					<li>
						<div>
							Send them the download
							<div className="mt-2">
								<Copyable value={DOWNLOAD} />
							</div>
						</div>
					</li>
				</ol>
				<p className="text-xs leading-5 text-muted-foreground">
					They add their own model key, and Ace finds the team when they open it.
				</p>
				<Footer next={<Button onClick={onClose}>Done</Button>} />
			</DialogContent>
		</Dialog>
	);
}
