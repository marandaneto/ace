import { type ComponentType, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
	Button,
	Dialog,
	DialogContent,
	DialogTitle,
	Input,
	Switch,
	type Theme,
	useTheme,
} from "@ace/ui";
import {
	IconArrowDownToLine,
	IconBolt,
	IconGlobe,
	IconKey,
	IconPointer,
	type IconProps,
	IconServer,
	IconSettings,
} from "@ace/ui/icons";
import type { ProviderSettings, Settings as HostSettings } from "@ace/host/protocol";

import { useCompute } from "./compute";
import { desktop } from "./desktop";
import { TeamSettings } from "./directory-settings";
import { useFolder } from "./folder";
import { host } from "./host";
import { HostStatus } from "./host-settings";
import { NativeStatus } from "./native-settings";
import {
	Confirm,
	Group,
	Page,
	Problem,
	Row,
	Segmented,
	Select,
	Status,
	TextRow,
} from "./settings-layout";
import { UpdateSettings } from "./updates";

export type Section = "general" | "providers" | "team" | "beta" | "host" | "computer" | "updates";

type Info = { id: Section; label: string; icon: ComponentType<IconProps>; desktop?: boolean };

const only = (sections: Info[]) => sections.filter((section) => !section.desktop || desktop);

const groups: { label?: string; sections: Info[] }[] = [
	{
		sections: [
			{ id: "general", label: "General", icon: IconSettings },
			{ id: "providers", label: "Providers", icon: IconKey },
			{ id: "team", label: "Team", icon: IconGlobe },
			{ id: "beta", label: "Beta", icon: IconBolt },
		],
	},
	{
		label: desktop ? "This Mac" : "This host",
		sections: only([
			{ id: "host", label: desktop ? "Ace Helper" : "Host", icon: IconServer },
			{ id: "computer", label: "Computer use", icon: IconPointer, desktop: true },
			{ id: "updates", label: "Updates", icon: IconArrowDownToLine, desktop: true },
		]),
	},
];

const labels = Object.fromEntries(
	groups.flatMap((group) => group.sections).map(({ id, label }) => [id, label]),
) as Record<Section, string>;

const themes: { value: Theme; label: string }[] = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

const sources = {
	keychain: "Saved in Keychain",
	environment: "From the environment",
	missing: "Not set",
	unavailable: "Keychain access needed",
};

function Provider({ provider, disabled }: { provider: ProviderSettings; disabled: boolean }) {
	const [value, setValue] = useState("");
	const [editing, setEditing] = useState(false);
	const [confirm, setConfirm] = useState(false);
	const [action, setAction] = useState<{ busy?: boolean; error?: string; message?: string }>({});
	const id = `key-${provider.id}`;
	const locked = disabled || action.busy;

	async function run(op: "key-set" | "key-check" | "key-remove") {
		setAction({ busy: true });
		try {
			await host.request(
				op === "key-set"
					? { op, provider: provider.id, value }
					: { op, provider: provider.id },
			);
			if (op === "key-set") {
				setValue("");
				setEditing(false);
			}
			setConfirm(false);
			setAction({
				message: op === "key-check"
					? "Connection verified."
					: op === "key-remove"
					? "Key removed."
					: "Key saved.",
			});
		} catch (error) {
			setAction({ error: (error as Error).message });
		}
	}

	return (
		<Row
			id={`${id}-label`}
			label={provider.name}
			description={`${
				provider.subscription
					? "ChatGPT subscription saved in Keychain"
					: provider.override
					? `${provider.override} overrides Keychain`
					: sources[provider.source]
			}${!provider.subscription && provider.rejected ? `, but ${provider.name} rejected it` : ""}`}
			footer={
				<>
					{editing && (
						<form
							className="flex flex-col gap-2 @md:flex-row"
							onSubmit={(event) => {
								event.preventDefault();
								void run("key-set");
							}}
						>
							<Input
								id={id}
								autoFocus
								type="password"
								autoComplete="new-password"
								spellCheck={false}
								aria-label={`${provider.name} API key`}
								value={value}
								maxLength={4096}
								disabled={locked}
								placeholder="API key"
								onChange={(event) => setValue(event.target.value)}
								onKeyDown={(event) => {
									if (event.key !== "Escape" || action.busy) return;
									// Escape cancels the key form before it reaches the dialog.
									event.stopPropagation();
									setEditing(false);
									setValue("");
								}}
							/>
							<div className="flex shrink-0 gap-2">
								<Button type="submit" disabled={locked || !value.trim()}>Check and save</Button>
								<Button
									type="button"
									variant="ghost"
									disabled={action.busy}
									onClick={() => {
										setEditing(false);
										setValue("");
									}}
								>
									Cancel
								</Button>
							</div>
						</form>
					)}
					{confirm && (
						<Confirm
							action="Remove key"
							busy={locked}
							onConfirm={() => void run("key-remove")}
							onCancel={() => setConfirm(false)}
						>
							Remove the saved {provider.name} key?
						</Confirm>
					)}
					{provider.id === "openai" && (
						<Status>
							{provider.subscription
								? (
									<>
										Subscription takes priority over API keys. Disconnect with{" "}
										<code>bun ace logout openai</code>.
									</>
								)
								: (
									<>
										Have a ChatGPT subscription? Run <code>bun ace login openai</code>{" "}
										in your terminal, then refresh.
									</>
								)}
						</Status>
					)}
					{provider.waiting && <Status>{provider.waiting}…</Status>}
					{provider.error && <Problem>{provider.error}</Problem>}
					{action.busy && <Status>Checking…</Status>}
					{action.error && <Problem>{action.error}</Problem>}
					{action.message && <Status>{action.message}</Status>}
				</>
			}
		>
			{!provider.subscription
				&& (provider.source === "keychain" || provider.source === "environment") && (
				<Button
					variant="outline"
					aria-label={`Check ${provider.name} connection`}
					disabled={locked}
					onClick={() => void run("key-check")}
				>
					Check
				</Button>
			)}
			{/* A saved key would go unused while the environment overrides it. */}
			{!editing && !provider.override && !provider.subscription && (
				<Button
					variant="outline"
					aria-label={`${provider.stored ? "Replace" : "Add"} ${provider.name} key`}
					disabled={locked}
					onClick={() => {
						setConfirm(false);
						setEditing(true);
					}}
				>
					{provider.stored ? "Replace" : "Add key"}
				</Button>
			)}
			{provider.stored && !confirm && (
				<Button
					variant="ghost"
					aria-label={`Remove ${provider.name} key…`}
					disabled={locked}
					onClick={() => {
						setEditing(false);
						setConfirm(true);
					}}
				>
					Remove…
				</Button>
			)}
		</Row>
	);
}

function DefaultModel({ settings, disabled }: { settings?: HostSettings; disabled: boolean }) {
	const [action, setAction] = useState<{ busy?: boolean; error?: string }>({});
	const chosen = settings?.modelOverride || settings?.model;
	const value = chosen ? `${chosen.provider}/${chosen.modelId}` : "";
	const available = new Set(settings?.models.map((model) => `${model.provider}/${model.modelId}`));

	async function save(value: string) {
		const split = value.indexOf("/");
		const model = value
			? { provider: value.slice(0, split), modelId: value.slice(split + 1) }
			: null;
		setAction({ busy: true });
		try {
			await host.request({ op: "preferences", model });
			setAction({});
		} catch (error) {
			setAction({ error: (error as Error).message });
		}
	}

	return (
		<Row
			id="default-model-label"
			label="Default model"
			description={settings?.modelOverride ? "Set by ACE_MODEL" : "For new chats"}
			footer={
				<>
					{settings?.waiting && <Status>{settings.waiting}…</Status>}
					{action.error && <Problem>{action.error}</Problem>}
				</>
			}
		>
			<Select
				aria-labelledby="default-model-label"
				className="w-64"
				value={value}
				disabled={!settings || disabled || action.busy || !!settings.modelOverride}
				onChange={(event) => void save(event.target.value)}
			>
				<option value="">{settings ? "Automatic" : "Loading…"}</option>
				{value && !available.has(value) && (
					<option value={value} disabled>{value} (unavailable)</option>
				)}
				{settings?.providers.map((provider) => {
					const models = settings.models.filter((model) => model.provider === provider.id);
					if (models.length) {
						return (
							<optgroup key={provider.id} label={provider.name}>
								{models.map(({ modelId }) => (
									<option key={modelId} value={`${provider.id}/${modelId}`}>{modelId}</option>
								))}
							</optgroup>
						);
					}
					const missing = provider.source === "missing" && !provider.subscription;
					return (
						<optgroup
							key={provider.id}
							label={`${provider.name} (${missing ? "no key" : "unavailable"})`}
						>
							<option disabled>
								{provider.subscription
									? "Reconnect with bun ace login openai"
									: `${
										missing ? "Add a key" : "Check its key"
									} in Providers to use ${provider.name} models`}
							</option>
						</optgroup>
					);
				})}
			</Select>
		</Row>
	);
}

function CloudCompute({ disabled }: { disabled: boolean }) {
	const { compute, error } = useCompute();
	const [action, setAction] = useState<{ busy?: boolean; error?: string }>({});
	const [note, setNote] = useState<string>();

	async function save(enabled: boolean, url: string | null) {
		await host.request({ op: "preferences", compute: { enabled, url: url || null } });
	}

	async function link(url: string) {
		setNote(undefined);
		await save(!!compute?.enabled, url);
		setNote(
			url
				? `Saved. ${new URL(url).host} answered as a compute service for this tailnet.`
				: "Cleared.",
		);
	}

	async function toggle(enabled: boolean) {
		setAction({ busy: true });
		try {
			await save(enabled, compute!.url);
			setAction({});
		} catch (error) {
			setAction({ error: (error as Error).message });
		}
	}

	return (
		<Group title="Cloud compute">
			<Row
				id="cloud-compute-label"
				label="Run in cloud"
				description="Offer cloud containers when starting a channel in a GitHub project"
				footer={(error || action.error) && <Problem>{error || action.error}</Problem>}
			>
				<Switch
					aria-labelledby="cloud-compute-label"
					checked={!!compute?.enabled}
					disabled={!compute || disabled || action.busy}
					onCheckedChange={(enabled) => void toggle(enabled)}
				/>
			</Row>
			<TextRow
				label="Service URL"
				type="url"
				placeholder="https://ace-compute.example.workers.dev"
				saved={compute && (compute.url || "")}
				disabled={disabled}
				footer={note && <Status>{note}</Status>}
				onSave={link}
			/>
		</Group>
	);
}

export function Settings(
	{ onClose, initialSection }: { onClose: () => void; initialSection?: Section },
) {
	const status = useSyncExternalStore(host.subscribe, () => host.status);
	const [section, setSection] = useState<Section>(
		// Updates exist only in the desktop app; browsers keep their usual first section.
		(initialSection !== "updates" || desktop ? initialSection : undefined)
			|| (status === "open" ? "general" : "host"),
	);
	// Sections stay mounted after their first visit so in-flight key, helper, and update actions
	// keep their busy state and results; hidden sections stop their own polling.
	const [visited, setVisited] = useState(() => new Set([section]));
	const version = useSyncExternalStore(host.subscribe, () => host.settingsVersion);
	const [retry, setRetry] = useState(0);
	/** Only Refresh reads again a key whose last read waited on a Keychain prompt. */
	const refreshing = useRef(false);
	const [again, setAgain] = useState<"busy" | "done">();
	const [result, setResult] = useState<{ settings?: HostSettings; error?: string }>({});
	const { theme, set: setTheme } = useTheme();
	const { folder, error: folderError } = useFolder();
	const offline = status !== "open";
	const current = useRef<HTMLButtonElement>(null);

	function show(next: Section) {
		setSection(next);
		setVisited((seen) => seen.has(next) ? seen : new Set(seen).add(next));
	}

	useEffect(() => {
		if (!desktop) return;
		const updates = () => show("updates");
		const helper = () => show("host");
		window.addEventListener("ace:updates", updates);
		window.addEventListener("ace:helper", helper);
		return () => {
			window.removeEventListener("ace:updates", updates);
			window.removeEventListener("ace:helper", helper);
		};
	}, []);

	// Reading provider settings touches Keychain, so pages that don't show it never request it.
	const needed = visited.has("general") || visited.has("providers");
	useEffect(() => {
		if (status !== "open" || !needed) return;
		let active = true;
		const fresh = refreshing.current;
		refreshing.current = false;
		host.request<HostSettings>({ op: "settings", ...(fresh ? { fresh } : {}) }).then(
			(settings) => {
				if (!active) return;
				setResult({ settings });
				if (fresh) setAgain("done");
			},
			(error: Error) => {
				if (!active) return;
				// Keep the last snapshot so mounted provider rows keep their drafts and busy state.
				setResult((last) => ({ settings: last.settings, error: error.message }));
				if (fresh) setAgain(undefined);
			},
		);
		return () => {
			active = false;
		};
	}, [status, version, retry, needed]);

	// A Keychain read waiting on a prompt lands in the background; show its result without a refresh.
	const waiting = !!result.settings?.waiting
		|| !!result.settings?.providers.some((provider) => provider.waiting);
	const shown = section === "general" || section === "providers";
	useEffect(() => {
		if (!shown || !waiting) return;
		const timer = setTimeout(() => setRetry((value) => value + 1), 3000);
		return () => clearTimeout(timer);
	}, [shown, waiting, result]);

	const reading = !result.settings && !result.error && !offline;
	const refresh = (label: string) => (
		<Button
			variant="ghost"
			size="sm"
			disabled={offline || again === "busy"}
			onClick={() => {
				refreshing.current = true;
				setAgain("busy");
				setRetry((value) => value + 1);
			}}
		>
			{again === "busy" ? "Refreshing…" : label}
		</Button>
	);
	const problems = (
		<>
			{offline && <Status>Waiting for Ace Helper…</Status>}
			{reading && <Status>Loading…</Status>}
			{result.error && <Problem>{result.error}</Problem>}
			{result.settings?.error && <Problem>{result.settings.error}</Problem>}
		</>
	);

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent
				initialFocus={current}
				className="grid h-[min(40rem,var(--dialog-max))] w-[min(56rem,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-none sm:grid-cols-[11.5rem_minmax(0,1fr)] sm:grid-rows-1"
			>
				<div className="flex min-w-0 flex-col gap-3 border-b border-border/60 bg-muted/40 p-3 sm:border-r sm:border-b-0">
					<DialogTitle className="px-2 pt-1">Settings</DialogTitle>
					<nav
						aria-label="Settings sections"
						className="flex flex-wrap gap-0.5 sm:flex-col sm:flex-nowrap sm:gap-4"
					>
						{groups.map((group) => (
							<div
								key={group.label || "app"}
								className="contents sm:flex sm:shrink-0 sm:flex-col sm:gap-0.5"
							>
								{group.label && (
									<h3 className="hidden px-2 pb-1 text-xs text-muted-foreground sm:block">
										{group.label}
									</h3>
								)}
								<ul className="contents sm:flex sm:flex-col sm:gap-0.5">
									{group.sections.map(({ id, label, icon: Icon }) => (
										<li key={id} className="shrink-0">
											<button
												type="button"
												ref={section === id ? current : undefined}
												aria-current={section === id ? "page" : undefined}
												// WebKit leaves focus where it was when a button is pressed, so the
												// focus ring would stay on the section the dialog opened with.
												onClick={(event) => {
													event.currentTarget.focus();
													show(id);
												}}
												className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-muted-foreground outline-none transition-colors duration-100 hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-[current=page]:bg-foreground/[0.07] aria-[current=page]:text-foreground motion-reduce:transition-none"
											>
												<Icon className="size-3.5 shrink-0" aria-hidden />
												{label}
											</button>
										</li>
									))}
								</ul>
							</div>
						))}
					</nav>
				</div>
				<div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
					<header className="py-4 pr-12 pl-6">
						<h2 className="text-lg font-semibold">{labels[section]}</h2>
					</header>
					<div className="@container min-h-0 overflow-y-auto overscroll-contain px-6 pb-6">
						{visited.has("general") && (
							<div hidden={section !== "general"}>
								<Page>
									<Group title="Appearance">
										<Row id="theme-label" label="Theme">
											<Segmented
												aria-labelledby="theme-label"
												value={theme}
												options={themes}
												onChange={setTheme}
											/>
										</Row>
									</Group>
									<Group title="Projects">
										<TextRow
											label="Projects folder"
											description="Where Clone from URL puts repositories"
											placeholder="~/code"
											saved={folder}
											disabled={offline}
											footer={folderError && <Problem>{folderError}</Problem>}
											onSave={async (value) => {
												await host.request({ op: "preferences", folder: value });
											}}
										/>
									</Group>
									<Group title="Models">
										<DefaultModel settings={result.settings} disabled={offline} />
									</Group>
									{problems}
									{result.error && <div>{refresh("Try again")}</div>}
								</Page>
							</div>
						)}
						{visited.has("providers") && (
							<div hidden={section !== "providers"}>
								<Page>
									{/* Keychain unlocks and environment changes happen outside Ace. */}
									<Group title="Providers" action={refresh("Refresh")}>
										{result.settings?.providers.map((provider) => (
											<Provider key={provider.id} provider={provider} disabled={offline} />
										))}
									</Group>
									{again === "done" && <Status>Read the keys again.</Status>}
									{problems}
								</Page>
							</div>
						)}
						{visited.has("team") && (
							<div hidden={section !== "team"}>
								<TeamSettings active={section === "team"} />
							</div>
						)}
						{visited.has("beta") && (
							<div hidden={section !== "beta"}>
								<Page>
									<CloudCompute disabled={offline} />
								</Page>
							</div>
						)}
						{visited.has("host") && (
							<div hidden={section !== "host"}>
								<HostStatus active={section === "host"} />
							</div>
						)}
						{desktop && visited.has("computer") && (
							<div hidden={section !== "computer"}>
								<NativeStatus native={desktop.native} active={section === "computer"} />
							</div>
						)}
						{desktop && visited.has("updates") && (
							<div hidden={section !== "updates"}>
								<UpdateSettings />
							</div>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
