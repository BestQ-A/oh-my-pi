import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { defaultRankingStrategy, defaultUsageProvider } from "@oh-my-pi/pi-ai/usage/registry";
import { zhipuCodingPlanRankingStrategy, zhipuCodingPlanUsageProvider } from "@oh-my-pi/pi-ai/usage/zhipu-coding-plan";

function makeCredential(apiKey = "zhipu-id.zhipu-secret"): UsageFetchParams["credential"] {
	return {
		type: "api_key",
		apiKey,
	};
}

function makeOAuthCredential(accessToken = "oauth-id.oauth-secret"): UsageFetchParams["credential"] {
	return {
		type: "oauth",
		accessToken,
		accountId: "zhipu-acc-1",
		email: "dev@example.com",
	};
}

function makeCtx(
	payload: unknown,
	sink?: { quotaUrl?: string; modelUsageUrl?: string; authorization?: string },
): UsageFetchContext {
	const fetch: FetchImpl = async (input, init) => {
		const url = String(input);
		if (sink) {
			sink.authorization = new Headers(init?.headers).get("Authorization") ?? undefined;
		}
		if (url.includes("/api/monitor/usage/model-usage")) {
			if (sink) sink.modelUsageUrl = url;
			return new Response(JSON.stringify({ code: 200, success: true, data: { x_time: [] } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (sink) sink.quotaUrl = url;
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch };
}

describe("zhipu-coding-plan usage provider", () => {
	it("is wired into default usage provider and ranking strategy registries", () => {
		expect(defaultUsageProvider("zhipu-coding-plan")).toBe(zhipuCodingPlanUsageProvider);
		expect(defaultRankingStrategy("zhipu-coding-plan")).toBe(zhipuCodingPlanRankingStrategy);
	});

	it("normalizes Coding Plan baseUrl to origin and sends Bearer authorization without duplicating prefix", async () => {
		const sink1: { quotaUrl?: string; modelUsageUrl?: string; authorization?: string } = {};
		const report1 = await zhipuCodingPlanUsageProvider.fetchUsage!(
			{
				provider: "zhipu-coding-plan",
				baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
				credential: makeCredential("bc88c7.secret123"),
				signal: undefined,
			},
			makeCtx(
				{
					code: 200,
					success: true,
					data: {
						limits: [{ type: "TOKENS_LIMIT", percentage: 7, nextResetTime: 1793386023778, unit: 3, number: 5 }],
						level: "max",
					},
				},
				sink1,
			),
		);

		expect(report1).not.toBeNull();
		expect(sink1.quotaUrl).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
		expect(sink1.modelUsageUrl).toStartWith("https://open.bigmodel.cn/api/monitor/usage/model-usage?");
		expect(sink1.authorization).toBe("Bearer bc88c7.secret123");
		expect(report1!.metadata?.planType).toBe("max");

		const sink2: { authorization?: string } = {};
		const report2 = await zhipuCodingPlanUsageProvider.fetchUsage!(
			{
				provider: "zhipu-coding-plan",
				credential: makeCredential("Bearer   bc88c7.secret123 "),
				signal: undefined,
			},
			makeCtx(
				{
					code: 200,
					success: true,
					data: {
						limits: [{ type: "TOKENS_LIMIT", percentage: 7, nextResetTime: 1793386023778, unit: 3, number: 5 }],
					},
				},
				sink2,
			),
		);
		expect(report2).not.toBeNull();
		expect(sink2.authorization).toBe("Bearer bc88c7.secret123");
	});

	it("supports valid api-key and oauth credentials while rejecting blank or wrong-provider inputs", () => {
		expect(
			zhipuCodingPlanUsageProvider.supports!({
				provider: "zhipu-coding-plan",
				credential: makeCredential(),
				signal: undefined,
			}),
		).toBe(true);
		expect(
			zhipuCodingPlanUsageProvider.supports!({
				provider: "zhipu-coding-plan",
				credential: makeOAuthCredential(),
				signal: undefined,
			}),
		).toBe(true);
		expect(
			zhipuCodingPlanUsageProvider.supports!({
				provider: "zhipu-coding-plan",
				credential: { type: "oauth" },
				signal: undefined,
			}),
		).toBe(false);
		expect(
			zhipuCodingPlanUsageProvider.supports!({
				provider: "zhipu-coding-plan",
				credential: makeCredential("Bearer   "),
				signal: undefined,
			}),
		).toBe(false);
		expect(
			zhipuCodingPlanUsageProvider.supports!({
				provider: "zai",
				credential: makeCredential(),
				signal: undefined,
			}),
		).toBe(false);
	});

	it("parses 5h token, weekly credit/token, and monthly feature TIME_LIMIT windows", async () => {
		const report = await zhipuCodingPlanUsageProvider.fetchUsage!(
			{ provider: "zhipu-coding-plan", credential: makeCredential(), signal: undefined },
			makeCtx({
				code: 200,
				msg: "操作成功",
				success: true,
				data: {
					limits: [
						{
							type: "TIME_LIMIT",
							unit: 5,
							number: 1,
							usage: 4000,
							currentValue: 20,
							remaining: 3980,
							percentage: 1,
							nextResetTime: 1794828707983,
							usageDetails: [
								{ modelCode: "search-prime", usage: 14 },
								{ modelCode: "web-reader", usage: 6 },
								{ modelCode: "zread", usage: 0 },
							],
						},
						{
							type: "TOKENS_LIMIT",
							unit: 3,
							number: 5,
							percentage: 7,
							nextResetTime: 1793386023778,
						},
						{
							type: "CREDIT_LIMIT",
							unit: 6,
							number: 1,
							usage: 140000,
							currentValue: 14000,
							remaining: 126000,
							percentage: 10,
							nextResetTime: 1793900000000,
						},
					],
					level: "max",
				},
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.limits.map(limit => limit.id)).toEqual([
			"zhipu:features:zread:1mo",
			"zhipu:tokens:5h",
			"zhipu:credits:1w",
		]);
		expect(report!.limits.map(limit => limit.label)).toEqual([
			"Zhipu Zread Quota",
			"Zhipu 5 Hours Token Quota",
			"Zhipu Weekly Credit Quota",
		]);
		expect(report!.limits.map(limit => limit.scope.shared)).toEqual([false, true, true]);
		expect(report!.limits[0]?.scope.tier).toBe("zread");
		expect(report!.limits[0]?.amount.usedFraction).toBeCloseTo(20 / 4000, 5);
		expect(report!.limits[1]?.amount.usedFraction).toBeCloseTo(0.07, 5);
		expect(report!.limits[1]?.amount.remainingFraction).toBeCloseTo(0.93, 5);
		expect(report!.limits[2]?.amount.usedFraction).toBeCloseTo(14000 / 140000, 5);
		expect(report!.metadata?.planType).toBe("max");

		const windows = zhipuCodingPlanRankingStrategy.findWindowLimits(report!);
		expect(windows.primary?.id).toBe("zhipu:tokens:5h");
		expect(windows.secondary?.id).toBe("zhipu:credits:1w");
	});

	it("parses general TIME_LIMIT into zhipu:requests:* and deduplicates mixed 5h + weekly windows", async () => {
		const generalRequestReport = await zhipuCodingPlanUsageProvider.fetchUsage!(
			{ provider: "zhipu-coding-plan", credential: makeCredential(), signal: undefined },
			makeCtx({
				success: true,
				data: {
					limits: [
						{
							type: "TIME_LIMIT",
							unit: 3,
							number: 5,
							usage: 500,
							currentValue: 125,
							remaining: 375,
							percentage: 25,
							nextResetTime: 1793386023778,
						},
					],
				},
			}),
		);
		expect(generalRequestReport).not.toBeNull();
		expect(generalRequestReport!.limits[0]?.id).toBe("zhipu:requests:5h");
		expect(generalRequestReport!.limits[0]?.label).toBe("Zhipu Request Quota");
		expect(generalRequestReport!.limits[0]?.scope.shared).toBe(true);

		const mixedReport = await zhipuCodingPlanUsageProvider.fetchUsage!(
			{ provider: "zhipu-coding-plan", credential: makeCredential(), signal: undefined },
			makeCtx({
				success: true,
				data: {
					limits: [
						{ type: "TOKENS_LIMIT", percentage: 82, nextResetTime: 1787804173065, unit: 3, number: 5 },
						{ type: "CREDIT_LIMIT", usage: 12000, currentValue: 1438, percentage: 11, unit: 3, number: 5 },
						{ type: "TOKENS_LIMIT", percentage: 15, nextResetTime: 1788223121997, unit: 6 },
						{ type: "CREDIT_LIMIT", usage: 60000, currentValue: 30000, percentage: 50, unit: 6 },
					],
					level: "pro",
				},
			}),
		);
		expect(mixedReport).not.toBeNull();
		const ranked = zhipuCodingPlanRankingStrategy.findWindowLimits(mixedReport!);
		expect(ranked.primary?.id).toBe("zhipu:tokens:5h");
		expect(ranked.secondary?.id).toBe("zhipu:credits:1w");
	});

	it("silently ignores pay-as-you-go accounts without a Coding Plan while warning on real errors", async () => {
		const warnings: string[] = [];
		const logger = { debug() {}, warn: (message: string) => warnings.push(message) };
		const fetchUsage = (payload: unknown) =>
			zhipuCodingPlanUsageProvider.fetchUsage!(
				{ provider: "zhipu-coding-plan", credential: makeCredential(), signal: undefined },
				{ ...makeCtx(payload), logger },
			);

		expect(await fetchUsage({ code: 500, msg: "当前用户不存在coding plan", success: false })).toBeNull();
		expect(warnings).toEqual([]);

		expect(await fetchUsage({ code: 500, msg: "您的coding plan已过期", success: false })).toBeNull();
		expect(await fetchUsage({ code: 500, msg: "internal error", success: false })).toBeNull();
		expect(warnings).toEqual(["Zhipu usage response invalid", "Zhipu usage response invalid"]);
	});
});
