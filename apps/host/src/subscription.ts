import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Credential, CredentialStore } from "@earendil-works/pi-ai";

import { config } from "./config";

const NAME = "OPENAI_OAUTH_CREDENTIALS";
type State = { version: 1; device: string; connected: boolean };
type Secrets = {
	read(name: string): Promise<string | undefined>;
	write(name: string, value: string): Promise<void>;
	remove(name: string): Promise<boolean>;
};

function path(): string {
	return join(config.settings, "subscription.json");
}

function state(): State | undefined {
	if (!existsSync(path())) return;
	const value = JSON.parse(readFileSync(path(), "utf8")) as State;
	if (value.version !== 1) throw new Error("Unsupported subscription settings version");
	return value;
}

function save(value: State): void {
	const temporary = `${path()}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
	renameSync(temporary, path());
}

/** A kernel-held lock survives neither crashes nor exits; refresh must hold it across the network call. */
async function locked<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	signal?.throwIfAborted();
	mkdirSync(config.settings, { recursive: true });
	const db = new Database(join(config.settings, "subscription.lock"));
	db.run("PRAGMA busy_timeout = 0");
	const until = Date.now() + 30_000;
	try {
		while (true) {
			signal?.throwIfAborted();
			try {
				db.run("BEGIN EXCLUSIVE");
				break;
			} catch (error) {
				if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
				if (Date.now() >= until) {
					throw new Error("Another process is updating the ChatGPT subscription. Try again.", {
						cause: error,
					});
				}
				await Bun.sleep(25);
			}
		}
		return await work();
	} finally {
		db.close();
	}
}

export function hasSubscription(): boolean {
	return !!state()?.connected;
}

export async function deviceId(signal?: AbortSignal): Promise<string> {
	return locked(async () => {
		const current = state();
		if (current) return current.device;
		const device = randomUUID();
		save({ version: 1, device, connected: false });
		return device;
	}, signal);
}

export function subscription(secrets: Secrets, lookup = secrets.read): CredentialStore {
	async function read(provider: string, resolve = lookup): Promise<Credential | undefined> {
		if (provider !== "openai" || !state()?.connected) return;
		const value = await resolve(NAME);
		if (!value) return;
		try {
			return JSON.parse(value) as Credential;
		} catch {
			throw new Error("Cannot read the saved ChatGPT sign-in. Run ace login openai again.");
		}
	}
	return {
		async read(provider, options) {
			options?.signal?.throwIfAborted();
			return read(provider);
		},
		async list(options) {
			options?.signal?.throwIfAborted();
			return state()?.connected ? [{ providerId: "openai", type: "oauth" }] : [];
		},
		async modify(provider, update, options) {
			if (provider !== "openai") throw new Error("Subscription sign-in supports OpenAI only");
			return locked(async () => {
				// Settings may use a cached lookup, but refresh must re-read the authoritative token under the lock.
				const current = await read(provider, secrets.read);
				options?.signal?.throwIfAborted();
				const next = await update(current);
				if (!next) return current;
				await secrets.write(NAME, JSON.stringify(next));
				save({ version: 1, device: state()?.device || randomUUID(), connected: true });
				return next;
			}, options?.signal);
		},
		async delete(provider, options) {
			if (provider !== "openai") return;
			await locked(async () => {
				await secrets.remove(NAME);
				const current = state();
				if (current) save({ ...current, connected: false });
			}, options?.signal);
		},
	};
}
