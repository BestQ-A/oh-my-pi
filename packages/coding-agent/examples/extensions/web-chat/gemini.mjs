import { setTimeout as delay } from "node:timers/promises";

// Observed in the signed-in Gemini UI; Enter is not a reliable submit gesture here.
const EDITOR =
	'rich-textarea[enterkeyhint="send"] [contenteditable="true"][role="textbox"][aria-label="Enter a prompt for Gemini"]';

function normalize(text) {
	return text.replace(/\s+/gu, " ").trim();
}

async function observe(page, pending) {
	return page.evaluate(
		({ editorSelector, pending }) => {
			const visible = element => {
				if (!element || !element.getClientRects().length) return false;
				const style = getComputedStyle(element);
				return style.display !== "none" && style.visibility !== "hidden";
			};
			const normalizeText = text => (text ?? "").replace(/\s+/gu, " ").trim();
			const editors = [...document.querySelectorAll(editorSelector)].filter(visible);
			const editor = editors[0];
			const accounts = new Set(
				[...document.querySelectorAll('a[gem-open-account-menu][aria-label^="Google Account:"]')]
					.filter(visible)
					.map(element =>
						element
							.getAttribute("aria-label")
							.match(/\(([^()\s]+@[^()\s]+)\)\s*$/u)?.[1]
							?.toLowerCase(),
					)
					.filter(Boolean),
			);
			const account = accounts.size === 1 ? [...accounts][0] : undefined;
			const mode = [...document.querySelectorAll('button[data-test-id="bard-mode-menu-button"]')].find(visible);
			const modeLabel = mode?.getAttribute("aria-label") ?? "";
			const model = modeLabel.startsWith("Open mode picker, currently ")
				? modeLabel.slice("Open mode picker, currently ".length).trim()
				: normalizeText(mode?.querySelector(".picker-primary-text")?.textContent);
			const plan = [...document.querySelectorAll(".mavatar-enterprise-label,.mavatar-tier-label")]
				.filter(visible)
				.map(element => normalizeText(element.innerText))
				.filter(Boolean)
				.join(" • ");
			// Restrict notices to application chrome; an answer discussing limits is not a quota notice.
			const notices = [
				...document.querySelectorAll(
					'chat-app-banners,chat-app-announcement-banners,chat-notifications,zero-state-banners,[role="alert"],[role="status"],[role="dialog"],[role="region"][aria-label="Notifications"]',
				),
			]
				.filter(
					element => visible(element) && !element.closest("model-response,user-query,side-navigation-content"),
				)
				.map(element => normalizeText(element.innerText))
				.filter(Boolean);
			const message = [...new Set(notices)].join("\n").slice(0, 2000);
			const signIn = [...document.querySelectorAll("a,button")].find(
				element =>
					visible(element) &&
					!element.closest("model-response,user-query") &&
					/^(?:sign in|log in|登录|登入)$/iu.test(normalizeText(element.innerText)),
			);
			let status;
			if (
				location.hostname === "accounts.google.com" ||
				signIn ||
				/(?:sign in|log in|登录|登入).*(?:continue|use Gemini|继续|使用)/iu.test(message)
			) {
				status = "login_required";
			} else if (
				/(?:reached|exceeded|hit|daily|usage|rate).{0,50}limit|limit.{0,80}(?:reached|exceeded|reset|try again)|too many requests|out of (?:messages|prompts)|达到.{0,20}(?:上限|限制)|额度.{0,20}(?:耗尽|用完)|次数.{0,20}用完/iu.test(
					message,
				)
			) {
				status = "limited";
			} else if (
				/something went wrong|unable to|couldn.t|\berror\b|try again|出了点问题|出错|无法|重试/iu.test(message)
			) {
				status = "error";
			} else if (location.hostname !== "gemini.google.com") {
				status = "error";
			}
			const turns = [...document.querySelectorAll(".conversation-container[id]")].map(turn => {
				const response = turn.querySelector("model-response");
				const content = response?.querySelector("message-content[id]");
				return {
					id: turn.id,
					responseId: content?.id ?? "",
					hasResponse: Boolean(response),
					complete: Boolean(response?.querySelector(".response-footer.complete")),
				};
			});
			let answer;
			if (pending) {
				const previousTurns = new Set(pending.turnIds);
				const previousResponses = new Set(pending.responseIds);
				for (const turn of document.querySelectorAll(".conversation-container[id]")) {
					if (previousTurns.has(turn.id)) continue;
					const query = [...turn.querySelectorAll("user-query .query-text-line")]
						.map(line => line.innerText)
						.join("\n");
					if (normalizeText(query) !== pending.prompt) continue;
					const response = turn.querySelector("model-response");
					const content = response?.querySelector("message-content[id]");
					if (!content?.id || previousResponses.has(content.id)) continue;
					const body = content.querySelector(".markdown-main-panel");
					if (visible(body) && response.querySelector(".response-footer.complete")) {
						const text = body.innerText.trim();
						if (text) answer = { id: content.id, text };
					}
				}
			}
			return {
				url: location.href,
				account,
				model,
				plan,
				message,
				status,
				editorCount: editors.length,
				editorEnabled: Boolean(
					editor && editor.getAttribute("aria-disabled") !== "true" && !editor.closest("[inert]"),
				),
				draft: editor?.innerText ?? "",
				turns,
				answer,
			};
		},
		{ editorSelector: EDITOR, pending },
	);
}

function result(state, status, message, text) {
	return {
		status,
		url: state.url,
		...(state.model ? { model: state.model } : {}),
		...(state.plan ? { plan: state.plan } : {}),
		...(state.account ? { account: state.account } : {}),
		...(text === undefined ? {} : { text }),
		...(message || state.message ? { message: [message, state.message].filter(Boolean).join("\n") } : {}),
	};
}

function accountError(state, expected) {
	if (!expected || state.account === expected) return undefined;
	return {
		...result(
			state,
			"error",
			`Gemini account is ${state.account ?? "unavailable or ambiguous"}; expected ${expected}. Check the configured Google account slot before continuing.`,
		),
		reason: "account_mismatch",
	};
}

/**
 * Run inside Ego's Node runtime with its existing Page handle.
 * Navigation, outer cancellation, TaskSpace ownership, and finish belong to the runner.
 * Ego exceptions (including user-control loss) propagate unchanged; never retry a send.
 */
export async function runGemini(page, request) {
	const timeoutMs = request.timeoutMs;
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
		throw new TypeError("Gemini timeoutMs must be a positive finite number.");
	const deadline = Date.now() + timeoutMs;
	let state = await observe(page, null);
	const readyDeadline = Math.min(deadline, Date.now() + 10_000);
	while (
		!state.status &&
		(state.editorCount === 0 || (request.expectedAccount && !state.account)) &&
		Date.now() < readyDeadline
	) {
		await delay(Math.min(300, readyDeadline - Date.now()));
		state = await observe(page, null);
	}
	if (state.status) return result(state, state.status);
	let accountFailure = accountError(state, request.expectedAccount);
	if (accountFailure) return accountFailure;
	if (state.editorCount !== 1 || !state.editorEnabled) {
		return result(
			state,
			"error",
			"Gemini's observed prompt editor is unavailable or ambiguous; no prompt was submitted.",
		);
	}
	if (request.action === "status") {
		return result(
			state,
			"ready",
			state.turns.at(-1)?.hasResponse && !state.turns.at(-1).complete
				? "Gemini is currently generating a response."
				: undefined,
		);
	}
	if (request.action !== "ask" || typeof request.prompt !== "string" || !request.prompt.trim()) {
		return result(state, "error", "Gemini ask requires a nonempty prompt.");
	}
	if (normalize(state.draft)) {
		return result(state, "error", "Gemini has an existing draft; no prompt was submitted.");
	}
	if (state.turns.at(-1)?.hasResponse && !state.turns.at(-1).complete) {
		return result(state, "error", "Gemini is already generating; no prompt was submitted.");
	}
	if (state.turns.some(turn => !turn.id || (turn.hasResponse && !turn.responseId))) {
		return result(state, "error", "Gemini conversation identities are unavailable; no prompt was submitted.");
	}
	const pending = {
		turnIds: state.turns.map(turn => turn.id),
		responseIds: state.turns.map(turn => turn.responseId).filter(Boolean),
		prompt: normalize(request.prompt),
	};
	if (Date.now() >= deadline)
		return result(state, "error", "Gemini timed out before submission; no prompt was submitted.");
	await page.fill(EDITOR, request.prompt);
	state = await observe(page, null);
	if (state.status) return result(state, state.status);
	accountFailure = accountError(state, request.expectedAccount);
	if (accountFailure) return accountFailure;
	if (state.editorCount !== 1 || !state.editorEnabled || normalize(state.draft) !== pending.prompt) {
		return result(state, "error", "Gemini's editor did not contain the requested prompt; no send was attempted.");
	}
	if (Date.now() >= deadline)
		return result(state, "error", "Gemini timed out with the prompt still in the editor; no send was attempted.");
	// This is the only submission action. An exception or timeout must never cause another send.
	await page.click('button[aria-label="Send message"][aria-disabled="false"]');
	let completed;
	while (Date.now() < deadline) {
		state = await observe(page, pending);
		if (state.status) return result(state, state.status);
		accountFailure = accountError(state, request.expectedAccount);
		if (accountFailure) return accountFailure;
		if (state.answer) {
			// Require the completion marker and identical fresh text across two observations.
			if (completed?.id === state.answer.id && completed.text === state.answer.text) {
				return result(state, "answered", undefined, state.answer.text);
			}
			completed = state.answer;
		} else {
			completed = undefined;
		}
		const remaining = deadline - Date.now();
		if (remaining > 0) await delay(Math.min(350, remaining));
	}
	return result(
		state,
		"error",
		"Timed out waiting for a new completed Gemini answer. Submission may have succeeded; inspect the returned conversation URL before retrying.",
	);
}
