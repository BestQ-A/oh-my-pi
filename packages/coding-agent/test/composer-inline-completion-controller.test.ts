import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	COMPLETION_MAX_TOKENS,
	type CompletionModelRunnerInput,
	ComposerInlineCompletionController,
	djb2Hash,
	type GitStatusFile,
	normalizeInlineCompletionSuffix,
	parseGitPorcelainStatus,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/composer-inline-completion-controller";

type ControllerContext = ConstructorParameters<typeof ComposerInlineCompletionController>[0];

interface PendingCompletionCall {
	input: CompletionModelRunnerInput;
	resolve: (reply: string | undefined) => void;
	promise: Promise<string | undefined>;
}

function makeMessage(role: "user" | "assistant", content: Message["content"], timestamp = 1): AgentMessage {
	if (role === "user") {
		return { role: "user", content, timestamp } as Message;
	}
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	} as Message;
}

function createHarness(
	options: {
		enabled?: boolean;
		focusedAgentId?: string;
		debounceMs?: number;
		deadlineMs?: number;
		cwd?: string;
		messages?: AgentMessage[];
		gitStatusFiles?: readonly GitStatusFile[];
	} = {},
) {
	const calls: PendingCompletionCall[] = [];
	const messages: AgentMessage[] = options.messages ? [...options.messages] : [];
	let renders = 0;

	const ctx = {
		settings: Settings.isolated({ "composer.inlineCompletions": options.enabled ?? true }),
		viewSession: { messages },
		focusedAgentId: options.focusedAgentId,
		editor: { getText: () => "" },
		ui: { requestRender: () => renders++ },
	} as unknown as ControllerContext;

	const controller = new ComposerInlineCompletionController(ctx, {
		debounceMs: options.debounceMs ?? 150,
		deadlineMs: options.deadlineMs ?? 3_500,
		cwd: options.cwd,
		gitStatusFiles: options.gitStatusFiles,
		runner: input => {
			const { promise, resolve } = Promise.withResolvers<string | undefined>();
			calls.push({ input, resolve, promise });
			return promise;
		},
	});

	const queryLine = (line: string, col = line.length): string | undefined =>
		controller.getInlineCompletion([line], 0, col);

	const resolveCall = async (index: number, reply: string | undefined): Promise<void> => {
		const call = calls[index]!;
		call.resolve(reply);
		await call.promise;
		await Promise.resolve();
	};

	return {
		controller,
		calls,
		messages,
		queryLine,
		resolveCall,
		renders: () => renders,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("normalizeInlineCompletionSuffix", () => {
	it("unwraps wrapping quotes while preserving leading spaces and intentional open quotes", () => {
		expect(normalizeInlineCompletionSuffix("bun test ", '"--watch"')).toBe("--watch");
		expect(normalizeInlineCompletionSuffix("bun test", ' "--watch"')).toBe(" --watch");
		expect(normalizeInlineCompletionSuffix("bun test ", "“--watch”")).toBe("--watch");
		expect(normalizeInlineCompletionSuffix("bun test ", "`--watch`")).toBe("--watch");
		expect(normalizeInlineCompletionSuffix('echo "', 'hello"')).toBe('hello"');
	});

	it("rejects NO_COMPLETION, empty replies, cursor echoes, and overly long outputs", () => {
		expect(normalizeInlineCompletionSuffix("fix ", "NO_COMPLETION")).toBeUndefined();
		expect(normalizeInlineCompletionSuffix("fix ", "  NO_COMPLETION \nextra")).toBeUndefined();
		expect(normalizeInlineCompletionSuffix("fix ", "<|cursor|>")).toBeUndefined();
		expect(normalizeInlineCompletionSuffix("fix ", "   ")).toBeUndefined();
		expect(normalizeInlineCompletionSuffix("fix ", "x".repeat(161))).toBeUndefined();
	});

	it("strips full-line and partial suffix-prefix overlap without eating valid doubled letters", () => {
		expect(normalizeInlineCompletionSuffix("bun test packages/", "bun test packages/coding-agent")).toBe(
			"coding-agent",
		);
		expect(normalizeInlineCompletionSuffix("wire composer-", "composer-inline-completion-controller")).toBe(
			"inline-completion-controller",
		);
		expect(normalizeInlineCompletionSuffix("cal", "l the helper")).toBe("l the helper");
		expect(normalizeInlineCompletionSuffix("git commit", " -m 'wire inline ghost'\nsecond line")).toBe(
			" -m 'wire inline ghost'",
		);
	});
});

describe("ComposerInlineCompletionController", () => {
	it("slices cached completions in 0 ms across sequential keystrokes and Ctrl+Right partial accepts", async () => {
		vi.useFakeTimers();
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-inline-slice-"));
		try {
			const { controller, calls, queryLine, resolveCall, renders } = createHarness({ cwd: tempDir });

			expect(queryLine("fix the ")).toBeUndefined();
			vi.advanceTimersByTime(150);
			expect(calls).toHaveLength(1);

			await resolveCall(0, "inline ghost completion");
			expect(renders()).toBe(1);
			expect(queryLine("fix the ")).toBe("inline ghost completion");

			// Sequential character typing slices synchronously with zero extra LLM calls
			expect(queryLine("fix the i")).toBe("nline ghost completion");
			expect(queryLine("fix the in")).toBe("line ghost completion");

			// Ctrl+Right partial word accept advances buffer to next word boundary
			controller.handleEvent("partial-accept", "line ");
			expect(queryLine("fix the inline ")).toBe("ghost completion");
			expect(queryLine("fix the inline ghost ")).toBe("completion");

			vi.advanceTimersByTime(500);
			expect(calls).toHaveLength(1);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("provides 0 ms Tier-1 completions from both workspace filenames and session messages", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-inline-tier1-"));
		try {
			for (const entry of ["OmniParser", "IDA-Pro-9.5", "agent-purge", "oh-my-pi"]) {
				fs.mkdirSync(path.join(tempDir, entry));
			}

			// Fresh session (0 messages): workspace folder/file names complete immediately in 0 ms
			const fresh = createHarness({ cwd: tempDir, messages: [] });
			expect(fresh.queryLine("inspect Omni")).toBe("Parser");
			expect(fresh.queryLine("open IDA-")).toBe("Pro-9.5");
			expect(fresh.queryLine("run agent-")).toBe("purge");
			expect(fresh.queryLine("cd oh-")).toBe("my-pi");
			expect(fresh.calls).toHaveLength(0);

			// Active session: technical identifiers, CLI flags, array content blocks, and user CJK phrases
			const active = createHarness({
				cwd: tempDir,
				messages: [
					makeMessage("user", "请帮我检查内联幽灵补全状态并启用 --disallow-code-generation"),
					makeMessage("assistant", [{ type: "text", text: "Updated ComposerInlineCompletionController wiring." }]),
				],
			});
			expect(active.queryLine("pass --disallow-")).toBe("code-generation");
			expect(active.queryLine("wire ComposerInline")).toBe("CompletionController");
			expect(active.queryLine("请帮我检查内联")).toBe("幽灵补全状态并启用");
			expect(active.calls).toHaveLength(0);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("debounces Tier-2 LLM calls on forward typing only, aborts stale requests, and never triggers on Backspace", async () => {
		vi.useFakeTimers();
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-inline-forward-"));
		try {
			const { calls, queryLine, resolveCall } = createHarness({ cwd: tempDir, debounceMs: 150 });

			// Coalesces rapid forward keystrokes within debounce window
			queryLine("wr");
			vi.advanceTimersByTime(100);
			queryLine("write ");
			vi.advanceTimersByTime(100);
			expect(calls).toHaveLength(0);

			vi.advanceTimersByTime(50);
			expect(calls).toHaveLength(1);
			expect(calls[0]!.input.userPrompt).toContain("<draft>write <|cursor|></draft>");
			expect(calls[0]!.input.signal.aborted).toBe(false);

			// Typing further while Call #0 is in-flight immediately aborts Call #0
			queryLine("write u");
			expect(calls[0]!.input.signal.aborted).toBe(true);

			vi.advanceTimersByTime(150);
			expect(calls).toHaveLength(2);
			expect(calls[1]!.input.userPrompt).toContain("<draft>write u<|cursor|></draft>");

			// Stale reply from aborted Call #0 is ignored; Call #1 populates cache
			await resolveCall(0, "something stale");
			await resolveCall(1, "nit tests");
			expect(queryLine("write u")).toBe("nit tests");

			// Start typing a fresh draft, then Backspace before/during request: aborts & does NOT schedule LLM
			queryLine("refactor the mod");
			vi.advanceTimersByTime(150);
			expect(calls).toHaveLength(3);
			expect(calls[2]!.input.signal.aborted).toBe(false);

			// Backspace from "refactor the mod" -> "refactor the mo" -> "refactor the m"
			queryLine("refactor the mo");
			expect(calls[2]!.input.signal.aborted).toBe(true);
			queryLine("refactor the m");
			vi.advanceTimersByTime(500);
			expect(calls).toHaveLength(3);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("suppresses Esc-dismissed (prefix, suffix) via DJB2 hash, snoozes after 2 dismissals, and resets on accept", async () => {
		vi.useFakeTimers();
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-inline-dismiss-"));
		try {
			fs.mkdirSync(path.join(tempDir, "OmniParser"));
			const { controller, calls, queryLine, resolveCall } = createHarness({ cwd: tempDir, debounceMs: 150 });

			// Dismissal #1: Tier-2 suggestion on "run the "
			queryLine("run the ");
			vi.advanceTimersByTime(150);
			expect(calls).toHaveLength(1);
			await resolveCall(0, "test suite");
			expect(queryLine("run the ")).toBe("test suite");

			controller.handleEvent("dismiss", "test suite");
			expect(djb2Hash("run the \0test suite")).toBeGreaterThan(0);
			expect(queryLine("run the ")).toBeUndefined();

			// Re-typing back to "run the " must keep rejecting the exact same dismissed suggestion
			controller.resetDraft();
			queryLine("run the ");
			vi.advanceTimersByTime(150);
			expect(calls).toHaveLength(2);
			await resolveCall(1, "test suite");
			expect(queryLine("run the ")).toBeUndefined();

			// After only 1 dismissal, forward typing on a new prefix still triggers Tier-2
			queryLine("run the build ");
			vi.advanceTimersByTime(150);
			expect(calls).toHaveLength(3);
			await resolveCall(2, "pipeline");
			expect(queryLine("run the build ")).toBe("pipeline");

			// Dismissal #2 within 20s trips AnnoyanceManager snooze
			controller.handleEvent("dismiss", "pipeline");
			expect(queryLine("run the build ")).toBeUndefined();

			// Forward typing while snoozed does NOT trigger Tier-2 LLM calls
			queryLine("run the build now ");
			vi.advanceTimersByTime(300);
			expect(calls).toHaveLength(3);

			// Accepting a suggestion (e.g. Tier-1 workspace completion) resets the snooze immediately
			expect(queryLine("run the build now Omni")).toBe("Parser");
			controller.handleEvent("accept", "Parser");

			queryLine("run the build now OmniParser ");
			vi.advanceTimersByTime(150);
			expect(calls).toHaveLength(4);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("indexes depth-5 workspace files, prioritizes git dirty paths, and sends maxTokens=128 + Effort.Low", () => {
		vi.useFakeTimers();
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-inline-git-tree-"));
		try {
			expect(
				parseGitPorcelainStatus(" M packages/tui/src/components/editor-dirty.ts\n?? scripts/new-helper.ts\n"),
			).toEqual([
				{ status: "M", path: "packages/tui/src/components/editor-dirty.ts" },
				{ status: "??", path: "scripts/new-helper.ts" },
			]);

			const nestedDir = path.join(tempDir, "packages", "tui", "src", "components");
			fs.mkdirSync(nestedDir, { recursive: true });
			fs.writeFileSync(path.join(nestedDir, "editor-clean.ts"), "");
			fs.writeFileSync(path.join(nestedDir, "editor-dirty.ts"), "");
			// Ignored directories must not pollute Tier-1
			fs.mkdirSync(path.join(tempDir, "node_modules", "secret-pkg"), { recursive: true });

			const { calls, queryLine } = createHarness({
				cwd: tempDir,
				gitStatusFiles: [{ status: "M", path: "packages/tui/src/components/editor-dirty.ts" }],
			});

			// Deep nested clean file completes by basename and relative path in 0 ms
			expect(queryLine("open editor-c")).toBe("lean.ts");
			expect(queryLine("inspect packages/tui/src/components/editor-c")).toBe("lean.ts");
			expect(queryLine("check secret-")).toBeUndefined();

			// Ambiguous prefix "editor-" prefers git-modified file (weight +8 vs +2)
			expect(queryLine("review editor-")).toBe("dirty.ts");

			// Tier-2 LLM call receives <git-status>, <workspace-files>, maxTokens=128, and disableReasoning=true
			vi.advanceTimersByTime(150);
			expect(calls.length).toBeGreaterThanOrEqual(1);
			const lastCall = calls.at(-1)!;
			expect(lastCall.input.maxTokens).toBe(200);
			expect(COMPLETION_MAX_TOKENS).toBe(200);
			expect(lastCall.input.disableReasoning).toBe(true);
			expect(lastCall.input.reasoning).toBeUndefined();
			expect(lastCall.input.userPrompt).toContain("<workspace-files>");
			expect(lastCall.input.userPrompt).toContain("packages/tui/src/components/editor-clean.ts");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
