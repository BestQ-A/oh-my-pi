import { setTimeout as delay } from "node:timers/promises";

// Selectors and completion markers observed in the signed-in ChatGPT UI.
const EDITOR = '[contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"]';

function inspectChatGPT() {
	const visible = element =>
		Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
	const editors = [
		...document.querySelectorAll('[contenteditable="true"][role="textbox"][aria-label="Ask ChatGPT"]'),
	].filter(visible);
	const notices = [...document.querySelectorAll('[role="alert"],[role="dialog"]')]
		.filter(visible)
		.map(element => element.innerText.trim())
		.filter(Boolean);
	const limit = notices.find(text =>
		/(?:usage|message|daily|weekly|rate) limit|reached.{0,40}limit|try again.{0,40}(?:later|tomorrow)|已达.{0,20}上限|额度.{0,20}(?:用完|耗尽)|次数.{0,20}上限/i.test(
			text,
		),
	);
	const login = [...document.querySelectorAll("button,a")]
		.filter(visible)
		.some(element => /^(?:log in|sign in|登录)$/i.test(element.innerText.trim()));
	const turns = [...document.querySelectorAll("[data-turn-key]")].map(turn => ({
		id: turn.getAttribute("data-turn-key"),
		user: turn.querySelector("[data-user-message-bubble]")?.innerText.trim() ?? "",
		complete: Boolean(turn.querySelector('[data-talvt-turn-state="complete"]')),
		answers: [...turn.querySelectorAll('[data-content-search-unit-key$=":assistant"]')].map(answer => ({
			id: answer.getAttribute("data-chatgpt-search-message-ids") ?? "",
			text: [...answer.querySelectorAll('[data-markdown-text-style="assistant-message"]')]
				.map(element => element.innerText.trim())
				.filter(Boolean)
				.join("\n\n"),
		})),
		copy: Boolean(turn.querySelector('button[aria-label="Copy"]')),
	}));
	return {
		url: location.href,
		editorCount: editors.length,
		draft: editors[0]?.innerText.trim() ?? "",
		model:
			[...document.querySelectorAll('button[aria-label="Select ChatGPT model"]')].find(visible)?.innerText.trim() ||
			undefined,
		limit,
		login: login && editors.length === 0,
		busy: [...document.querySelectorAll("[data-talvt-turn-state]")].some(
			element => element.getAttribute("data-talvt-turn-state") !== "complete",
		),
		turns,
	};
}

function blockingResult(state) {
	if (state.login || new URL(state.url).hostname === "auth.openai.com")
		return { status: "login_required", url: state.url, message: "Sign in to ChatGPT in Ego before asking." };
	if (new URL(state.url).hostname !== "chatgpt.com") {
		return {
			status: "error",
			url: state.url,
			message: "ChatGPT redirected away from chatgpt.com. Inspect the browser before continuing.",
		};
	}
	if (state.limit) return { status: "limited", url: state.url, model: state.model, message: state.limit };
	return undefined;
}

export async function runChatGPT(page, request) {
	const deadline = Date.now() + request.timeoutMs;
	let state;
	while (Date.now() < deadline) {
		state = await page.evaluate(inspectChatGPT);
		const blocked = blockingResult(state);
		if (blocked) return blocked;
		if (state.editorCount > 0) break;
		await delay(Math.min(350, Math.max(1, deadline - Date.now())));
	}
	if (!state || state.editorCount !== 1) {
		return {
			status: "error",
			url: state?.url ?? (await page.url()),
			message: "Expected one visible ChatGPT editor; the page is loading or its UI is unsupported.",
		};
	}
	if (request.action === "status") {
		return {
			status: "ready",
			url: state.url,
			model: state.model,
			message: state.busy
				? "Signed in; a response is still in progress."
				: "Signed in. Remaining web quota is not exposed by this page.",
		};
	}
	if (!request.prompt?.trim())
		return { status: "error", url: state.url, message: "ask requires an explicit nonempty prompt." };
	if (state.busy || state.draft) {
		return {
			status: "error",
			url: state.url,
			message: state.busy
				? "A response is already in progress. No prompt was submitted."
				: "The editor has an existing draft. No prompt was submitted or replaced.",
		};
	}
	const previousTurns = new Set(state.turns.map(turn => turn.id));
	const previousAnswers = new Set(state.turns.flatMap(turn => turn.answers.map(answer => answer.id)));
	await page.fill(EDITOR, request.prompt);
	state = await page.evaluate(inspectChatGPT);
	const blocked = blockingResult(state);
	if (blocked) return blocked;
	if (
		Date.now() >= deadline ||
		state.editorCount !== 1 ||
		state.draft.replace(/\r\n/g, "\n") !== request.prompt.trim().replace(/\r\n/g, "\n") ||
		state.busy
	) {
		return {
			status: "error",
			url: state.url,
			message: "The filled prompt or page state could not be confirmed. Draft retained; nothing was submitted.",
		};
	}
	// One native Enter send. Never retry a submission whose outcome is uncertain.
	await page.press(EDITOR, "Enter");
	let stableAnswer;
	while (Date.now() < deadline) {
		state = await page.evaluate(inspectChatGPT);
		const blocked = blockingResult(state);
		if (blocked) return blocked;
		const turn = state.turns.find(
			turn =>
				!previousTurns.has(turn.id) &&
				turn.user.replace(/\r\n/g, "\n") === request.prompt.trim().replace(/\r\n/g, "\n"),
		);
		const answer = turn?.answers.filter(answer => answer.id && !previousAnswers.has(answer.id) && answer.text).at(-1);
		if (turn?.complete && turn.copy && answer && !state.busy) {
			if (stableAnswer?.id === answer.id && stableAnswer.text === answer.text) {
				return { status: "answered", url: state.url, text: answer.text, model: state.model };
			}
			stableAnswer = answer;
		} else {
			stableAnswer = undefined;
		}
		await delay(Math.min(350, Math.max(1, deadline - Date.now())));
	}
	return {
		status: "error",
		url: state?.url ?? (await page.url()),
		message:
			"Timed out waiting for a new completed ChatGPT answer. Submission may have succeeded; inspect this conversation before sending again. No retry was attempted.",
	};
}
