import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import type { NativeChild, NativeNode } from "../src/native/node";
import { setNativeRendering } from "../src/native/state";
import { StatusLineComponent, summarizeQuotaPoolCapsules } from "../src/status-line/component";
import type { StatusLineHost, StatusLineSession } from "../src/status-line/host";
import { STATUS_LINE_PRESETS } from "../src/status-line/presets";
import { STATUS_LINE_SEGMENT_IDS } from "../src/status-line/schema";
import { describeSegment, renderSegment } from "../src/status-line/segments";
import type { SegmentContext, StatusLineSettings } from "../src/status-line/types";
import { initTheme } from "../src/theme";

const BASE_NOW_MS = 1_793_419_148_421;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	setNativeRendering(false);
});

function createModel(provider: string, id: string, name = id): Model {
	const template = getBundledModel("anthropic", "claude-sonnet-4-5");
	return {
		...template,
		provider,
		id,
		name,
	};
}

function buildSixProviderReports(nowMs = BASE_NOW_MS): readonly unknown[] {
	return [
		{
			provider: "openai-codex",
			fetchedAt: nowMs - 30_000,
			limits: [
				{
					id: "openai-codex:primary",
					label: "7 days",
					scope: { provider: "openai-codex", windowId: "7d", shared: true },
					window: { id: "7d", label: "7 days", durationMs: 7 * DAY_MS, resetsAt: nowMs + 3.8 * DAY_MS },
					amount: {
						used: 100,
						limit: 100,
						remaining: 0,
						usedFraction: 1,
						remainingFraction: 0,
						unit: "percent",
					},
					status: "warning",
				},
			],
			resetCredits: { availableCount: 0 },
			metadata: { accountId: "codex-acct-exhausted", planType: "promax" },
		},
		{
			provider: "openai-codex",
			fetchedAt: nowMs - 20_000,
			limits: [
				{
					id: "openai-codex:primary",
					label: "7 days",
					scope: { provider: "openai-codex", windowId: "7d", shared: true },
					window: { id: "7d", label: "7 days", durationMs: 7 * DAY_MS, resetsAt: nowMs + 4.2 * DAY_MS },
					amount: {
						used: 0,
						limit: 100,
						remaining: 100,
						usedFraction: 0,
						remainingFraction: 1,
						unit: "percent",
					},
					status: "ok",
				},
			],
			resetCredits: { availableCount: 1 },
			metadata: { accountId: "codex-acct-fresh", planType: "pro" },
		},
		{
			provider: "google-antigravity",
			fetchedAt: nowMs - 15_000,
			limits: [
				{
					id: "google-antigravity:anthropic:default:3p-weekly",
					label: "Claude & GPT (shared)",
					scope: { provider: "google-antigravity", windowId: "weekly", shared: true },
					window: { id: "weekly", label: "Weekly", durationMs: 7 * DAY_MS, resetsAt: nowMs + 3.9 * DAY_MS },
					amount: {
						unit: "percent",
						remainingFraction: 0,
						usedFraction: 1,
						remaining: 0,
						used: 100,
						limit: 100,
					},
					status: "exhausted",
				},
				{
					id: "google-antigravity:google:default:gemini-5h",
					label: "Gemini",
					scope: { provider: "google-antigravity", windowId: "5h" },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: nowMs + 3.4 * HOUR_MS },
					amount: {
						unit: "percent",
						remainingFraction: 0.86,
						usedFraction: 0.14,
						remaining: 86,
						used: 14,
						limit: 100,
					},
					status: "ok",
				},
				{
					id: "google-antigravity:google:default:gemini-weekly",
					label: "Gemini",
					scope: { provider: "google-antigravity", windowId: "weekly" },
					window: { id: "weekly", label: "Weekly", durationMs: 7 * DAY_MS, resetsAt: nowMs + 6.7 * DAY_MS },
					amount: {
						unit: "percent",
						remainingFraction: 0.96,
						usedFraction: 0.04,
						remaining: 96,
						used: 4,
						limit: 100,
					},
					status: "ok",
				},
			],
		},
		{
			provider: "zhipu-coding-plan",
			fetchedAt: nowMs - 10_000,
			limits: [
				{
					id: "zhipu:features:zread:1mo",
					label: "Zhipu Zread Quota",
					scope: { provider: "zhipu-coding-plan", windowId: "1mo", tier: "zread" },
					window: { id: "1mo", label: "Monthly", durationMs: 30 * DAY_MS, resetsAt: nowMs + 16 * DAY_MS },
					amount: {
						used: 20,
						limit: 4000,
						remaining: 3980,
						usedFraction: 0.005,
						remainingFraction: 0.995,
						unit: "requests",
					},
					status: "ok",
				},
				{
					id: "zhipu:tokens:5h",
					label: "Zhipu 5 Hours Token Quota",
					scope: { provider: "zhipu-coding-plan", windowId: "5h", shared: true },
					window: { id: "5h", label: "5 Hours", durationMs: 5 * HOUR_MS, resetsAt: nowMs + 3.3 * HOUR_MS },
					amount: {
						usedFraction: 0.03,
						remainingFraction: 0.97,
						unit: "tokens",
					},
					status: "ok",
				},
			],
		},
		{
			provider: "minimax-code",
			fetchedAt: nowMs - 5_000,
			limits: [
				{
					id: "general:5h",
					label: "General 5 Hour",
					scope: { provider: "minimax-code", shared: true, windowId: "5h" },
					window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: nowMs + 1.2 * HOUR_MS },
					amount: { used: 0, usedFraction: 0, remaining: 100, remainingFraction: 1, unit: "percent" },
					status: "ok",
				},
				{
					id: "general:7d",
					label: "General 7 Day",
					scope: { provider: "minimax-code", shared: true, windowId: "7d" },
					window: { id: "7d", label: "7 Day", durationMs: 7 * DAY_MS, resetsAt: nowMs + 2.1 * DAY_MS },
					amount: { used: 0, usedFraction: 0, remaining: 100, remainingFraction: 1, unit: "percent" },
					status: "ok",
				},
				{
					id: "video:24h",
					label: "Video 24 Hour",
					scope: { provider: "minimax-code", modelId: "video", windowId: "24h" },
					window: { id: "24h", label: "24 Hour", durationMs: DAY_MS, resetsAt: nowMs + 18 * HOUR_MS },
					amount: { used: 3, limit: 3, remaining: 0, usedFraction: 1, remainingFraction: 0, unit: "percent" },
					status: "exhausted",
				},
			],
		},
		{
			provider: "cursor",
			fetchedAt: nowMs - 25_000,
			limits: [
				{
					id: "cursor:usd:individual-auto",
					label: "Cursor Models",
					scope: { provider: "cursor", windowId: "monthly" },
					window: { id: "monthly", label: "Monthly", resetsAt: nowMs + 13.6 * DAY_MS },
					amount: { used: 30.86, usedFraction: 0.3086, unit: "percent" },
					status: "ok",
				},
				{
					id: "cursor:usd:individual-api",
					label: "Other Models",
					scope: { provider: "cursor", windowId: "monthly" },
					window: { id: "monthly", label: "Monthly", resetsAt: nowMs + 13.6 * DAY_MS },
					amount: { used: 400, limit: 400, remaining: 0, usedFraction: 1, remainingFraction: 0, unit: "usd" },
					status: "exhausted",
				},
			],
		},
		{
			provider: "devin",
			fetchedAt: nowMs - 12_000,
			limits: [
				{
					id: "devin:quota:weekly",
					label: "Weekly Quota",
					scope: { provider: "devin", windowId: "7d", tier: "Max" },
					window: { id: "7d", label: "Weekly Quota", durationMs: 7 * DAY_MS, resetsAt: nowMs + 1.2 * DAY_MS },
					amount: { used: 100, limit: 100, remaining: 0, usedFraction: 1, remainingFraction: 0, unit: "percent" },
					status: "exhausted",
				},
			],
		},
	];
}

function createSegmentTestContext(overrides: Partial<SegmentContext> = {}): SegmentContext {
	const model = createModel("google-antigravity", "gemini-4-argon", "Gemini 4 Argon");
	const session: StatusLineSession = {
		state: { model, messages: [] },
		model,
		messages: [],
		isStreaming: false,
		isAutoThinking: false,
		sessionManager: {
			getSessionName: () => undefined,
			getSessionId: () => "session-test",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		modelRegistry: { isUsingSubscription: () => true },
		getContextUsage: () => ({ tokens: 20_000, contextWindow: 200_000, percent: 10 }),
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => null,
		getGoalModeState: () => undefined,
	};
	return {
		session,
		width: 180,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: null,
		vibeMode: null,
		vim: null,
		collab: null,
		stream: null,
		recording: false,
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
		},
		contextPercent: 10,
		contextTokens: 20_000,
		contextWindow: 200_000,
		autoCompactEnabled: false,
		compactionSpeculation: "idle",
		speculationBlinkOn: true,
		subagentCount: 0,
		activeMs: 0,
		turnElapsedMs: null,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
		...overrides,
	};
}

function createTestableStatusLine(options: {
	settings: StatusLineSettings;
	model: Model;
	fetchReports?: () => Promise<unknown>;
}): {
	statusLine: StatusLineComponent;
	session: StatusLineSession;
} {
	const session: StatusLineSession = {
		state: { model: options.model, messages: [] },
		model: options.model,
		messages: [],
		isStreaming: false,
		isAutoThinking: false,
		sessionManager: {
			getSessionName: () => undefined,
			getSessionId: () => "session-1",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		modelRegistry: { isUsingSubscription: () => true },
		getContextUsage: () => ({ tokens: 20_000, contextWindow: 200_000, percent: 10 }),
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => null,
		getGoalModeState: () => undefined,
	};
	const host: StatusLineHost = {
		getSettings: () => options.settings,
		gitEnabled: () => false,
		codexResetFireworksEnabled: () => false,
		getSettingsRevision: () => 0,
		getSessionSettingsIdentity: () => undefined,
		getSessionSettingsRevision: () => 0,
		goalStatusInFooter: () => false,
		activeAccount: () => undefined,
		canFetchUsageReports: () => options.fetchReports !== undefined,
		fetchUsageReports: async () => (options.fetchReports ? options.fetchReports() : null),
		resolveActiveRepo: () => null,
		lookupPullRequest: async () => ({ stdout: "", exitCode: 1 }),
		calculateTokensPerSecond: () => null,
		limitMatchesActiveAccount: () => true,
		computeCompactionBoundaries: () => null,
	};
	return { statusLine: new StatusLineComponent(session, host), session };
}

function isNativeNode(child: NativeChild | undefined): child is NativeNode {
	return child !== undefined && "k" in child;
}

describe("summarizeQuotaPoolCapsules", () => {
	it("aggregates multi-account pools, selects provider primary windows, drops 0% secondary pools, and caps at 5", () => {
		const capsules = summarizeQuotaPoolCapsules(buildSixProviderReports(), {
			activeProvider: "google-antigravity",
			activeModelId: "gemini-4-argon",
			nowMs: BASE_NOW_MS,
		});

		expect(capsules).toHaveLength(5);
		expect(capsules.map(pool => pool.shortLabel)).toEqual(["AG", "MM", "GLM", "CDX", "CUR"]);

		const [ag, mm, glm, cdx, cur] = capsules;
		expect(ag).toEqual({
			provider: "google-antigravity",
			shortLabel: "AG",
			remainingPct: 86,
			resetText: "3h",
			active: true,
			severity: "warning",
		});
		expect(mm).toEqual({
			provider: "minimax-code",
			shortLabel: "MM",
			remainingPct: 100,
			resetText: "1h",
			severity: "ok",
		});
		expect(glm).toEqual({
			provider: "zhipu-coding-plan",
			shortLabel: "GLM",
			remainingPct: 97,
			resetText: "3h",
			severity: "ok",
		});
		expect(cdx).toEqual({
			provider: "openai-codex",
			shortLabel: "CDX",
			remainingPct: 100,
			resetText: "4d",
			bankedResets: 1,
			severity: "ok",
		});
		expect(cur).toEqual({
			provider: "cursor",
			shortLabel: "CUR",
			remainingPct: 69,
			severity: "ok",
		});
	});

	it("selects Claude & GPT window on google-antigravity when activeModelId matches claude or gpt", () => {
		const capsules = summarizeQuotaPoolCapsules(buildSixProviderReports(), {
			activeProvider: "google-antigravity",
			activeModelId: "claude-sonnet-4-6",
			nowMs: BASE_NOW_MS,
		});

		expect(capsules[0]).toEqual({
			provider: "google-antigravity",
			shortLabel: "AG",
			remainingPct: 0,
			resetText: "3d",
			active: true,
			severity: "error",
		});
	});

	it("retains and prioritizes an active 0% exhausted provider instead of dropping it", () => {
		const capsules = summarizeQuotaPoolCapsules(buildSixProviderReports(), {
			activeProvider: "devin",
			activeModelId: "devin-max",
			nowMs: BASE_NOW_MS,
		});

		expect(capsules[0]).toEqual({
			provider: "devin",
			shortLabel: "DEV",
			remainingPct: 0,
			resetText: "1d",
			active: true,
			severity: "error",
		});
		expect(capsules).toHaveLength(5);
	});

	it("formats sub-hour, hour, and day resets and omits resets beyond 7 days or already elapsed", () => {
		const reports = [
			{
				provider: "anthropic",
				limits: [
					{
						id: "claude:5h",
						label: "5h",
						scope: { windowId: "5h" },
						window: { resetsAt: BASE_NOW_MS + 42 * 60_000 },
						amount: { remainingFraction: 0.35 },
					},
				],
			},
			{
				provider: "alibaba-token-plan",
				limits: [
					{
						id: "qwen:7d",
						label: "7d",
						scope: { windowId: "7d" },
						window: { resetsAt: BASE_NOW_MS - 5_000 },
						amount: { remainingFraction: 0.12 },
					},
				],
			},
			{
				provider: "kimi-code",
				limits: [
					{
						id: "kimi:30d",
						label: "Monthly",
						scope: { windowId: "monthly" },
						window: { resetsAt: BASE_NOW_MS + 12 * DAY_MS },
						amount: { remainingFraction: 0.8 },
					},
				],
			},
		];

		const capsules = summarizeQuotaPoolCapsules(reports, { nowMs: BASE_NOW_MS });
		expect(capsules).toEqual([
			{
				provider: "anthropic",
				shortLabel: "CLD",
				remainingPct: 35,
				resetText: "42m",
				severity: "warning",
			},
			{
				provider: "alibaba-token-plan",
				shortLabel: "QWN",
				remainingPct: 12,
				severity: "error",
			},
			{
				provider: "kimi-code",
				shortLabel: "KIMI",
				remainingPct: 80,
				severity: "ok",
			},
		]);
	});
});

describe("quota_pools segment & presets", () => {
	it("registers quota_pools in schema and deduplicates cache_read in full and nerd presets", () => {
		expect(STATUS_LINE_SEGMENT_IDS).toContain("quota_pools");
		expect(STATUS_LINE_PRESETS.default.rightSegments).toContain("quota_pools");

		expect(STATUS_LINE_PRESETS.full.rightSegments).not.toContain("cache_read");
		const fullRateIdx = STATUS_LINE_PRESETS.full.rightSegments.indexOf("token_rate");
		expect(STATUS_LINE_PRESETS.full.rightSegments[fullRateIdx + 1]).toBe("quota_pools");

		expect(STATUS_LINE_PRESETS.nerd.rightSegments).not.toContain("cache_read");
		const nerdRateIdx = STATUS_LINE_PRESETS.nerd.rightSegments.indexOf("token_rate");
		expect(STATUS_LINE_PRESETS.nerd.rightSegments[nerdRateIdx + 1]).toBe("quota_pools");
	});

	it("renders ANSI capsules and matching native TspSpan[] descriptions", () => {
		const quotaPools = summarizeQuotaPoolCapsules(buildSixProviderReports(), {
			activeProvider: "google-antigravity",
			activeModelId: "gemini-4-argon",
			nowMs: BASE_NOW_MS,
		});
		const ctx = createSegmentTestContext({ quotaPools });

		const rendered = renderSegment("quota_pools", ctx);
		expect(rendered.visible).toBe(true);
		const plain = stripVTControlCharacters(rendered.content);
		expect(plain).toBe("AG 86%/3h · MM 100%/1h · GLM 97%/3h · CDX 100%/4d✦1 · CUR 69%");

		const view = describeSegment("quota_pools", ctx);
		expect(view).not.toBeNull();
		expect(view?.spans.map(part => part.t).join("")).toBe(plain);

		const emptyCtx = createSegmentTestContext({ quotaPools: [] });
		expect(renderSegment("quota_pools", emptyCtx)).toEqual({ content: "", visible: false });
		expect(describeSegment("quota_pools", emptyCtx)).toBeNull();
	});

	it("seeds StatusLineComponent via setQuotaPoolsFromReports, routes native click to status.cost, and re-marks active on model switch without wiping pools", () => {
		const geminiModel = createModel("google-antigravity", "gemini-4-argon", "Gemini 4 Argon");
		const { statusLine, session } = createTestableStatusLine({
			settings: {
				preset: "custom",
				leftSegments: ["model"],
				rightSegments: ["quota_pools"],
				separator: "slash",
			},
			model: geminiModel,
		});

		let branchNotifications = 0;
		statusLine.watchBranch(() => {
			branchNotifications++;
		});

		statusLine.setQuotaPoolsFromReports(buildSixProviderReports(Date.now()));
		expect(branchNotifications).toBe(1);

		const initialBorder = stripVTControlCharacters(statusLine.getTopBorder(180).content);
		expect(initialBorder).toContain("AG 86%/3h · MM 100%/1h · GLM 97%/3h · CDX 100%/4d✦1 · CUR 69%");

		// Switch active model to openai-codex: must NOT clear #cachedQuotaPools, and must promote CDX to active front.
		const codexModel = createModel("openai-codex", "gpt-5.3-codex", "GPT-5.3 Codex");
		session.state.model = codexModel;
		session.model = codexModel;

		const switchedBorder = stripVTControlCharacters(statusLine.getTopBorder(180).content);
		expect(switchedBorder).toContain("CDX 100%/4d✦1 · AG 86%/3h · MM 100%/1h · GLM 97%/3h · CUR 69%");

		// Verify native composer facts expose quota_pools with click -> status.cost
		setNativeRendering(true);
		const extras = statusLine.describeComposerFacts().extras;
		const quotaSeg = (extras.c ?? [])
			.filter(isNativeNode)
			.find(node => node.k === "seg" && node.key === "quota_pools");
		expect(quotaSeg).toBeDefined();
		expect(quotaSeg?.p).toMatchObject({
			actions: { click: "status.cost" },
		});

		let clickedAction: string | undefined;
		statusLine.onNativeAction = action => {
			clickedAction = action;
		};
		statusLine.handleNativeEvent({ type: "action", key: "quota_pools", act: "status.cost", mods: [] });
		expect(clickedAction).toBe("status.cost");

		statusLine.dispose();
	});
});
