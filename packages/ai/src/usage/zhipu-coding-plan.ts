import { toNumber } from "@oh-my-pi/pi-catalog/utils";
import { USER_AGENT } from "@oh-my-pi/pi-utils";
import type {
	CredentialRankingStrategy,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { buildUsageAmount, DAY_MS, HOUR_MS, parsePositiveTimestamp, usageStatus, WEEK_MS } from "./shared";

const PROVIDER = "zhipu-coding-plan";
const DEFAULT_ENDPOINT = "https://open.bigmodel.cn";
const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const MODEL_USAGE_PATH = "/api/monitor/usage/model-usage";
const MONTH_MS = 30 * DAY_MS;

interface ZhipuUsageDetail {
	modelCode?: string;
	usage?: number;
}

function normalizeZhipuBaseUrl(baseUrl?: string): string {
	if (!baseUrl?.trim()) return DEFAULT_ENDPOINT;
	try {
		const parsed = new URL(baseUrl.trim());
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return DEFAULT_ENDPOINT;
		return parsed.origin;
	} catch {
		return DEFAULT_ENDPOINT;
	}
}

/**
 * Domestic BigModel quota endpoints require `Authorization: Bearer <id.secret>`
 * (unlike international `api.z.ai`, which accepts the bare key). Deduplicate
 * any existing `Bearer ` prefix so pre-formatted tokens never double-prefix.
 */
function formatBearerAuthorization(rawToken: string | undefined): string | null {
	if (!rawToken) return null;
	const bare = rawToken
		.trim()
		.replace(/^Bearer(?:\s+|$)/i, "")
		.trim();
	return bare ? `Bearer ${bare}` : null;
}

interface ZhipuUsageLimitItem {
	type?: string;
	usage?: number;
	currentValue?: number;
	percentage?: number;
	remaining?: number;
	nextResetTime?: number;
	unit?: number;
	number?: number;
	usageDetails?: ZhipuUsageDetail[];
}

interface ZhipuQuotaPayload {
	success?: boolean;
	code?: number;
	msg?: string;
	data?: {
		limits?: ZhipuUsageLimitItem[];
		/** Coding-plan tier (e.g. "lite", "pro", "max") surfaced as the plan label. */
		level?: string;
	};
}

function parseUsageDetails(value: unknown): ZhipuUsageDetail[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const details: ZhipuUsageDetail[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const modelCode = typeof item.modelCode === "string" && item.modelCode ? item.modelCode : undefined;
		const usage = toNumber(item.usage);
		details.push({
			...(modelCode !== undefined ? { modelCode } : {}),
			...(usage !== undefined ? { usage } : {}),
		});
	}
	return details.length > 0 ? details : undefined;
}

function parseLimitItem(value: unknown): ZhipuUsageLimitItem | null {
	if (!isRecord(value)) return null;
	const type = typeof value.type === "string" ? value.type : undefined;
	if (!type) return null;
	return {
		type,
		usage: toNumber(value.usage),
		currentValue: toNumber(value.currentValue),
		percentage: toNumber(value.percentage),
		remaining: toNumber(value.remaining),
		nextResetTime: parsePositiveTimestamp(value.nextResetTime),
		unit: toNumber(value.unit),
		number: toNumber(value.number),
		usageDetails: parseUsageDetails(value.usageDetails),
	};
}

/** Zhipu `percentage` is 0-100 and may overshoot; clamp it to a used fraction. */
function percentageFraction(percentage: number | undefined): number | undefined {
	return percentage === undefined ? undefined : Math.min(Math.max(percentage / 100, 0), 1);
}

function formatDate(value: Date): string {
	const pad = (input: number) => String(input).padStart(2, "0");
	return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}+${pad(value.getHours())}:${pad(
		value.getMinutes(),
	)}:${pad(value.getSeconds())}`;
}

function formatCountedUnit(count: number, singular: string): string {
	const suffix = count === 1 ? "" : "s";
	return `${count} ${singular}${suffix}`;
}

function buildZhipuWindow(parsed: ZhipuUsageLimitItem): UsageWindow {
	const count = parsed.number !== undefined && parsed.number > 0 ? parsed.number : 1;
	let id: string;
	let label: string;
	let durationMs: number | undefined;
	switch (parsed.unit) {
		case 3:
			id = `${count}h`;
			label = formatCountedUnit(count, "Hour");
			durationMs = count * HOUR_MS;
			break;
		case 4:
			id = `${count}d`;
			label = formatCountedUnit(count, "Day");
			durationMs = count * DAY_MS;
			break;
		case 5:
			id = `${count}mo`;
			label = count === 1 ? "Monthly" : formatCountedUnit(count, "Month");
			durationMs = count * MONTH_MS;
			break;
		case 6:
			id = "1w";
			label = "Weekly";
			durationMs = WEEK_MS;
			break;
		default:
			id = parsed.unit !== undefined ? `${count}u${parsed.unit}` : "quota";
			label = "Quota";
			break;
	}
	return {
		id,
		label,
		...(durationMs !== undefined ? { durationMs } : {}),
		...(parsed.nextResetTime !== undefined ? { resetsAt: parsed.nextResetTime } : {}),
	};
}

function isZhipuFeatureRequestLimit(parsed: ZhipuUsageLimitItem): boolean {
	const detailCodes =
		parsed.usageDetails?.map(detail => detail.modelCode).filter((code): code is string => !!code) ?? [];
	return detailCodes.includes("search-prime") && detailCodes.includes("web-reader") && detailCodes.includes("zread");
}

function buildModelUsageUrl(baseUrl: string, now: Date): string {
	const start = new Date(now.getTime() - WEEK_MS);
	const startTime = formatDate(start);
	const endTime = formatDate(now);
	return `${baseUrl}${MODEL_USAGE_PATH}?startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}`;
}

function getZhipuCredentialLimits(report: UsageReport): UsageLimit[] {
	return report.limits.filter(
		limit =>
			limit.id.startsWith("zhipu:requests:") ||
			limit.id.startsWith("zhipu:tokens:") ||
			limit.id.startsWith("zhipu:credits:"),
	);
}

function zhipuLimitPressure(limit: UsageLimit): number {
	const fraction = limit.amount.usedFraction;
	return typeof fraction === "number" && Number.isFinite(fraction) ? fraction : -1;
}

function rankZhipuRequestLimits(report: UsageReport): UsageLimit[] {
	const requestLimits = report.limits.filter(limit => limit.id.startsWith("zhipu:requests:"));
	const credentialLimits = getZhipuCredentialLimits(report);
	const limits = requestLimits.length > 0 ? requestLimits : credentialLimits;
	// Mixed-meter payloads (tokens + credits on the same plan) can repeat a
	// window; keep the most-binding limit per window so a second 5h row never
	// displaces the weekly window when primary/secondary are picked positionally.
	const byWindow = new Map<number, UsageLimit>();
	for (const limit of limits) {
		const durationMs = limit.window?.durationMs ?? Number.POSITIVE_INFINITY;
		const current = byWindow.get(durationMs);
		if (!current || zhipuLimitPressure(limit) > zhipuLimitPressure(current)) byWindow.set(durationMs, limit);
	}
	const ranked = [...byWindow.values()];
	ranked.sort((left, right) => {
		const leftDuration = left.window?.durationMs ?? Number.POSITIVE_INFINITY;
		const rightDuration = right.window?.durationMs ?? Number.POSITIVE_INFINITY;
		if (leftDuration !== rightDuration) return leftDuration - rightDuration;
		const leftReset = left.window?.resetsAt ?? Number.POSITIVE_INFINITY;
		const rightReset = right.window?.resetsAt ?? Number.POSITIVE_INFINITY;
		return leftReset - rightReset;
	});
	return ranked;
}

async function fetchZhipuCodingPlanUsage(
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<UsageReport | null> {
	if (params.provider !== PROVIDER) return null;
	const credential = params.credential;
	const authorization = formatBearerAuthorization(
		credential.type === "oauth" ? credential.accessToken : credential.apiKey,
	);
	if (!authorization) return null;

	const baseUrl = normalizeZhipuBaseUrl(params.baseUrl);
	const url = `${baseUrl}${QUOTA_PATH}`;
	const headers: Record<string, string> = {
		Accept: "application/json",
		Authorization: authorization,
		"Content-Type": "application/json",
		"User-Agent": USER_AGENT,
	};

	let payload: ZhipuQuotaPayload | null = null;
	try {
		const response = await ctx.fetch(url, {
			headers,
			signal: params.signal,
		});
		if (!response.ok) {
			ctx.logger?.warn("Zhipu usage fetch failed", { status: response.status, statusText: response.statusText });
			return null;
		}
		payload = (await response.json()) as ZhipuQuotaPayload;
	} catch (error) {
		ctx.logger?.warn("Zhipu usage fetch error", { error: String(error) });
		return null;
	}

	if (!payload) return null;
	if (payload.success !== true) {
		// An account without a GLM Coding Plan (pay-as-you-go models only) answers
		// `{code: 500, msg: "当前用户不存在coding plan"}`: nothing to meter, not a failure.
		if (typeof payload.msg === "string" && /不存在\s*coding\s*plan|no\s+coding\s+plan/i.test(payload.msg)) {
			ctx.logger?.debug("Zhipu account has no Coding Plan to meter", { code: payload.code });
			return null;
		}
		ctx.logger?.warn("Zhipu usage response invalid", { code: payload.code, message: payload.msg });
		return null;
	}

	const limitsPayload = Array.isArray(payload.data?.limits) ? payload.data?.limits : [];
	const limits: UsageLimit[] = [];

	for (const rawLimit of limitsPayload) {
		const parsed = parseLimitItem(rawLimit);
		if (!parsed) continue;
		if (parsed.type === "TOKENS_LIMIT") {
			const hasAbsoluteMeter = parsed.currentValue !== undefined && parsed.usage !== undefined && parsed.usage > 0;
			const amount = buildUsageAmount({
				used: parsed.currentValue,
				limit: parsed.usage,
				remaining: parsed.remaining,
				usedFraction: hasAbsoluteMeter ? undefined : percentageFraction(parsed.percentage),
				unit: "tokens",
			});
			const window = buildZhipuWindow(parsed);
			limits.push({
				id: `zhipu:tokens:${window.id}`,
				label: `Zhipu ${window.label} Token Quota`,
				scope: {
					provider: params.provider,
					windowId: window.id,
					shared: true,
				},
				window,
				amount,
				status: amount.usedFraction === undefined ? undefined : usageStatus(amount.usedFraction),
			});
		}
		if (parsed.type === "TIME_LIMIT") {
			const window = buildZhipuWindow(parsed);
			const hasAbsoluteMeter = parsed.currentValue !== undefined && parsed.usage !== undefined && parsed.usage > 0;
			const amount = buildUsageAmount({
				used: parsed.currentValue,
				limit: parsed.usage,
				remaining: parsed.remaining,
				usedFraction: hasAbsoluteMeter ? undefined : percentageFraction(parsed.percentage),
				unit: "requests",
			});
			const featureLimit = isZhipuFeatureRequestLimit(parsed);
			limits.push({
				id: featureLimit ? `zhipu:features:zread:${window.id}` : `zhipu:requests:${window.id}`,
				label: featureLimit ? "Zhipu Zread Quota" : "Zhipu Request Quota",
				scope: {
					provider: params.provider,
					windowId: window.id,
					shared: !featureLimit,
					...(featureLimit ? { tier: "zread" } : {}),
				},
				window,
				amount,
				status: amount.usedFraction === undefined ? undefined : usageStatus(amount.usedFraction),
			});
		}
		if (parsed.type === "CREDIT_LIMIT") {
			// Zhipu Coding Plan windows (e.g. Lite 2k/10k, Pro 12k/60k, Max 28k/140k
			// across 5h + weekly): `usage` is the plan allotment, `currentValue` the spend.
			// Prefer the exact ratio over server-rounded integer `percentage`.
			const window = buildZhipuWindow(parsed);
			const hasAbsoluteMeter = parsed.currentValue !== undefined && parsed.usage !== undefined && parsed.usage > 0;
			const amount = buildUsageAmount({
				used: parsed.currentValue,
				limit: parsed.usage,
				remaining: parsed.remaining,
				usedFraction: hasAbsoluteMeter ? undefined : percentageFraction(parsed.percentage),
				unit: "credits",
			});
			limits.push({
				id: `zhipu:credits:${window.id}`,
				label: `Zhipu ${window.label} Credit Quota`,
				scope: {
					provider: params.provider,
					windowId: window.id,
					shared: true,
				},
				window,
				amount,
				status: amount.usedFraction === undefined ? undefined : usageStatus(amount.usedFraction),
			});
		}
	}

	if (limits.length === 0) return null;

	const report: UsageReport = {
		provider: params.provider,
		fetchedAt: Date.now(),
		limits,
		metadata: {
			endpoint: url,
			accountId: credential.accountId,
			email: credential.email,
			...(typeof payload.data?.level === "string" && payload.data.level ? { planType: payload.data.level } : {}),
		},
		raw: payload,
	};

	const modelUsageUrl = buildModelUsageUrl(baseUrl, new Date());
	try {
		const response = await ctx.fetch(modelUsageUrl, {
			headers,
			signal: params.signal,
		});
		if (response.ok) {
			const modelUsagePayload = (await response.json()) as unknown;
			if (isRecord(modelUsagePayload)) {
				report.metadata = {
					...report.metadata,
					modelUsage: modelUsagePayload,
				};
			}
		}
	} catch (error) {
		ctx.logger?.debug("Zhipu model usage fetch failed", { error: String(error) });
	}

	return report;
}

/** Fetches the account-wide quota windows for Zhipu Coding Plan credentials. */
export const zhipuCodingPlanUsageProvider: UsageProvider = {
	id: PROVIDER,
	cacheVersion: 1,
	fetchUsage: fetchZhipuCodingPlanUsage,
	supports: params =>
		params.provider === PROVIDER &&
		Boolean(
			formatBearerAuthorization(
				params.credential.type === "oauth" ? params.credential.accessToken : params.credential.apiKey,
			),
		),
};

/** Ranks Zhipu Coding Plan credentials and identifies quota blocks a live report can heal. */
export const zhipuCodingPlanRankingStrategy: CredentialRankingStrategy = {
	healsGlobalBlocks: true,
	findWindowLimits(report) {
		const ranked = rankZhipuRequestLimits(report);
		return { primary: ranked[0], secondary: ranked[1] };
	},
	scopeLimits(report) {
		return getZhipuCredentialLimits(report);
	},
	blockScope() {
		return "credits";
	},
	healableBlockScopes(report) {
		const limits = getZhipuCredentialLimits(report);
		// A feature-only report cannot prove the shared credit/token pool recovered.
		if (!limits.some(limit => limit.id.startsWith("zhipu:credits:") || limit.id.startsWith("zhipu:tokens:"))) {
			return [];
		}
		return [
			{ blockScope: "credits", limits },
			{ blockScope: "", limits },
		];
	},
	windowDefaults: {
		primaryMs: 5 * HOUR_MS,
		secondaryMs: WEEK_MS,
	},
};
