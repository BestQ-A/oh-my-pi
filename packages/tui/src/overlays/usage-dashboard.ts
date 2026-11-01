/**
 * Fullscreen `/usage` dashboard (the /settings idiom): mounted as an overlay
 * on the alternate screen so it takes no transcript space. Shows a compact
 * subscriptions grid (one card per provider, worst window per quota bucket)
 * above a GitHub-style daily activity heatmap fed by the local stats DB.
 * Enter flips into the classic full per-account report, scrollable in place.
 */
import * as os from "node:os";
import { resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";
import {
	type Component,
	matchesKey,
	replaceTabs,
	routeSgrMouseInput,
	sliceWithWidth,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../index";
import { colorLuma, formatDuration, hexToRgb, rgbToHex, sanitizeText } from "@oh-my-pi/pi-utils";
import { formatProviderName } from "../chrome/format";
import {
	collapseSharedUsageReports,
	formatLimitTitle,
	summarizeUsageResetCredits,
	type UsageResetSummary,
} from "./usage-display";
import { colorToAnsi } from "../theme/color";
import { ensureThemeSync, theme } from "../theme/theme";
import { formatAbsoluteOnlyAmount } from "../prompt/usage-amounts";
import { truncateMiddleToWidth } from "../render/render-utils";
import { actionMarkerAt, formatActionMarker } from "../render/extension-links";
import { sanitizeDisplayLine } from "./extensions/display-text";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { OverlayPanel, PanelDivider, PanelRows } from "../chrome/overlay-box";
import { formatKeyHint } from "../app-keybindings";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import type { TspSpan, TspTableColumn, TspText, TspTone } from "@oh-my-pi/pi-wire";
import { col, elapsed, node, span, text } from "../native/describe";
import { type DescribeContext, leafKey, type NativeChild, type NativeNode, type NativeUiEvent } from "../native/node";
import { actionBar, actionButton } from "../native/overlay";

/** Local calendar-day activity consumed by the usage heatmap. */
export interface DailyActivityPoint {
	day: string;
	cost: number;
	requests: number;
}

// =============================================================================
// Subscriptions grid model
// =============================================================================

/** One quota bucket row on a provider or per-account card. */
export interface CardWindowRow {
	/** Display label (limit label with tier folded in). */
	label: string;
	/** Window label/id shown dim after the label when sibling rows share a label. */
	windowTag?: string;
	/** Used fraction (0..1, >1 = overage); undefined when unreported. */
	fraction: number | undefined;
	status: UsageLimit["status"];
	/** Reset countdown in ms from now, when in the future. */
	resetMs?: number;
	/** Total window duration in ms, when known (used for Magpie linear burn pace). */
	durationMs?: number;
	/** Magpie pace delta (`usedPct - expectedLinearUsedPct`): >0 burning faster, <0 burning slower. */
	paceDiffPct?: number;
	/** Compact absolute count remaining (`3,980/4,000` or `$69/$100`) when reported. */
	countLeftText?: string;
	/** Compact absolute count used (`20/4,000` or `$31/$100`) when reported. */
	countUsedText?: string;
	/** Absolute one-sided amount (e.g. `$12.34 used`, `100 credits left`) for limits without a fraction. */
	usedText?: string;
}

/** Per-account quota breakdown inside a multi-account (or single-account) provider card (Magpie `#panelQuota` idiom). */
export interface AccountQuotaSection {
	accountLabel: string;
	planLabel?: string;
	daybreak: boolean;
	unlimited: boolean;
	status: UsageLimit["status"];
	windows: CardWindowRow[];
	resetCredits?: {
		bankedCount: number;
		redeemableCount: number;
		soonestExpiryMs?: number;
		unavailableReasons: string[];
	};
}

/** A connected account whose usage lookup produced no attributable report. */
export interface UnavailableUsageAccount {
	provider: string;
	label: string;
}

/** Compact per-provider summary backing one card in the subscriptions grid. */
export interface ProviderCard {
	provider: string;
	name: string;
	/** Number of represented accounts, including unavailable usage lookups. */
	accounts: number;
	unavailableAccounts: string[];
	/** Per-account un-averaged sections so multi-account pools never mislead with averaged percentages. */
	accountSections: AccountQuotaSection[];
	/** Window rows in provider-declared order (aggregate summary retained for callers/native tree). */
	windows: CardWindowRow[];
	/** True when every account reports no limits (e.g. enterprise plans, providers without a quota API). */
	unlimited: boolean;
	/** Distinct report notes across accounts (e.g. why a provider exposes no quota windows). */
	notes: string[];
	/** True when nothing is used anywhere (or there are no limits). */
	idle: boolean;
	resetCredits?: {
		bankedCount: number;
		redeemableCount: number;
		soonestExpiryMs?: number;
		unavailableReasons: string[];
	};
	/** Labels of accounts with verified Daybreak access. */
	daybreakAccounts?: string[];
}
/**
 * Aggregate status across a bucket's limits, mirroring the classic report:
 * a mix of healthy and pressured accounts reads as a warning, not as the
 * worst account's status.
 */
function aggregateStatus(limits: readonly { status?: UsageLimit["status"] }[]): UsageLimit["status"] {
	const hasOk = limits.some(limit => limit.status === "ok");
	const hasWarning = limits.some(limit => limit.status === "warning");
	const hasExhausted = limits.some(limit => limit.status === "exhausted");
	if (hasOk) return hasWarning || hasExhausted ? "warning" : "ok";
	if (hasWarning) return "warning";
	if (hasExhausted) return "exhausted";
	return "unknown";
}

/**
 * Card status when some connected accounts reported no usage: the missing
 * report raises the card to a warning but never hides an exhausted quota.
 */
function statusWithUnavailableAccounts(windows: readonly { status?: UsageLimit["status"] }[]): UsageLimit["status"] {
	if (windows.length === 0) return "unknown";
	return aggregateStatus(windows) === "exhausted" ? "exhausted" : "warning";
}

/** Fraction below which a window counts as untouched (renders as 100% free). */
const IDLE_FRACTION = 0.005;
/**
 * Compact duration tag for a window (`7d`, `1d`, `5h`, `mo`), preferring the
 * declared duration and falling back to a short id. Kept terse because it
 * shares the label column with the limit name.
 */
function compactWindowTag(window: NonNullable<UsageLimit["window"]>): string {
	if (window.durationMs) {
		const hours = window.durationMs / 3_600_000;
		if (hours >= 28 * 24) return "mo";
		if (hours >= 24) return `${Math.round(hours / 24)}d`;
		return `${Math.round(hours)}h`;
	}
	const id = window.id.toLowerCase();
	return id.length <= 3 ? id : id.slice(0, 1);
}
function computeMagpiePaceDiffPct(
	usedFraction: number | undefined,
	resetMs: number | undefined,
	durationMs: number | undefined,
): number | undefined {
	if (
		usedFraction === undefined ||
		usedFraction <= 0 ||
		resetMs === undefined ||
		durationMs === undefined ||
		!(durationMs > 0) ||
		!(resetMs > 0) ||
		resetMs >= durationMs
	) {
		return undefined;
	}
	const elapsedFraction = 1 - resetMs / durationMs;
	// Avoid noisy pace figures in the first 5% of a window cycle (same spirit as Magpie's low-reading guard).
	if (elapsedFraction < 0.05) return undefined;
	return Math.round((usedFraction - elapsedFraction) * 100);
}

function formatWindowAbsoluteCounts(limit: UsageLimit): { left?: string; used?: string } {
	const amt = limit.amount;
	if (!amt) return {};
	const total = amt.limit;
	const unit = amt.unit;
	if (typeof total !== "number" || !Number.isFinite(total) || total <= 0 || unit === "percent") {
		return {};
	}
	const rem =
		typeof amt.remaining === "number" && Number.isFinite(amt.remaining)
			? Math.max(0, amt.remaining)
			: typeof amt.used === "number" && Number.isFinite(amt.used)
				? Math.max(0, total - amt.used)
				: undefined;
	const used =
		typeof amt.used === "number" && Number.isFinite(amt.used)
			? Math.max(0, amt.used)
			: rem !== undefined
				? Math.max(0, total - rem)
				: undefined;
	if (rem === undefined || used === undefined) return {};
	if (unit === "usd") {
		const fmtUsd = (n: number) =>
			`$${n >= 10 && Number.isInteger(Math.round(n * 10) / 10) ? Math.round(n) : n.toFixed(1)}`;
		return { left: `${fmtUsd(rem)}/${fmtUsd(total)}`, used: `${fmtUsd(used)}/${fmtUsd(total)}` };
	}
	const fmtInt = (n: number) => Math.round(n).toLocaleString("en-US");
	return { left: `${fmtInt(rem)}/${fmtInt(total)}`, used: `${fmtInt(used)}/${fmtInt(total)}` };
}

function buildWindowsFromLimits(limits: readonly UsageLimit[], nowMs: number, maxVisible: number): CardWindowRow[] {
	const buckets = new Map<string, { label: string; limits: UsageLimit[] }>();
	for (const limit of limits) {
		const label = formatLimitTitle(limit);
		const key =
			limit.scope.sharedGroup ?? `${label}|${limit.window?.id ?? limit.scope.windowId ?? "default"}|${limit.id}`;
		const entry = buckets.get(key) ?? { label, limits: [] };
		entry.limits.push(limit);
		buckets.set(key, entry);
	}
	const declared: CardWindowRow[] = [...buckets.values()].map(bucket => {
		const fractions = bucket.limits
			.map(limit => resolveUsedFraction(limit))
			.filter((value): value is number => value !== undefined);
		const fraction =
			fractions.length > 0 ? fractions.reduce((sum, value) => sum + value, 0) / fractions.length : undefined;
		const worst = bucket.limits.reduce((max, limit) =>
			(resolveUsedFraction(limit) ?? -1) > (resolveUsedFraction(max) ?? -1) ? limit : max,
		);
		const resetsAt = worst.window?.resetsAt;
		const resetMs = resetsAt !== undefined && resetsAt > nowMs ? resetsAt - nowMs : undefined;
		const durationMs = worst.window?.durationMs;
		const counts = bucket.limits.length === 1 ? formatWindowAbsoluteCounts(worst) : {};
		return {
			label: bucket.label,
			windowTag: worst.window ? compactWindowTag(worst.window) : undefined,
			fraction,
			status: aggregateStatus(bucket.limits),
			resetMs,
			durationMs,
			paceDiffPct: computeMagpiePaceDiffPct(fraction, resetMs, durationMs),
			countLeftText: counts.left,
			countUsedText: counts.used,
			usedText: fraction === undefined ? formatAbsoluteOnlyAmount(bucket.limits) : undefined,
		};
	});
	const visible = new Set([...declared].sort((a, b) => (b.fraction ?? -1) - (a.fraction ?? -1)).slice(0, maxVisible));
	const windows = [...declared.filter(row => visible.has(row)), ...declared.filter(row => !visible.has(row))];
	for (const window of windows) {
		const duplicated = windows.some(other => other !== window && other.label === window.label);
		if (!duplicated) window.windowTag = undefined;
	}
	return windows;
}

function extractAccountSection(
	report: UsageReport,
	index: number,
	totalInProvider: number,
	nowMs: number,
): AccountQuotaSection {
	const meta = report.metadata;
	const email = typeof meta?.email === "string" && meta.email.trim() ? meta.email.trim() : undefined;
	const accountId = typeof meta?.accountId === "string" && meta.accountId.trim() ? meta.accountId.trim() : undefined;
	const planRaw =
		typeof meta?.planType === "string" && meta.planType.trim()
			? meta.planType.trim()
			: typeof meta?.orgName === "string" && meta.orgName.trim()
				? meta.orgName.trim()
				: undefined;
	const accountLabel =
		email ?? (accountId ? accountId.slice(0, 12) : totalInProvider > 1 ? `Account #${index + 1}` : "");
	const planLabel = planRaw && planRaw.toLowerCase() !== accountLabel.toLowerCase() ? planRaw : undefined;
	const windows = buildWindowsFromLimits(report.limits, nowMs, CARD_MAX_WINDOWS);
	const resetSummary = summarizeUsageResetCredits(report.resetCredits, nowMs);
	let resetCredits: AccountQuotaSection["resetCredits"];
	if (resetSummary && resetSummary.bankedCount > 0) {
		const expiryMs =
			resetSummary.soonestExpiry !== undefined && Number.isFinite(Date.parse(resetSummary.soonestExpiry))
				? Date.parse(resetSummary.soonestExpiry) - nowMs
				: undefined;
		resetCredits = {
			bankedCount: resetSummary.bankedCount,
			redeemableCount: resetSummary.redeemableCount,
			soonestExpiryMs: expiryMs,
			unavailableReasons: resetSummary.unavailableReason ? [resetSummary.unavailableReason] : [],
		};
	}
	const unlimited = windows.length === 0;
	const status: UsageLimit["status"] = unlimited ? "ok" : aggregateStatus(windows);
	return {
		accountLabel,
		planLabel,
		daybreak: meta?.daybreak === true,
		unlimited,
		status,
		windows,
		resetCredits,
	};
}

/**
 * Collapse usage reports into one compact card per provider: limits grouped by
 * quota bucket (label + window), each bucket showing the mean used fraction
 * across accounts (matching the classic report's aggregate "% free") with the
 * most-used account's reset countdown. Rows keep the provider's declared window
 * order so 5h → week → month reads the same every time; cards sort by their
 * fullest window so what's burning is on top-left; fully idle providers
 * collapse into a tick.
 */
export function buildProviderCards(
	reports: UsageReport[],
	nowMs: number,
	unavailableAccounts: readonly UnavailableUsageAccount[] = [],
): ProviderCard[] {
	const displayReports = collapseSharedUsageReports(reports);
	const grouped = new Map<string, UsageReport[]>();
	for (const report of displayReports) {
		const list = grouped.get(report.provider) ?? [];
		list.push(report);
		grouped.set(report.provider, list);
	}
	for (const account of unavailableAccounts) {
		if (!grouped.has(account.provider)) grouped.set(account.provider, []);
	}

	const cards: ProviderCard[] = [];
	for (const [provider, providerReports] of grouped) {
		const unavailable = unavailableAccounts
			.filter(account => account.provider === provider)
			.map(account => account.label);
		const buckets = new Map<string, { label: string; limits: UsageLimit[] }>();
		for (const report of providerReports) {
			for (const limit of report.limits) {
				const label = formatLimitTitle(limit);
				// Distinct buckets can share a label and window (Antigravity's Gemini
				// vs Gemini (Argon) weekly) and must not average into one row, so the
				// id joins the key. The label and window stay in it too: some
				// providers build ids positionally or per plan (kimi's `${index}`,
				// copilot's allowance), where ids differ across accounts for the
				// same quota, so an id-only key would split those accounts apart.
				// `sharedGroup` already names the routing copies of one shared bucket.
				const key =
					limit.scope.sharedGroup ??
					`${label}|${limit.window?.id ?? limit.scope.windowId ?? "default"}|${limit.id}`;
				const entry = buckets.get(key) ?? { label, limits: [] };
				entry.limits.push(limit);
				buckets.set(key, entry);
			}
		}

		const declared: CardWindowRow[] = [...buckets.values()].map(bucket => {
			const fractions = bucket.limits
				.map(limit => resolveUsedFraction(limit))
				.filter((value): value is number => value !== undefined);
			const fraction =
				fractions.length > 0 ? fractions.reduce((sum, value) => sum + value, 0) / fractions.length : undefined;
			const worst = bucket.limits.reduce((max, limit) =>
				(resolveUsedFraction(limit) ?? -1) > (resolveUsedFraction(max) ?? -1) ? limit : max,
			);
			const resetsAt = worst.window?.resetsAt;
			return {
				label: bucket.label,
				windowTag: worst.window ? compactWindowTag(worst.window) : undefined,
				fraction,
				status: aggregateStatus(bucket.limits),
				resetMs: resetsAt !== undefined && resetsAt > nowMs ? resetsAt - nowMs : undefined,
				usedText: fraction === undefined ? formatAbsoluteOnlyAmount(bucket.limits) : undefined,
			};
		});
		// Cards render at most CARD_MAX_WINDOWS rows; when a provider declares
		// more, keep the fullest ones visible (still in declared order) so an
		// exhausted bucket never hides behind "+N more".
		const visible = new Set(
			[...declared].sort((a, b) => (b.fraction ?? -1) - (a.fraction ?? -1)).slice(0, CARD_PRIORITY_LEAD_WINDOWS),
		);
		const windows = [...declared.filter(row => visible.has(row)), ...declared.filter(row => !visible.has(row))];
		// The window tag earns its columns only when sibling rows would otherwise
		// be indistinguishable (e.g. Antigravity's daily vs weekly "Usage (Google)").
		for (const window of windows) {
			const duplicated = windows.some(other => other !== window && other.label === window.label);
			if (!duplicated) window.windowTag = undefined;
		}

		const resetRows = providerReports
			.map(report => summarizeUsageResetCredits(report.resetCredits, nowMs))
			.filter((summary): summary is UsageResetSummary => summary !== undefined && summary.bankedCount > 0);
		const bankedCount = resetRows.reduce((total, summary) => total + summary.bankedCount, 0);
		const redeemableCount = resetRows.reduce((total, summary) => total + summary.redeemableCount, 0);
		const resetExpiries = resetRows
			.map(summary => summary.soonestExpiry)
			.filter((expiry): expiry is string => expiry !== undefined)
			.map(expiry => Date.parse(expiry))
			.filter(Number.isFinite)
			.sort((left, right) => left - right);
		const soonestResetExpiry = resetExpiries.find(expiry => expiry > nowMs) ?? resetExpiries.at(-1);
		const unavailableReasons = [
			...new Set(
				resetRows
					.map(summary => summary.unavailableReason)
					.filter((reason): reason is string => reason !== undefined),
			),
		];
		const resetCredits =
			bankedCount > 0
				? {
						bankedCount,
						redeemableCount,
						soonestExpiryMs: soonestResetExpiry === undefined ? undefined : soonestResetExpiry - nowMs,
						unavailableReasons,
					}
				: undefined;
		const daybreakAccounts = providerReports.flatMap((report, index) =>
			report.metadata?.daybreak === true
				? [
						typeof report.metadata.email === "string" && report.metadata.email
							? report.metadata.email
							: typeof report.metadata.accountId === "string" && report.metadata.accountId
								? report.metadata.accountId
								: `account ${index + 1}`,
					]
				: [],
		);
		const accountSections = providerReports.map((report, idx) =>
			extractAccountSection(report, idx, providerReports.length, nowMs),
		);
		if (accountSections.length > 1) {
			// Order healthier / reset-backed accounts first so ready capacity leads at a glance.
			accountSections.sort((a, b) => {
				const aMinUsed = a.windows.reduce((min, w) => Math.min(min, w.fraction ?? 0), 1);
				const bMinUsed = b.windows.reduce((min, w) => Math.min(min, w.fraction ?? 0), 1);
				if (aMinUsed !== bMinUsed) return aMinUsed - bMinUsed;
				return (b.resetCredits?.bankedCount ?? 0) - (a.resetCredits?.bankedCount ?? 0);
			});
		}
		cards.push({
			provider,
			name: formatProviderName(provider),
			accounts: providerReports.length + unavailable.length,
			unavailableAccounts: unavailable,
			windows,
			accountSections,
			unlimited: windows.length === 0 && unavailable.length === 0,
			notes: [...new Set(providerReports.flatMap(report => report.notes ?? []))],
			idle:
				unavailable.length === 0 &&
				!resetCredits &&
				daybreakAccounts.length === 0 &&
				windows.every(window => window.fraction !== undefined && window.fraction < IDLE_FRACTION),
			resetCredits,
			...(daybreakAccounts.length > 0 ? { daybreakAccounts } : {}),
		});
	}

	const worstFraction = new Map(
		cards.map(card => [card, card.windows.reduce((max, window) => Math.max(max, window.fraction ?? -1), -1)]),
	);
	cards.sort((a, b) => {
		const aWorst = worstFraction.get(a)!;
		const bWorst = worstFraction.get(b)!;
		if (aWorst !== bWorst) return bWorst - aWorst;
		return a.name.localeCompare(b.name);
	});
	return cards;
}

// =============================================================================
// Activity heatmap model
// =============================================================================

/** GitHub-style week-per-column heatmap grid derived from daily activity. */
export interface HeatmapLayout {
	/** Per week column: short month name when the column starts a new month. */
	monthLabels: (string | undefined)[];
	/** 7 rows (Mon..Sun) × N week columns; 0..4 intensity, null = future day. */
	cells: (number | null)[][];
	totalCost: number;
	totalRequests: number;
	/** Local midnight of the first cell (column 0, Monday). */
	start: Date;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const HEATMAP_DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

function localIso(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * Lay out daily activity into a Monday-first week grid ending at `today`'s
 * week. Intensity levels are magnitude-scaled against the busiest day
 * (square-root compressed so mid-size days stay distinguishable from
 * outliers), over per-day cost — falling back to request counts when nothing
 * in range has priced usage. Unlike GitHub's rank quartiles, intensity tracks
 * *how much* work a day carried.
 */
export function buildHeatmapLayout(points: DailyActivityPoint[], weeks: number, today = new Date()): HeatmapLayout {
	const byDay = new Map(points.map(point => [point.day, point]));
	const anyCost = points.some(point => point.cost > 0);
	const metric = (point: DailyActivityPoint): number => (anyCost ? point.cost : point.requests);

	const today0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
	const mondayOffset = (today0.getDay() + 6) % 7;
	const currentMonday = addDays(today0, -mondayOffset);
	const start = addDays(currentMonday, -(weeks - 1) * 7);
	const startIso = localIso(start);
	const todayIso = localIso(today0);

	const inRange = points.filter(point => point.day >= startIso && point.day <= todayIso);
	const max = inRange.reduce((acc, point) => Math.max(acc, metric(point)), 0);
	const level = (value: number): number => {
		if (value <= 0 || max <= 0) return 0;
		return Math.min(4, Math.max(1, Math.ceil(Math.sqrt(value / max) * 4)));
	};

	const monthLabels: (string | undefined)[] = [];
	const cells: (number | null)[][] = Array.from({ length: 7 }, () =>
		Array.from({ length: weeks }, (): number | null => null),
	);
	let previousMonth = -1;
	for (let week = 0; week < weeks; week++) {
		const weekStart = addDays(start, week * 7);
		const month = weekStart.getMonth();
		monthLabels.push(month !== previousMonth ? MONTH_NAMES[month] : undefined);
		previousMonth = month;
		for (let day = 0; day < 7; day++) {
			const date = addDays(weekStart, day);
			if (date > today0) continue;
			const point = byDay.get(localIso(date));
			cells[day][week] = level(point ? metric(point) : 0);
		}
	}

	return {
		monthLabels,
		cells,
		totalCost: inRange.reduce((sum, point) => sum + point.cost, 0),
		totalRequests: inRange.reduce((sum, point) => sum + point.requests, 0),
		start,
	};
}

// =============================================================================
// Native description helpers
// =============================================================================

/** Weeks of history the native heatmap carries (a year, GitHub-style). */
const NATIVE_HEATMAP_WEEKS = 53;
/** Span tokens for heatmap intensity levels 1..4 (the `table` fallback). */
const HEAT_LEVEL_TOKENS = ["dim", "accent dim", "accent", "accent strong"];
/** Heatmap row labels, Monday first like omp's grid: M/W/F only. */
const HEATMAP_ROW_LABELS = ["M", "", "W", "", "F", "", ""];
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Meter tone of a quota window: ok is the accent fill, pressure warns, exhaustion errors. */
function statusTone(status: UsageLimit["status"]): TspTone {
	if (status === "exhausted") return "error";
	if (status === "warning") return "warning";
	if (status === "ok") return "accent";
	return "muted";
}

/** Status dot before a provider's name, toned by the card's aggregate status. */
function statusDot(status: UsageLimit["status"]): NativeNode {
	const token =
		status === "exhausted" ? "error" : status === "warning" ? "warning" : status === "ok" ? "success" : "dim";
	const label =
		status === "exhausted"
			? "Exhausted"
			: status === "warning"
				? "Under pressure"
				: status === "ok"
					? "OK"
					: "Unknown";
	return text([span("●", token)], { role: "omp.usage.dot", title: label, aria: label });
}

/**
 * Used-fraction bar of a quota window, toned by status: a `meter` where the
 * terminal draws one, else a `progress` bar.
 */
function usageMeter(fraction: number, status: UsageLimit["status"], meter: boolean): NativeNode {
	const value = Math.min(Math.max(fraction, 0), 1);
	const tone = statusTone(status);
	return meter ? node("meter", { value, style: "bar", size: "md", tone }) : node("progress", { value, tone, grow: 1 });
}

/** `Mon 28 Sep` for a local date. */
function shortDate(date: Date): string {
	return `${WEEKDAY_NAMES[date.getDay()]} ${date.getDate()} ${MONTH_NAMES[date.getMonth()]}`;
}

/** `18:00` for a local time. */
function clockTime(date: Date): string {
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * When a window resets, `resetMs` from `nowMs`: the countdown (`resets in
 * 2h30m`), which reads the same in every time zone; the title carries the
 * local date and time.
 */
function resetLabel(nowMs: number, resetMs: number): { text: string; title: string } {
	const at = new Date(nowMs + resetMs);
	return {
		text: `resets in ${formatDuration(resetMs)}`,
		title: `Resets ${shortDate(at)} ${at.getFullYear()}, ${clockTime(at)}`,
	};
}

function mutedText(content: string, wrap = false): NativeNode {
	return text([span(content, "muted")], wrap ? { wrap: "word" } : { truncate: "end" });
}

/**
 * A quiet row under the provider rows naming the providers that get none
 * (`Untouched   Kimi Code, Zai`): the label sits in the provider column, the
 * names in the quota column; `title` says why on hover.
 */
function footnote(key: string, label: string, cards: readonly ProviderCard[], title?: string): NativeNode {
	const names = cards.map(card => card.name).join(", ");
	return node(
		"row",
		{ role: "omp.usage.footnote", align: "baseline", ...(title ? { title: sanitizeDisplayLine(title) } : {}) },
		[text([span(label, "dim")], { role: "omp.usage.footnote.k" }), text([span(names)], { wrap: "word" })],
		key,
	);
}

/** A section's title over its rows (`Quotas`, `Activity`) with quiet facts at its right end. */
function sectionHead(title: string, meta: readonly NativeChild[]): NativeNode {
	return node(
		"row",
		{ role: "omp.usage.section", gap: "sm", align: "center" },
		[text([span(title)], { role: "omp.usage.section.title" }), node("spacer", { grow: 1 }), ...meta],
		"head",
	);
}

/**
 * One headline figure of the summary strip: a small label, the figure (with an
 * optional chart beside it), and a line of context under it.
 */
function statTile(
	key: string,
	label: string,
	value: TspText,
	sub: TspText,
	options: { chart?: NativeNode; title?: string } = {},
): NativeNode {
	const figure: NativeChild[] = [text(value, { role: "omp.usage.stat.value", truncate: "end" })];
	if (options.chart) figure.push(options.chart);
	return node(
		"col",
		{ role: "omp.usage.stat", gap: "xs", ...(options.title ? { title: options.title } : {}) },
		[
			text([span(label)], { role: "omp.usage.stat.label", truncate: "end" }),
			node("row", { gap: "md", align: "end" }, figure, "figure"),
			text(sub, { role: "omp.usage.stat.sub", truncate: "end" }),
		],
		key,
	);
}

/** `62%` in mono, toned like the window's status, then a quiet `left`. */
function leftSpans(fraction: number, status: UsageLimit["status"]): TspSpan[] {
	const token = status === "exhausted" ? "mono error" : status === "warning" ? "mono warning" : "mono";
	return [span(`${Math.max(0, Math.round((1 - fraction) * 100))}%`, token), span(" left", "dim")];
}

/** Stable, human account name for a report in the detail view. */
function reportAccountLabel(report: UsageReport, limit: UsageLimit | undefined, index: number): string {
	const metadata = report.metadata;
	const pick = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
	const identity =
		pick(metadata?.email) ??
		pick(metadata?.accountId) ??
		pick(metadata?.projectId) ??
		pick(limit?.scope.projectId) ??
		`account ${index + 1}`;
	const org = pick(metadata?.orgName);
	return sanitizeDisplayLine(org && org !== identity ? `${identity} (${org})` : identity);
}

/** Window qualifier worth showing after a limit title (none when the title already names it). */
function detailWindowLabel(label: string, limit: UsageLimit): string | undefined {
	const windowLabel = limit.window?.label ?? limit.window?.id ?? limit.scope.windowId;
	if (!windowLabel) return undefined;
	const normalized = windowLabel.toLowerCase();
	if (normalized === "quota window" || label.toLowerCase().includes(normalized)) return undefined;
	return sanitizeDisplayLine(windowLabel);
}

const WHOLE_DOLLARS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const COMPACT_COUNT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** `$1,234`, `$759`, `$84.20`, `$0.13`: cents only below $100. */
function formatCost(cost: number): string {
	if (cost <= 0) return "$0";
	return cost >= 100 ? `$${WHOLE_DOLLARS.format(cost)}` : `$${cost.toFixed(2)}`;
}

function requestsText(requests: number): string {
	return `${COMPACT_COUNT.format(requests)} request${requests === 1 ? "" : "s"}`;
}

/** Days the spend spark and the "Last 30 days" figure cover. */
const MONTH_DAYS = 30;

interface ActivityDay {
	date: Date;
	cost: number;
	requests: number;
}

/** Headline figures of the activity history behind the summary strip and the calendar's foot. */
interface ActivityFigures {
	/** Whether any day in range carries a price (else figures fall back to request counts). */
	priced: boolean;
	/** The last {@link MONTH_DAYS} days, oldest first. */
	month: ActivityDay[];
	monthCost: number;
	monthRequests: number;
	busiest?: ActivityDay;
	activeDays: number;
	longestStreak: number;
}

/** Derive the headline figures from the daily points over the heatmap's range. */
function activityFigures(
	points: readonly DailyActivityPoint[],
	layout: HeatmapLayout,
	today = new Date(),
): ActivityFigures {
	const byDay = new Map(points.map(point => [point.day, point]));
	const today0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
	const priced = layout.totalCost > 0;
	const weight = (day: ActivityDay): number => (priced ? day.cost : day.requests);
	const month: ActivityDay[] = [];
	for (let back = MONTH_DAYS - 1; back >= 0; back--) {
		const date = addDays(today0, -back);
		const point = byDay.get(localIso(date));
		month.push({ date, cost: point?.cost ?? 0, requests: point?.requests ?? 0 });
	}
	let busiest: ActivityDay | undefined;
	let activeDays = 0;
	let streak = 0;
	let longestStreak = 0;
	for (let date = layout.start; date <= today0; date = addDays(date, 1)) {
		const point = byDay.get(localIso(date));
		if (!point || (point.cost <= 0 && point.requests <= 0)) {
			streak = 0;
			continue;
		}
		activeDays++;
		streak++;
		longestStreak = Math.max(longestStreak, streak);
		const day = { date, cost: point.cost, requests: point.requests };
		if (!busiest || weight(day) > weight(busiest)) busiest = day;
	}
	return {
		priced,
		month,
		monthCost: month.reduce((sum, day) => sum + day.cost, 0),
		monthRequests: month.reduce((sum, day) => sum + day.requests, 0),
		busiest,
		activeDays,
		longestStreak,
	};
}

/** `$1,234 · 5.6K requests` totals for the activity summary. */
function formatActivityTotals(layout: HeatmapLayout): string {
	const cost =
		layout.totalCost >= 1 ? `$${WHOLE_DOLLARS.format(layout.totalCost)}` : `$${layout.totalCost.toFixed(2)}`;
	return `${cost} · ${COMPACT_COUNT.format(layout.totalRequests)} requests`;
}

// =============================================================================
// Component
// =============================================================================

/** Callbacks and data sources for {@link UsageDashboardComponent}. */
export interface UsageDashboardOptions {
	reports: UsageReport[];
	unavailableAccounts?: readonly UnavailableUsageAccount[];
	/**
	 * Full classic `/usage` report of `reports` (the latest refresh) for the
	 * expanded detail view; re-invoked per terminal width.
	 */
	renderDetail: (width: number, reports: UsageReport[]) => string;
	/**
	 * Stream daily activity into the heatmap: push cached DB rows immediately,
	 * then push again after an incremental session sync. Resolves when the sync
	 * settles; rejection renders as a dim unavailable note. `signal` aborts when
	 * the dashboard closes so an in-flight sync can stop early.
	 */
	loadActivity: (push: (points: DailyActivityPoint[]) => void, signal: AbortSignal) => Promise<void>;
	/** Re-fetch the usage reports (`r`); omitted when the host can't. Resolves null when nothing came back. */
	refresh?: () => Promise<UsageReport[] | null>;
	/** Optional saved model presets rendered in the top presets bar (`[1]`..`[9]`). */
	presets?: ReadonlyArray<{ name: string; active: boolean }>;
	/** Switch active model preset when pressing `1`..`9` in the dashboard. */
	onSwitchPreset?: (name: string) => Promise<{ ok: boolean; message: string; activeName?: string }>;
	/** Launch or bring forward the standalone Desktop Quota HUD (`p` / `P`). */
	onOpenDesktopHud?: () => Promise<string> | string;
	requestRender: () => void;
	onClose: () => void;
}

/**
 * Sanitize activity loading error text for safe single-line display in the TUI overlay.
 * Strips ANSI/control sequences, expands tabs, collapses whitespace runs/newlines,
 * shortens home directory paths to ~, and removes trailing dots.
 */
export function formatActivityErrorDetail(error: string, homeDir = os.homedir()): string {
	let text = replaceTabs(sanitizeText(error)).replace(/\s+/g, " ").trim();
	if (homeDir) {
		const escaped = homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const forward = homeDir.replaceAll("\\", "/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		text = text.replace(new RegExp(`${escaped}|${forward}`, "gi"), "~");
	}
	return text.replace(/\.+$/, "");
}

const CARD_MIN_WIDTH = 32;
const CARD_GUTTER = 3;
const CARD_PRIORITY_LEAD_WINDOWS = 4;
const CARD_MAX_WINDOWS = 10;
const CARD_MIN_BAR_WIDTH = 12;
const CARD_MAX_LABEL_LINES = 2;
const PRESET_DIGIT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

interface CardRowLayout {
	labelWidth: number;
	resetWidth: number;
	barWidth: number;
	stacked: boolean;
	labelHeights: number[];
}

export class UsageDashboardComponent implements Component {
	/** The terminal draws the sheet: a large glass overlay titled Usage. */
	readonly nativeOverlay = { role: "omp.overlay.usage", size: "lg", anchor: "center", head: "Usage" } as const;
	#options: UsageDashboardOptions;
	#reports: UsageReport[];
	#cards: ProviderCard[];
	#unavailableAccounts: readonly UnavailableUsageAccount[] | undefined;
	#presets: Array<{ name: string; active: boolean }>;
	#switchingPreset = false;
	#actionBanner: string | null = null;
	#nowMs: number;
	#refreshing = false;
	#refreshError: string | null = null;
	/** Bumped whenever anything the native description shows changes. */
	#revision = 0;
	#view: "overview" | "detail" = "overview";
	#scroll = 0;
	/** Magpie `quotaLeft` polarity: `true` = show Remaining (`剩余`), `false` = show Used (`已用`). */
	#quotaLeft = true;
	#activity: DailyActivityPoint[] | null = null;
	#activityError: string | null = null;
	#syncing = true;
	#detailCache: { width: number; lines: string[] } | null = null;
	/** ANSI overview rows; rebuilt when the revision or width changes. */
	#overviewCache: { revision: number; width: number; lines: string[] } | null = null;
	#lastViewportRows = 10;
	#closed = false;
	#lastRenderedLines: readonly string[] = [];
	readonly #panel: OverlayPanel;
	readonly #header: PanelRows;
	readonly #body: PanelRows;
	readonly #footer: PanelRows;
	readonly #closeController = new AbortController();
	#nativeCache: { revision: number; meter: boolean; chart: boolean; node: NativeNode } | undefined;

	constructor(options: UsageDashboardOptions) {
		ensureThemeSync();
		this.#options = options;
		this.#reports = options.reports;
		this.#unavailableAccounts = options.unavailableAccounts;
		this.#presets = options.presets
			? options.presets.map(preset => ({ name: preset.name, active: preset.active }))
			: [];
		this.#nowMs = Date.now();
		this.#cards = buildProviderCards(this.#reports, this.#nowMs, this.#unavailableAccounts);
		this.#panel = new OverlayPanel("Usage");
		this.#header = new PanelRows();
		this.#header.setHeight(1);
		this.#body = new PanelRows();
		this.#footer = new PanelRows();
		this.#footer.setHeight(1);
		this.#panel.addChild(this.#header);
		this.#panel.addChild(this.#body);
		this.#panel.addChild(new PanelDivider());
		this.#panel.addChild(this.#footer);
		void this.#loadActivity();
	}

	async #loadActivity(): Promise<void> {
		try {
			await this.#options.loadActivity(points => {
				if (this.#closed) return;
				this.#activity = points;
				this.#changed();
			}, this.#closeController.signal);
		} catch (error) {
			this.#activityError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#syncing = false;
			if (!this.#closed) this.#changed();
		}
	}

	/** Push updated usage reports from an asynchronous background refresh while open. */
	updateReports(reports: UsageReport[], unavailableAccounts?: readonly UnavailableUsageAccount[]): void {
		if (this.#closed) return;
		if (unavailableAccounts !== undefined) {
			this.#unavailableAccounts = unavailableAccounts;
		}
		this.#reports = reports;
		this.#nowMs = Date.now();
		this.#cards = buildProviderCards(reports, this.#nowMs, this.#unavailableAccounts);
		this.#detailCache = null;
		this.#overviewCache = null;
		this.#changed();
	}

	invalidate(): void {
		this.#detailCache = null;
		this.#overviewCache = null;
		this.#panel.invalidate();
	}

	dispose(): void {
		this.#closed = true;
		this.#closeController.abort();
		this.#panel.dispose();
	}

	// ---------------------------------------------------------------------------
	// Subscriptions grid rendering
	// ---------------------------------------------------------------------------

	#statusIcon(status: UsageLimit["status"]): string {
		if (status === "exhausted") return theme.fg("error", theme.status.error);
		if (status === "warning") return theme.fg("warning", theme.status.warning);
		if (status === "ok") return theme.fg("success", theme.status.success);
		return theme.fg("dim", theme.status.info);
	}

	#statusColor(status: UsageLimit["status"]): "success" | "warning" | "error" | "dim" {
		if (status === "exhausted") return "error";
		if (status === "warning") return "warning";
		if (status === "ok") return "success";
		return "dim";
	}

	#miniBar(fillFraction: number | undefined, status: UsageLimit["status"], width: number): string {
		if (fillFraction === undefined) return theme.fg("dim", "·".repeat(width));
		const clamped = Math.min(Math.max(fillFraction, 0), 1);
		const filled = Math.round(clamped * width);
		const bar = "█".repeat(filled);
		const empty = "░".repeat(width - filled);
		return `${theme.fg(this.#statusColor(status), bar)}${theme.fg("dim", empty)}`;
	}

	#formatWindowDisplayLabel(window: CardWindowRow): string {
		const base = sanitizeDisplayLine(window.label);
		const countText = this.#quotaLeft ? window.countLeftText : window.countUsedText;
		const withCount = countText ? `${base} (${sanitizeDisplayLine(countText)})` : base;
		const formatted = theme.fg("muted", withCount);
		const tag = window.windowTag ? sanitizeDisplayLine(window.windowTag) : "";
		return tag ? `${formatted} ${theme.fg("dim", tag)}` : formatted;
	}

	#formatWindowResetAndPace(window: CardWindowRow, includePace: boolean): string {
		if (window.fraction !== undefined && window.fraction <= 0.0005) {
			return "未使用";
		}
		const resetPart = window.resetMs !== undefined ? formatDuration(window.resetMs) : "";
		if (!includePace || window.paceDiffPct === undefined || Math.abs(window.paceDiffPct) < 8) {
			return resetPart;
		}
		const diff = this.#quotaLeft ? -window.paceDiffPct : window.paceDiffPct;
		const sign = diff > 0 ? "+" : diff < 0 ? "−" : "±";
		const paceStr = `${sign}${Math.abs(diff)}%`;
		return resetPart ? `${resetPart}·${paceStr}` : paceStr;
	}

	#renderResetCreditLines(
		resets: NonNullable<ProviderCard["resetCredits"]>,
		indent: string,
		maxTextWidth: number,
	): string[] {
		const out: string[] = [];
		let resetText = `↺ ${resets.bankedCount} reset${resets.bankedCount === 1 ? "" : "s"}`;
		if (resets.redeemableCount !== resets.bankedCount) {
			resetText += ` · ${resets.redeemableCount} usable`;
		}
		if (resets.soonestExpiryMs !== undefined) {
			resetText +=
				resets.soonestExpiryMs > 0 ? ` · expires ${formatDuration(resets.soonestExpiryMs)}` : " · expired";
		}
		out.push(
			`${indent}${theme.fg(resets.redeemableCount > 0 ? "success" : "warning", truncateToWidth(resetText, maxTextWidth))}`,
		);
		if (resets.redeemableCount === 0 && resets.unavailableReasons.length > 0) {
			const reason = sanitizeText(resets.unavailableReasons.join(" • ").replace(/[\r\n\t]+/g, " "));
			out.push(`${indent}${theme.fg("dim", truncateToWidth(`unavailable: ${reason}`, maxTextWidth))}`);
		}
		return out;
	}

	#renderWindowBlock(
		windows: readonly CardWindowRow[],
		labelLines: string[][],
		layout: CardRowLayout,
		contentWidth: number,
		indent: string,
		showPolarityWord: boolean,
		includePace: boolean,
		keyPrefix: string,
	): string[] {
		const lines: string[] = [];
		const hidden = windows.length - CARD_MAX_WINDOWS;
		const { labelWidth, resetWidth, barWidth, stacked, labelHeights } = layout;
		const polarityWord = showPolarityWord ? (this.#quotaLeft ? "余" : "用") : "";
		const pctPadWidth = showPolarityWord ? 4 : 5;

		for (let index = 0; index < Math.min(windows.length, CARD_MAX_WINDOWS); index++) {
			const window = windows[index]!;
			const rowLabels = labelLines[index] ?? [this.#formatWindowDisplayLabel(window)];
			const label = rowLabels[0] ?? "";
			const prefix = stacked ? "" : `${label}${" ".repeat(Math.max(0, labelWidth - visibleWidth(label)))} `;
			if (stacked) {
				const height = labelHeights[index] ?? rowLabels.length;
				for (let line = 0; line < height; line++) {
					lines.push(`${indent}${rowLabels[line] ?? ""}`);
				}
			}
			if (window.fraction === undefined) {
				const text = theme.fg("dim", window.usedText ?? "no data");
				for (const line of wrapTextWithAnsi(`${prefix}${text}`, contentWidth)) lines.push(`${indent}${line}`);
				continue;
			}
			const shownFraction = this.#quotaLeft ? Math.max(0, 1 - window.fraction) : Math.max(0, window.fraction);
			const shownPct = Math.max(0, Math.round(shownFraction * 100));
			const rawPct = showPolarityWord
				? ` ${polarityWord}${`${shownPct}%`.padStart(pctPadWidth)}`
				: `${shownPct}%`.padStart(5);
			const pctText = theme.fg(this.#statusColor(window.status), rawPct);
			const resetPlain = this.#formatWindowResetAndPace(window, includePace);
			const resetColor = window.paceDiffPct !== undefined && window.paceDiffPct >= 10 ? "warning" : "dim";
			const resetPad = " ".repeat(Math.max(0, resetWidth - visibleWidth(resetPlain)));
			const resetText = resetWidth > 0 ? ` ${theme.fg(resetColor, `${resetPad}${resetPlain}`)}` : "";
			const meterBar = `${this.#miniBar(shownFraction, window.status, barWidth)}${pctText}`;
			const clickableMeter = formatActionMarker(
				meterBar,
				"omp-overlay:toggle-polarity",
				`${keyPrefix}:meter:${index}`,
			);
			for (const line of wrapTextWithAnsi(`${prefix}${clickableMeter}${resetText}`, contentWidth)) {
				lines.push(`${indent}${line}`);
			}
		}
		if (hidden > 0) lines.push(`${indent}${theme.fg("dim", `+${hidden} more`)}`);
		return lines;
	}

	#computeWindowLayout(
		windowGroups: ReadonlyArray<readonly CardWindowRow[]>,
		cardWidth: number,
		indentCols: number,
		showPolarityWord: boolean,
		includePace: boolean,
	): { layout: CardRowLayout; labelLines: string[][][] } {
		const labels = windowGroups.map(rows => rows.map(w => this.#formatWindowDisplayLabel(w)));
		const labelWidth = labels.reduce(
			(max, rows) => rows.reduce((w, label) => Math.max(w, visibleWidth(label)), max),
			0,
		);
		const resetWidth = windowGroups.reduce(
			(max, rows) =>
				rows.reduce((w, win) => Math.max(w, visibleWidth(this.#formatWindowResetAndPace(win, includePace))), max),
			0,
		);
		const contentWidth = Math.max(1, cardWidth - indentCols);
		const pctWidth = showPolarityWord ? 7 : 5;
		const suffixWidth = pctWidth + (resetWidth > 0 ? resetWidth + 1 : 0);
		const inlineBarWidth = contentWidth - labelWidth - 1 - suffixWidth;
		const stacked = inlineBarWidth < CARD_MIN_BAR_WIDTH;
		const maxRows = Math.max(1, ...windowGroups.map(g => g.length));
		const labelLines = labels.map(rows =>
			rows.map(label => {
				if (!stacked) return [label];
				const bounded = truncateMiddleToWidth(label, contentWidth * CARD_MAX_LABEL_LINES);
				const wrapped = wrapTextWithAnsi(bounded, contentWidth);
				if (wrapped.length <= CARD_MAX_LABEL_LINES) return wrapped;
				const first = sliceWithWidth(bounded, 0, contentWidth, true);
				const rest = sliceWithWidth(bounded, first.width, visibleWidth(bounded) - first.width, true);
				return [first.text, truncateMiddleToWidth(rest.text, contentWidth)];
			}),
		);
		const labelHeights = Array.from({ length: maxRows }, (_, index) =>
			Math.max(0, ...labelLines.map(rows => rows[index]?.length ?? 0)),
		);
		return {
			layout: {
				labelWidth,
				resetWidth,
				barWidth: Math.max(1, stacked ? contentWidth - suffixWidth : inlineBarWidth),
				stacked,
				labelHeights,
			},
			labelLines,
		};
	}

	#renderCardLines(
		card: ProviderCard,
		width: number,
		sharedSingleLabels?: string[][],
		sharedSingleLayout?: CardRowLayout,
	): string[] {
		const lines: string[] = [];
		const cardStatus =
			card.unavailableAccounts.length > 0
				? statusWithUnavailableAccounts(card.windows)
				: card.unlimited
					? "ok"
					: aggregateStatus(card.windows);
		const accountsText = card.accounts > 1 ? theme.fg("dim", `${card.accounts} accts`) : "";
		const titleBudget = width - 2 - visibleWidth(accountsText) - (accountsText ? 1 : 0);
		const title = theme.bold(truncateToWidth(card.name, Math.max(4, titleBudget)));
		const titlePad = Math.max(0, width - 2 - visibleWidth(title) - visibleWidth(accountsText));
		lines.push(`${this.#statusIcon(cardStatus)} ${title}${" ".repeat(titlePad)}${accountsText}`);

		const showPolarityWord = width >= 32;
		const includePace = width >= 40;

		// Multi-account provider (Magpie `#panelQuota` idiom): render EVERY account separately
		// with its own identity, its own reset credits, and its own un-averaged quota bars!
		if (card.accountSections.length > 1) {
			for (const [acctIdx, section] of card.accountSections.entries()) {
				if (acctIdx > 0) {
					lines.push(`  ${theme.fg("dim", "╌".repeat(Math.max(4, Math.min(24, width - 4))))}`);
				}
				const whoParts = [section.accountLabel, section.planLabel].filter((part): part is string =>
					Boolean(part && part.trim()),
				);
				if (section.daybreak) whoParts.push("daybreak");
				const whoRaw = sanitizeDisplayLine(whoParts.join(" · ") || `Account #${acctIdx + 1}`);
				const whoLine = `${this.#statusIcon(section.status)} ${theme.fg("text", truncateToWidth(whoRaw, Math.max(4, width - 5)))}`;
				lines.push(`  ${whoLine}`);

				if (section.resetCredits) {
					lines.push(...this.#renderResetCreditLines(section.resetCredits, "    ", Math.max(1, width - 4)));
				}
				if (section.unlimited) {
					lines.push(`    ${theme.fg("dim", "no limits")}`);
					continue;
				}
				const sliced = section.windows.slice(0, CARD_MAX_WINDOWS);
				const { layout, labelLines } = this.#computeWindowLayout([sliced], width, 4, showPolarityWord, includePace);
				lines.push(
					...this.#renderWindowBlock(
						section.windows,
						labelLines[0]!,
						layout,
						Math.max(1, width - 4),
						"    ",
						showPolarityWord,
						includePace,
						`${card.provider}:acct${acctIdx}`,
					),
				);
			}
			for (const account of card.unavailableAccounts) {
				const text = sanitizeDisplayLine(`${account} — usage unavailable`);
				for (const line of wrapTextWithAnsi(text, Math.max(1, width - 2))) {
					lines.push(`  ${theme.fg("dim", line)}`);
				}
			}
			return lines;
		}

		// Single-account provider card
		const singleAcct = card.accountSections[0];
		if (singleAcct && width >= 34) {
			const subParts = [singleAcct.accountLabel, singleAcct.planLabel].filter((p): p is string =>
				Boolean(p && p.trim()),
			);
			if (subParts.length > 0) {
				const subClean = sanitizeDisplayLine(subParts.join(" · "));
				lines.push(`  ${theme.fg("dim", truncateToWidth(subClean, Math.max(1, width - 2)))}`);
			}
		}

		for (const account of card.daybreakAccounts ?? []) {
			const label = sanitizeText(account.replace(/[\r\n\t]+/g, " "));
			lines.push(`  ${theme.fg("success", truncateToWidth(`daybreak · ${label}`, width - 2))}`);
		}

		if (card.resetCredits) {
			lines.push(...this.#renderResetCreditLines(card.resetCredits, "  ", Math.max(1, width - 2)));
		}

		for (const account of card.unavailableAccounts) {
			const text = sanitizeDisplayLine(`${account} — usage unavailable`);
			for (const line of wrapTextWithAnsi(text, Math.max(1, width - 2))) {
				lines.push(`  ${theme.fg("dim", line)}`);
			}
		}

		if (card.unlimited) {
			lines.push(`  ${theme.fg("dim", "no limits")}`);
			return lines;
		}

		let layout = sharedSingleLayout;
		let labelLines = sharedSingleLabels;
		if (!layout || !labelLines) {
			const computed = this.#computeWindowLayout(
				[card.windows.slice(0, CARD_MAX_WINDOWS)],
				width,
				2,
				showPolarityWord,
				includePace,
			);
			layout = computed.layout;
			labelLines = computed.labelLines[0]!;
		}

		lines.push(
			...this.#renderWindowBlock(
				card.windows,
				labelLines,
				layout,
				Math.max(1, width - 2),
				"  ",
				showPolarityWord,
				includePace,
				card.provider,
			),
		);
		return lines;
	}

	#renderCardsGrid(innerWidth: number): string[] {
		if (this.#cards.length === 0) return [theme.fg("dim", "No usage data available.")];
		// Show ALL metered cards (including 100%-remaining untouched pools) so nothing is hidden
		// behind an "untouched:" footnote; only truly windowless `unlimited` cards collapse below.
		const metered = this.#cards.filter(card => !card.unlimited);
		const unmetered = this.#cards.filter(card => card.unlimited);
		const columns = Math.max(1, Math.floor((innerWidth + CARD_GUTTER) / (CARD_MIN_WIDTH + CARD_GUTTER)));
		const cardWidth = Math.floor((innerWidth - (columns - 1) * CARD_GUTTER) / columns);
		const showPolarityWord = cardWidth >= 32;
		const includePace = cardWidth >= 40;
		const lines: string[] = [];

		for (let start = 0; start < metered.length; start += columns) {
			const cards = metered.slice(start, start + columns);
			const allSingleAccount = cards.every(card => card.accountSections.length <= 1);
			let rowCards: string[][];
			if (allSingleAccount) {
				const windows = cards.map(card => card.windows.slice(0, CARD_MAX_WINDOWS));
				const { layout, labelLines } = this.#computeWindowLayout(
					windows,
					cardWidth,
					2,
					showPolarityWord,
					includePace,
				);
				rowCards = cards.map((card, index) => this.#renderCardLines(card, cardWidth, labelLines[index]!, layout));
			} else {
				rowCards = cards.map(card => this.#renderCardLines(card, cardWidth));
			}
			const height = Math.max(...rowCards.map(card => card.length));
			for (let lineIdx = 0; lineIdx < height; lineIdx++) {
				const segments = rowCards.map(card => {
					const line = card[lineIdx] ?? "";
					return line + " ".repeat(Math.max(0, cardWidth - visibleWidth(line)));
				});
				lines.push(segments.join(" ".repeat(CARD_GUTTER)).trimEnd());
			}
			if (start + columns < metered.length) lines.push("");
		}
		if (unmetered.length > 0) {
			if (metered.length > 0) lines.push("");
			const names = unmetered.map(card => card.name).join(" · ");
			const prefix = `${theme.fg("success", theme.status.success)} `;
			lines.push(truncateToWidth(`${prefix}${theme.fg("dim", `no limits: ${names}`)}`, innerWidth));
		}
		return lines;
	}

	// ---------------------------------------------------------------------------
	// Heatmap rendering
	// ---------------------------------------------------------------------------

	/** Truecolor ramp from the theme's background side toward its accent: level 1
	 * sits near-invisible, level 4 is the full accent, so cell brightness reads
	 * as amount of work. Anchored to black or white by the text color's luma so
	 * the ramp keeps its direction on light themes. */
	#heatRamp(): string[] {
		const mode = theme.getColorMode();
		const darkBackground = (colorLuma(theme.getColorHex("text")) ?? 1) > 0.5;
		const from = darkBackground ? { r: 20, g: 20, b: 24 } : { r: 244, g: 244, b: 246 };
		const to = hexToRgb(theme.getColorHex("accent"));
		return [0.3, 0.5, 0.72, 1].map(t =>
			colorToAnsi(
				rgbToHex({
					r: Math.round(from.r + (to.r - from.r) * t),
					g: Math.round(from.g + (to.g - from.g) * t),
					b: Math.round(from.b + (to.b - from.b) * t),
				}),
				mode,
			),
		);
	}

	#renderHeatmap(innerWidth: number): string[] {
		const summary: string[] = [];
		if (this.#activityError) {
			const detail = formatActivityErrorDetail(this.#activityError);
			return [theme.fg("dim", detail ? `Usage history unavailable (${detail}).` : "Usage history unavailable.")];
		}
		const points = this.#activity;
		if (!points) return [theme.fg("dim", "Loading usage history…")];

		const labelWidth = 2;
		const weeks = Math.max(4, Math.min(53, Math.floor((innerWidth - labelWidth) / 2)));
		const layout = buildHeatmapLayout(points, weeks);
		const ramp = this.#heatRamp();
		const reset = "\x1b[39m";

		summary.push(
			`${theme.bold(theme.fg("accent", "Activity"))} ${theme.fg("dim", `${formatActivityTotals(layout)} · last ${weeks} weeks`)}${this.#syncing ? theme.fg("dim", " · syncing…") : ""}`,
		);
		summary.push("");

		let monthLine = " ".repeat(labelWidth);
		for (let week = 0; week < weeks; week++) {
			const label = layout.monthLabels[week];
			const targetCol = labelWidth + week * 2;
			if (label && targetCol >= visibleWidth(monthLine)) {
				monthLine = monthLine.padEnd(targetCol) + label;
			}
		}
		summary.push(theme.fg("dim", truncateToWidth(monthLine, innerWidth)));

		for (let day = 0; day < 7; day++) {
			let line = theme.fg("dim", HEATMAP_DAY_LABELS[day]) + " ";
			for (let week = 0; week < weeks; week++) {
				const cell = layout.cells[day][week];
				if (cell === null) line += "  ";
				else if (cell === 0) line += `${theme.fg("dim", "·")} `;
				else line += `${ramp[cell - 1]}■${reset} `;
			}
			summary.push(line.trimEnd());
		}
		return summary;
	}

	// ---------------------------------------------------------------------------
	// Frame
	// ---------------------------------------------------------------------------

	#renderPresetsBar(innerWidth: number): string[] {
		const lines: string[] = [];
		const visiblePresets = this.#presets.slice(0, PRESET_DIGIT_KEYS.length);
		if (visiblePresets.length > 0) {
			const heading = `${theme.bold(theme.fg("accent", "Presets"))}  `;
			const continuationIndent = " ".repeat(visibleWidth(heading));
			const separator = "   ";
			const items = visiblePresets.map((preset, index) => {
				const cleanName = sanitizeDisplayLine(preset.name);
				const keyLabel = `[${index + 1}]`;
				const itemText = preset.active
					? `${theme.fg("accent", keyLabel)} ${theme.fg("success", "●")} ${theme.bold(theme.fg("accent", cleanName))}`
					: `${theme.fg("dim", keyLabel)} ${theme.fg("dim", "○")} ${theme.fg("muted", cleanName)}`;
				return formatActionMarker(itemText, `omp-overlay:preset:${index}`, `preset-${index}`);
			});
			let currentLine = heading;
			let hasItemOnLine = false;
			for (const item of items) {
				const candidate = hasItemOnLine ? `${currentLine}${separator}${item}` : `${currentLine}${item}`;
				if (hasItemOnLine && visibleWidth(candidate) > innerWidth) {
					lines.push(truncateToWidth(currentLine, innerWidth));
					currentLine = `${continuationIndent}${item}`;
				} else {
					currentLine = candidate;
					hasItemOnLine = true;
				}
			}
			if (hasItemOnLine) {
				lines.push(truncateToWidth(currentLine, innerWidth));
			}
		}
		if (innerWidth >= 44) {
			const leftOpt = this.#quotaLeft
				? `${theme.fg("success", "●")} ${theme.bold(theme.fg("success", "剩余 Left"))}`
				: `${theme.fg("dim", "○")} ${theme.fg("muted", "剩余 Left")}`;
			const usedOpt = !this.#quotaLeft
				? `${theme.fg("warning", "●")} ${theme.bold(theme.fg("warning", "已用 Used"))}`
				: `${theme.fg("dim", "○")} ${theme.fg("muted", "已用 Used")}`;
			const togglePill = formatActionMarker(
				`[${leftOpt} ⇄ ${usedOpt}]`,
				"omp-overlay:toggle-polarity",
				"header-toggle-polarity",
			);
			lines.push(
				truncateToWidth(
					`${theme.fg("muted", "额度视角:")} ${togglePill} ${theme.fg("dim", "(点击或按 u 切换 · 多账号独立展示 · 滚轮滑动)")}`,
					innerWidth,
				),
			);
		}
		if (this.#actionBanner) {
			lines.push(truncateToWidth(theme.fg("accent", `↳ ${sanitizeDisplayLine(this.#actionBanner)}`), innerWidth));
		}
		return lines;
	}

	#overviewLines(innerWidth: number): string[] {
		const cached = this.#overviewCache;
		if (cached?.revision === this.#revision && cached.width === innerWidth) return cached.lines;
		const lines: string[] = [];
		const presetLines = this.#renderPresetsBar(innerWidth);
		if (presetLines.length > 0) {
			lines.push(...presetLines, "");
		}
		lines.push(...this.#renderCardsGrid(innerWidth));
		lines.push("");
		lines.push(...this.#renderHeatmap(innerWidth));
		this.#overviewCache = { revision: this.#revision, width: innerWidth, lines };
		return lines;
	}

	#detailLines(innerWidth: number): string[] {
		if (this.#detailCache?.width !== innerWidth) {
			this.#detailCache = {
				width: innerWidth,
				lines: this.#options.renderDetail(innerWidth, this.#reports).split("\n"),
			};
		}
		return this.#detailCache.lines;
	}

	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || 40);
		const innerWidth = Math.max(20, width - 4);

		const hasScrollbar = this.#view === "overview" && innerWidth >= 40;
		// Compute content once; if it overflows, reserve 2 cols on the right for a visual scrollbar.
		let bodyWidth = innerWidth;
		let contentSource = this.#view === "detail" ? this.#detailLines(bodyWidth) : this.#overviewLines(bodyWidth);
		// Fixed chrome: top border, blank, content…, divider, hint, bottom border.
		const contentRows = Math.max(5, height - 5);
		this.#lastViewportRows = contentRows;
		const overflows = hasScrollbar && contentSource.length > contentRows;
		if (overflows) {
			bodyWidth = Math.max(20, innerWidth - 2);
			contentSource = this.#view === "detail" ? this.#detailLines(bodyWidth) : this.#overviewLines(bodyWidth);
		}
		const maxScroll = Math.max(0, contentSource.length - contentRows);
		if (this.#scroll > maxScroll) this.#scroll = maxScroll;

		const latestFetchedAt = Math.max(0, ...this.#reports.map(report => report.fetchedAt ?? 0));
		const checkedText = this.#refreshing
			? "refreshing…"
			: latestFetchedAt
				? `checked ${formatDuration(this.#nowMs - latestFetchedAt)} ago`
				: "";
		const modeLabel = this.#quotaLeft ? "剩余" : "已用";
		const title = this.#view === "detail" ? "Usage · Details" : `Usage · ${modeLabel}`;

		const scrollHint = maxScroll > 0 ? `${editorKeys("tui.select.up", "tui.select.down")}/滚轮 scroll · ` : "";
		const cancel = editorKey("tui.select.cancel");
		const presetMax = Math.min(PRESET_DIGIT_KEYS.length, this.#presets.length);
		const presetHint = presetMax > 0 ? (presetMax === 1 ? "1 preset · " : `1-${presetMax} preset · `) : "";
		const polarityHint =
			this.#view === "overview"
				? `${formatActionMarker(`u ${this.#quotaLeft ? "切已用" : "切剩余"}`, "omp-overlay:toggle-polarity", "footer-polarity")} · `
				: "";
		const hudHint = this.#options.onOpenDesktopHud
			? `${formatActionMarker("p desktop HUD", "omp-overlay:desktop-hud", "footer-desktop-hud")} · `
			: "";
		const refreshHint = this.#options.refresh
			? `${formatActionMarker("r refresh", "omp-overlay:refresh", "footer-refresh")} · `
			: "";
		const hint =
			this.#view === "detail"
				? `${scrollHint}${presetHint}${hudHint}${refreshHint}${formatActionMarker(`${cancel} back`, "omp-overlay:overview", "footer-overview")}`
				: `${scrollHint}${presetHint}${hudHint}${refreshHint}${polarityHint}${formatActionMarker(`${formatKeyHint("enter")} details`, "omp-overlay:detail", "footer-detail")} · ${formatActionMarker(`${cancel} close`, "omp-overlay:close", "footer-close")}`;
		this.#panel.title = title;
		const headerParts: string[] = [];
		if (checkedText) headerParts.push(theme.fg("dim", checkedText));
		if (maxScroll > 0) {
			const startRow = this.#scroll + 1;
			const endRow = Math.min(contentSource.length, this.#scroll + contentRows);
			headerParts.push(theme.fg("dim", `行 ${startRow}–${endRow}/${contentSource.length}`));
		}
		if (this.#actionBanner) headerParts.push(theme.fg("accent", sanitizeDisplayLine(this.#actionBanner)));
		this.#header.setLines([headerParts.length > 0 ? truncateToWidth(headerParts.join("  ·  "), innerWidth) : ""]);

		const visibleSlice = contentSource.slice(this.#scroll, this.#scroll + contentRows);
		if (overflows && contentSource.length > 0) {
			const thumbHeight = Math.max(1, Math.round((contentRows / contentSource.length) * contentRows));
			const maxThumbTop = Math.max(0, contentRows - thumbHeight);
			const thumbTop = maxScroll > 0 ? Math.round((this.#scroll / maxScroll) * maxThumbTop) : 0;
			const withBar = Array.from({ length: contentRows }, (_, idx) => {
				const rowText = visibleSlice[idx] ?? "";
				const padCols = Math.max(0, bodyWidth - visibleWidth(rowText));
				const isThumb = idx >= thumbTop && idx < thumbTop + thumbHeight;
				const barGlyph = isThumb ? theme.fg("accent", "█") : theme.fg("dim", "│");
				return `${rowText}${" ".repeat(padCols)} ${barGlyph}`;
			});
			this.#body.setLines(withBar);
		} else {
			this.#body.setLines(visibleSlice);
		}
		this.#body.setHeight(contentRows);
		this.#footer.setLines([truncateToWidth(theme.fg("dim", hint), innerWidth)]);
		const rendered = this.#panel.render(width);
		this.#lastRenderedLines = rendered;
		return rendered;
	}

	// ---------------------------------------------------------------------------
	// Native description
	// ---------------------------------------------------------------------------

	/**
	 * The sheet body (the terminal's `lg` overlay is the frame): a toolbar
	 * (Overview/Details, freshness, Refresh), then either the overview — a
	 * strip of headline figures, the quota rows per provider, the activity
	 * calendar — or the per-provider detail tables, then Close like the other
	 * report sheets. `meter`/`chart` fall back to `progress`/`table` on
	 * terminals without them. Rebuilt only when its inputs change.
	 */
	describe(cx: DescribeContext): NativeNode {
		const meter = cx.supports("meter");
		const chart = cx.supports("chart");
		const cache = this.#nativeCache;
		if (cache && cache.revision === this.#revision && cache.meter === meter && cache.chart === chart) {
			return cache.node;
		}
		const body = this.#view === "detail" ? this.#describeDetail() : this.#describeOverview(meter, chart);
		// Esc leaves Details for Overview first, so only Overview's Close wears its keycap.
		const close = actionButton("Close", "close", this.#view === "overview" ? { keys: "escape" } : {});
		const root = col(
			[
				this.#describeHead(),
				node("col", { role: "omp.usage.body", gap: "lg" }, body, this.#view),
				actionBar([null, close]),
			],
			{ gap: "lg" },
		);
		this.#nativeCache = { revision: this.#revision, meter, chart, node: root };
		return root;
	}

	/** Tab clicks switch views like Enter/Esc; the Refresh button runs `r`; Close closes from either view. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action") {
			if (event.act === "refresh") void this.#refresh();
			else if (event.act === "desktop-hud") this.#openDesktopHud();
			else if (event.act === "close") this.#close();
			return;
		}
		if (event.type !== "select" && event.type !== "activate") return;
		if (leafKey(event.key) !== "tabs") return;
		if ((event.item === "overview" || event.item === "detail") && event.item !== this.#view) {
			this.#setView(event.item);
		}
	}

	/** The toolbar: the two views as a segmented control, then how fresh the reports are and Refresh. */
	#describeHead(): NativeNode {
		const checked: NativeChild[] = [];
		const latestFetchedAt = Math.max(0, ...this.#reports.map(report => report.fetchedAt ?? 0));
		if (this.#refreshing) {
			checked.push(node("spinner", { style: "dots", label: [span("Refreshing…", "dim")] }));
		} else if (this.#refreshError) {
			checked.push(
				text([span(`Refresh failed: ${sanitizeDisplayLine(this.#refreshError)}`, "warning")], {
					truncate: "end",
					title: sanitizeDisplayLine(this.#refreshError),
				}),
			);
		} else if (latestFetchedAt) {
			checked.push(
				text([span("Updated", "dim")]),
				elapsed(Date.now() - latestFetchedAt),
				text([span("ago", "dim")]),
			);
		}
		if (!this.#refreshing && !this.#refreshError && this.#actionBanner) {
			if (checked.length > 0) checked.push(text([span("·", "dim")]));
			checked.push(
				text([span(sanitizeDisplayLine(this.#actionBanner), "accent")], {
					truncate: "end",
					title: sanitizeDisplayLine(this.#actionBanner),
				}),
			);
		}
		const children: NativeChild[] = [
			node(
				"tabs",
				{
					items: [
						{ id: "overview", label: "Overview" },
						{ id: "detail", label: "Details" },
					],
					active: this.#view,
				},
				undefined,
				"tabs",
			),
			node("spacer", { grow: 1 }),
			node("row", { gap: "xs", align: "baseline", shrink: 1 }, checked, "checked"),
		];
		if (this.#options.onOpenDesktopHud) children.push(actionButton("Desktop HUD", "desktop-hud", { keys: "p" }));
		if (this.#options.refresh) children.push(actionButton("Refresh", "refresh", { keys: "r" }));
		return node("row", { role: "omp.usage.head", gap: "md", align: "center" }, children, "head");
	}

	/**
	 * The overview: headline figures, then a row per provider with something
	 * to show (the rest named in footnote rows), then the activity calendar.
	 * With nothing used anywhere it is one empty state instead.
	 */
	#describeOverview(meter: boolean, chart: boolean): NativeChild[] {
		// Only providers with something to show get a row: the rest are named
		// in footnotes, whether untouched, unreadable or quota-less.
		const framed: ProviderCard[] = [];
		const untouched: ProviderCard[] = [];
		const unreported: ProviderCard[] = [];
		const unmetered: ProviderCard[] = [];
		for (const entry of this.#cards) {
			const shown =
				entry.windows.length > 0 || entry.resetCredits !== undefined || entry.daybreakAccounts !== undefined;
			if (!shown) (entry.unavailableAccounts.length > 0 ? unreported : unmetered).push(entry);
			else if (entry.idle) untouched.push(entry);
			else framed.push(entry);
		}
		const notes: NativeNode[] = [];
		if (untouched.length > 0) notes.push(footnote("idle", "Untouched", untouched));
		if (unreported.length > 0) {
			const accounts = unreported.flatMap(entry =>
				entry.unavailableAccounts.map(account => `${entry.name} (${account})`),
			);
			notes.push(
				footnote(
					"unreported",
					"No usage data",
					unreported,
					`No usage report came back for ${accounts.join(", ")}: the sign-in expired, the request failed, or the plan has no quotas`,
				),
			);
		}
		if (unmetered.length > 0) {
			const why = unmetered.flatMap(entry => entry.notes.map(note => `${entry.name}: ${note}`));
			notes.push(
				footnote(
					"unmetered",
					"No quotas reported",
					unmetered,
					why.length > 0 ? why.join(" • ") : "These providers report no quota windows to track",
				),
			);
		}

		const points = this.#activity;
		const layout = points ? buildHeatmapLayout(points, NATIVE_HEATMAP_WEEKS) : undefined;
		const figures = points && layout ? activityFigures(points, layout) : undefined;
		const quiet = layout !== undefined && layout.totalCost <= 0 && layout.totalRequests <= 0;
		if (framed.length === 0 && quiet && !this.#activityError) {
			const children: NativeChild[] = [
				node("icon", { name: "gauge" }, undefined, "icon"),
				text([span("No usage yet")], { role: "omp.usage.empty.title" }),
				text(
					[
						span(
							"Quotas show here once a signed-in provider reports usage, and the calendar fills in as you work.",
							"muted",
						),
					],
					{ role: "omp.usage.empty.body", wrap: "word" },
				),
			];
			if (notes.length > 0) children.push(node("col", { gap: "xs" }, notes, "footnotes"));
			return [node("col", { role: "omp.usage.empty", gap: "sm", align: "center" }, children, "empty")];
		}

		const quotas: NativeChild[] = [sectionHead("Quotas", this.#quotaMeta(framed))];
		for (const entry of framed) quotas.push(this.#describeProvider(entry, meter));
		if (this.#cards.length === 0) {
			quotas.push(text([span("No usage data available.", "muted")], { role: "omp.usage.none", wrap: "word" }));
		} else if (framed.length === 0) {
			quotas.push(text([span("Nothing used on any quota yet.", "muted")], { role: "omp.usage.none", wrap: "word" }));
		}
		quotas.push(...notes);
		return [
			this.#describeStats(framed, layout, figures, chart),
			node("col", { role: "omp.usage.quotas" }, quotas, "quotas"),
			this.#describeActivity(chart, layout, figures),
		];
	}

	/** `3 providers · 10 accounts` over the quota rows. */
	#quotaMeta(framed: readonly ProviderCard[]): NativeChild[] {
		if (framed.length === 0) return [];
		const accounts = framed.reduce((sum, entry) => sum + entry.accounts, 0);
		const parts = [`${framed.length} provider${framed.length === 1 ? "" : "s"}`];
		if (accounts > framed.length) parts.push(`${accounts} accounts`);
		return [
			text([span(parts.join(" · "), "dim")], {
				role: "omp.usage.section.meta",
				title: "Each quota shows the mean across a provider's accounts; it resets with the fullest one",
			}),
		];
	}

	/**
	 * The summary strip: the tightest quota (what stops work first), the
	 * year's spend, the last 30 days with a spend spark, and the busiest day.
	 */
	#describeStats(
		framed: readonly ProviderCard[],
		layout: HeatmapLayout | undefined,
		figures: ActivityFigures | undefined,
		chart: boolean,
	): NativeNode {
		const tiles: NativeNode[] = [];
		let tightest: { entry: ProviderCard; window: CardWindowRow; fraction: number } | undefined;
		for (const entry of framed) {
			for (const window of entry.windows) {
				if (window.fraction === undefined) continue;
				if (!tightest || window.fraction > tightest.fraction)
					tightest = { entry, window, fraction: window.fraction };
			}
		}
		if (tightest) {
			const where = `${sanitizeDisplayLine(tightest.window.label)} · ${tightest.entry.name}`;
			const reset =
				tightest.window.resetMs !== undefined ? resetLabel(this.#nowMs, tightest.window.resetMs) : undefined;
			tiles.push(
				statTile(
					"quota",
					"Tightest quota",
					leftSpans(tightest.fraction, tightest.window.status),
					[span(where, "dim")],
					{
						title: reset ? `${where} · ${reset.title}` : where,
					},
				),
			);
		} else {
			tiles.push(
				statTile(
					"quota",
					"Tightest quota",
					[span("—", "dim")],
					[span(this.#cards.length > 0 ? "Every quota untouched" : "No quotas reported", "dim")],
				),
			);
		}

		if (!figures || !layout) {
			const sub = [span(this.#activityError ? "History unavailable" : "Loading…", "dim")];
			tiles.push(
				statTile("year", "Past year", [span("—", "dim")], sub),
				statTile("month", "Last 30 days", [span("—", "dim")], sub),
				statTile("busiest", "Busiest day", [span("—", "dim")], sub),
			);
			return node("row", { role: "omp.usage.stats", wrap: true }, tiles, "stats");
		}

		const amount = (cost: number, requests: number): TspSpan[] =>
			figures.priced ? [span(formatCost(cost))] : [span(COMPACT_COUNT.format(requests))];
		const counted = (requests: number): string =>
			figures.priced ? requestsText(requests) : `request${requests === 1 ? "" : "s"}`;
		tiles.push(
			statTile("year", "Past year", amount(layout.totalCost, layout.totalRequests), [
				span(counted(layout.totalRequests), "dim"),
			]),
		);

		const spark =
			chart && (figures.monthCost > 0 || figures.monthRequests > 0)
				? node(
						"chart",
						{
							kind: "spark",
							token: "accent",
							series: figures.month.map(day => ({
								value: figures.priced ? day.cost : day.requests,
								title: `${shortDate(day.date)} · ${formatCost(day.cost)} · ${requestsText(day.requests)}`,
							})),
						},
						undefined,
						"spark",
					)
				: undefined;
		tiles.push(
			statTile(
				"month",
				"Last 30 days",
				amount(figures.monthCost, figures.monthRequests),
				[span(counted(figures.monthRequests), "dim")],
				spark ? { chart: spark } : {},
			),
		);

		const busiest = figures.busiest;
		tiles.push(
			busiest
				? statTile("busiest", "Busiest day", amount(busiest.cost, busiest.requests), [
						span(
							figures.priced
								? `${shortDate(busiest.date)} · ${requestsText(busiest.requests)}`
								: `requests · ${shortDate(busiest.date)}`,
							"dim",
						),
					])
				: statTile("busiest", "Busiest day", [span("—", "dim")], [span("No activity yet", "dim")]),
		);
		return node("row", { role: "omp.usage.stats", wrap: true }, tiles, "stats");
	}

	/**
	 * One provider: its name, status and accounts in the left column, one row
	 * per quota window on the right (label · meter · left · reset), aligned
	 * with every other provider's.
	 */
	#describeProvider(entry: ProviderCard, meter: boolean): NativeNode {
		const cardStatus =
			entry.unavailableAccounts.length > 0
				? statusWithUnavailableAccounts(entry.windows)
				: entry.unlimited
					? "ok"
					: aggregateStatus(entry.windows);
		const who: NativeChild[] = [
			node(
				"row",
				{ gap: "sm", align: "center" },
				[
					statusDot(cardStatus),
					text([span(entry.name)], { role: "omp.usage.provider.name", truncate: "end", title: entry.name }),
				],
				"name",
			),
		];
		if (entry.accounts > 1) {
			who.push(text([span(`${entry.accounts} accounts`, "dim")], { role: "omp.usage.provider.meta" }));
		}
		if (entry.resetCredits) {
			const resets = entry.resetCredits;
			const details: string[] = [];
			if (resets.redeemableCount !== resets.bankedCount) details.push(`${resets.redeemableCount} usable now`);
			if (resets.soonestExpiryMs !== undefined) {
				details.push(
					resets.soonestExpiryMs > 0 ? `expires in ${formatDuration(resets.soonestExpiryMs)}` : "expired",
				);
			}
			if (resets.redeemableCount === 0 && resets.unavailableReasons.length > 0) {
				details.push(`unavailable: ${sanitizeDisplayLine(resets.unavailableReasons.join(" • "))}`);
			}
			const label = `${resets.bankedCount} reset${resets.bankedCount === 1 ? "" : "s"} banked`;
			who.push(
				text([span(label, resets.redeemableCount > 0 ? "success" : "warning")], {
					role: "omp.usage.provider.meta",
					title: details.length > 0 ? `${label} · ${details.join(" · ")}` : label,
				}),
			);
		}
		for (const account of entry.daybreakAccounts ?? []) {
			const name = sanitizeDisplayLine(account);
			who.push(
				text([span(`Daybreak · ${name}`, "success")], {
					role: "omp.usage.provider.meta",
					truncate: "middle",
					title: `Daybreak access · ${name}`,
				}),
			);
		}
		for (const account of entry.unavailableAccounts) {
			const name = sanitizeDisplayLine(account);
			who.push(
				text([span(`${name}: no usage data`, "warning")], {
					role: "omp.usage.provider.meta",
					truncate: "middle",
					title: `${name}: no usage data`,
				}),
			);
		}

		const rows: NativeChild[] = [];
		if (entry.unlimited) {
			rows.push(text([span("No quotas reported", "muted")], { role: "omp.usage.none" }));
		} else {
			for (const [index, window] of entry.windows.slice(0, CARD_MAX_WINDOWS).entries()) {
				const label: TspSpan[] = [span(sanitizeDisplayLine(window.label))];
				if (window.windowTag) label.push(span(` ${sanitizeDisplayLine(window.windowTag)}`, "dim"));
				const cells: NativeChild[] = [
					text(label, { role: "omp.usage.label", truncate: "end", title: sanitizeDisplayLine(window.label) }),
				];
				if (window.fraction === undefined) {
					cells.push(
						text([span(window.usedText ?? "No data", "muted")], { role: "omp.usage.amount", truncate: "end" }),
					);
				} else {
					cells.push(
						usageMeter(window.fraction, window.status, meter),
						text(leftSpans(window.fraction, window.status), { role: "omp.usage.pct" }),
					);
					if (window.resetMs !== undefined) {
						const reset = resetLabel(this.#nowMs, window.resetMs);
						cells.push(text([span(reset.text, "dim")], { role: "omp.usage.reset", title: reset.title }));
					}
				}
				rows.push(node("row", { role: "omp.usage.window", gap: "md", align: "center" }, cells, `w${index}`));
			}
			const hidden = entry.windows.length - CARD_MAX_WINDOWS;
			if (hidden > 0) {
				rows.push(
					text([span(`${hidden} more in Details`, "dim")], {
						role: "omp.usage.more",
						title: "Details lists every quota per account  ⏎",
					}),
				);
			}
		}
		return node(
			"row",
			{ role: "omp.usage.provider", gap: "lg", align: "start" },
			[
				node("col", { role: "omp.usage.provider.head", gap: "xs" }, who, "who"),
				node("col", { role: "omp.usage.windows", grow: 1 }, rows, "windows"),
			],
			entry.provider,
		);
	}

	/**
	 * The activity calendar: a year of daily spend as a heatmap (per-day
	 * tooltips), then active days and the longest streak beside a Less–More
	 * legend; loading, failure and a quiet year each say so in its place.
	 */
	#describeActivity(
		chart: boolean,
		layout: HeatmapLayout | undefined,
		figures: ActivityFigures | undefined,
	): NativeNode {
		const meta: NativeChild[] = [];
		if (this.#syncing && this.#activity) {
			meta.push(node("spinner", { style: "dots", label: [span("Syncing", "dim")] }));
		} else if (layout) {
			const today = new Date();
			const range = `${layout.start.getDate()} ${MONTH_NAMES[layout.start.getMonth()]} ${layout.start.getFullYear()} – ${today.getDate()} ${MONTH_NAMES[today.getMonth()]} ${today.getFullYear()}`;
			meta.push(text([span(range, "dim")], { role: "omp.usage.section.meta" }));
		}
		const children: NativeChild[] = [sectionHead("Activity", meta)];
		const points = this.#activity;
		if (this.#activityError) {
			const detail = formatActivityErrorDetail(this.#activityError);
			children.push(
				text([span(detail ? `Usage history unavailable (${detail}).` : "Usage history unavailable.", "muted")], {
					role: "omp.usage.none",
					wrap: "word",
				}),
			);
		} else if (!points || !layout || !figures) {
			children.push(
				node("spinner", { style: "dots", label: [span("Loading usage history…", "muted")] }, undefined, "loading"),
			);
		} else {
			const summary =
				layout.totalRequests > 0 || layout.totalCost > 0
					? `${formatActivityTotals(layout)} · last ${NATIVE_HEATMAP_WEEKS} weeks`
					: `No activity in the last ${NATIVE_HEATMAP_WEEKS} weeks`;
			children.push(chart ? this.#heatmapChart(layout, points, summary) : this.#heatmapTable(layout, summary));
			const foot: NativeChild[] = [
				text(
					[
						span(
							figures.activeDays > 0
								? `${figures.activeDays} active day${figures.activeDays === 1 ? "" : "s"} · longest streak ${figures.longestStreak} day${figures.longestStreak === 1 ? "" : "s"}`
								: `No activity in the last ${NATIVE_HEATMAP_WEEKS} weeks`,
							"dim",
						),
					],
					{ truncate: "end" },
				),
			];
			if (chart) {
				foot.push(
					node("spacer", { grow: 1 }),
					node(
						"row",
						{ role: "omp.usage.legend", gap: "sm", align: "center" },
						[
							text([span("Less", "dim")]),
							node(
								"chart",
								{ kind: "heatmap", cells: [[0, 0.25, 0.5, 0.75, 1]], token: "accent", size: "md" },
								undefined,
								"scale",
							),
							text([span("More", "dim")]),
						],
						"legend",
					),
				);
			}
			children.push(node("row", { role: "omp.usage.activity.foot", gap: "md", align: "center" }, foot, "foot"));
		}
		return node("col", { role: "omp.usage.activity" }, children, "activity");
	}

	/** The heatmap as a `chart`: 0–1 intensities, month columns, M/W/F rows, per-day tooltips. */
	#heatmapChart(layout: HeatmapLayout, points: readonly DailyActivityPoint[], summary: string): NativeNode {
		const byDay = new Map(points.map(point => [point.day, point]));
		const cells = layout.cells.map(days => days.map(level => (level === null ? null : level / 4)));
		const tips = layout.cells.map((days, day) =>
			days.map((level, week) => {
				if (level === null) return null;
				const date = addDays(layout.start, week * 7 + day);
				const point = byDay.get(localIso(date));
				if (!point || (point.cost <= 0 && point.requests <= 0)) return `${shortDate(date)} · No activity`;
				const requests = `${point.requests} request${point.requests === 1 ? "" : "s"}`;
				const cost = point.cost >= 100 ? `$${Math.round(point.cost)}` : `$${point.cost.toFixed(2)}`;
				return `${shortDate(date)} · ${cost} · ${requests}`;
			}),
		);
		// A month label needs room: drop one whose successor starts within two columns (GitHub's rule).
		const starts = layout.monthLabels.flatMap((label, at) => (label ? [{ at, label }] : []));
		const cols = starts.filter((entry, index) => {
			const next = starts[index + 1];
			return !next || next.at - entry.at > 2;
		});
		return node(
			"chart",
			{ kind: "heatmap", cells, cols, rows: HEATMAP_ROW_LABELS, tips, token: "accent", summary, size: "md" },
			undefined,
			"heatmap",
		);
	}

	/** The heatmap as a `table` of glyph cells, for terminals without `chart`. */
	#heatmapTable(layout: HeatmapLayout, summary: string): NativeNode {
		const cols: TspTableColumn[] = [{ id: "day", priority: NATIVE_HEATMAP_WEEKS }];
		for (let week = 0; week < NATIVE_HEATMAP_WEEKS; week++) {
			cols.push({ id: `w${week}`, align: "center", priority: week });
		}
		const rows = HEATMAP_DAY_LABELS.map((label, day) => {
			const cells: Record<string, TspText> = { day: [span(label, "dim")] };
			for (let week = 0; week < NATIVE_HEATMAP_WEEKS; week++) {
				const level = layout.cells[day][week];
				if (level === null) continue;
				cells[`w${week}`] = level === 0 ? [span("·", "dim")] : [span("■", HEAT_LEVEL_TOKENS[level - 1])];
			}
			return { id: `d${day}`, cells };
		});
		return node(
			"col",
			{ gap: "sm" },
			[mutedText(summary), node("table", { cols, rows }, undefined, "table")],
			"heatmap",
		);
	}

	/**
	 * Per provider: a head like the overview's provider column, notes and
	 * saved resets as a `kv`, the limit buckets as a `table` (one row per
	 * account).
	 */
	#describeDetail(): NativeChild[] {
		const nowMs = this.#nowMs;
		const grouped = new Map<string, UsageReport[]>();
		for (const report of collapseSharedUsageReports(this.#reports)) {
			const list = grouped.get(report.provider) ?? [];
			list.push(report);
			grouped.set(report.provider, list);
		}
		const unavailable = this.#options.unavailableAccounts ?? [];
		const sections: NativeChild[] = [];
		for (const entry of this.#cards) {
			const reports = grouped.get(entry.provider) ?? [];
			const cardStatus =
				entry.unavailableAccounts.length > 0
					? statusWithUnavailableAccounts(entry.windows)
					: entry.unlimited
						? "ok"
						: aggregateStatus(entry.windows);
			const head: NativeChild[] = [
				statusDot(cardStatus),
				text([span(entry.name)], { role: "omp.usage.provider.name", truncate: "end" }),
			];
			if (entry.accounts > 1) {
				head.push(text([span(`${entry.accounts} accounts`, "dim")], { role: "omp.usage.provider.meta" }));
			}
			const children: NativeChild[] = [
				node("row", { role: "omp.usage.report.head", gap: "sm", align: "baseline" }, head, "head"),
			];
			for (const account of unavailable) {
				if (account.provider !== entry.provider) continue;
				children.push(mutedText(`${sanitizeDisplayLine(account.label)}: no usage data`, true));
			}

			const facts: { k: TspText; v: TspText }[] = [];
			const notes = [...new Set(reports.flatMap(report => report.notes ?? []))];
			if (notes.length > 0) facts.push({ k: [span("Notes", "muted")], v: sanitizeDisplayLine(notes.join(" • ")) });
			for (const [index, report] of reports.entries()) {
				const resets = summarizeUsageResetCredits(report.resetCredits, nowMs);
				if (!resets || resets.bankedCount <= 0) continue;
				const value: TspSpan[] = [
					span(
						`${resets.bankedCount} saved reset${resets.bankedCount === 1 ? "" : "s"}`,
						resets.redeemableCount > 0 ? "success" : "warning",
					),
				];
				if (resets.redeemableCount !== resets.bankedCount) {
					value.push(span(` · ${resets.redeemableCount} usable now`, "muted"));
				}
				if (resets.soonestExpiry) {
					const remaining = Date.parse(resets.soonestExpiry) - nowMs;
					const date = resets.soonestExpiry.slice(0, 10);
					value.push(
						span(
							remaining > 0 ? ` · expires in ${formatDuration(remaining)} (${date})` : ` · expired (${date})`,
							"muted",
						),
					);
				}
				if (resets.redeemableCount === 0 && resets.unavailableReason) {
					value.push(span(` · unavailable: ${sanitizeDisplayLine(resets.unavailableReason)}`, "muted"));
				}
				facts.push({
					k: [span(`Resets · ${reportAccountLabel(report, report.limits[0], index)}`, "muted")],
					v: value,
				});
			}
			if (facts.length > 0) {
				children.push(node("kv", { items: facts, layout: "grid", role: "omp.usage.facts" }, undefined, "facts"));
			}

			const buckets = new Map<string, { label: string; window?: string; rows: Record<string, TspText>[] }>();
			const limitNotes: string[] = [];
			for (const [index, report] of reports.entries()) {
				for (const limit of report.limits) {
					const label = sanitizeDisplayLine(formatLimitTitle(limit));
					// Same hybrid key as the cards: distinct buckets that share a
					// label and window (Gemini vs Gemini (Argon) weekly) stay separate.
					const key =
						limit.scope.sharedGroup ??
						`${label}|${limit.window?.id ?? limit.scope.windowId ?? "default"}|${limit.id}`;
					let bucket = buckets.get(key);
					if (!bucket) {
						bucket = { label, window: detailWindowLabel(label, limit), rows: [] };
						buckets.set(key, bucket);
					}
					const fraction = resolveUsedFraction(limit);
					const resetsAt = limit.window?.resetsAt;
					bucket.rows.push({
						account: [span(reportAccountLabel(report, limit, index), "muted")],
						left:
							fraction === undefined
								? [span(formatAbsoluteOnlyAmount([limit]) ?? "No data", "muted")]
								: leftSpans(fraction, limit.status),
						reset:
							resetsAt !== undefined && resetsAt > nowMs
								? [
										span(
											`${limit.window?.resetLabel ?? "resets"} in ${formatDuration(resetsAt - nowMs)}`,
											"dim",
										),
									]
								: "",
					});
					for (const note of limit.notes ?? []) limitNotes.push(sanitizeDisplayLine(note));
				}
			}
			if (buckets.size > 0) {
				const rows: { id: string; cells: Record<string, TspText> }[] = [];
				for (const bucket of buckets.values()) {
					for (const [index, cells] of bucket.rows.entries()) {
						const limitCell: TspSpan[] =
							index === 0
								? [span(bucket.label), ...(bucket.window ? [span(` ${bucket.window}`, "dim")] : [])]
								: [];
						rows.push({ id: `r${rows.length}`, cells: { limit: limitCell, ...cells } });
					}
				}
				const cols: TspTableColumn[] = [
					{ id: "limit", head: "Limit", grow: 1, priority: 4 },
					{ id: "account", head: "Account", truncate: "middle", priority: 1 },
					{ id: "left", head: "Left", align: "end", priority: 3 },
					{ id: "reset", head: "Resets", align: "end", priority: 2 },
				];
				children.push(node("table", { cols, rows, role: "omp.usage.limits" }, undefined, "limits"));
				for (const note of new Set(limitNotes)) children.push(mutedText(note, true));
			} else if (unavailable.every(account => account.provider !== entry.provider)) {
				children.push(mutedText("No quotas reported"));
			}
			sections.push(node("col", { role: "omp.usage.report", gap: "sm" }, children, entry.provider));
		}
		if (sections.length === 0) {
			sections.push(text([span("No usage data available.", "muted")], { role: "omp.usage.none" }));
		}
		return sections;
	}

	/** Re-fetch the reports (`r` / Refresh); the last reports stay on failure, with the error in the head. */
	async #refresh(): Promise<void> {
		const refresh = this.#options.refresh;
		if (!refresh || this.#refreshing || this.#closed) return;
		this.#refreshing = true;
		this.#refreshError = null;
		this.#changed();
		try {
			const reports = await refresh();
			if (this.#closed) return;
			if (reports) {
				this.#reports = reports;
				this.#nowMs = Date.now();
				this.#cards = buildProviderCards(reports, this.#nowMs, this.#unavailableAccounts);
				this.#detailCache = null;
			}
		} catch (error) {
			this.#refreshError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#refreshing = false;
			if (!this.#closed) this.#changed();
		}
	}

	/** Invalidate the native description and repaint. */
	#changed(): void {
		this.#revision++;
		this.#options.requestRender();
	}

	#scrollBy(delta: number): void {
		this.#scroll = Math.max(0, this.#scroll + delta);
		this.#options.requestRender();
	}

	#setView(view: "overview" | "detail"): void {
		this.#view = view;
		this.#scroll = 0;
		this.#changed();
	}

	async #switchPresetByIndex(index: number): Promise<void> {
		const onSwitch = this.#options.onSwitchPreset;
		const preset = this.#presets[index];
		if (!onSwitch || !preset || this.#refreshing || this.#switchingPreset || this.#closed) return;
		this.#switchingPreset = true;
		this.#actionBanner = `Switching to preset "${preset.name}"…`;
		this.#changed();
		try {
			const res = await onSwitch(preset.name);
			if (this.#closed) return;
			if (res.ok) {
				const activeTarget = res.activeName ?? preset.name;
				this.#presets = this.#presets.map(entry => ({
					name: entry.name,
					active: entry.name === activeTarget,
				}));
			} else if (res.activeName !== undefined) {
				this.#presets = this.#presets.map(entry => ({
					name: entry.name,
					active: entry.name === res.activeName,
				}));
			}
			this.#actionBanner = res.message;
		} catch (error) {
			this.#actionBanner = `Preset switch failed: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			this.#switchingPreset = false;
			if (!this.#closed) this.#changed();
		}
	}

	#openDesktopHud(): void {
		const onOpen = this.#options.onOpenDesktopHud;
		if (!onOpen || this.#closed) return;
		try {
			const result = onOpen();
			if (typeof result === "string") {
				this.#actionBanner = result;
				this.#changed();
				return;
			}
			void result.then(
				message => {
					if (this.#closed) return;
					this.#actionBanner = message;
					this.#changed();
				},
				(error: unknown) => {
					if (this.#closed) return;
					this.#actionBanner = `Desktop HUD failed: ${error instanceof Error ? error.message : String(error)}`;
					this.#changed();
				},
			);
		} catch (error) {
			this.#actionBanner = `Desktop HUD failed: ${error instanceof Error ? error.message : String(error)}`;
			this.#changed();
		}
	}

	handleInput(data: string): void {
		if (
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					this.#scrollBy(event.wheel * 4);
					return true;
				}
				if (event.leftClick) {
					const act = actionMarkerAt(this.#lastRenderedLines[event.row] ?? "", event.col);
					if (!act) return false;
					if (act.startsWith("omp-overlay:preset:")) {
						const idx = Number(act.slice("omp-overlay:preset:".length));
						if (Number.isInteger(idx) && idx >= 0 && !this.#refreshing) {
							void this.#switchPresetByIndex(idx);
						}
						return true;
					}
					switch (act) {
						case "omp-overlay:refresh":
							void this.#refresh();
							return true;
						case "omp-overlay:toggle-polarity":
							this.#togglePolarity();
							return true;
						case "omp-overlay:desktop-hud":
							this.#openDesktopHud();
							return true;
						case "omp-overlay:detail":
							this.#setView("detail");
							return true;
						case "omp-overlay:overview":
							this.#setView("overview");
							return true;
						case "omp-overlay:close":
							this.#close();
							return true;
						default:
							return false;
					}
				}
				return false;
			})
		) {
			return;
		}
		if (matchesSelectCancel(data) || matchesKey(data, "q")) {
			if (this.#view === "detail") {
				this.#setView("overview");
				return;
			}
			this.#close();
			return;
		}
		if (matchesKey(data, "r")) {
			void this.#refresh();
			return;
		}
		if (this.#view === "overview" && (matchesKey(data, "u") || matchesKey(data, "shift+u") || data === "U")) {
			this.#togglePolarity();
			return;
		}
		if (matchesKey(data, "alt+q")) {
			this.#close();
			return;
		}
		if (this.#options.onOpenDesktopHud && (matchesKey(data, "p") || matchesKey(data, "shift+p") || data === "P")) {
			this.#openDesktopHud();
			return;
		}
		for (let idx = 0; idx < PRESET_DIGIT_KEYS.length && idx < this.#presets.length; idx++) {
			if (matchesKey(data, PRESET_DIGIT_KEYS[idx]!)) {
				if (!this.#refreshing) {
					void this.#switchPresetByIndex(idx);
				}
				return;
			}
		}
		if (
			this.#view === "overview" &&
			(matchesKey(data, "return") || matchesKey(data, "tab") || matchesKey(data, "d"))
		) {
			this.#setView("detail");
			return;
		}
		if (matchesSelectUp(data)) this.#scrollBy(-1);
		else if (matchesSelectDown(data)) this.#scrollBy(1);
		else if (matchesSelectPageUp(data)) this.#scrollBy(-this.#lastViewportRows);
		else if (matchesSelectPageDown(data)) this.#scrollBy(this.#lastViewportRows);
		else if (matchesKey(data, "home")) {
			this.#scroll = 0;
			this.#options.requestRender();
		} else if (matchesKey(data, "end")) this.#scrollBy(Number.MAX_SAFE_INTEGER);
	}
	#togglePolarity(): void {
		this.#quotaLeft = !this.#quotaLeft;
		this.#overviewCache = null;
		this.#changed();
	}

	#close(): void {
		this.dispose();
		this.#options.onClose();
	}
}
