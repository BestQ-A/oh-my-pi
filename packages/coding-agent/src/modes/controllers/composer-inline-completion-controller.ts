import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { completeSimple, type Effort, type Model } from "@oh-my-pi/pi-ai";
import { logger, prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import { resolveRoleChain, resolveRoleSelection } from "../../config/model-resolver";
import inlineCompletionSystemPrompt from "../../prompts/system/composer-inline-completion.md" with { type: "text" };
import { cfgComposerInlineCompletions, cfgComposerPredictions } from "../settings";
import type { InteractiveModeContext } from "../types";
import { prewarmCursorTabConnection, requestCursorTabCompletion } from "./cursor-tab-client";

const SKIP_TOKEN = "NO_COMPLETION";
const MAX_SUFFIX_LENGTH = 160;
/** Requested 128-token cap with reasoning disabled (`disableReasoning: true`) for instant output. */
export const COMPLETION_MAX_TOKENS = 200;
const COMPLETION_DEADLINE_MS = 5_000;
/** Forward-typing coalesce window (modeled on Antigravity GetInputCompletion / Cursor Tab). */
const DEFAULT_DEBOUNCE_MS = 150;
const LRU_CACHE_LIMIT = 128;
/** Windsurf AnnoyanceManager: 2 explicit Esc dismissals in 20s snooze LLM ghost requests for 20s. */
const ANNOYANCE_WINDOW_MS = 20_000;
const ANNOYANCE_DISMISS_THRESHOLD = 2;
/** Cursor DJB2 hash seed (149417) for rejected (prefix, suffix) suppression. */
const DJB2_SEED = 149_417;

const WORKSPACE_TREE_TTL_MS = 30_000;
const WORKSPACE_TREE_MAX_DEPTH = 5;
const WORKSPACE_TREE_MAX_ENTRIES = 500;
const GIT_STATUS_TTL_MS = 8_000;

const IGNORED_DIRS: Record<string, true> = {
	".git": true,
	node_modules: true,
	dist: true,
	build: true,
	target: true,
	".venv": true,
	venv: true,
	__pycache__: true,
	".next": true,
	".turbo": true,
	".cache": true,
	cache: true,
	blobs: true,
	unpacked: true,
	coverage: true,
	".omp": true,
	".claude": true,
	".codex": true,
};

const WRAPPING_QUOTES = /^(?:"([^"]*)"|“([^“”]*)”|`([^`]*)`)$/;
const IDENT_TAIL_RE = /[A-Za-z0-9_./:@-]{2,}$/;
const CJK_TAIL_RE = /[\p{Script=Han}]{2,8}$/u;
const IDENT_SCAN_RE = /[A-Za-z][A-Za-z0-9_./:@-]{3,79}|--[a-z0-9][a-z0-9-]{2,39}/g;
const CJK_PHRASE_SCAN_RE = /[\p{Script=Han}]{4,16}/gu;
const WORKSPACE_TOKEN_RE = /^[A-Za-z0-9_.][A-Za-z0-9_./-]{2,95}$/;
const WORKSPACE_CJK_RE = /^[\p{Script=Han}]{3,16}$/u;

export interface GitStatusFile {
	status: string;
	path: string;
}

interface WorkspaceTreeSnapshot {
	paths: readonly string[];
	scannedAt: number;
}

interface GitStatusSnapshot {
	files: readonly GitStatusFile[];
	scannedAt: number;
	generation: number;
	inFlight: boolean;
}

const workspaceTreeByCwd = new Map<string, WorkspaceTreeSnapshot>();
const gitStatusByCwd = new Map<string, GitStatusSnapshot>();
let globalGitGeneration = 0;

const EMPTY_MENU_SYSTEM_PROMPT = `Predict 3 concise, high-value next messages the developer may want to send right now in this coding session.
Rules:
- Do NOT emit internal thinking or reasoning; output the candidate line immediately.
- Output ONLY a single line formatted as: 1. <action 1>  2. <action 2>  3. <action 3>
- Match the user's language (default Simplified Chinese mixed with exact technical file/tool names when appropriate) and terse imperative style.
- Each option MUST be short (4–18 chars in Chinese or 3–10 words in English), concrete, and directly usable as a prompt (e.g. referencing dirty git files, verification, or next engineering steps).
- No quotes, no markdown fences, no extra lines. If nothing sensible can be suggested, output NO_COMPLETION.`;

type InlineCompletionContext = Pick<
	InteractiveModeContext,
	"settings" | "viewSession" | "focusedAgentId" | "editor" | "ui"
>;

export interface CompletionModelRunnerInput {
	systemPrompt: string;
	userPrompt: string;
	signal: AbortSignal;
	maxTokens: number;
	reasoning?: Effort;
	disableReasoning?: boolean;
}

export type CompletionModelRunner = (input: CompletionModelRunnerInput) => Promise<string | undefined>;

/** 32-bit DJB2 hash (Cursor Tab seed 149417) for rejected suggestion suppression. */
export function djb2Hash(text: string): number {
	let hash = DJB2_SEED >>> 0;
	for (let i = 0; i < text.length; i++) {
		hash = (((hash << 5) + hash) ^ text.charCodeAt(i)) >>> 0;
	}
	return hash >>> 0;
}

/** Parse `git status --porcelain=v1` output into normalized forward-slash relative file entries. */
export function parseGitPorcelainStatus(stdout: string): GitStatusFile[] {
	const out: GitStatusFile[] = [];
	for (const rawLine of stdout.split(/\r?\n/)) {
		if (rawLine.length < 4) continue;
		const status = rawLine.slice(0, 2).trim() || "M";
		let relPath = rawLine.slice(3).trim();
		const arrowIdx = relPath.indexOf(" -> ");
		if (arrowIdx !== -1) relPath = relPath.slice(arrowIdx + 4).trim();
		if (relPath.startsWith('"') && relPath.endsWith('"') && relPath.length >= 2) {
			relPath = relPath.slice(1, -1);
		}
		relPath = relPath.replace(/\\/g, "/");
		if (!relPath) continue;
		out.push({ status, path: relPath });
		if (out.length >= 60) break;
	}
	return out;
}

/**
 * Breadth-first workspace directory/file tree scanner (up to depth 5, capped at 500 entries)
 * so nested source files (e.g. `packages/tui/src/components/editor.ts`) are indexed for 0 ms
 * Tier-1 completion and Tier-2 LLM context without blocking on deep `node_modules` trees.
 */
export function scanWorkspaceTree(
	cwd: string,
	maxDepth: number = WORKSPACE_TREE_MAX_DEPTH,
	maxEntries: number = WORKSPACE_TREE_MAX_ENTRIES,
): readonly string[] {
	const now = Date.now();
	const cached = workspaceTreeByCwd.get(cwd);
	if (cached && now - cached.scannedAt < WORKSPACE_TREE_TTL_MS) {
		return cached.paths;
	}

	const paths: string[] = [];
	const queue: Array<{ absDir: string; relPrefix: string; depth: number }> = [
		{ absDir: cwd, relPrefix: "", depth: 1 },
	];

	while (queue.length > 0 && paths.length < maxEntries) {
		const current = queue.shift()!;
		let dirents: fs.Dirent[];
		try {
			dirents = fs.readdirSync(current.absDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const d of dirents) {
			if (d.name === ".DS_Store" || Object.hasOwn(IGNORED_DIRS, d.name)) continue;
			if (d.name.startsWith(".") && d.isDirectory() && d.name !== ".github") continue;
			const rel = current.relPrefix ? `${current.relPrefix}/${d.name}` : d.name;
			paths.push(rel);
			if (paths.length >= maxEntries) break;
			if (d.isDirectory() && current.depth < maxDepth) {
				queue.push({
					absDir: path.join(current.absDir, d.name),
					relPrefix: rel,
					depth: current.depth + 1,
				});
			}
		}
	}

	workspaceTreeByCwd.set(cwd, { paths, scannedAt: now });
	return paths;
}

function hasGitRepo(startDir: string): boolean {
	let cur = path.resolve(startDir);
	while (true) {
		if (fs.existsSync(path.join(cur, ".git"))) return true;
		const parent = path.dirname(cur);
		if (parent === cur) return false;
		cur = parent;
	}
}

function triggerAsyncGitStatusRefresh(cwd: string, onUpdated?: () => void): readonly GitStatusFile[] {
	const now = Date.now();
	let snap = gitStatusByCwd.get(cwd);
	if (!snap) {
		snap = { files: [], scannedAt: 0, generation: 0, inFlight: false };
		gitStatusByCwd.set(cwd, snap);
	}
	if (!snap.inFlight && now - snap.scannedAt >= GIT_STATUS_TTL_MS) {
		if (!hasGitRepo(cwd)) {
			snap.scannedAt = now;
			snap.files = [];
			return snap.files;
		}
		snap.inFlight = true;
		execFile(
			"git",
			["-C", cwd, "--no-optional-locks", "status", "--porcelain=v1", "-uall"],
			{ timeout: 2_000, windowsHide: true, maxBuffer: 512 * 1024 },
			(err, stdout) => {
				snap.inFlight = false;
				snap.scannedAt = Date.now();
				const nextFiles = err ? [] : parseGitPorcelainStatus(stdout);
				const prevSig = snap.files.map(f => `${f.status}:${f.path}`).join("|");
				const nextSig = nextFiles.map(f => `${f.status}:${f.path}`).join("|");
				snap.files = nextFiles;
				if (prevSig !== nextSig) {
					globalGitGeneration++;
					snap.generation = globalGitGeneration;
					onUpdated?.();
				}
			},
		);
	}
	return snap.files;
}

/**
 * Strip any accidental prefix echo from an LLM continuation reply so ghost text
 * joins seamlessly at `<|cursor|>` without duplicating characters already typed.
 */
export function normalizeInlineCompletionSuffix(beforeCursorLine: string, rawReply: string): string | undefined {
	if (!rawReply) return undefined;
	const firstLine = sanitizeText(rawReply).split(/\r?\n/)[0] ?? "";
	const trimmedCheck = firstLine.trim();
	if (!trimmedCheck || trimmedCheck.includes(SKIP_TOKEN) || trimmedCheck === "<|cursor|>") {
		return undefined;
	}

	let candidate = firstLine.replace(/\s+$/, "");
	const quoted = WRAPPING_QUOTES.exec(candidate.trim());
	if (quoted && !beforeCursorLine.endsWith('"') && !beforeCursorLine.endsWith("`")) {
		const unwrapped = quoted[1] ?? quoted[2] ?? quoted[3] ?? "";
		const hadLeadingSpace = /^\s/.test(candidate);
		candidate = hadLeadingSpace && unwrapped && !/^\s/.test(unwrapped) ? ` ${unwrapped}` : unwrapped;
	}

	candidate = candidate.replace(/^<\|cursor\|>/, "");
	if (!candidate) return undefined;

	// Case 1: Model repeated the entire current line before cursor, then appended the continuation.
	if (beforeCursorLine.length > 0 && candidate.startsWith(beforeCursorLine)) {
		candidate = candidate.slice(beforeCursorLine.length);
	} else if (beforeCursorLine.length > 0) {
		// Case 2: Model echoed a trailing suffix of `beforeCursorLine` (e.g. last word or last N chars).
		const maxOverlap = Math.min(beforeCursorLine.length, candidate.length - 1, 64);
		for (let k = maxOverlap; k >= 1; k--) {
			if (beforeCursorLine.endsWith(candidate.slice(0, k))) {
				if (k >= 2 || /\W/.test(candidate[0]!)) {
					candidate = candidate.slice(k);
					break;
				}
			}
		}
	}

	if (!candidate || !candidate.trim() || candidate.length > MAX_SUFFIX_LENGTH) return undefined;
	return candidate;
}

function normalizeEmptyMenuReply(rawReply: string): string | undefined {
	if (!rawReply) return undefined;
	const cleaned = sanitizeText(rawReply).trim();
	if (!cleaned || cleaned.includes(SKIP_TOKEN)) return undefined;
	// Collapse multi-line numbered lists ("1. foo\n2. bar\n3. baz") onto a single double-spaced line.
	const lines = cleaned
		.split(/\r?\n/)
		.map(l => l.trim())
		.filter(Boolean);
	const numberedLines = lines.filter(l => /^[1-9][.)、]\s*\S/.test(l));
	const joined = (numberedLines.length >= 2 ? numberedLines.join("  ") : lines.join("  "))
		.replace(/\s+(?=[2-9][.)、]\s*)/g, "  ")
		.trim();
	if (!joined || joined.length > 360) return undefined;
	return joined;
}

function getMessageRole(msg: unknown): string | undefined {
	if (typeof msg === "object" && msg !== null && "role" in msg && typeof msg.role === "string") {
		return msg.role;
	}
	return undefined;
}

function isTextContentBlock(block: unknown): block is { type: "text"; text: string } {
	return (
		typeof block === "object" &&
		block !== null &&
		"type" in block &&
		block.type === "text" &&
		"text" in block &&
		typeof block.text === "string"
	);
}

function extractMessageText(msg: unknown): string {
	if (typeof msg !== "object" || msg === null || !("content" in msg)) return "";
	const raw = msg.content;
	if (typeof raw === "string") return raw;
	if (Array.isArray(raw)) {
		const parts: string[] = [];
		for (const block of raw) {
			if (isTextContentBlock(block)) {
				parts.push(block.text);
			}
		}
		return parts.join("\n");
	}
	return "";
}

interface CacheEntry {
	prefix: string;
	suffix: string;
}

export class ComposerInlineCompletionController {
	readonly #ctx: InlineCompletionContext;
	readonly #debounceMs: number;
	readonly #deadlineMs: number;
	readonly #customRunner: CompletionModelRunner | undefined;
	readonly #cwd: string | undefined;
	readonly #staticGitFiles: readonly GitStatusFile[] | undefined;

	#lastDocPrefix = "";
	#cache: CacheEntry[] = [];
	#rejectedHashes = new Set<number>();
	#dismissTimestamps: number[] = [];
	#snoozedUntil = 0;

	#debounceTimer: NodeJS.Timeout | undefined;
	#abort: AbortController | undefined;
	#pendingPrefix: string | undefined;

	// Fast empty-composer numbered menu fallback (`1. ...  2. ...  3. ...`)
	#emptyMenuText: string | undefined;
	#emptyMenuKey: string | undefined;
	#emptyMenuAbort: AbortController | undefined;

	// Memoized Tier-1 live session + deep workspace + git status index
	#indexedCwd: string | undefined;
	#indexedSessionRef: unknown;
	#indexedMessageCount = -1;
	#indexedLastMsgRef: unknown;
	#indexedGitGeneration = -1;
	#identCounts = new Map<string, number>();
	#cjkPhrases = new Map<string, number>();

	constructor(
		ctx: InlineCompletionContext,
		options: {
			debounceMs?: number;
			deadlineMs?: number;
			runner?: CompletionModelRunner;
			cwd?: string;
			gitStatusFiles?: readonly GitStatusFile[];
		} = {},
	) {
		this.#ctx = ctx;
		this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		this.#deadlineMs = options.deadlineMs ?? COMPLETION_DEADLINE_MS;
		this.#customRunner = options.runner;
		this.#cwd = options.cwd;
		if (!this.#customRunner) {
			prewarmCursorTabConnection();
		}
		this.#staticGitFiles = options.gitStatusFiles;

		const initialCwd = this.#cwd ?? process.cwd();
		scanWorkspaceTree(initialCwd);
		if (!this.#staticGitFiles) {
			triggerAsyncGitStatusRefresh(initialCwd);
		}
	}

	/**
	 * Fast numbered `1. ...  2. ...  3. ...` menu for an empty composer when
	 * `ComposerPredictionController` hasn't produced one yet (e.g. fresh session startup
	 * with dirty git files, or while the heavy main model's ephemeral turn is still running).
	 */
	get emptyPrediction(): string | undefined {
		if (!cfgComposerPredictions.get(this.#ctx.settings) && !cfgComposerInlineCompletions.get(this.#ctx.settings)) {
			return undefined;
		}
		if (this.#ctx.focusedAgentId !== undefined) return undefined;
		const session = this.#ctx.viewSession;
		if (session.isStreaming || session.isCompacting) return undefined;

		const cwd = this.#cwd ?? process.cwd();
		const gitFiles = this.#getGitFiles(cwd);
		const msgs = session.messages ?? [];
		const key = `${cwd}::${msgs.length}::${gitFiles.map(f => `${f.status}:${f.path}`).join(",")}`;

		if (this.#emptyMenuKey === key) {
			return this.#emptyMenuText;
		}
		// Only auto-request via real network when no custom unit-test runner is injected,
		// so mid-typing unit tests retain deterministic call counts.
		if (!this.#customRunner && Date.now() >= this.#snoozedUntil) {
			this.#emptyMenuKey = key;
			this.#emptyMenuText = undefined;
			this.#requestEmptyMenu(cwd, gitFiles);
		}
		return this.#emptyMenuText;
	}

	/** Cancel any pending/in-flight request (e.g. on submit, session switch, or setting off). */
	cancel(): void {
		if (this.#debounceTimer !== undefined) {
			clearTimeout(this.#debounceTimer);
			this.#debounceTimer = undefined;
		}
		this.#abort?.abort();
		this.#abort = undefined;
		this.#pendingPrefix = undefined;
		this.#emptyMenuAbort?.abort();
		this.#emptyMenuAbort = undefined;
	}

	/** Reset transient typing state when a prompt is submitted or session changes. */
	resetDraft(): void {
		this.cancel();
		this.#lastDocPrefix = "";
		this.#emptyMenuText = undefined;
		this.#emptyMenuKey = undefined;
	}

	/** Handle Editor feedback (`accept`, `partial-accept`, `dismiss`). */
	handleEvent(event: "accept" | "partial-accept" | "dismiss", shownSuffix?: string): void {
		if (event === "accept" || event === "partial-accept") {
			this.#snoozedUntil = 0;
			this.#dismissTimestamps.length = 0;
			return;
		}
		if (event === "dismiss") {
			this.cancel();
			if (shownSuffix && this.#lastDocPrefix) {
				this.#rejectedHashes.add(djb2Hash(`${this.#lastDocPrefix}\0${shownSuffix}`));
				this.#cache = this.#cache.filter(entry => {
					if (!this.#lastDocPrefix.startsWith(entry.prefix)) return true;
					const delta = this.#lastDocPrefix.slice(entry.prefix.length);
					return !(delta.length < entry.suffix.length && entry.suffix.startsWith(delta));
				});
			}
			const now = Date.now();
			this.#dismissTimestamps = this.#dismissTimestamps.filter(t => now - t < ANNOYANCE_WINDOW_MS);
			this.#dismissTimestamps.push(now);
			if (this.#dismissTimestamps.length >= ANNOYANCE_DISMISS_THRESHOLD) {
				this.#snoozedUntil = now + ANNOYANCE_WINDOW_MS;
			}
			this.#ctx.ui.requestRender();
		}
	}

	/**
	 * Synchronous render-path query invoked by `Editor.#getInlineHint()`.
	 * Returns cached/Tier-1 ghost text immediately (0 ms) and schedules a debounced
	 * Tier-2 Flash LLM continuation (with light reasoning & maxTokens=128) on forward typing.
	 */
	getInlineCompletion(lines: readonly string[], cursorLine: number, cursorCol: number): string | undefined {
		if (!cfgComposerInlineCompletions.get(this.#ctx.settings)) return undefined;
		if (this.#ctx.focusedAgentId !== undefined) return undefined;

		const currentLine = lines[cursorLine] ?? "";
		if (cursorCol !== currentLine.length) return undefined;

		const docPrefix = [...lines.slice(0, cursorLine), currentLine.slice(0, cursorCol)].join("\n");
		const prevPrefix = this.#lastDocPrefix;
		this.#lastDocPrefix = docPrefix;

		const trimmedStart = docPrefix.trimStart();
		if (!trimmedStart || (cursorLine === 0 && (trimmedStart.startsWith("/") || trimmedStart.startsWith("!")))) {
			if (prevPrefix !== docPrefix) this.cancel();
			return undefined;
		}

		// 1. 0 ms Type-Through Prefix Slicer (handles continuous typing AND Ctrl+Right partial word accept)
		const cachedSuffix = this.#sliceCached(docPrefix);
		if (cachedSuffix) return cachedSuffix;

		// 2. Forward-typing gate: schedule debounced Tier-2 Flash LLM call when user adds characters forward.
		const isBackspaceShrink = docPrefix.length < prevPrefix.length && prevPrefix.startsWith(docPrefix);
		const movedForward = docPrefix !== prevPrefix && !isBackspaceShrink;

		if (movedForward && trimmedStart.length >= 2 && Date.now() >= this.#snoozedUntil) {
			this.#scheduleLlmRequest(docPrefix, currentLine);
		} else if (docPrefix !== prevPrefix && this.#pendingPrefix && !docPrefix.startsWith(this.#pendingPrefix)) {
			this.cancel();
		}

		// 3. Tier-1 Instant (<0.2 ms) Git-Status + Deep-Tree + Session Identifier Completion
		return this.#lookupLocalSessionToken(docPrefix, currentLine);
	}

	#getGitFiles(cwd: string): readonly GitStatusFile[] {
		if (this.#staticGitFiles !== undefined) return this.#staticGitFiles;
		return triggerAsyncGitStatusRefresh(cwd, () => {
			this.#ctx.ui.requestRender();
		});
	}

	#sliceCached(docPrefix: string): string | undefined {
		for (let i = this.#cache.length - 1; i >= 0; i--) {
			const entry = this.#cache[i]!;
			if (!docPrefix.startsWith(entry.prefix)) continue;
			const delta = docPrefix.slice(entry.prefix.length);
			if (delta.length < entry.suffix.length && entry.suffix.startsWith(delta)) {
				const remaining = entry.suffix.slice(delta.length);
				if (!this.#rejectedHashes.has(djb2Hash(`${docPrefix}\0${remaining}`))) {
					return remaining;
				}
			}
		}
		return undefined;
	}

	#putCache(prefix: string, suffix: string): void {
		this.#cache = this.#cache.filter(e => e.prefix !== prefix);
		this.#cache.push({ prefix, suffix });
		if (this.#cache.length > LRU_CACHE_LIMIT) {
			this.#cache.splice(0, this.#cache.length - LRU_CACHE_LIMIT);
		}
	}

	#indexPathToken(relPath: string, weight: number): void {
		const normalized = relPath.replace(/\\/g, "/");
		if (WORKSPACE_TOKEN_RE.test(normalized)) {
			this.#identCounts.set(normalized, (this.#identCounts.get(normalized) ?? 0) + weight);
		}
		const base = path.posix.basename(normalized);
		if (base && base !== normalized) {
			if (WORKSPACE_TOKEN_RE.test(base)) {
				this.#identCounts.set(base, (this.#identCounts.get(base) ?? 0) + weight);
			} else if (WORKSPACE_CJK_RE.test(base)) {
				this.#cjkPhrases.set(base, (this.#cjkPhrases.get(base) ?? 0) + weight);
			}
		} else if (WORKSPACE_CJK_RE.test(normalized)) {
			this.#cjkPhrases.set(normalized, (this.#cjkPhrases.get(normalized) ?? 0) + weight);
		}
	}

	#refreshSessionIndex(): void {
		const cwd = this.#cwd ?? process.cwd();
		const session = this.#ctx.viewSession;
		const msgs = session.messages ?? [];
		const lastMsg = msgs.at(-1);
		const gitFiles = this.#getGitFiles(cwd);
		const gitGen = this.#staticGitFiles ? 0 : (gitStatusByCwd.get(cwd)?.generation ?? 0);

		if (
			this.#indexedCwd === cwd &&
			this.#indexedSessionRef === session &&
			this.#indexedMessageCount === msgs.length &&
			this.#indexedLastMsgRef === lastMsg &&
			this.#indexedGitGeneration === gitGen
		) {
			return;
		}
		this.#indexedCwd = cwd;
		this.#indexedSessionRef = session;
		this.#indexedMessageCount = msgs.length;
		this.#indexedLastMsgRef = lastMsg;
		this.#indexedGitGeneration = gitGen;
		this.#identCounts.clear();
		this.#cjkPhrases.clear();

		// 1. Deep workspace tree (BFS up to depth 5): base weight +2
		for (const relPath of scanWorkspaceTree(cwd)) {
			this.#indexPathToken(relPath, 2);
		}

		// 2. Git modified / staged / untracked paths: high priority weight +6
		for (const gf of gitFiles) {
			this.#indexPathToken(gf.path, 6);
		}

		// 3. Active conversation recent 16 messages: user weight +3, assistant weight +1
		const tail = msgs.slice(-16);
		for (const msg of tail) {
			const role = getMessageRole(msg);
			if (role !== "user" && role !== "assistant") continue;
			const weight = role === "user" ? 3 : 1;
			const text = extractMessageText(msg).slice(0, 6_000);
			if (!text) continue;
			for (const m of text.matchAll(IDENT_SCAN_RE)) {
				const tok = m[0];
				if (tok.length >= 4) {
					this.#identCounts.set(tok, (this.#identCounts.get(tok) ?? 0) + weight);
				}
			}
			if (role === "user") {
				for (const m of text.matchAll(CJK_PHRASE_SCAN_RE)) {
					const phrase = m[0];
					this.#cjkPhrases.set(phrase, (this.#cjkPhrases.get(phrase) ?? 0) + weight);
				}
			}
		}
	}

	#lookupLocalSessionToken(docPrefix: string, currentLine: string): string | undefined {
		this.#refreshSessionIndex();

		const identMatch = IDENT_TAIL_RE.exec(currentLine);
		if (identMatch) {
			const prefix = identMatch[0];
			const lower = prefix.toLowerCase();
			let bestToken: string | undefined;
			let bestScore = 0;
			for (const [tok, count] of this.#identCounts) {
				if (tok.length <= prefix.length) continue;
				const exactCase = tok.startsWith(prefix);
				if (!exactCase && !tok.toLowerCase().startsWith(lower)) continue;
				const score = count * (exactCase ? 2 : 1);
				if (score > bestScore) {
					bestScore = score;
					bestToken = tok;
				}
			}
			if (bestToken) {
				const suffix = bestToken.slice(prefix.length);
				if (!this.#rejectedHashes.has(djb2Hash(`${docPrefix}\0${suffix}`))) {
					return suffix;
				}
			}
		}

		const cjkMatch = CJK_TAIL_RE.exec(currentLine);
		if (cjkMatch) {
			const prefix = cjkMatch[0];
			let bestPhrase: string | undefined;
			let bestScore = 0;
			for (const [phrase, count] of this.#cjkPhrases) {
				if (phrase.length > prefix.length && phrase.startsWith(prefix) && count > bestScore) {
					bestScore = count;
					bestPhrase = phrase;
				}
			}
			if (bestPhrase) {
				const suffix = bestPhrase.slice(prefix.length);
				if (!this.#rejectedHashes.has(djb2Hash(`${docPrefix}\0${suffix}`))) {
					return suffix;
				}
			}
		}
		return undefined;
	}

	#scheduleLlmRequest(docPrefix: string, currentLine: string): void {
		if (this.#pendingPrefix === docPrefix) return;
		if (this.#debounceTimer !== undefined) {
			clearTimeout(this.#debounceTimer);
			this.#debounceTimer = undefined;
		}
		this.#abort?.abort();
		this.#abort = undefined;
		this.#pendingPrefix = docPrefix;

		this.#debounceTimer = setTimeout(() => {
			this.#debounceTimer = undefined;
			if (this.#lastDocPrefix !== docPrefix) return;
			const abort = new AbortController();
			this.#abort = abort;
			void this.#runLlmCompletion(docPrefix, currentLine, abort);
		}, this.#debounceMs);
	}

	#buildWorkspaceSections(docPrefix: string, recentText: string): string[] {
		const cwd = this.#cwd ?? process.cwd();
		const gitFiles = this.#getGitFiles(cwd);
		const treePaths = scanWorkspaceTree(cwd);
		const sections: string[] = [];

		if (gitFiles.length > 0) {
			const lines = gitFiles.slice(0, 20).map(f => `${f.status} ${f.path}`);
			sections.push(`<git-status>\n${lines.join("\n")}\n</git-status>`);
		}

		if (treePaths.length > 0) {
			const querySource = `${docPrefix} ${recentText}`.toLowerCase();
			const queryTokens = [...new Set(querySource.match(/[a-z0-9_.-]{3,}/g) ?? [])].slice(-20);
			const scored = treePaths.map(p => {
				const lower = p.toLowerCase();
				let score = p.includes("/") ? 1 : 2;
				for (const qt of queryTokens) {
					if (lower.includes(qt)) score += 5;
				}
				return { path: p, score };
			});
			scored.sort((a, b) => b.score - a.score);
			const picked = scored.slice(0, 30).map(s => s.path);
			sections.push(`<workspace-files>\n${picked.join("\n")}\n</workspace-files>`);
		}
		return sections;
	}

	#buildUserPrompt(docPrefix: string): string {
		const session = this.#ctx.viewSession;
		const msgs = session.messages ?? [];
		const recentTurns: string[] = [];
		const userStyleSamples: string[] = [];

		for (let i = msgs.length - 1; i >= 0 && (recentTurns.length < 4 || userStyleSamples.length < 5); i--) {
			const msg = msgs[i]!;
			const role = getMessageRole(msg);
			if (role !== "user" && role !== "assistant") continue;
			const text = sanitizeText(extractMessageText(msg)).replace(/\s+/g, " ").trim();
			if (!text) continue;
			if (role === "user" && userStyleSamples.length < 5 && !text.startsWith("<")) {
				userStyleSamples.unshift(text.slice(0, 140));
			}
			if (recentTurns.length < 4) {
				recentTurns.unshift(`${role.toUpperCase()}: ${text.slice(0, 320)}`);
			}
		}

		const sections: string[] = [...this.#buildWorkspaceSections(docPrefix, recentTurns.join(" "))];
		if (userStyleSamples.length > 0) {
			sections.push(
				`<user-voice-samples>\n${userStyleSamples.map(s => `- ${s}`).join("\n")}\n</user-voice-samples>`,
			);
		}
		if (recentTurns.length > 0) {
			sections.push(`<recent-conversation>\n${recentTurns.join("\n")}\n</recent-conversation>`);
		}
		const tailDraft = docPrefix.length > 600 ? docPrefix.slice(-600) : docPrefix;
		sections.push(`<draft>${tailDraft}<|cursor|></draft>`);
		return sections.join("\n\n");
	}

	#resolveFastModel(): Model | undefined {
		const session = this.#ctx.viewSession;
		const registry = session.modelRegistry;
		if (!registry) return session.model;
		const available = registry.getAvailable?.() ?? [];
		if (available.length > 0) {
			const smol = resolveRoleChain("smol", this.#ctx.settings, available)[0]?.model;
			if (smol) return smol;
			const tiny = resolveRoleSelection(["tiny"], this.#ctx.settings, available)?.model;
			if (tiny) return tiny;
		}
		return session.model;
	}

	async #invokeFastLlm(sysPrompt: string, userPrompt: string, signal: AbortSignal): Promise<string | undefined> {
		if (this.#customRunner) {
			return this.#customRunner({
				systemPrompt: sysPrompt,
				userPrompt,
				signal,
				maxTokens: COMPLETION_MAX_TOKENS,
				disableReasoning: true,
			});
		}
		const session = this.#ctx.viewSession;
		const model = this.#resolveFastModel();
		const registry = session.modelRegistry;
		if (!model || !registry) return undefined;
		const sessionId = session.sessionManager?.getSessionId?.();
		const apiKey = await registry.getApiKey(model, sessionId);
		if (!apiKey || signal.aborted) return undefined;

		const response = await completeSimple(
			model,
			{
				systemPrompt: [sysPrompt],
				messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
			},
			{
				apiKey: registry.resolver(model, sessionId),
				sessionId,
				maxTokens: COMPLETION_MAX_TOKENS,
				disableReasoning: true,
				signal,
			},
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") return undefined;
		return response.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map(b => b.text)
			.join("");
	}

	#requestEmptyMenu(cwd: string, gitFiles: readonly GitStatusFile[]): void {
		this.#emptyMenuAbort?.abort();
		const session = this.#ctx.viewSession;
		const msgs = session.messages ?? [];
		if (msgs.length === 0 && gitFiles.length === 0) return;

		const abort = new AbortController();
		this.#emptyMenuAbort = abort;
		const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(this.#deadlineMs)]);

		const recentTurns: string[] = [];
		for (let i = msgs.length - 1; i >= 0 && recentTurns.length < 4; i--) {
			const msg = msgs[i]!;
			const role = getMessageRole(msg);
			if (role !== "user" && role !== "assistant") continue;
			const text = sanitizeText(extractMessageText(msg)).replace(/\s+/g, " ").trim();
			if (text) recentTurns.unshift(`${role.toUpperCase()}: ${text.slice(0, 300)}`);
		}
		const sections = [...this.#buildWorkspaceSections("", recentTurns.join(" "))];
		if (recentTurns.length > 0) {
			sections.push(`<recent-conversation>\n${recentTurns.join("\n")}\n</recent-conversation>`);
		}
		const userPrompt = sections.join("\n\n") || `Workspace: ${cwd}`;

		void (async () => {
			try {
				const raw = await this.#invokeFastLlm(EMPTY_MENU_SYSTEM_PROMPT, userPrompt, signal);
				if (abort.signal.aborted || !raw) return;
				const menu = normalizeEmptyMenuReply(raw);
				if (!menu) return;
				this.#emptyMenuText = menu;
				if (!this.#ctx.editor.getText()) {
					this.#ctx.ui.requestRender();
				}
			} catch (error) {
				if (!abort.signal.aborted) {
					logger.debug("Empty composer menu prediction failed", { error: String(error) });
				}
			} finally {
				if (this.#emptyMenuAbort === abort) this.#emptyMenuAbort = undefined;
			}
		})();
	}

	async #tryCursorTabCompletion(
		docPrefix: string,
		currentLine: string,
		signal: AbortSignal,
	): Promise<string | undefined> {
		if (this.#customRunner) return undefined;
		const cwd = this.#cwd ?? process.cwd();
		const gitFiles = this.#getGitFiles(cwd)
			.slice(0, 12)
			.map(f => `${f.status} ${f.path}`);
		const treePaths = scanWorkspaceTree(cwd);
		const lowerDraft = docPrefix.toLowerCase();
		const queryTokens = [...new Set(lowerDraft.match(/[a-z0-9_.-]{3,}/g) ?? [])].slice(-12);
		const matchedFiles =
			queryTokens.length > 0
				? treePaths
						.filter(p => {
							const lp = p.toLowerCase();
							return queryTokens.some(qt => lp.includes(qt));
						})
						.slice(0, 14)
				: treePaths.slice(0, 10);

		const msgs = this.#ctx.viewSession.messages ?? [];
		const recentConversation: string[] = [];
		for (let i = msgs.length - 1; i >= 0 && recentConversation.length < 3; i--) {
			const msg = msgs[i]!;
			const role = getMessageRole(msg);
			if (role !== "user" && role !== "assistant") continue;
			const text = sanitizeText(extractMessageText(msg)).replace(/\s+/g, " ").trim();
			if (text) recentConversation.unshift(`${role.toUpperCase()}: ${text.slice(0, 200)}`);
		}

		let cursorAuthToken: string | undefined;
		const registry = this.#ctx.viewSession.modelRegistry;
		if (registry) {
			const cursorModel = registry.getAvailable?.().find(m => m.provider === "cursor");
			if (cursorModel) {
				cursorAuthToken = await registry.getApiKey(cursorModel).catch(() => undefined);
			}
		}

		return requestCursorTabCompletion({
			cwd,
			draftPrefix: docPrefix,
			currentLine,
			dirtyFiles: gitFiles,
			workspaceFiles: matchedFiles,
			recentConversation,
			overrideToken: cursorAuthToken,
			signal,
		}).catch(() => undefined);
	}

	async #runLlmCompletion(docPrefix: string, currentLine: string, abort: AbortController): Promise<void> {
		try {
			const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(this.#deadlineMs)]);

			// Primary Tier-2 Engine: Cursor's native Fusion Tab (`StreamCpp`, ~500ms, 0 reasoning tokens).
			// Automatically falls back to `#invokeFastLlm` if no Cursor token is present or if Tab returns empty.
			let rawReply = await this.#tryCursorTabCompletion(docPrefix, currentLine, signal);
			if (!rawReply && !abort.signal.aborted) {
				const sysPrompt = prompt.render(inlineCompletionSystemPrompt, { skip: SKIP_TOKEN });
				const userPrompt = this.#buildUserPrompt(docPrefix);
				rawReply = await this.#invokeFastLlm(sysPrompt, userPrompt, signal);
			}
			if (abort.signal.aborted || !rawReply) return;
			const suffix = normalizeInlineCompletionSuffix(currentLine, rawReply);
			if (!suffix) return;
			if (this.#rejectedHashes.has(djb2Hash(`${docPrefix}\0${suffix}`))) return;

			this.#putCache(docPrefix, suffix);
			if (this.#lastDocPrefix.startsWith(docPrefix)) {
				this.#ctx.ui.requestRender();
			}
		} catch (error) {
			if (!abort.signal.aborted) {
				logger.debug("Inline completion failed", { error: String(error) });
			}
		} finally {
			if (this.#abort === abort) {
				this.#abort = undefined;
				this.#pendingPrefix = undefined;
			}
		}
	}
}
