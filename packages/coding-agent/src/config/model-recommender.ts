/**
 * Resource-pool & model-capability aware recommendation and routing engine.
 *
 * Evaluates every available model across two orthogonal axes:
 * 1. Resource Pool Health & FinOps Urgency (from live/cached `UsageReport[]`):
 *    - Exact model-scoped quota window matching (e.g. `google-antigravity`
 *      Gemini vs Claude/GPT window, `cursor` Cursor Models vs Other Models,
 *      `opencode-go` multi-window most-constraining check, `zhipu-coding-plan`
 *      5h token window).
 *    - Expiring-window salvage ("🔥 临期优先"): windows resetting within <= 6h
 *      (or <= 24h with >= 40% left) receive a priority boost so expiring
 *      subscription quota is burned before it resets.
 *    - Exhausted windows (`0%` remaining) are disqualified whenever healthy
 *      alternatives exist.
 *    - Local gateway (`magpie`) models are down-ranked when the local gateway
 *      is unreachable so direct authenticated providers win automatically.
 * 2. Model Capability per Role (`default`, `slow`, `plan`, `smol`, `vision`,
 *    `advisor`, `commit`, and subagent archetypes `task`, `reviewer`,
 *    `security-reviewer`, `scout`):
 *    - Frontier reasoning tier (`gemini-4-argon`, `claude-opus-5-5`,
 *      `claude-fable-5-1`, `gpt-6-astra`, `gpt-6.1-sol`), Workhorse tier
 *      (`claude-sonnet-5-5`, `glm-5.3`, `kimi-k3`), Fast SWE/Flash tier
 *      (`swe-2`, `gemini-3.8-flash`, `deepseek-v4.1-flash`,
 *      `MiniMax-M3.1-Flash`, `cursor-grok-4.6-fast`).
 */
import * as net from "node:net";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { cfgRetryFallbackChains } from "../session/settings";
import { cfgTaskAgentModelOverrides } from "../task/settings";
import { acquireModelRoleMutation, findActiveModelPreset, type ModelPresetSession } from "./model-presets";
import { disabledProviderIds, formatModelStringWithRouting } from "./model-resolver";
import { cfgModelRoleStorage } from "./model-settings";
import type { Settings } from "./settings";

export const RECOMMENDED_ROLE_IDS = ["default", "slow", "plan", "smol", "vision", "advisor", "commit"] as const;

export type RecommendedRoleId = (typeof RECOMMENDED_ROLE_IDS)[number];

/**
 * Fast TCP loopback probe to check whether the local Magpie gateway (`127.0.0.1:3425`) is listening.
 */
export function probeMagpieGatewayUp(port = 3425, timeoutMs = 250): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	let settled = false;
	const socket = new net.Socket();
	const finish = (up: boolean) => {
		if (settled) return;
		settled = true;
		try {
			socket.destroy();
		} catch {
			// ignore
		}
		resolve(up);
	};
	socket.setTimeout(timeoutMs);
	socket.once("connect", () => finish(true));
	socket.once("timeout", () => finish(false));
	socket.once("error", () => finish(false));
	try {
		socket.connect(port, "127.0.0.1");
	} catch {
		finish(false);
	}
	return promise;
}
export type PoolUrgencyState = "salvage" | "healthy" | "reserve" | "exhausted" | "unknown";

export interface EvaluatedPoolHealth {
	provider: string;
	shortLabel: string;
	state: PoolUrgencyState;
	remainingPct?: number;
	resetMs?: number;
	resetText?: string;
	bankedResets: number;
	poolScore: number;
	reason: string;
}

export interface ScoredModelCandidate {
	model: Model<Api>;
	selector: string;
	capabilityTier: number;
	capabilityScore: number;
	pool: EvaluatedPoolHealth;
	totalScore: number;
	reason: string;
}

export interface RoleRecommendation {
	role: RecommendedRoleId;
	primary: ScoredModelCandidate | undefined;
	fallbacks: ScoredModelCandidate[];
}

export interface SessionModelRecommendation {
	roles: Record<RecommendedRoleId, RoleRecommendation>;
	agentOverrides: Partial<Record<"task" | "reviewer" | "security-reviewer" | "scout", string>>;
	headline: string;
	shortBadge: string;
	activePresetName?: string;
}

export interface RecommendModelsOptions {
	models: readonly Model<Api>[];
	reports: readonly unknown[];
	settings?: Settings;
	nowMs?: number;
	/** Whether the local Magpie gateway (`127.0.0.1:3425`) is reachable. Defaults to `false`. */
	magpieGatewayUp?: boolean;
}

const PROVIDER_SHORT_LABELS: Record<string, string> = {
	"google-antigravity": "AGY",
	"zhipu-coding-plan": "GLM",
	"minimax-code": "MM",
	"minimax-code-cn": "MM",
	"openai-codex": "CDX",
	cursor: "CUR",
	devin: "DEV",
	anthropic: "CLD",
	"github-copilot": "COP",
	"opencode-go": "OCG",
	deepseek: "DS",
	magpie: "MGP",
};

const AUXILIARY_SCOPE_PATTERN = /\b(video|image|audio|music|speech|tts|zread)\b/i;

interface ParsedWindow {
	id: string;
	label: string;
	windowId?: string;
	scopeModelId?: string;
	remainingPct: number;
	resetsAt?: number;
	durationMs: number;
	isAuxiliary: boolean;
}

function providerShortLabel(provider: string): string {
	const mapped = PROVIDER_SHORT_LABELS[provider];
	if (mapped) return mapped;
	const cleaned = provider.replace(/[^a-zA-Z0-9]+/g, "").toUpperCase();
	return cleaned.slice(0, 4) || provider.slice(0, 4).toUpperCase();
}

function formatResetCountdown(resetMs: number | undefined): string | undefined {
	if (resetMs === undefined || !Number.isFinite(resetMs) || resetMs <= 0 || resetMs > 14 * 86_400_000) {
		return undefined;
	}
	if (resetMs < 3_600_000) {
		return `${Math.max(1, Math.floor(resetMs / 60_000))}m`;
	}
	if (resetMs < 86_400_000) {
		return `${Math.floor(resetMs / 3_600_000)}h`;
	}
	return `${Math.floor(resetMs / 86_400_000)}d`;
}

function parseLimitWindow(rawLimit: unknown): ParsedWindow | null {
	if (!isRecord(rawLimit)) return null;
	const id = typeof rawLimit.id === "string" ? rawLimit.id : "";
	const label = typeof rawLimit.label === "string" ? rawLimit.label : id;
	const scope = isRecord(rawLimit.scope) ? rawLimit.scope : null;
	const windowObj = isRecord(rawLimit.window) ? rawLimit.window : null;
	const amount = isRecord(rawLimit.amount) ? rawLimit.amount : null;
	const status = typeof rawLimit.status === "string" ? rawLimit.status : undefined;

	const windowId =
		(windowObj && typeof windowObj.id === "string" ? windowObj.id : undefined) ??
		(scope && typeof scope.windowId === "string" ? scope.windowId : undefined);
	const scopeModelId =
		scope && typeof scope.modelId === "string" && scope.modelId.trim()
			? scope.modelId.trim().toLowerCase()
			: undefined;

	let remainingPct: number | undefined;
	if (amount) {
		if (typeof amount.remainingFraction === "number" && Number.isFinite(amount.remainingFraction)) {
			remainingPct = Math.round(Math.max(0, Math.min(1, amount.remainingFraction)) * 100);
		} else if (typeof amount.usedFraction === "number" && Number.isFinite(amount.usedFraction)) {
			remainingPct = Math.round(Math.max(0, Math.min(1, 1 - amount.usedFraction)) * 100);
		} else if (
			typeof amount.remaining === "number" &&
			typeof amount.limit === "number" &&
			amount.limit > 0 &&
			Number.isFinite(amount.remaining)
		) {
			remainingPct = Math.round(Math.max(0, Math.min(1, amount.remaining / amount.limit)) * 100);
		}
	}
	if (status === "exhausted") {
		remainingPct = 0;
	}
	if (remainingPct === undefined) return null;

	const resetsAt =
		windowObj && typeof windowObj.resetsAt === "number" && Number.isFinite(windowObj.resetsAt)
			? windowObj.resetsAt
			: undefined;
	const durationMs =
		windowObj && typeof windowObj.durationMs === "number" && Number.isFinite(windowObj.durationMs)
			? windowObj.durationMs
			: Number.POSITIVE_INFINITY;
	const isAuxiliary = AUXILIARY_SCOPE_PATTERN.test(`${id} ${label} ${scopeModelId ?? ""}`);

	return {
		id,
		label,
		windowId,
		scopeModelId,
		remainingPct,
		resetsAt,
		durationMs,
		isAuxiliary,
	};
}

function mostConstrainingWindow(windows: readonly ParsedWindow[]): ParsedWindow {
	let worst = windows[0]!;
	for (let i = 1; i < windows.length; i++) {
		const cur = windows[i]!;
		if (cur.remainingPct !== worst.remainingPct) {
			if (cur.remainingPct < worst.remainingPct) worst = cur;
			continue;
		}
		if (cur.durationMs !== worst.durationMs) {
			if (cur.durationMs < worst.durationMs) worst = cur;
			continue;
		}
		const worstReset = worst.resetsAt ?? Number.POSITIVE_INFINITY;
		const curReset = cur.resetsAt ?? Number.POSITIVE_INFINITY;
		if (curReset < worstReset) worst = cur;
	}
	return worst;
}

function selectWindowForModel(
	provider: string,
	modelId: string,
	windows: readonly ParsedWindow[],
): ParsedWindow | null {
	const nonAux = windows.filter(w => !w.isAuxiliary);
	const pool = nonAux.length > 0 ? nonAux : windows;
	if (pool.length === 0) return null;

	if (provider === "google-antigravity") {
		const isClaudeOrGpt = /claude|gpt|opus|sonnet|haiku|fable/i.test(modelId);
		const matching = pool.filter(w =>
			isClaudeOrGpt
				? /claude|gpt|anthropic|openai|3p/i.test(`${w.label} ${w.id}`)
				: /gemini/i.test(`${w.label} ${w.id}`),
		);
		if (matching.length > 0) return mostConstrainingWindow(matching);
		return mostConstrainingWindow(pool);
	}

	if (provider === "cursor") {
		const isCursorNative = /^(cursor-grok|composer|grok-4|default)/i.test(modelId);
		const matching = pool.filter(w =>
			isCursorNative
				? /cursor\s*models|individual-auto/i.test(`${w.label} ${w.id}`)
				: /other\s*models|individual-api/i.test(`${w.label} ${w.id}`),
		);
		if (matching.length > 0) return mostConstrainingWindow(matching);
		return mostConstrainingWindow(pool);
	}

	if (provider === "zhipu-coding-plan") {
		// If any window is 0%, it constrains the account; otherwise prefer the 5h token window for pace/salvage.
		const exhausted = pool.filter(w => w.remainingPct <= 0);
		if (exhausted.length > 0) return mostConstrainingWindow(exhausted);
		const fiveHour = pool.filter(
			w => w.windowId === "5h" || /5\s*hours?\s*token|tokens:5h/i.test(`${w.label} ${w.id}`),
		);
		if (fiveHour.length > 0) return mostConstrainingWindow(fiveHour);
		return mostConstrainingWindow(pool);
	}

	return mostConstrainingWindow(pool);
}

/**
 * Evaluate the quota health and urgency score for a specific `(provider, modelId)`.
 */
export function evaluateModelPoolHealth(
	provider: string,
	modelId: string,
	reports: readonly unknown[],
	options?: { nowMs?: number; magpieGatewayUp?: boolean },
): EvaluatedPoolHealth {
	const nowMs = options?.nowMs ?? Date.now();
	const shortLabel = providerShortLabel(provider);

	// Magpie local gateway routes to sub-providers (`magpie/devin/...`, `magpie/codex/...`, etc.)
	if (provider === "magpie") {
		const gatewayUp = options?.magpieGatewayUp ?? false;
		if (!gatewayUp) {
			return {
				provider,
				shortLabel,
				state: "unknown",
				bankedResets: 0,
				poolScore: -180,
				reason: "Magpie网关未启动(兜底)",
			};
		}
		return {
			provider,
			shortLabel,
			state: "healthy",
			bankedResets: 0,
			poolScore: 45,
			reason: "Magpie本地网关",
		};
	}

	const matchingReports: Record<string, unknown>[] = [];
	if (Array.isArray(reports)) {
		for (const raw of reports) {
			if (!isRecord(raw)) continue;
			if (typeof raw.provider === "string" && raw.provider.trim() === provider && Array.isArray(raw.limits)) {
				matchingReports.push(raw);
			}
		}
	}

	if (matchingReports.length === 0) {
		return {
			provider,
			shortLabel,
			state: "unknown",
			bankedResets: 0,
			poolScore: 25,
			reason: `${shortLabel}按量/无配额窗口`,
		};
	}

	let totalBankedResets = 0;
	const seenAccounts = new Set<string>();
	const accountWindows: ParsedWindow[] = [];

	for (const report of matchingReports) {
		if (
			isRecord(report.resetCredits) &&
			typeof report.resetCredits.availableCount === "number" &&
			Number.isFinite(report.resetCredits.availableCount)
		) {
			const meta = isRecord(report.metadata) ? report.metadata : null;
			const acctId = meta && typeof meta.accountId === "string" ? meta.accountId.trim() : "";
			if (!acctId || !seenAccounts.has(acctId)) {
				if (acctId) seenAccounts.add(acctId);
				totalBankedResets += Math.max(0, Math.trunc(report.resetCredits.availableCount));
			}
		}
		const rawLimits = Array.isArray(report.limits) ? report.limits : [];
		const parsed: ParsedWindow[] = [];
		for (const lim of rawLimits) {
			const w = parseLimitWindow(lim);
			if (w) parsed.push(w);
		}
		const chosen = selectWindowForModel(provider, modelId, parsed);
		if (chosen) accountWindows.push(chosen);
	}

	if (accountWindows.length === 0) {
		return {
			provider,
			shortLabel,
			state: "unknown",
			bankedResets: totalBankedResets,
			poolScore: 30,
			reason: `${shortLabel}无限制窗口`,
		};
	}

	// Best available account for this provider/model
	let best = accountWindows[0]!;
	for (let i = 1; i < accountWindows.length; i++) {
		const cand = accountWindows[i]!;
		if (cand.remainingPct > best.remainingPct) {
			best = cand;
		} else if (cand.remainingPct === best.remainingPct && (cand.resetsAt ?? Infinity) < (best.resetsAt ?? Infinity)) {
			best = cand;
		}
	}

	const remainingPct = best.remainingPct;
	const resetMs = best.resetsAt !== undefined ? best.resetsAt - nowMs : undefined;
	const resetText = formatResetCountdown(resetMs);
	const resetSuffix = resetText ? `/${resetText}` : "";
	const creditsSuffix = totalBankedResets > 0 ? ` ✦${totalBankedResets}` : "";

	if (remainingPct <= 0) {
		return {
			provider,
			shortLabel,
			state: "exhausted",
			remainingPct: 0,
			resetMs,
			resetText,
			bankedResets: totalBankedResets,
			poolScore: -1000,
			reason: `${shortLabel} 0%已耗尽${resetSuffix}`,
		};
	}

	// Salvage check:
	// - Short rolling windows (<= 6h, e.g. 5h window): only salvage when already active (< 92% left) and resetting within <= 4h.
	// - Long period windows (> 6h, e.g. 7d/monthly): salvage when resetting within <= 24h with >= 15% left.
	const isShortRollingWindow = Number.isFinite(best.durationMs) && best.durationMs <= 6 * 3_600_000;
	const isUrgentSalvage =
		remainingPct >= 15 &&
		resetMs !== undefined &&
		Number.isFinite(resetMs) &&
		resetMs > 0 &&
		(isShortRollingWindow ? remainingPct < 92 && resetMs <= 4 * 3_600_000 : resetMs <= 6 * 3_600_000);
	const isDailySalvage =
		!isShortRollingWindow &&
		remainingPct >= 25 &&
		resetMs !== undefined &&
		Number.isFinite(resetMs) &&
		resetMs > 0 &&
		resetMs <= 24 * 3_600_000;
	if (isUrgentSalvage || isDailySalvage) {
		const urgencyBoost = isUrgentSalvage ? 35 : 18;
		return {
			provider,
			shortLabel,
			state: "salvage",
			remainingPct,
			resetMs,
			resetText,
			bankedResets: totalBankedResets,
			poolScore: Math.round(75 + remainingPct * 0.45 + urgencyBoost + Math.min(12, totalBankedResets * 4)),
			reason: `🔥${shortLabel} ${remainingPct}%${resetSuffix}临期优先${creditsSuffix}`,
		};
	}

	if (remainingPct <= 15) {
		return {
			provider,
			shortLabel,
			state: "reserve",
			remainingPct,
			resetMs,
			resetText,
			bankedResets: totalBankedResets,
			poolScore: -90 + remainingPct * 2,
			reason: `⚠️${shortLabel} ${remainingPct}%${resetSuffix}余量低`,
		};
	}

	return {
		provider,
		shortLabel,
		state: "healthy",
		remainingPct,
		resetMs,
		resetText,
		bankedResets: totalBankedResets,
		poolScore: Math.round(40 + remainingPct * 0.45 + Math.min(12, totalBankedResets * 4)),
		reason: `${shortLabel} ${remainingPct}%${resetSuffix}${creditsSuffix}`,
	};
}

/**
 * Intrinsic capability tier (1..5) and fast-execution suitability for a model.
 */
export function classifyModelCapability(model: Model<Api>): {
	tier: number;
	isFast: boolean;
	isVision: boolean;
	isReasoning: boolean;
	isUncensoredOrGateway: boolean;
} {
	const id = model.id.toLowerCase();
	const name = (model.name || model.id).toLowerCase();
	const combined = `${id} ${name}`;
	const isVision = Array.isArray(model.input) && model.input.includes("image");
	const isReasoning = Boolean(model.reasoning || model.thinking);
	const isUncensoredOrGateway = /uncensored|abliterated/i.test(combined);

	// Skip non-chat image/embedding/tab-completion models
	if (/\b(image-01|banana|tab_flash|tab_jump|embed|tts|whisper)\b/i.test(combined)) {
		return { tier: 0, isFast: false, isVision: false, isReasoning: false, isUncensoredOrGateway: false };
	}

	let tier = 3.0;
	let isFast = false;

	if (
		/gemini-4-argon|claude-opus-5-5|claude-opus-5\.5|claude-fable-5|gpt-6-astra|gpt-6\.1-sol|gpt-6-1-sol|fusion-claude-(opus|fable)-5|fusion-gpt-6/i.test(
			combined,
		)
	) {
		tier = 5.0;
		if (/gemini-4-argon|gpt-6\.1-sol|gpt-6-1-sol|-fast\b/i.test(combined)) {
			isFast = true;
		}
	} else if (
		/claude-sonnet-5-5|claude-sonnet-5\.5|gpt-6-sol|glm-5\.3(?!-flash)|glm-5-3(?!-flash)|kimi-k3|deepseek-v4-pro|group\/flagship|claude-opus-5\b|claude-opus-4-[78]/i.test(
			combined,
		)
	) {
		tier = 4.3;
	} else if (
		/swe-2|gemini-3[.-]8-flash|deepseek-v4[.-]1-flash|deepseek-flash|minimax-m3[.-]1-flash|qwen3\.8-flash|gpt-6\.1-terra|gpt-6-1-terra|gpt-5\.6-sol|glm-5\.2|glm-5-2|composer-2\.5|group\/workhorse/i.test(
			combined,
		)
	) {
		tier = 3.8;
		isFast = true;
	} else if (
		/haiku-5|haiku-4|grok-4[.-][67]-fast|cursor-grok|glm-5[.-]3-flash|gpt-6-luna|gpt-5[.-]6-luna|gemini-3[.-][567]-flash|group\/flash-free/i.test(
			combined,
		)
	) {
		tier = 3.1;
		isFast = true;
	} else if (/lite|mini|nano|turbo/i.test(combined)) {
		tier = 2.2;
		isFast = true;
	}

	return { tier, isFast, isVision, isReasoning, isUncensoredOrGateway };
}

/**
 * Score a model's capability for a specific role. Returns `<= -500` when the
 * model is incompatible with the role (e.g. non-vision model for `vision`).
 */
export function scoreModelCapabilityForRole(model: Model<Api>, role: RecommendedRoleId): number {
	const cap = classifyModelCapability(model);
	if (cap.tier <= 0) return -1000;

	const id = model.id.toLowerCase();
	const fusionPenalty = id.startsWith("fusion-") ? -25 : 0;
	const contextBonus = (model.contextWindow ?? 0) >= 500_000 ? 8 : (model.contextWindow ?? 0) >= 200_000 ? 4 : 0;

	switch (role) {
		case "vision": {
			if (!cap.isVision) return -1000;
			const geminiVisionBonus = /gemini-4-argon|gemini-3[.-]8-flash/i.test(id) ? 32 : 0;
			const frontierBonus = cap.tier >= 4.8 ? 28 : 0;
			return Math.round(cap.tier * 24 + frontierBonus + contextBonus + geminiVisionBonus + fusionPenalty);
		}
		case "slow":
		case "plan":
		case "advisor": {
			if (!cap.isReasoning) return -200;
			const frontierBonus = cap.tier >= 4.8 ? 42 : cap.tier >= 4.2 ? 12 : -30;
			return Math.round(cap.tier * 25 + frontierBonus + contextBonus + fusionPenalty);
		}
		case "default": {
			const reasoningBonus = cap.isReasoning ? 12 : 0;
			const visionBonus = cap.isVision ? 8 : 0;
			const versatilityBonus = cap.tier >= 4.8 ? 36 : cap.tier >= 4.2 ? 10 : 0;
			return Math.round(
				cap.tier * 22 + reasoningBonus + visionBonus + versatilityBonus + contextBonus + fusionPenalty,
			);
		}
		case "smol":
		case "commit": {
			const speedBonus = cap.isFast ? 28 : -25;
			const sweetSpotBonus = cap.tier >= 3.0 && cap.tier <= 4.0 && cap.isFast ? 28 : 0;
			return Math.round(Math.min(cap.tier, 4.0) * 15 + speedBonus + sweetSpotBonus + contextBonus + fusionPenalty);
		}
	}
}

/**
 * Recommend optimal primary + fallback models for every role and subagent type
 * by combining live resource-pool health with model capability scores.
 */
export function recommendModelsForSession(options: RecommendModelsOptions): SessionModelRecommendation {
	const { models, reports, settings, nowMs = Date.now(), magpieGatewayUp = false } = options;
	const disabled = disabledProviderIds(settings);
	const candidatePool = models.filter(m => !disabled.has(m.provider));
	const poolCache = new Map<string, EvaluatedPoolHealth>();
	const getPool = (model: Model<Api>): EvaluatedPoolHealth => {
		const key = `${model.provider}\0${model.id}`;
		const cached = poolCache.get(key);
		if (cached) return cached;
		const evaluated = evaluateModelPoolHealth(model.provider, model.id, reports, { nowMs, magpieGatewayUp });
		poolCache.set(key, evaluated);
		return evaluated;
	};

	const rankForRole = (role: RecommendedRoleId): RoleRecommendation => {
		const scored: ScoredModelCandidate[] = [];
		const seenSelectors = new Set<string>();

		for (const model of candidatePool) {
			const selector = formatModelStringWithRouting(model);
			if (seenSelectors.has(selector)) continue;
			const capabilityScore = scoreModelCapabilityForRole(model, role);
			if (capabilityScore <= -500) continue;
			const pool = getPool(model);
			if (pool.state === "exhausted") continue;
			seenSelectors.add(selector);

			const cap = classifyModelCapability(model);
			const totalScore = capabilityScore + pool.poolScore;
			const capLabel =
				cap.tier >= 4.8 ? "旗舰推理" : cap.tier >= 4.2 ? "主力编码" : cap.isFast ? "高速低延迟" : "通用";
			scored.push({
				model,
				selector,
				capabilityTier: cap.tier,
				capabilityScore,
				pool,
				totalScore,
				reason: `${pool.reason} · ${capLabel}`,
			});
		}

		scored.sort((a, b) => {
			if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
			if ((b.pool.remainingPct ?? -1) !== (a.pool.remainingPct ?? -1)) {
				return (b.pool.remainingPct ?? -1) - (a.pool.remainingPct ?? -1);
			}
			return a.selector.localeCompare(b.selector);
		});

		const primary = scored[0];
		if (!primary) {
			return { role, primary: undefined, fallbacks: [] };
		}

		// Build diverse fallback chain: avoid flooding with 6 fusion variants from the same provider
		const fallbacks: ScoredModelCandidate[] = [];
		const providerCount = new Map<string, number>();
		providerCount.set(primary.model.provider, 1);

		for (let i = 1; i < scored.length && fallbacks.length < 6; i++) {
			const cand = scored[i]!;
			if (cand.pool.state === "exhausted") continue;
			if (cand.model.id.startsWith("fusion-")) continue;
			const count = providerCount.get(cand.model.provider) ?? 0;
			if (count >= 2) continue;
			providerCount.set(cand.model.provider, count + 1);
			fallbacks.push(cand);
		}

		return { role, primary, fallbacks };
	};

	const roles = {
		default: rankForRole("default"),
		slow: rankForRole("slow"),
		plan: rankForRole("plan"),
		smol: rankForRole("smol"),
		vision: rankForRole("vision"),
		advisor: rankForRole("advisor"),
		commit: rankForRole("commit"),
	} satisfies Record<RecommendedRoleId, RoleRecommendation>;

	// Ensure advisor uses a distinct provider/model from default when possible for cross-model review diversity
	if (
		roles.advisor.primary &&
		roles.default.primary &&
		roles.advisor.primary.selector === roles.default.primary.selector &&
		roles.advisor.fallbacks.length > 0
	) {
		const defaultProvider = roles.default.primary.model.provider;
		const distinctAdvisor = roles.advisor.fallbacks.find(
			cand => cand.model.provider !== defaultProvider && cand.capabilityTier >= 4.2,
		);
		if (distinctAdvisor) {
			const prevPrimary = roles.advisor.primary;
			roles.advisor = {
				role: "advisor",
				primary: distinctAdvisor,
				fallbacks: [
					prevPrimary,
					...roles.advisor.fallbacks.filter(c => c.selector !== distinctAdvisor.selector),
				].slice(0, 6),
			};
		}
	}

	const agentOverrides: Partial<Record<"task" | "reviewer" | "security-reviewer" | "scout", string>> = {};
	if (roles.default.primary) agentOverrides.task = roles.default.primary.selector;
	if (roles.slow.primary) {
		agentOverrides.reviewer = roles.slow.primary.selector;
		agentOverrides["security-reviewer"] = roles.slow.primary.selector;
	}
	if (roles.smol.primary) agentOverrides.scout = roles.smol.primary.selector;

	const defPrimary = roles.default.primary;
	const defSecond = roles.default.fallbacks[0];
	if (!defPrimary) {
		return {
			roles,
			agentOverrides,
			headline: "当前无可用且未耗尽的模型资源池",
			shortBadge: "无可用池",
			activePresetName: settings ? findActiveModelPreset(settings) : undefined,
		};
	}
	const shortModelName = (defPrimary.model.name || defPrimary.model.id).replace(/\s*·.*$/, "").trim();
	const shortBadge = `${defPrimary.pool.shortLabel}/${shortModelName}`;
	const headline = defSecond
		? `${defPrimary.selector} (${defPrimary.reason}) → 备选 ${defSecond.selector} (${defSecond.pool.reason})`
		: `${defPrimary.selector} (${defPrimary.reason})`;
	return {
		roles,
		agentOverrides,
		headline,
		shortBadge,
		activePresetName: settings ? findActiveModelPreset(settings) : undefined,
	};
}

/**
 * Apply the recommended models across `modelRoles`, `retry.fallbackChains`,
 * and `task.agentModelOverrides`, and switch the live session model.
 */
export async function applyModelRecommendations(
	settings: Settings,
	session: ModelPresetSession,
	recommendation: SessionModelRecommendation,
): Promise<{ ok: boolean; message: string; activePresetName?: string }> {
	const release = await acquireModelRoleMutation();
	try {
		if (!recommendation.roles.default.primary) {
			return {
				ok: false,
				message: "当前无可用且未耗尽的模型可供推荐应用。",
			};
		}
		const project = cfgModelRoleStorage.get(settings) === "project";
		for (const role of RECOMMENDED_ROLE_IDS) {
			const rec = recommendation.roles[role];
			if (!rec?.primary) continue;
			if (project) {
				settings.setProjectModelRole(role, rec.primary.selector);
			} else {
				settings.setModelRole(role, rec.primary.selector);
			}
		}

		// Update retry.fallbackChains for default, slow, plan, smol (exclude primary so it does not self-fallback)
		for (const chainRole of ["default", "slow", "plan", "smol"] as const) {
			const rec = recommendation.roles[chainRole];
			if (!rec?.primary) continue;
			const uniqueChain = [...new Set(rec.fallbacks.map(f => f.selector))];
			cfgRetryFallbackChains.setEntry(settings, chainRole, uniqueChain);
		}

		// Update task.agentModelOverrides
		const currentOverrides = { ...cfgTaskAgentModelOverrides.get(settings) };
		for (const [agentKey, selector] of Object.entries(recommendation.agentOverrides)) {
			if (selector) currentOverrides[agentKey] = selector;
		}
		cfgTaskAgentModelOverrides.set(settings, currentOverrides);

		await session.setModel(recommendation.roles.default.primary.model, "default");
		const activePresetName = findActiveModelPreset(settings);
		return {
			ok: true,
			message: `已智能应用最优模型路由: default=${recommendation.roles.default.primary.selector} (${recommendation.roles.default.primary.reason})`,
			activePresetName,
		};
	} catch (error) {
		return {
			ok: false,
			message: `智能路由应用失败: ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		release();
	}
}

/**
 * Format a full Markdown report comparing current role assignments against
 * the resource-pool + capability recommendations.
 */
export function formatModelRecommendationReport(
	recommendation: SessionModelRecommendation,
	settings: Settings,
): string {
	const currentRoles = settings.getModelRoles();
	const lines: string[] = [
		"### 智能资源池 × 模型能力推荐路由 (`/quota auto` 一键应用)",
		"",
		`| 角色 (Role) | 当前配置 (Current) | 推荐主模型 (Recommended) | 资源池与能力依据 (Reason) | 自动回退链 (Top Fallbacks) |`,
		`| :--- | :--- | :--- | :--- | :--- |`,
	];

	for (const role of RECOMMENDED_ROLE_IDS) {
		const rec = recommendation.roles[role];
		const current = currentRoles[role] || "-";
		const fallbacks = rec.fallbacks
			.slice(0, 3)
			.map(f => `\`${f.selector}\``)
			.join(" → ");
		const primaryCell = rec.primary ? `**\`${rec.primary.selector}\`**` : "_无可用模型_";
		const reasonCell = rec.primary ? rec.primary.reason : "无兼容或未耗尽模型";
		lines.push(`| \`${role}\` | \`${current}\` | ${primaryCell} | ${reasonCell} | ${fallbacks || "-"} |`);
	}

	lines.push(
		"",
		`- **子 Agent 推荐绑定 (\`task.agentModelOverrides\`)**：\`task\` → \`${recommendation.agentOverrides.task ?? "-"}\` · \`reviewer\` → \`${recommendation.agentOverrides.reviewer ?? "-"}\` · \`scout\` → \`${recommendation.agentOverrides.scout ?? "-"}\``,
		`- **快速应用**：执行 \`/quota auto\`（或在 \`/quota\` 面板按 \`a\`、点击四边舱顶栏 \`⚡ 智选\`）即可一键写入角色、回退链与子 Agent 模型。`,
	);
	return lines.join("\n");
}
