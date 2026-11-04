import { $which, TempDir } from "@oh-my-pi/pi-utils";
import { combineSignals, exec } from "@oh-my-pi/pi-utils/ptree";

export type WebChatProvider = "chatgpt" | "gemini";

export interface WebChatRequest {
	action: "status" | "ask";
	prompt?: string;
	conversationUrl?: string;
	/** Total deadline in seconds, including time waiting for the browser runner. */
	timeout?: number;
}

export interface WebChatResult {
	status: "ready" | "answered" | "login_required" | "limited" | "error";
	url: string;
	text?: string;
	model?: string;
	plan?: string;
	account?: string;
	message?: string;
	reason?: string;
	notice?: string;
	taskSpaceId?: number;
	pageLabel?: string;
}

export interface WebChatRunnerOptions {
	/** Existing agent-owned space. Its lifecycle belongs to the caller. */
	spaceId?: number;
	pages?: Partial<Record<WebChatProvider, string>>;
	/** Pin Gemini's Google account slot and verify its visible email before sending. */
	geminiAccount?: { email: string; index: number };
}

export interface WebChatInvocationOptions {
	signal?: AbortSignal;
}

interface BrowserContext {
	spaceId: number;
	pages: Partial<Record<WebChatProvider, string>>;
}

interface BrowserRecord {
	kind: "context" | "result";
	context?: BrowserContext;
	result?: WebChatResult;
}

const HOME: Record<WebChatProvider, string> = {
	chatgpt: "https://chatgpt.com/",
	gemini: "https://gemini.google.com/app",
};
const PREFIX = "OMP_WEB_CHAT:";
const BROWSER_ENTRY = new URL("./browser.mjs", import.meta.url).href;
// Browser work ends at the deadline; allow its final result and process cleanup to reach the parent.
const PROCESS_EXIT_GRACE_MS = 1000;
let browserQueue: Promise<unknown> = Promise.resolve();

function errorResult(url: string, reason: string, message: string): WebChatResult {
	return { status: "error", url, reason, message };
}

function cancelledResult(url: string, reason: unknown): WebChatResult {
	const timeout = reason instanceof Error && reason.name === "TimeoutError";
	return errorResult(
		url,
		timeout ? "timeout" : "cancelled",
		`${timeout ? "Browser deadline exceeded" : "Browser operation cancelled"}. Submission may have succeeded; inspect the conversation before sending again. No retry was attempted.`,
	);
}

function checkDeadline(deadline: number, signal: AbortSignal): void {
	signal.throwIfAborted();
	if (Date.now() >= deadline) throw new DOMException("Browser deadline exceeded", "TimeoutError");
}

async function serialized(
	signal: AbortSignal,
	url: string,
	action: () => Promise<WebChatResult>,
): Promise<WebChatResult> {
	if (signal.aborted) return cancelledResult(url, signal.reason);
	const aborted = Promise.withResolvers<WebChatResult>();
	const onAbort = () => aborted.resolve(cancelledResult(url, signal.reason));
	signal.addEventListener("abort", onAbort, { once: true });
	const work = browserQueue.then(() => {
		// Only queued calls may return before their turn. Active calls must finish subprocess cleanup.
		signal.removeEventListener("abort", onAbort);
		return signal.aborted ? cancelledResult(url, signal.reason) : action();
	});
	browserQueue = work.then(
		() => undefined,
		() => undefined,
	);
	try {
		return await Promise.race([work, aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function conversationUrl(provider: WebChatProvider, value?: string): string {
	if (!value) return HOME[provider];
	const url = new URL(value);
	const pathAllowed =
		provider === "chatgpt"
			? /^\/(?:c\/[^/]+\/?|g\/[^/]+\/c\/[^/]+\/?)?$/.test(url.pathname)
			: /^\/(?:u\/\d+\/)?app(?:\/[^/]+)?\/?$/.test(url.pathname);
	if (
		url.protocol !== "https:" ||
		url.hostname !== new URL(HOME[provider]).hostname ||
		url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!pathAllowed
	) {
		throw new Error(
			`conversationUrl must be a plain HTTPS ${provider} home or conversation URL without credentials, query, or fragment.`,
		);
	}
	return url.href;
}

function records(output: string): BrowserRecord[] {
	const parsed: BrowserRecord[] = [];
	for (const line of output.split(/\r?\n/)) {
		if (!line.startsWith(PREFIX)) continue;
		const value: unknown = JSON.parse(line.slice(PREFIX.length));
		if (typeof value !== "object" || value === null || !("kind" in value)) continue;
		if (value.kind === "context" || value.kind === "result") parsed.push(value as BrowserRecord);
	}
	return parsed;
}

/** All instances share one queue because Ego foreground browser actions must not overlap. */
export class WebChatRunner {
	#external: boolean;
	#geminiAccount?: WebChatRunnerOptions["geminiAccount"];
	#context?: BrowserContext;
	#spaceName = `OMP Web Chat ${crypto.randomUUID()}`;
	#guideRead = false;
	#stopped?: string;
	#closed = false;
	#lastSucceeded = false;

	constructor(options: WebChatRunnerOptions = {}) {
		if (options.spaceId !== undefined && (!Number.isSafeInteger(options.spaceId) || options.spaceId <= 0))
			throw new Error("spaceId must be a positive integer.");
		if (options.geminiAccount) {
			const { email, index } = options.geminiAccount;
			if (!email.trim() || !Number.isSafeInteger(index) || index < 0)
				throw new Error("geminiAccount requires an email and a nonnegative integer index.");
			this.#geminiAccount = { email: email.trim().toLowerCase(), index };
		}
		this.#external = options.spaceId !== undefined;
		if (options.spaceId !== undefined) this.#context = { spaceId: options.spaceId, pages: { ...options.pages } };
	}

	async invoke(
		provider: WebChatProvider,
		request: WebChatRequest,
		options: WebChatInvocationOptions = {},
	): Promise<WebChatResult> {
		if (provider !== "chatgpt" && provider !== "gemini")
			return errorResult("", "invalid_request", "Unknown web chat provider.");
		let url: string;
		try {
			const home =
				provider === "gemini" && this.#geminiAccount
					? `https://gemini.google.com/u/${this.#geminiAccount.index}/app`
					: undefined;
			url = conversationUrl(provider, request.conversationUrl ?? home);
		} catch (error) {
			return errorResult(HOME[provider], "invalid_request", String(error instanceof Error ? error.message : error));
		}
		if (provider === "gemini" && this.#geminiAccount) {
			const index = Number(new URL(url).pathname.match(/^\/u\/(\d+)\//)?.[1] ?? 0);
			if (index !== this.#geminiAccount.index)
				return errorResult(
					url,
					"account_mismatch",
					"This Gemini URL belongs to a different Google account slot. Use a conversation URL returned for the configured account.",
				);
		}
		if (request.action !== "status" && request.action !== "ask")
			return errorResult(url, "invalid_request", "action must be status or ask.");
		if (request.action === "ask" && !request.prompt?.trim())
			return errorResult(url, "invalid_request", "ask requires an explicit nonempty prompt.");
		const timeout = request.timeout ?? 120;
		if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600)
			return errorResult(url, "invalid_request", "timeout must be between 1 and 600 seconds.");
		const timeoutMs = Math.round(timeout * 1000);
		const deadline = Date.now() + timeoutMs;
		const signal = combineSignals(options.signal, timeoutMs);
		if (!signal) throw new Error("Missing browser deadline.");
		return serialized(signal, url, async () => {
			if (this.#closed || this.#stopped)
				return errorResult(
					url,
					"runner_stopped",
					this.#stopped ?? "This browser goal has finished. Create a runner for a new user goal.",
				);
			if (this.#external && !this.#context?.pages[provider])
				return errorResult(
					url,
					"invalid_request",
					"An existing page label is required for this provider in an external TaskSpace.",
				);
			return this.#execute("invoke", provider, { ...request, conversationUrl: url }, deadline, options.signal);
		});
	}

	/** Finish only this runner's own successful, still-controlled goal; never an override. */
	async finish(): Promise<WebChatResult> {
		const deadline = Date.now() + 15000;
		const signal = AbortSignal.timeout(15000);
		return serialized(signal, "", async () => {
			if (this.#external || !this.#context || this.#closed || this.#stopped || !this.#lastSucceeded)
				return { status: "ready", url: "", message: "No owned successful browser goal to finish." };
			this.#closed = true;
			return this.#execute("finish", undefined, undefined, deadline);
		});
	}

	async #execute(
		operation: "invoke" | "finish",
		provider: WebChatProvider | undefined,
		request: WebChatRequest | undefined,
		deadline: number,
		abortSignal?: AbortSignal,
	): Promise<WebChatResult> {
		const url = request?.conversationUrl ?? "";
		const signal = combineSignals(abortSignal, Math.max(1, deadline - Date.now() + PROCESS_EXIT_GRACE_MS));
		if (!signal) throw new Error("Missing browser deadline.");
		const binary = $which("ego-browser");
		if (!binary)
			return errorResult(
				url,
				"browser_unavailable",
				"ego-browser is not installed or is unavailable on PATH. Install Ego Lite and sign in through its browser UI.",
			);
		await using control = await TempDir.create("@omp-web-chat-");
		const controlPath = control.join("control");
		await Bun.write(controlPath, "active");
		try {
			checkDeadline(deadline, signal);
			if (!this.#guideRead) {
				const guide = await exec([binary, "skill"], {
					signal,
					timeout: Math.min(15000, Math.max(1, deadline - Date.now())),
					allowNonZero: true,
					allowAbort: true,
				});
				checkDeadline(deadline, signal);
				if (!guide.ok || !/^\[ego-browser:skill\] end of guide/m.test(guide.stdout))
					return errorResult(
						url,
						"browser_guide_unavailable",
						"ego-browser skill did not return a complete usage guide. Read the installed guide before using the browser.",
					);
				this.#guideRead = true;
			}
			const payload = {
				operation,
				provider,
				request,
				deadline,
				spaceId: this.#context?.spaceId,
				spaceName: this.#spaceName,
				pages: this.#context?.pages ?? {},
				external: this.#external,
				geminiAccount: this.#geminiAccount?.email,
				controlPath,
			};
			// JSON is encoded as data inside stdin, never interpolated into a shell or argv.
			const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
			const input = `import { runBrowser } from ${JSON.stringify(BROWSER_ENTRY)};\nawait runBrowser(JSON.parse(Buffer.from(${JSON.stringify(encoded)}, "base64").toString("utf8")));\n`;
			checkDeadline(deadline, signal);
			const processResult = await exec([binary, "nodejs"], {
				input,
				signal,
				allowNonZero: true,
				allowAbort: true,
			});
			const output = `${processResult.stdout}\n${processResult.stderr}`;
			const outputRecords = records(output);
			for (const record of outputRecords) if (record.context) this.#context = record.context;
			let result = outputRecords.findLast(record => record.kind === "result")?.result;
			if (signal.aborted) result = cancelledResult(result?.url ?? url, signal.reason);
			if (!result)
				result = errorResult(
					url,
					"browser_error",
					processResult.stderr.trim() ||
						"Ego did not return a browser result. Submission outcome is uncertain; do not resend without inspecting the conversation.",
				);
			if (
				result.status === "error" &&
				(!processResult.ok ||
					result.reason === "control_lost" ||
					result.reason === "browser_error" ||
					result.reason === "timeout" ||
					result.reason === "cancelled")
			)
				this.#stopped = result.message ?? "Browser operation stopped. Explicit user recovery is required.";
			if (result.status === "login_required")
				this.#stopped = "Sign in in Ego and explicitly start a new browser goal after user control is returned.";
			this.#lastSucceeded = result.status === "ready" || result.status === "answered" || result.status === "limited";
			const notice = output.split(/\r?\n/).find(line => line.startsWith("[ego-browser:notice]"));
			return {
				...result,
				taskSpaceId: this.#context?.spaceId,
				pageLabel: provider ? this.#context?.pages[provider] : undefined,
				...(notice ? { notice } : {}),
			};
		} catch (error) {
			this.#lastSucceeded = false;
			const interrupted = signal.aborted || (error instanceof Error && error.name === "TimeoutError");
			const result = interrupted
				? cancelledResult(url, signal.aborted ? signal.reason : error)
				: errorResult(url, "browser_error", String(error instanceof Error ? error.message : error));
			this.#stopped = result.message ?? "Browser operation stopped. Explicit user recovery is required.";
			return {
				...result,
				taskSpaceId: this.#context?.spaceId,
				pageLabel: provider ? this.#context?.pages[provider] : undefined,
			};
		}
	}
}
