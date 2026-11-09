import { createInterface } from "node:readline/promises";

import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

import { deviceId } from "./subscription";

export async function login(save: (value: string) => Promise<unknown>): Promise<void> {
	if (!process.stdin.isTTY) throw new Error("Run ace login openai in an interactive terminal");
	const input = createInterface({ input: process.stdin, output: process.stdout });
	const abort = new AbortController();
	const cancel = () => abort.abort();
	process.once("SIGINT", cancel);
	input.once("close", cancel);
	try {
		const device = await deviceId(abort.signal);
		const oauth = openaiProvider().auth.oauth;
		if (!oauth) throw new Error("This model library does not support ChatGPT sign-in");
		const credential = await oauth.login({
			signal: abort.signal,
			prompt: (prompt) =>
				input.question(`${prompt.message} `, {
					signal: prompt.signal || abort.signal,
				}),
			notify(event) {
				if (event.type === "auth_url") {
					console.log(`Open this URL in Brave to sign in with ChatGPT:\n${event.url}`);
					if (event.instructions) console.log(event.instructions);
				} else if (event.type === "info" || event.type === "progress") {
					console.log(event.message);
				}
			},
		}, { getDeviceId: () => device }).catch(() => {
			throw new Error(
				abort.signal.aborted
					? "ChatGPT sign-in cancelled"
					: "ChatGPT sign-in failed. Check the browser authorization and try again.",
			);
		});
		await save(JSON.stringify(credential));
		console.log("ChatGPT subscription connected. Run ace models to see available models.");
	} finally {
		process.removeListener("SIGINT", cancel);
		input.removeListener("close", cancel);
		input.close();
	}
}
