import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";

export type DesktopQuotaHudMode = "open" | "toggle" | "mini" | "full" | "refresh" | "close";

const DESKTOP_HUD_STATUS_MESSAGES: Record<DesktopQuotaHudMode, string> = {
	open: "Launched Desktop Quota HUD",
	toggle: "Toggled Desktop Quota HUD",
	mini: "Launched Desktop Quota HUD (Mini Capsule Strip)",
	full: "Launched Desktop Quota HUD (Full Multi-Pool Cards)",
	refresh: "Signaled Desktop Quota HUD refresh",
	close: "Closed Desktop Quota HUD",
};

function isUsageReportEntry(entry: unknown): entry is UsageReport {
	return isRecord(entry) && typeof entry.provider === "string" && Array.isArray(entry.limits);
}

/**
 * Resolve `~/.omp/cache/finops-live-usage.json` (or `OMP_FINOPS_USAGE_CACHE_PATH`
 * when overridden in isolated tests).
 */
export function getFinopsUsageCachePath(): string {
	const override = process.env.OMP_FINOPS_USAGE_CACHE_PATH?.trim();
	if (override) {
		return override;
	}
	return path.join(os.homedir(), ".omp", "cache", "finops-live-usage.json");
}

/**
 * Guard default home-cache reads/writes during `bun test` so synthetic unit-test
 * reports do not clobber the user's real `~/.omp/cache/finops-live-usage.json`
 * unless `OMP_FINOPS_USAGE_CACHE_PATH` points to a test fixture.
 */
export function canUseDefaultFinopsUsageCache(): boolean {
	if (process.env.OMP_FINOPS_USAGE_CACHE_PATH?.trim()) {
		return true;
	}
	return process.env.NODE_ENV !== "test";
}

/**
 * Safely read and validate cached `UsageReport[]` from `finops-live-usage.json`.
 * Returns `[]` on missing or corrupt files.
 */
export function readCachedFinopsUsageReports(cachePath = getFinopsUsageCachePath()): UsageReport[] {
	let raw: string;
	try {
		raw = fs.readFileSync(cachePath, "utf8");
	} catch {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.reports)) {
		return [];
	}
	const reports: UsageReport[] = [];
	for (const entry of parsed.reports) {
		if (isUsageReportEntry(entry)) {
			reports.push(entry);
		}
	}
	return reports;
}

/**
 * Atomically update `generatedAt` and `reports` in `finops-live-usage.json`,
 * preserving any other top-level keys (such as `capacity` or FinOps summaries).
 */
export function writeCachedFinopsUsageReports(
	reports: readonly UsageReport[],
	cachePath = getFinopsUsageCachePath(),
): void {
	let existing: Record<string, unknown> = {};
	try {
		const raw = fs.readFileSync(cachePath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (isRecord(parsed)) {
			existing = parsed;
		}
	} catch {
		// Start from a clean top-level object when missing or unreadable.
	}

	const payload: Record<string, unknown> = {
		...existing,
		generatedAt: Date.now(),
		reports: [...reports],
	};
	const serialized = `${JSON.stringify(payload, null, 2)}\n`;
	const dir = path.dirname(cachePath);
	fs.mkdirSync(dir, { recursive: true });
	const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tmpPath, serialized, "utf8");
	try {
		fs.renameSync(tmpPath, cachePath);
	} catch {
		try {
			fs.writeFileSync(cachePath, serialized, "utf8");
		} finally {
			try {
				fs.unlinkSync(tmpPath);
			} catch {
				// Best-effort temp cleanup on Windows rename contention.
			}
		}
	}
}

/**
 * Forward cached or freshly fetched `UsageReport[]` into `StatusLineComponent`
 * when multi-pool capsule seeding is present.
 */
export function seedStatusLineQuotaPools(statusLine: object | null | undefined, reports: readonly UsageReport[]): void {
	if (
		statusLine &&
		"setQuotaPoolsFromReports" in statusLine &&
		typeof statusLine.setQuotaPoolsFromReports === "function"
	) {
		statusLine.setQuotaPoolsFromReports(reports);
	}
}

/** Resolve `scripts/omp-quota-hud.py` across source and bundled layouts. */
export function resolveDesktopQuotaHudScriptPath(): string | undefined {
	const envScript = process.env.OMP_QUOTA_HUD_SCRIPT?.trim();
	const candidates = [
		...(envScript ? [envScript] : []),
		path.resolve(import.meta.dir, "../../../../scripts/omp-quota-hud.py"),
		path.resolve(import.meta.dir, "../../../scripts/omp-quota-hud.py"),
		path.resolve(import.meta.dir, "../../scripts/omp-quota-hud.py"),
	];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function resolvePythonLauncher(): string {
	if (process.platform === "win32") {
		if (fs.existsSync("C:\\Python312\\pythonw.exe")) {
			return "C:\\Python312\\pythonw.exe";
		}
		if (fs.existsSync("C:\\Python312\\python.exe")) {
			return "C:\\Python312\\python.exe";
		}
		return "pythonw";
	}
	return "python3";
}

/**
 * Spawn the standalone always-on-top Desktop Quota HUD detached in the requested mode.
 */
export function launchDesktopQuotaHud(mode: DesktopQuotaHudMode = "open"): { ok: boolean; message: string } {
	const scriptPath = resolveDesktopQuotaHudScriptPath();
	if (!scriptPath) {
		const expected = path.resolve(import.meta.dir, "../../../../scripts/omp-quota-hud.py");
		return {
			ok: false,
			message: `Desktop Quota HUD script not found (${expected})`,
		};
	}
	if (process.env.OMP_QUOTA_HUD_DRY_RUN === "1") {
		return {
			ok: true,
			message: DESKTOP_HUD_STATUS_MESSAGES[mode],
		};
	}
	const pythonBin = resolvePythonLauncher();
	try {
		const child = spawn(pythonBin, [scriptPath, `--${mode}`], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		child.on("error", () => {});
		child.unref();
		return {
			ok: true,
			message: DESKTOP_HUD_STATUS_MESSAGES[mode],
		};
	} catch (error) {
		return {
			ok: false,
			message: `Failed to launch Desktop Quota HUD: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
