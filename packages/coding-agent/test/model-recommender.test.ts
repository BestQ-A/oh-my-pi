import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	applyModelRecommendations,
	evaluateModelPoolHealth,
	formatModelRecommendationReport,
	recommendModelsForSession,
} from "../src/config/model-recommender";
import { kNoAuth } from "../src/config/model-registry";
import { resolveModelOverrideWithAuthFallback } from "../src/config/model-resolver";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { cfgDisabledProviders } from "../src/config/model-settings";
import { cfgRetryFallbackChains, cfgRetryUsageAwareFallback } from "../src/session/settings";
import { cfgTaskAgentModelOverrides } from "../src/task/settings";

const NOW_MS = 1_793_613_500_000;

function makeModel(overrides: Partial<Model<Api>> & { provider: string; id: string; name?: string }): Model<Api> {
	return {
		api: "openai-completions" as Api,
		provider: overrides.provider,
		id: overrides.id,
		name: overrides.name ?? overrides.id,
		baseUrl: "https://example.invalid/v1",
		input: overrides.input ?? ["text", "image"],
		contextWindow: overrides.contextWindow ?? 262_000,
		maxTokens: overrides.maxTokens ?? 64_000,
		reasoning: overrides.reasoning ?? true,
		thinking: overrides.thinking ?? { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		cost: overrides.cost ?? { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 },
		compat: overrides.compat,
		identity: overrides.identity ?? classifyModel(overrides.provider, overrides.id, { lenient: true }),
	};
}

function sampleUsageReports() {
	return [
		{
			provider: "google-antigravity",
			fetchedAt: NOW_MS - 10_000,
			limits: [
				{
					id: "google-antigravity:gemini",
					label: "Gemini",
					window: { id: "5h", durationMs: 5 * 3_600_000, resetsAt: NOW_MS + 3 * 3_600_000 },
					amount: { remainingFraction: 0.87, usedFraction: 0.13, unit: "percent" },
					status: "ok",
				},
				{
					id: "google-antigravity:claude-gpt",
					label: "Claude & GPT (shared)",
					window: { id: "7d", durationMs: 7 * 86_400_000, resetsAt: NOW_MS + 4 * 86_400_000 },
					amount: { remainingFraction: 0, usedFraction: 1, unit: "percent" },
					status: "exhausted",
				},
			],
		},
		{
			provider: "devin",
			fetchedAt: NOW_MS - 10_000,
			limits: [
				{
					id: "devin:weekly",
					label: "Weekly Quota",
					window: { id: "7d", durationMs: 7 * 86_400_000, resetsAt: NOW_MS + 5 * 86_400_000 },
					amount: { remainingFraction: 0.76, usedFraction: 0.24, unit: "percent" },
					status: "ok",
				},
			],
		},
		{
			provider: "openai-codex",
			fetchedAt: NOW_MS - 10_000,
			limits: [
				{
					id: "openai-codex:primary",
					label: "7 days",
					window: { id: "7d", durationMs: 7 * 86_400_000, resetsAt: NOW_MS + 2 * 86_400_000 },
					amount: { remainingFraction: 0.91, usedFraction: 0.09, unit: "percent" },
					status: "ok",
				},
			],
			resetCredits: { availableCount: 3 },
		},
		{
			provider: "cursor",
			fetchedAt: NOW_MS - 10_000,
			limits: [
				{
					id: "cursor:usd:individual-auto",
					label: "Cursor Models",
					window: { id: "monthly", resetsAt: NOW_MS + 10 * 86_400_000 },
					amount: { remainingFraction: 0.69, usedFraction: 0.31, unit: "percent" },
					status: "ok",
				},
				{
					id: "cursor:usd:individual-api",
					label: "Other Models",
					window: { id: "monthly", resetsAt: NOW_MS + 10 * 86_400_000 },
					amount: { remainingFraction: 0, usedFraction: 1, unit: "usd" },
					status: "exhausted",
				},
			],
		},
		{
			provider: "minimax-code",
			fetchedAt: NOW_MS - 10_000,
			limits: [
				{
					id: "minimax:5h",
					label: "General 5 Hour",
					window: { id: "5h", durationMs: 5 * 3_600_000, resetsAt: NOW_MS + 4 * 3_600_000 },
					amount: { remainingFraction: 1, usedFraction: 0, unit: "percent" },
					status: "ok",
				},
			],
		},
	];
}

describe("model-recommender: pool health + capability scoring", () => {
	let settings: Settings;

	beforeEach(async () => {
		resetSettingsForTest();
		settings = await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		delete process.env.OMP_FINOPS_USAGE_CACHE_PATH;
		resetSettingsForTest();
	});

	it("distinguishes model-scoped quota windows within google-antigravity and cursor", () => {
		const reports = sampleUsageReports();

		const agyGemini = evaluateModelPoolHealth("google-antigravity", "gemini-4-argon", reports, { nowMs: NOW_MS });
		expect(agyGemini.state).toBe("salvage");
		expect(agyGemini.remainingPct).toBe(87);

		const agyClaude = evaluateModelPoolHealth("google-antigravity", "claude-opus-5-5", reports, { nowMs: NOW_MS });
		expect(agyClaude.state).toBe("exhausted");
		expect(agyClaude.remainingPct).toBe(0);

		const cursorFast = evaluateModelPoolHealth("cursor", "cursor-grok-4.6-fast", reports, { nowMs: NOW_MS });
		expect(cursorFast.state).toBe("healthy");
		expect(cursorFast.remainingPct).toBe(69);

		const cursorClaude = evaluateModelPoolHealth("cursor", "claude-opus-5-5", reports, { nowMs: NOW_MS });
		expect(cursorClaude.state).toBe("exhausted");
		expect(cursorClaude.remainingPct).toBe(0);
	});

	it("recommends expiring-soon frontier models first, skips exhausted windows, and diversifies advisor", async () => {
		const models = [
			makeModel({ provider: "google-antigravity", id: "claude-opus-5-5", name: "Claude Opus 5.5" }),
			makeModel({ provider: "google-antigravity", id: "gemini-4-argon", name: "Gemini 4 Argon" }),
			makeModel({ provider: "devin", id: "gemini-4-argon", name: "Gemini 4 Argon" }),
			makeModel({ provider: "devin", id: "swe-2", name: "SWE-2" }),
			makeModel({ provider: "openai-codex", id: "gpt-6-astra", name: "GPT-6 Astra" }),
			makeModel({ provider: "cursor", id: "claude-opus-5-5", name: "Claude Opus 5.5" }),
			makeModel({ provider: "cursor", id: "cursor-grok-4.6-fast", name: "Grok 4.6 Fast", input: ["text"] }),
			makeModel({ provider: "minimax-code", id: "MiniMax-M3.1-Flash", name: "MiniMax M3.1 Flash", input: ["text"] }),
			makeModel({ provider: "magpie", id: "devin/gemini-4-argon", name: "Gemini 4 Argon · Devin" }),
		];

		const rec = recommendModelsForSession({
			models,
			reports: sampleUsageReports(),
			settings,
			nowMs: NOW_MS,
			magpieGatewayUp: false,
		});

		// google-antigravity/gemini-4-argon has 87% remaining in a 5h window resetting in 3h (salvage + frontier)
		expect(rec.roles.default.primary?.selector).toBe("google-antigravity/gemini-4-argon");
		expect(rec.roles.slow.primary?.selector).toBe("google-antigravity/gemini-4-argon");
		expect(rec.roles.plan.primary?.selector).toBe("google-antigravity/gemini-4-argon");
		expect(rec.roles.vision.primary?.selector).toBe("google-antigravity/gemini-4-argon");

		// Exhausted models must never appear in fallbacks
		const defaultFallbackSelectors = rec.roles.default.fallbacks.map(f => f.selector);
		expect(defaultFallbackSelectors).not.toContain("google-antigravity/claude-opus-5-5");
		expect(defaultFallbackSelectors).not.toContain("cursor/claude-opus-5-5");
		expect(defaultFallbackSelectors).toContain("devin/gemini-4-argon");

		// Advisor diversifies away from default's provider when another frontier pool is healthy
		expect(rec.roles.advisor.primary?.model.provider).not.toBe("google-antigravity");

		let switchedTo: string | undefined;
		const sessionMock = {
			setModel: async (model: Model) => {
				switchedTo = `${model.provider}/${model.id}`;
				return { switched: true };
			},
			setThinkingLevel: () => {},
			getAvailableModels: () => models,
			scopedModels: [],
			modelRegistry: {} as never,
		};

		const applied = await applyModelRecommendations(settings, sessionMock, rec);
		expect(applied.ok).toBe(true);
		expect(switchedTo).toBe("google-antigravity/gemini-4-argon");
		expect(settings.getModelRole("default")).toBe("google-antigravity/gemini-4-argon");
		expect(cfgRetryFallbackChains.get(settings).default).not.toContain("google-antigravity/gemini-4-argon");
		expect(cfgRetryFallbackChains.get(settings).default).toContain("devin/gemini-4-argon");
		expect(cfgTaskAgentModelOverrides.get(settings).task).toBe("google-antigravity/gemini-4-argon");

		const reportMd = formatModelRecommendationReport(rec, settings);
		expect(reportMd).toContain("google-antigravity/gemini-4-argon");
		expect(reportMd).toContain("devin/gemini-4-argon");
	});

	it("promotes a healthy fallback candidate in resolveModelOverrideWithAuthFallback when primary pool is exhausted", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-recommender-cache-"));
		const cacheFile = path.join(tmpDir, "finops-live-usage.json");
		fs.writeFileSync(
			cacheFile,
			JSON.stringify({
				generatedAt: NOW_MS,
				reports: sampleUsageReports(),
			}),
			"utf8",
		);
		process.env.OMP_FINOPS_USAGE_CACHE_PATH = cacheFile;

		try {
			cfgRetryUsageAwareFallback.set(settings, true);
			const exhaustedModel = makeModel({
				provider: "google-antigravity",
				id: "claude-opus-5-5",
				name: "Claude Opus 5.5",
			});
			const healthyModel = makeModel({
				provider: "devin",
				id: "gemini-4-argon",
				name: "Gemini 4 Argon",
			});
			const registry = {
				getAvailable: () => [exhaustedModel, healthyModel],
				getApiKey: async () => kNoAuth,
			};

			const resolved = await resolveModelOverrideWithAuthFallback(
				["google-antigravity/claude-opus-5-5", "devin/gemini-4-argon"],
				"devin/gemini-4-argon",
				registry,
				settings,
			);
			expect(resolved.model?.provider).toBe("devin");
			expect(resolved.model?.id).toBe("gemini-4-argon");
			expect(resolved.authFallbackUsed).toBe(false);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("handles empty, all-disabled, text-only (no vision), and all-exhausted catalogs without inventing unavailable primaries", async () => {
		// 1. Empty catalog
		const emptyRec = recommendModelsForSession({
			models: [],
			reports: sampleUsageReports(),
			settings,
			nowMs: NOW_MS,
		});
		expect(emptyRec.roles.default.primary).toBeUndefined();
		expect(emptyRec.roles.vision.primary).toBeUndefined();

		// 2. All-disabled catalog
		cfgDisabledProviders.set(settings, ["devin"]);
		const disabledRec = recommendModelsForSession({
			models: [makeModel({ provider: "devin", id: "gemini-4-argon", name: "Gemini 4 Argon" })],
			reports: sampleUsageReports(),
			settings,
			nowMs: NOW_MS,
		});
		expect(disabledRec.roles.default.primary).toBeUndefined();
		cfgDisabledProviders.set(settings, []);

		// 3. Text-only catalog leaves vision role undefined while populating chat roles
		const textOnlyModel = makeModel({
			provider: "minimax-code",
			id: "MiniMax-M3.1-Flash",
			name: "MiniMax M3.1 Flash",
			input: ["text"],
		});
		const textOnlyRec = recommendModelsForSession({
			models: [textOnlyModel],
			reports: sampleUsageReports(),
			settings,
			nowMs: NOW_MS,
		});
		expect(textOnlyRec.roles.default.primary?.selector).toBe("minimax-code/MiniMax-M3.1-Flash");
		expect(textOnlyRec.roles.vision.primary).toBeUndefined();

		// 4. All-exhausted catalog never selects an exhausted model as primary
		const exhaustedRec = recommendModelsForSession({
			models: [
				makeModel({ provider: "google-antigravity", id: "claude-opus-5-5", name: "Claude Opus 5.5" }),
				makeModel({ provider: "cursor", id: "claude-opus-5-5", name: "Claude Opus 5.5" }),
			],
			reports: sampleUsageReports(),
			settings,
			nowMs: NOW_MS,
		});
		expect(exhaustedRec.roles.default.primary).toBeUndefined();
		const applyRes = await applyModelRecommendations(
			settings,
			{
				setModel: async () => ({ switched: true }),
				setThinkingLevel: () => {},
				getAvailableModels: () => [],
				scopedModels: [],
				modelRegistry: {} as never,
			},
			exhaustedRec,
		);
		expect(applyRes.ok).toBe(false);
	});
});
