import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { Editor, visibleWidth } from "@oh-my-pi/pi-tui";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { UsageDashboardComponent } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import {
	actionMarkerAt,
	extensionLinkLabels,
	formatActionMarker,
	setExtensionLinks,
	stripExtensionLinkMarkers,
} from "@oh-my-pi/pi-tui/render/extension-links";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { StatusLineHost, StatusLineSession } from "../src/status-line/host";
import { renderSegment } from "../src/status-line/segments";
import type { SegmentContext, StatusLineSettings } from "../src/status-line/types";
import { defaultEditorTheme } from "./test-themes";

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	setExtensionLinks([]);
	setNativeRendering(false);
});

afterEach(() => {
	setExtensionLinks([]);
	setNativeRendering(false);
});

/** Build a 1-based SGR 1006 left-button press report for 0-based `(row, col)`. */
function sgrLeftClick(col: number, row: number): string {
	return `\x1b[<0;${col + 1};${row + 1}M`;
}

/** Locate the first rendered cell `(row, col)` whose action marker equals `targetUri`. */
function findMarkerCell(lines: readonly string[], targetUri: string): { row: number; col: number } | undefined {
	for (let row = 0; row < lines.length; row++) {
		const line = lines[row] ?? "";
		const width = visibleWidth(line);
		for (let col = 0; col < width; col++) {
			if (actionMarkerAt(line, col) === targetUri) {
				return { row, col };
			}
		}
	}
	return undefined;
}

function createModel(provider: string, id: string, name = id): Model {
	const template = getBundledModel("anthropic", "claude-sonnet-4-5");
	return {
		...template,
		provider,
		id,
		name,
	};
}

function createStatusSession(model: Model): StatusLineSession {
	return {
		state: { model, messages: [] },
		model,
		messages: [],
		isStreaming: false,
		isAutoThinking: false,
		sessionManager: {
			getSessionName: () => undefined,
			getSessionId: () => "session-mouse-test",
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
		modelRegistry: { isUsingOAuth: () => true },
		getContextUsage: () => ({ tokens: 20_000, contextWindow: 200_000, percent: 10 }),
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => null,
		getGoalModeState: () => undefined,
	};
}

function createSegmentContext(overrides: Partial<SegmentContext> = {}): SegmentContext {
	const model = createModel("google-antigravity", "gemini-4-argon", "Gemini 4 Argon");
	return {
		session: createStatusSession(model),
		width: 160,
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

describe("formatActionMarker & actionMarkerAt", () => {
	it("wraps labels without forced underline, hit-tests cells independent of setExtensionLinks, and strips cleanly", () => {
		const left = formatActionMarker("●HUD", "omp-ui:desktop-hud", "hud-btn");
		const right = formatActionMarker("AG 86%", "omp-overlay:quota", "quota-btn");
		const row = `  ${left}   ${right}  `;

		// No forced underline SGR codes are injected by formatActionMarker.
		expect(left).not.toMatch(/\x1b\[4(?::4)?m/);
		// Terminal output stripping leaves exact visible text with zero OSC 8 remnants.
		expect(stripExtensionLinkMarkers(row)).toBe("  ●HUD   AG 86%  ");

		// Unregistered schemes are ignored by extensionLinkLabels, while actionMarkerAt resolves all markers.
		expect(extensionLinkLabels(row)).toEqual([]);
		expect(actionMarkerAt(row, -1)).toBeUndefined();
		expect(actionMarkerAt(row, 1)).toBeUndefined();
		for (let col = 2; col < 6; col++) {
			expect(actionMarkerAt(row, col)).toBe("omp-ui:desktop-hud");
		}
		for (let col = 6; col < 9; col++) {
			expect(actionMarkerAt(row, col)).toBeUndefined();
		}
		for (let col = 9; col < 15; col++) {
			expect(actionMarkerAt(row, col)).toBe("omp-overlay:quota");
		}
		expect(actionMarkerAt(row, 15)).toBeUndefined();

		// Once omp-ui is registered, extensionLinkLabels resolves omp-ui:* while still ignoring omp-overlay:*.
		setExtensionLinks(["omp-ui"]);
		expect(extensionLinkLabels(row).map(label => ({ url: label.url, start: label.start, end: label.end }))).toEqual([
			{ url: "omp-ui:desktop-hud", start: 2, end: 6 },
		]);

		// Native rendering and empty/sanitized hrefs return raw label unchanged.
		expect(formatActionMarker("Plain", "\x1b\x07", "empty")).toBe("Plain");
		setNativeRendering(true);
		expect(formatActionMarker("Native", "omp-ui:model", "native")).toBe("Native");
	});
});

describe("Editor empty-box numbered prediction action markers & acceptPredictionOption", () => {
	it("marks each numbered option 1/2/3 separately for click hit-testing and accepts option 2 cleanly", () => {
		const editor = new Editor(defaultEditorTheme);
		editor.setPaddingX(0);
		editor.predictions = () => ["1. 提交当前改动  2. 查看 git diff  3. 继续优化补全延迟"];

		const lines = editor.render(100);
		const inputRow = lines[1] ?? "";
		expect(stripExtensionLinkMarkers(Bun.stripANSI(inputRow))).toContain(
			"1. 提交当前改动  2. 查看 git diff  3. 继续优化补全延迟",
		);

		const hit1 = findMarkerCell(lines, "omp-ui:accept-pred:1");
		const hit2 = findMarkerCell(lines, "omp-ui:accept-pred:2");
		const hit3 = findMarkerCell(lines, "omp-ui:accept-pred:3");
		expect(hit1).toBeDefined();
		expect(hit2).toBeDefined();
		expect(hit3).toBeDefined();
		expect(hit1!.row).toBe(1);
		expect(hit2!.col).toBeGreaterThan(hit1!.col);
		expect(hit3!.col).toBeGreaterThan(hit2!.col);

		// The 2-space gap immediately before option 2 has no marker.
		expect(actionMarkerAt(inputRow, hit2!.col - 1)).toBeUndefined();
		expect(actionMarkerAt(inputRow, hit2!.col - 2)).toBeUndefined();

		// Clicking/accepting option 2 fills clean text without the "2. " prefix.
		expect(editor.acceptPredictionOption(2)).toBe(true);
		expect(editor.getText()).toBe("查看 git diff");
		expect(editor.acceptPredictionOption(9)).toBe(false);

		// Chunk acceptance via public acceptGhostChunk() advances one chunk at a time.
		editor.setText("");
		expect(editor.acceptGhostChunk()).toBe(true);
		expect(editor.getText()).toBe("提交");
	});
});

describe("StatusLine action markers", () => {
	it("wraps model, quota_pools, and usage segments in omp-ui:model and omp-ui:quota markers", () => {
		const model = createModel("google-antigravity", "gemini-4-argon", "Gemini 4 Argon");
		const session = createStatusSession(model);
		const settings: StatusLineSettings = {
			preset: "custom",
			leftSegments: ["model"],
			rightSegments: ["quota_pools"],
			separator: "slash",
		};
		const host: StatusLineHost = {
			getSettings: () => settings,
			gitEnabled: () => false,
			codexResetFireworksEnabled: () => false,
			getSettingsRevision: () => 0,
			getSessionSettingsIdentity: () => undefined,
			getSessionSettingsRevision: () => 0,
			goalStatusInFooter: () => false,
			activeAccount: () => undefined,
			canFetchUsageReports: () => false,
			fetchUsageReports: async () => null,
			resolveActiveRepo: () => null,
			lookupPullRequest: async () => ({ stdout: "", exitCode: 1 }),
			calculateTokensPerSecond: () => null,
			limitMatchesActiveAccount: () => true,
			computeCompactionBoundaries: () => null,
		};
		const statusLine = new StatusLineComponent(session, host);
		try {
			const now = Date.now();
			statusLine.setQuotaPoolsFromReports([
				{
					provider: "google-antigravity",
					fetchedAt: now,
					limits: [
						{
							id: "ag:5h",
							label: "Gemini",
							scope: { provider: "google-antigravity", windowId: "5h" },
							window: { id: "5h", label: "5h", durationMs: 5 * 3_600_000, resetsAt: now + 2 * 3_600_000 },
							amount: { remainingFraction: 0.86, usedFraction: 0.14, unit: "percent" },
							status: "ok",
						},
					],
				},
			]);

			const borderLine = statusLine.getTopBorder(120).content;
			expect(findMarkerCell([borderLine], "omp-ui:model")).toBeDefined();
			expect(findMarkerCell([borderLine], "omp-ui:quota")).toBeDefined();

			setExtensionLinks(["omp-ui"]);
			expect(extensionLinkLabels(borderLine).map(label => label.url)).toEqual(["omp-ui:model", "omp-ui:quota"]);
		} finally {
			statusLine.dispose();
		}

		const usageRendered = renderSegment(
			"usage",
			createSegmentContext({
				usage: { fiveHour: { percent: 42, resetMinutes: 90 } },
			}),
		);
		expect(usageRendered.visible).toBe(true);
		expect(findMarkerCell([usageRendered.content], "omp-ui:quota")).toBeDefined();
	});
});

describe("UsageDashboardComponent SGR mouse left-click interactivity", () => {
	it("switches presets, opens Desktop HUD, refreshes, toggles details/back, and closes on SGR left-click", async () => {
		const switchedPresets: string[] = [];
		let desktopHudClicks = 0;
		let refreshClicks = 0;
		let closeClicks = 0;
		const now = Date.now();
		const sampleReports: UsageReport[] = [
			{
				provider: "anthropic",
				fetchedAt: now,
				limits: [
					{
						id: "anthropic:5h",
						label: "Claude 5h",
						scope: { provider: "anthropic", accountId: "acct-1", windowId: "5h" },
						window: { id: "5h", label: "5h", resetsAt: now + 3_600_000 },
						amount: { usedFraction: 0.25, unit: "percent" },
						status: "ok",
					},
				],
			},
		];

		const dashboard = new UsageDashboardComponent({
			reports: sampleReports,
			presets: [
				{ name: "Flagship", active: true },
				{ name: "ZeroCash", active: false },
			],
			onSwitchPreset: async name => {
				switchedPresets.push(name);
				return { ok: true, message: `Switched to ${name}`, activeName: name };
			},
			onOpenDesktopHud: () => {
				desktopHudClicks++;
				return "Desktop HUD toggled";
			},
			refresh: async () => {
				refreshClicks++;
				return sampleReports;
			},
			renderDetail: () => "Detailed per-account quota breakdown",
			loadActivity: async push => {
				push([]);
			},
			requestRender: () => {},
			onClose: () => {
				closeClicks++;
			},
		});

		try {
			// 1) Left-click preset [2] -> switches preset to ZeroCash
			let lines = dashboard.render(110);
			const preset2Hit = findMarkerCell(lines, "omp-overlay:preset:1");
			expect(preset2Hit).toBeDefined();
			dashboard.handleInput(sgrLeftClick(preset2Hit!.col, preset2Hit!.row));
			await Promise.resolve();
			await Promise.resolve();
			expect(switchedPresets).toEqual(["ZeroCash"]);

			// 2) Left-click "p desktop HUD" -> invokes onOpenDesktopHud
			lines = dashboard.render(110);
			const hudHit = findMarkerCell(lines, "omp-overlay:desktop-hud");
			expect(hudHit).toBeDefined();
			dashboard.handleInput(sgrLeftClick(hudHit!.col, hudHit!.row));
			expect(desktopHudClicks).toBe(1);

			// 3) Left-click "r refresh" -> invokes refresh
			lines = dashboard.render(110);
			const refreshHit = findMarkerCell(lines, "omp-overlay:refresh");
			expect(refreshHit).toBeDefined();
			dashboard.handleInput(sgrLeftClick(refreshHit!.col, refreshHit!.row));
			await Promise.resolve();
			expect(refreshClicks).toBe(1);

			// 4) Left-click "enter details" -> switches to detail view, then "esc back" -> returns to overview
			lines = dashboard.render(110);
			const detailHit = findMarkerCell(lines, "omp-overlay:detail");
			expect(detailHit).toBeDefined();
			dashboard.handleInput(sgrLeftClick(detailHit!.col, detailHit!.row));
			lines = dashboard.render(110);
			expect(Bun.stripANSI(lines.join("\n"))).toContain("Usage · Details");

			const backHit = findMarkerCell(lines, "omp-overlay:overview");
			expect(backHit).toBeDefined();
			dashboard.handleInput(sgrLeftClick(backHit!.col, backHit!.row));
			lines = dashboard.render(110);
			expect(Bun.stripANSI(lines[0] ?? "")).not.toContain("Details");

			// 5) Left-click "esc close" -> closes dashboard
			const closeHit = findMarkerCell(lines, "omp-overlay:close");
			expect(closeHit).toBeDefined();
			dashboard.handleInput(sgrLeftClick(closeHit!.col, closeHit!.row));
			expect(closeClicks).toBe(1);
		} finally {
			dashboard.dispose();
		}
	});
});
