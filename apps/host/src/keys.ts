/**
 * Provider credentials. pi-ai asks for each by its usual environment name, such as
 * `OPENAI_API_KEY`; Ace answers from `ACE_<NAME>`, then `<NAME>`, then the OS keychain. The
 * keychain lets the desktop app, which starts without a shell's environment, find keys.
 */
import { access } from "node:fs/promises";
import { homedir } from "node:os";

import type { MutableModels, OAuthCredential } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { config } from "./config";
import type { CredentialStatus } from "./protocol";
import { subscription } from "./subscription";

const sealed = new Map<string, string>();

/**
 * Agent shells inherit the worker's environment, and anyone admitted to a channel can run
 * `env` through its agent. Credentials leave `process.env` before any tool runs and stay
 * readable only through `key`.
 */
const secret = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?)$/;

export function seal(): void {
	for (const [name, value] of Object.entries(process.env)) {
		if (!secret.test(name) || value === undefined) continue;
		sealed.set(name, value);
		delete process.env[name];
	}
}

/** Only channel workers receive these values; each seals them before running tools. */
export function workerEnv(): NodeJS.ProcessEnv {
	return { ...process.env, ...Object.fromEntries(sealed) };
}

/** GitHub CLI receives only its own sealed credentials, not model provider keys. */
export function githubEnv(): NodeJS.ProcessEnv {
	const token = env("GH_TOKEN") || env("GITHUB_TOKEN");
	return token ? { GH_TOKEN: token } : {};
}

function env(name: string): string | undefined {
	return set(sealed.get(name) ?? process.env[name]);
}

function set(value: string | undefined): string | undefined {
	return value?.trim() ? value : undefined;
}

/** What a keychain read waits on once it takes longer than a read without a macOS prompt. */
export const KEYCHAIN_WAITING = "Ace Helper is waiting for keychain access";

/** A macOS prompt holds a read until someone answers it, so concurrent readers share one prompt. */
const reading = new Map<string, Promise<string | undefined>>();

function keychain(name: string): Promise<string | undefined> {
	let read = reading.get(name);
	if (read) return read;
	// Resolve each request so running workers observe replacement and removal immediately.
	read = Bun.secrets.get({ service: config.keychain, name }).then(
		(value) => set(value ?? undefined),
		() => {
			throw new Error(
				`Cannot access ${name} in the keychain. Unlock it and allow Ace Helper, then retry.`,
			);
		},
	).finally(() => reading.delete(name));
	reading.set(name, read);
	return read;
}

export async function key(name: string): Promise<string | undefined> {
	return env(`ACE_${name}`) ?? env(name) ?? await keychain(name);
}

/** A read slower than this waited on something, usually a macOS prompt. */
const PROMPT = 50;

/** A finished keychain read for Settings. Values stay in Ace Helper; Settings shows only status. */
type Read = { value?: string; error?: string; prompted?: boolean };

/** Each name's last finished Settings read. */
const known = new Map<string, Read>();
/** When Ace Helper last saved or removed each name; a read started before then is stale. */
const changed = new Map<string, number>();

/** Names whose current value its provider rejected at the last check; a new value clears it. */
const rejected = new Set<string>();

function change(name: string): void {
	known.delete(name);
	rejected.delete(name);
	changed.set(name, performance.now());
}

/** Records a provider's verdict on `name`'s current value; true when that changes what Settings shows. */
export function judge(name: string, accepted: boolean): boolean {
	if (accepted !== rejected.has(name)) return false;
	if (accepted) rejected.delete(name);
	else rejected.add(name);
	return true;
}

export const isRejected = (name: string) => rejected.has(name);

export async function store(name: string, value: string): Promise<void> {
	await Bun.secrets.set({ service: config.keychain, name, value });
	change(name);
}

export async function forget(name: string): Promise<boolean> {
	const removed = await Bun.secrets.delete({ service: config.keychain, name });
	change(name);
	return removed;
}

/** The environment variable that supplies `name` ahead of the keychain, if any. */
export function overriding(name: string): string | undefined {
	return env(`ACE_${name}`) ? `ACE_${name}` : env(name) ? name : undefined;
}

/**
 * Settings reads one name at a time: model availability asks for about 40 names, and reading them
 * together could raise a prompt for each at once.
 */
const queued = new Map<string, Promise<Read>>();
let line: Promise<unknown> = Promise.resolve();
/** Settles once the read at the head of the line has waited longer than a read without a prompt. */
let stuck = Promise.withResolvers<undefined>();
/** The name whose read is at the head of the line. */
let head: string | undefined;

function look(name: string): Promise<Read> {
	let read = queued.get(name);
	if (read) return read;
	read = line.then(async () => {
		head = name;
		const started = performance.now();
		let prompted = false;
		const timer = setTimeout(() => {
			prompted = true;
			stuck.resolve(undefined);
		}, PROMPT);
		const result: Read = await keychain(name).then(
			(value) => ({ value }),
			(error: Error) => ({ error: error.message }),
		);
		clearTimeout(timer);
		head = undefined;
		if (prompted) stuck = Promise.withResolvers();
		result.prompted = prompted;
		if (started > (changed.get(name) ?? 0)) known.set(name, result);
		return result;
	}).finally(() => queued.delete(name));
	queued.set(name, read);
	line = read;
	return read;
}

/**
 * A keychain read for Settings, which must not wait on a prompt: undefined while the line is held
 * by a prompt, and a later call picks up the result. Settings polls while it waits, so after a
 * prompted read only `fresh` reads again, or each poll would raise another prompt.
 */
function peek(name: string, fresh?: boolean): Promise<Read | undefined> {
	const last = known.get(name);
	if (last?.prompted && !fresh && !queued.has(name)) return Promise.resolve(last);
	return Promise.race([look(name), stuck.promise]);
}

function describe({ value, error }: Read, override?: string): CredentialStatus {
	if (error) {
		return { source: override ? "environment" : "unavailable", stored: null, override, error };
	}
	return {
		source: override ? "environment" : value ? "keychain" : "missing",
		stored: !!value,
		override,
	};
}

/**
 * A credential's status for Settings: the last finished read while the line waits on a prompt,
 * marked `waiting` when that prompt is for this name or nothing has been read yet.
 */
export async function latest(name: string, fresh?: boolean): Promise<CredentialStatus> {
	const override = overriding(name);
	const read = await peek(name, fresh);
	if (read) return describe(read, override);
	const last = known.get(name);
	if (last && head !== name) return describe(last, override);
	return {
		...last
			? describe(last, override)
			: { source: override ? "environment" : "unavailable", stored: null, override },
		waiting: KEYCHAIN_WAITING,
	};
}

export async function connectSubscription(value: string): Promise<void> {
	let credential: OAuthCredential;
	try {
		if (typeof value !== "string" || value.length > 65_536) throw new Error();
		credential = JSON.parse(value) as OAuthCredential;
		if (
			credential.type !== "oauth" || !credential.access || !credential.refresh
			|| typeof credential.access !== "string" || typeof credential.refresh !== "string"
			|| !Number.isFinite(credential.expires)
		) throw new Error();
	} catch {
		throw new Error("Invalid ChatGPT subscription credential");
	}
	await subscription({ read: keychain, write: store, remove: forget }).modify(
		"openai",
		async () => credential,
	);
}

function catalog(lookup: (name: string) => Promise<string | undefined>): MutableModels {
	return builtinModels({
		credentials: subscription({ read: keychain, write: store, remove: forget }, lookup),
		authContext: {
			env: lookup,
			async fileExists(path) {
				try {
					await access(path.startsWith("~") ? homedir() + path.slice(1) : path);
					return true;
				} catch {
					return false;
				}
			},
		},
	});
}

/** pi-ai's built-in providers, resolving credentials through Ace. */
export function models(): MutableModels {
	return catalog(key);
}

/**
 * `models` for Settings: a name whose read waits on a prompt keeps its last finished value, and
 * `waiting` reports that some did. Agents keep using `models`, which waits for each read.
 */
export function settled(fresh?: boolean): { models: MutableModels; waiting(): boolean } {
	let waiting = false;
	return {
		models: catalog(async (name) => {
			const found = env(`ACE_${name}`) ?? env(name);
			if (found) return found;
			const read = await peek(name, fresh);
			if (!read) waiting = true;
			return (read ?? known.get(name))?.value;
		}),
		waiting: () => waiting,
	};
}
