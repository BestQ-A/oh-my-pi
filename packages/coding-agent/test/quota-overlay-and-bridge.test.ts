import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { CommandController, renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import {
	getFinopsUsageCachePath,
	launchDesktopQuotaHud,
	readCachedFinopsUsageReports,
	seedStatusLineQuotaPools,
	writeCachedFinopsUsageReports,
} from "@oh-my-pi/pi-coding-agent/modes/quota-hud-bridge";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import * as activityClient from "@oh-my-pi/pi-coding-agent/stats/activity-client";
import { UsageDashboardComponent } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

function buildSampleReport(provider: string, usedFraction: number, fetchedAt = 1_790_000_000_000): UsageReport {
	return {
		provider,
		fetchedAt,
		metadata: { email: "dev@example.test", accountId: `${provider}-acct` },
		limits: [
			{
				id: `${provider}:5h`,
				label: `${provider} 5h`,
				scope: { provider, accountId: `${provider}-acct`, windowId: "5h" },
				window: { id: "5h", label: "5 Hour", durationMs: 18_000_000, resetsAt: fetchedAt + 10_800_000 },
				amount: {
					usedFraction,
					remainingFraction: Math.max(0, 1 - usedFraction),
					unit: "percent",
				},
				status: usedFraction >= 0.9 ? "warning" : "ok",
			},
		],
	};
}

describe("UsageDashboardComponent presets & Desktop HUD controls", () => {
	beforeAll(async () => {
		const darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Expected dark theme");
		setThemeInstance(darkTheme);
	});

	it("renders model presets bar, switches presets via [1-4], and triggers Desktop HUD via [p]", async () => {
		const switched: string[] = [];
		let hudLaunches = 0;
		let switchDone = Promise.withResolvers<void>();
		const component = new UsageDashboardComponent({
			reports: [buildSampleReport("google-antigravity", 0.14)],
			presets: [
				{ name: "burn_expiring_gemini", active: true },
				{ name: "colab_blackwell_max", active: false },
				{ name: "steady_pool", active: false },
				{ name: "zero_cost_blitz", active: false },
			],
			onSwitchPreset: async name => {
				switched.push(name);
				return {
					ok: true,
					message: `Switched to preset "${name}"`,
					activeName: name,
				};
			},
			onOpenDesktopHud: () => {
				hudLaunches += 1;
				return "Launched Desktop Quota HUD";
			},
			renderDetail: (width, current) => renderUsageReports(current, theme, Date.now(), width),
			loadActivity: async push => {
				push([]);
			},
			requestRender: () => {
				if (switched.length > 0) {
					switchDone.resolve();
				}
			},
			onClose: () => {},
		});

		try {
			const initialText = stripVTControlCharacters(component.render(140).join("\n"));
			expect(initialText).toContain("Presets");
			expect(initialText).toContain("[1] ● burn_expiring_gemini");
			expect(initialText).toContain("[2] ○ colab_blackwell_max");
			expect(initialText).toContain("[3] ○ steady_pool");
			expect(initialText).toContain("[4] ○ zero_cost_blitz");
			expect(initialText).toContain("1-4 preset · p desktop HUD ·");

			// Press "2" to switch to colab_blackwell_max
			switchDone = Promise.withResolvers<void>();
			component.handleInput("2");
			await switchDone.promise;
			// Flush microtask after #switchPresetByIndex settles
			await Promise.resolve();

			expect(switched).toEqual(["colab_blackwell_max"]);
			const afterPreset2 = stripVTControlCharacters(component.render(140).join("\n"));
			expect(afterPreset2).toContain("[1] ○ burn_expiring_gemini");
			expect(afterPreset2).toContain("[2] ● colab_blackwell_max");
			expect(afterPreset2).toContain('Switched to preset "colab_blackwell_max"');

			// Press "4" to switch to zero_cost_blitz
			switchDone = Promise.withResolvers<void>();
			component.handleInput("4");
			await switchDone.promise;
			await Promise.resolve();

			expect(switched).toEqual(["colab_blackwell_max", "zero_cost_blitz"]);
			const afterPreset4 = stripVTControlCharacters(component.render(140).join("\n"));
			expect(afterPreset4).toContain("[2] ○ colab_blackwell_max");
			expect(afterPreset4).toContain("[4] ● zero_cost_blitz");
			expect(afterPreset4).toContain('Switched to preset "zero_cost_blitz"');

			// Press "p" and "P" to trigger Desktop HUD
			component.handleInput("p");
			expect(hudLaunches).toBe(1);
			const afterHud = stripVTControlCharacters(component.render(140).join("\n"));
			expect(afterHud).toContain("Launched Desktop Quota HUD");

			component.handleInput("P");
			expect(hudLaunches).toBe(2);

			// Live updateReports pushes refreshed percentages in-place
			component.updateReports([buildSampleReport("google-antigravity", 0.42)]);
			const afterLiveUpdate = stripVTControlCharacters(component.render(140).join("\n"));
			expect(afterLiveUpdate).toContain("58%");
		} finally {
			component.dispose();
		}
	});
});

describe("quota-hud-bridge cache & launcher", () => {
	const savedCacheEnv = process.env.OMP_FINOPS_USAGE_CACHE_PATH;
	const savedHudScriptEnv = process.env.OMP_QUOTA_HUD_SCRIPT;
	const savedHudDryRunEnv = process.env.OMP_QUOTA_HUD_DRY_RUN;

	afterEach(() => {
		if (savedCacheEnv === undefined) delete process.env.OMP_FINOPS_USAGE_CACHE_PATH;
		else process.env.OMP_FINOPS_USAGE_CACHE_PATH = savedCacheEnv;
		if (savedHudScriptEnv === undefined) delete process.env.OMP_QUOTA_HUD_SCRIPT;
		else process.env.OMP_QUOTA_HUD_SCRIPT = savedHudScriptEnv;
		if (savedHudDryRunEnv === undefined) delete process.env.OMP_QUOTA_HUD_DRY_RUN;
		else process.env.OMP_QUOTA_HUD_DRY_RUN = savedHudDryRunEnv;
	});

	it("resolves default finops cache path under ~/.omp/cache/finops-live-usage.json", () => {
		delete process.env.OMP_FINOPS_USAGE_CACHE_PATH;
		expect(getFinopsUsageCachePath()).toBe(path.join(os.homedir(), ".omp", "cache", "finops-live-usage.json"));
	});

	it("reads safely on missing/corrupt files and atomically preserves extra top-level keys on write", () => {
		const tmp = TempDir.createSync("@omp-quota-cache-");
		try {
			const cacheFile = path.join(tmp.path(), "finops-live-usage.json");
			expect(readCachedFinopsUsageReports(cacheFile)).toEqual([]);

			fs.writeFileSync(cacheFile, "{not-valid-json", "utf8");
			expect(readCachedFinopsUsageReports(cacheFile)).toEqual([]);

			fs.writeFileSync(
				cacheFile,
				JSON.stringify({
					generatedAt: 100,
					reports: [],
					capacity: { "minimax-code": [{ window: "5h", remainingAccounts: 1 }] },
				}),
				"utf8",
			);

			const sample = [buildSampleReport("zai-coding-plan", 0.03)];
			writeCachedFinopsUsageReports(sample, cacheFile);

			const loaded = readCachedFinopsUsageReports(cacheFile);
			expect(loaded).toHaveLength(1);
			expect(loaded[0]?.provider).toBe("zai-coding-plan");

			const rawObj: unknown = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
			expect(isRecord(rawObj)).toBe(true);
			if (isRecord(rawObj)) {
				expect(typeof rawObj.generatedAt).toBe("number");
				expect(rawObj.generatedAt).not.toBe(100);
				expect(rawObj.capacity).toEqual({ "minimax-code": [{ window: "5h", remainingAccounts: 1 }] });
			}
		} finally {
			tmp.removeSync();
		}
	});

	it("seeds StatusLine quota pools and dry-runs Desktop HUD launcher modes", () => {
		const tmp = TempDir.createSync("@omp-quota-hud-");
		try {
			const dummyScript = path.join(tmp.path(), "omp-quota-hud.py");
			fs.writeFileSync(dummyScript, "# stub\n", "utf8");
			process.env.OMP_QUOTA_HUD_SCRIPT = dummyScript;
			process.env.OMP_QUOTA_HUD_DRY_RUN = "1";

			expect(launchDesktopQuotaHud("open")).toEqual({
				ok: true,
				message: "Launched Desktop Quota HUD",
			});
			expect(launchDesktopQuotaHud("mini")).toEqual({
				ok: true,
				message: "Launched Desktop Quota HUD (Mini Capsule Strip)",
			});

			const seeded: Array<readonly UsageReport[]> = [];
			const mockStatusLine = {
				setQuotaPoolsFromReports(reports: readonly UsageReport[]) {
					seeded.push(reports);
				},
			};
			const reports = [buildSampleReport("cursor", 0.31)];
			seedStatusLineQuotaPools(mockStatusLine, reports);
			expect(seeded).toEqual([reports]);
		} finally {
			tmp.removeSync();
		}
	});
});

describe("/quota 0ms cache-first command & Alt+Q hotkey", () => {
	const savedCacheEnv = process.env.OMP_FINOPS_USAGE_CACHE_PATH;
	const savedHudScriptEnv = process.env.OMP_QUOTA_HUD_SCRIPT;
	const savedHudDryRunEnv = process.env.OMP_QUOTA_HUD_DRY_RUN;

	beforeAll(async () => {
		const darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Expected dark theme");
		setThemeInstance(darkTheme);
	});

	afterEach(() => {
		if (savedCacheEnv === undefined) delete process.env.OMP_FINOPS_USAGE_CACHE_PATH;
		else process.env.OMP_FINOPS_USAGE_CACHE_PATH = savedCacheEnv;
		if (savedHudScriptEnv === undefined) delete process.env.OMP_QUOTA_HUD_SCRIPT;
		else process.env.OMP_QUOTA_HUD_SCRIPT = savedHudScriptEnv;
		if (savedHudDryRunEnv === undefined) delete process.env.OMP_QUOTA_HUD_DRY_RUN;
		else process.env.OMP_QUOTA_HUD_DRY_RUN = savedHudDryRunEnv;
		vi.restoreAllMocks();
	});

	it("opens Quota Overlay in 0ms from cache, refreshes in background, and binds /quota + Alt+Q", async () => {
		spyOn(activityClient, "loadDailyActivity").mockResolvedValue(undefined);
		const tmp = TempDir.createSync("@omp-quota-cmd-");
		try {
			const cacheFile = path.join(tmp.path(), "finops-live-usage.json");
			const dummyScript = path.join(tmp.path(), "omp-quota-hud.py");
			fs.writeFileSync(dummyScript, "# stub\n", "utf8");
			process.env.OMP_FINOPS_USAGE_CACHE_PATH = cacheFile;
			process.env.OMP_QUOTA_HUD_SCRIPT = dummyScript;
			process.env.OMP_QUOTA_HUD_DRY_RUN = "1";

			writeCachedFinopsUsageReports([buildSampleReport("google-antigravity", 0.14)], cacheFile);

			const pendingLiveFetch = Promise.withResolvers<UsageReport[] | null>();
			const liveSeeded = Promise.withResolvers<readonly UsageReport[]>();
			const seededSnapshots: Array<readonly UsageReport[]> = [];
			let mounted: UsageDashboardComponent | undefined;
			const inputListeners: Array<(data: string) => { consume?: boolean } | undefined> = [];

			const ctx = createInteractiveModeContext({
				session: {
					fetchUsageReports: () => pendingLiveFetch.promise,
					getUsageReportingModelSelectors: () => [],
					modelRegistry: {
						authStorage: {
							credentials: { all: () => ({}) },
							usage: { providerFor: () => undefined },
							oauth: { identity: () => undefined },
						},
					},
				},
				statusLine: {
					invalidate: vi.fn(),
					markActivityStart: vi.fn(),
					markActivityEnd: vi.fn(),
					setSession: vi.fn(),
					setQuotaPoolsFromReports: (reports: readonly UsageReport[]) => {
						seededSnapshots.push(reports);
						if (seededSnapshots.length >= 2) {
							liveSeeded.resolve(reports);
						}
					},
				},
				dictationSpaceHold: () => ({ enabled: () => false, onStart: () => {}, onEnd: () => {} }),
				editor: {
					getText: () => "",
					setText: vi.fn(),
					setActionKeys: vi.fn(),
					clearCustomKeyHandlers: vi.fn(),
					setCustomKeyHandler: vi.fn(),
					composerChips: () => [],
					spaceHold: { keys: [] },
				},
				ui: {
					hasOverlay: () => mounted !== undefined,
					addInputListener: listener => {
						inputListeners.push(listener);
						return () => {};
					},
					addStartListener: () => () => {},
					getFocused: () => null,
					requestRender: () => {},
					setFocus: () => {},
					showOverlay: component => {
						if (!(component instanceof UsageDashboardComponent)) {
							throw new Error("Expected UsageDashboardComponent");
						}
						mounted = component;
						return {
							hide: () => {
								mounted = undefined;
							},
							setHidden: () => {},
							isHidden: () => false,
						};
					},
				},
			});

			const selector = new SelectorController(ctx);
			ctx.showUsageDashboard = reports => selector.showUsageDashboard(reports);
			ctx.updateUsageDashboard = reports => selector.updateUsageDashboard(reports);
			const commandController = new CommandController(ctx);
			ctx.handleQuotaCommand = sub => commandController.handleQuotaCommand(sub);

			// 1. `/quota` slash command opens overlay immediately (before pendingLiveFetch resolves!)
			const runtime: TuiSlashCommandRuntime = { ctx };
			const slashHandled = await executeBuiltinSlashCommand("/quota", runtime);
			expect(slashHandled).toBe(true);
			expect(mounted).toBeDefined();
			expect(seededSnapshots).toHaveLength(1);
			const cachedView = stripVTControlCharacters(mounted!.render(120).join("\n"));
			expect(cachedView).toContain("86%");

			// 2. Background refresh completes -> updates cache, statusLine, and open overlay in-place
			pendingLiveFetch.resolve([buildSampleReport("google-antigravity", 0.35)]);
			await liveSeeded.promise;

			const refreshedView = stripVTControlCharacters(mounted!.render(120).join("\n"));
			expect(refreshedView).toContain("65%");
			expect(readCachedFinopsUsageReports(cacheFile)[0]?.limits[0]?.amount.usedFraction).toBe(0.35);

			// Close overlay and test Alt+Q global hotkey
			mounted!.handleInput("\x1b");
			expect(mounted).toBeUndefined();

			const quotaSpy = spyOn(ctx, "handleQuotaCommand");
			const inputController = new InputController(ctx);
			inputController.setupKeyHandlers();
			for (const listener of inputListeners) {
				listener("\x1bq");
			}
			expect(quotaSpy).toHaveBeenCalledTimes(1);
		} finally {
			tmp.removeSync();
		}
	});
});
