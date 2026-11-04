import * as fs from "node:fs/promises";
import { runChatGPT } from "./chatgpt.mjs";
import { runGemini } from "./gemini.mjs";

const PREFIX = "OMP_WEB_CHAT:";
const HOME = { chatgpt: "https://chatgpt.com/", gemini: "https://gemini.google.com/app" };

function emit(record) {
	console.log(PREFIX + JSON.stringify(record));
}

function errorReason(error) {
	if (error?.name === "TimeoutError") return "timeout";
	if (error?.name === "AbortError") return "cancelled";
	const message = `${error?.code ?? ""} ${error?.message ?? error}`;
	return /EGO_\S*(?:CONTROL|OWNERSHIP|INACTIVE|UNASSIGNED|NOT_ASSIGNED|NOT_OWNED)|user.{0,30}control|space.{0,30}(?:inactive|unassigned|user.owned)/i.test(
		message,
	)
		? "control_lost"
		: "browser_error";
}

// Called through ego-browser nodejs stdin. Every invocation is its own Node process.
export async function runBrowser(input) {
	let task;
	let page;
	let context;
	const deadline = input.deadline;
	const timeoutMs = Math.max(0, deadline - Date.now());
	const watchdog = setTimeout(() => {
		emit({
			kind: "result",
			context,
			result: {
				status: "error",
				reason: "timeout",
				url: input.request?.conversationUrl ?? HOME[input.provider] ?? "",
				message:
					"Browser deadline exceeded. Submission may have succeeded; inspect the conversation before sending again. No retry was attempted.",
			},
		});
		process.exit(124);
	}, timeoutMs);
	let checking = false;
	const cancellation = setInterval(async () => {
		if (checking) return;
		checking = true;
		try {
			if ((await fs.readFile(input.controlPath, "utf8")) !== "active") throw new Error("cancelled");
		} catch {
			emit({
				kind: "result",
				context,
				result: {
					status: "error",
					reason: "cancelled",
					url: input.request?.conversationUrl ?? HOME[input.provider] ?? "",
					message: "Browser operation cancelled. No submission retry was attempted.",
				},
			});
			process.exit(125);
		} finally {
			checking = false;
		}
	}, 200);
	try {
		if ((await fs.readFile(input.controlPath, "utf8")) !== "active")
			throw new DOMException("Browser operation cancelled", "AbortError");
		if (Date.now() >= deadline)
			throw new DOMException(
				"Browser deadline exceeded before browser execution; no prompt was submitted.",
				"TimeoutError",
			);
		task = await taskSpace(input.spaceId ?? input.spaceName);
		context = { spaceId: task.spaceId, pages: { ...input.pages } };
		emit({ kind: "context", context });
		if (task.ownership !== "agent") {
			emit({
				kind: "result",
				context,
				result: {
					status: "error",
					reason: "control_lost",
					url: "",
					message: "TaskSpace is no longer agent-owned. Resume requires explicit user action.",
				},
			});
			return;
		}
		if (input.operation === "finish") {
			await task.finish({ keep: [] });
			emit({
				kind: "result",
				context,
				result: { status: "ready", url: "", message: "Owned browser TaskSpace finished." },
			});
			return;
		}
		const label = context.pages[input.provider];
		if (label) {
			page = task.page(label);
		} else if (input.external) {
			throw new Error("An existing page label is required for an external TaskSpace.");
		} else {
			page = Object.keys(context.pages).length === 0 ? task.page("p1") : await task.newPage();
			context.pages[input.provider] = page.label;
		}
		emit({ kind: "context", context });
		await page.goto(input.request.conversationUrl ?? HOME[input.provider]);
		if (Date.now() >= deadline)
			throw new DOMException(
				"Browser deadline exceeded before adapter execution; no prompt was submitted.",
				"TimeoutError",
			);
		if ((await fs.readFile(input.controlPath, "utf8")) !== "active")
			throw new DOMException(
				"Browser operation cancelled before adapter execution; no prompt was submitted.",
				"AbortError",
			);
		const adapter = input.provider === "chatgpt" ? runChatGPT : runGemini;
		const result = await adapter(page, {
			...input.request,
			expectedAccount: input.provider === "gemini" ? input.geminiAccount : undefined,
			timeoutMs: Math.max(1, deadline - Date.now()),
		});
		// External TaskSpaces always remain under the caller's lifecycle ownership.
		if (!input.external && result.status === "login_required") await task.handOff();
		emit({ kind: "result", context, result });
	} catch (error) {
		const result = {
			status: "error",
			reason: errorReason(error),
			url: input.request?.conversationUrl ?? HOME[input.provider] ?? "",
			message: String(error?.message ?? error),
		};
		// Do not retry, take over, or finish after an error or loss of user control.
		emit({ kind: "result", context, result });
	} finally {
		clearTimeout(watchdog);
		clearInterval(cancellation);
	}
}
