import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	ComposerMarginHudFrame,
	type MarginHudHostAccess,
	MarginHudTelemetryCollector,
	type MarginHudTelemetrySnapshot,
	parseGitStatusPorcelain,
	parseNvidiaSmiCsv,
	shortenGpuName,
} from "@oh-my-pi/pi-coding-agent/modes/components/composer-margin-hud";
import { CURSOR_MARKER, padding, visibleWidth } from "@oh-my-pi/pi-tui";
import { extensionLinkLabels, setExtensionLinks } from "@oh-my-pi/pi-tui/render/extension-links";
import type { QuotaPoolCapsule } from "@oh-my-pi/pi-tui/status-line";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { TempDir } from "@oh-my-pi/pi-utils";

interface MockHostState {
	enabled: boolean;
	plainEditorActive: boolean;
	cwd: string;
	presetName?: string;
	quotaCapsules: QuotaPoolCapsule[];
	todoPhases: TodoPhase[];
	subagents: {
		running: Array<{ id?: string; label: string; elapsed?: string }>;
		recent: Array<{ id?: string; label: string; status: string }>;
	};
	mcpServers: Array<{ name: string; tools: number }>;
	draftEmpty: boolean;
	numberedPrediction: boolean;
	centerRenderer?: (width: number) => string[];
	centerWidthsSeen: number[];
	renderRequests: number;
}

function createMockHost(overrides: Partial<MockHostState> = {}): {
	host: MarginHudHostAccess;
	state: MockHostState;
} {
	const state: MockHostState = {
		enabled: true,
		plainEditorActive: true,
		cwd: "E:/DevTools/oh-my-pi",
		presetName: "burn_expiring_gemini",
		quotaCapsules: [
			{
				provider: "google-antigravity",
				shortLabel: "AG",
				remainingPct: 28,
				resetText: "2h",
				active: true,
				severity: "warning",
			},
			{
				provider: "zai-coding-plan",
				shortLabel: "GLM",
				remainingPct: 94,
				resetText: "3h",
				severity: "ok",
			},
		],
		todoPhases: [
			{
				name: "HUD",
				tasks: [
					{ content: "Scaffold margin HUD contract", status: "completed" },
					{ content: "Wire 4-edge composer wings", status: "in_progress" },
				],
			},
		],
		subagents: {
			running: [{ id: "MarginHudWorker", label: "MarginHudWorker", elapsed: "14s" }],
			recent: [],
		},
		mcpServers: [
			{ name: "ida_headless", tools: 38 },
			{ name: "computer_use_windows", tools: 28 },
		],
		draftEmpty: true,
		numberedPrediction: true,
		centerWidthsSeen: [],
		renderRequests: 0,
		...overrides,
	};

	const host: MarginHudHostAccess = {
		isEnabled: () => state.enabled,
		isPlainEditorActive: () => state.plainEditorActive,
		renderCenterEditor: width => {
			state.centerWidthsSeen.push(width);
			if (state.centerRenderer) {
				return state.centerRenderer(width);
			}
			const topBorder = "─".repeat(Math.max(1, width));
			const promptLine = `> ${CURSOR_MARKER}1. 跑全量测试  2. 看 diff`;
			const paddedPrompt = `${promptLine}${padding(Math.max(0, width - visibleWidth(promptLine)))}`;
			const bottomBorder = "─".repeat(Math.max(1, width));
			return [topBorder, paddedPrompt, bottomBorder];
		},
		getCwd: () => state.cwd,
		getActivePresetName: () => state.presetName,
		getQuotaCapsules: () => state.quotaCapsules,
		getTodoPhases: () => state.todoPhases,
		getSubagentSummary: () => state.subagents,
		getMcpServers: () => state.mcpServers,
		isDraftEmpty: () => state.draftEmpty,
		hasNumberedPrediction: () => state.numberedPrediction,
		requestRender: () => {
			state.renderRequests += 1;
		},
	};

	return { host, state };
}

function createSeededCollector(seed: Partial<MarginHudTelemetrySnapshot> = {}): MarginHudTelemetryCollector {
	return new MarginHudTelemetryCollector({
		autoStart: false,
		initialSnapshot: {
			gpu: { name: "RTX 3090", usedGb: "2.7", totalGb: "24.0", tempC: 51, utilPct: 18 },
			cpuPct: 14,
			ramUsedGb: "18.2",
			ramTotalGb: "64.0",
			gitBranch: "main",
			gitDirtyCount: 2,
			gitFiles: [
				{
					status: "M",
					path: "editor.ts",
					fullPath: "packages/tui/src/components/editor.ts",
				},
				{
					status: "?",
					path: "foo.ts",
					fullPath: "packages/coding-agent/src/foo.ts",
				},
			],
			daemons: [
				{ label: "Omni", port: 18799, up: true },
				{ label: "IDA", port: 8745, up: true },
				{ label: "Purge", port: 7788, up: false },
				{ label: "HUD", port: 51234, up: true },
			],
			...seed,
		},
	});
}

function stripCursorAndAnsi(text: string): string {
	return stripVTControlCharacters(text.replaceAll(CURSOR_MARKER, ""));
}

describe("ComposerMarginHudFrame", () => {
	beforeAll(async () => {
		const darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Expected dark theme");
		setThemeInstance(darkTheme);
	});

	it("renders all 4 edges at >= 140 cols, 3 edges at 110..139 cols, and compact Top+Center+Bottom at < 110 cols", () => {
		const { host, state } = createMockHost();
		const collector = createSeededCollector();
		const frame = new ComposerMarginHudFrame(host, collector);

		try {
			// 160 cols -> Full 4-Edge Cockpit (leftW=28, rightW=30, two 3-col dividers -> centerW=96)
			const lines160 = frame.render(160);
			expect(state.centerWidthsSeen).toEqual([96]);
			expect(lines160.length).toBe(6); // TopBar (1) + MiddleBand (min 4) + BottomStrip (1)
			for (const line of lines160) {
				expect(visibleWidth(line)).toBe(160);
			}
			const plain160 = stripCursorAndAnsi(lines160.join("\n"));
			expect(plain160).toContain("▲ Preset: burn_expiring_gemini");
			expect(plain160).toContain("RTX 3090 2.7/24.0G");
			expect(plain160).toContain("CPU 14%");
			expect(plain160).toContain("RAM 18.2/64.0G");
			expect(plain160).toContain("🔥 临期: AG 28%/2h");
			expect(plain160).toContain("◀ Git & 任务");
			expect(plain160).toContain("M editor.ts");
			expect(plain160).toContain("▶ Agents & 服务");
			expect(plain160).toContain("● MarginHudWorker 14s");
			expect(plain160).toContain("MCP: ida · comp-use");
			expect(plain160).toContain("●Omni ●IDA ○Purge ●HUD");
			expect(plain160).toContain(
				"▼ git:main*2 │ 服务 3/4 │ Tab 全选 · 1-3+Tab 选候选 · Alt+Q 额度舱 · Alt+H 四边舱",
			);

			// 120 cols -> 3-Edge (no Left Wing, rightW=28, one 3-col divider -> centerW=89)
			state.centerWidthsSeen = [];
			const lines120 = frame.render(120);
			expect(state.centerWidthsSeen).toEqual([89]);
			for (const line of lines120) {
				expect(visibleWidth(line)).toBe(120);
			}
			const plain120 = stripCursorAndAnsi(lines120.join("\n"));
			expect(plain120).toContain("▲ Preset: burn_expiring_gemini");
			expect(plain120).not.toContain("◀ Git & 任务");
			expect(plain120).toContain("▶ Agents & 服务");
			expect(plain120).toContain("▼ git:main*2");

			// 90 cols -> Compact Top + full-width Center + Bottom (centerW=90, no side wings)
			state.centerWidthsSeen = [];
			const lines90 = frame.render(90);
			expect(state.centerWidthsSeen).toEqual([90]);
			expect(lines90.length).toBe(5); // TopBar (1) + 3 editor rows + BottomStrip (1)
			for (const line of lines90) {
				expect(visibleWidth(line)).toBe(90);
			}
			const plain90 = stripCursorAndAnsi(lines90.join("\n"));
			expect(plain90).toContain("▲ Preset: burn_expiring_gemini");
			expect(plain90).not.toContain("◀ Git & 任务");
			expect(plain90).not.toContain("▶ Agents & 服务");
			expect(plain90).toContain("▼ git:main*2");
		} finally {
			frame.dispose();
			collector.stop();
		}
	});

	it("preserves CURSOR_MARKER and lands at exact visible column offset across CJK and ANSI spans", () => {
		const beforeCursor = "你好 \x1b[36momp\x1b[39m ";
		const afterCursor = "world";
		const innerCursorCol = visibleWidth(beforeCursor);
		expect(innerCursorCol).toBe(9);

		const { host } = createMockHost({
			todoPhases: [
				{
					name: "宽字符边界测试",
					tasks: [
						{
							content: "这是一个非常长的中文待办事项用于验证左翼截断对齐不会偏移光标列",
							status: "in_progress",
						},
					],
				},
			],
			centerRenderer: width => [
				"─".repeat(width),
				`${beforeCursor}${CURSOR_MARKER}${afterCursor}`,
				"─".repeat(width),
			],
		});
		const collector = createSeededCollector({
			gitFiles: [{ status: "M", path: "超长中文文件名对齐测试_editor.ts" }],
		});
		const frame = new ComposerMarginHudFrame(host, collector);

		try {
			// Full 4-Edge (160 cols): leftW (28) + divider (3) + innerCursorCol (9) = 40
			const lines160 = frame.render(160);
			const cursorLines160 = lines160.filter(line => line.includes(CURSOR_MARKER));
			expect(cursorLines160).toHaveLength(1);
			const line160 = cursorLines160[0] ?? "";
			const idx160 = line160.indexOf(CURSOR_MARKER);
			expect(idx160).toBeGreaterThan(0);
			expect(visibleWidth(line160.slice(0, idx160))).toBe(28 + 3 + innerCursorCol);
			expect(visibleWidth(line160)).toBe(160);

			// 3-Edge (120 cols): no Left Wing -> cursor col === innerCursorCol (9)
			const lines120 = frame.render(120);
			const cursorLines120 = lines120.filter(line => line.includes(CURSOR_MARKER));
			expect(cursorLines120).toHaveLength(1);
			const line120 = cursorLines120[0] ?? "";
			const idx120 = line120.indexOf(CURSOR_MARKER);
			expect(visibleWidth(line120.slice(0, idx120))).toBe(innerCursorCol);
			expect(visibleWidth(line120)).toBe(120);

			// Compact (90 cols): no wings -> cursor col === innerCursorCol (9)
			const lines90 = frame.render(90);
			const cursorLines90 = lines90.filter(line => line.includes(CURSOR_MARKER));
			expect(cursorLines90).toHaveLength(1);
			const line90 = cursorLines90[0] ?? "";
			const idx90 = line90.indexOf(CURSOR_MARKER);
			expect(visibleWidth(line90.slice(0, idx90))).toBe(innerCursorCol);
			expect(visibleWidth(line90)).toBe(90);
		} finally {
			frame.dispose();
			collector.stop();
		}
	});

	it("passes through full-width center editor verbatim when disabled or selector/ask dialog is active", () => {
		const dialogLines = ["┌─ Ask Dialog ─┐", `│ Pick option ${CURSOR_MARKER} │`, "└──────────────┘"];
		const { host, state } = createMockHost({
			plainEditorActive: false,
			centerRenderer: () => dialogLines,
		});
		const collector = createSeededCollector();
		const frame = new ComposerMarginHudFrame(host, collector);

		try {
			const selectorResult = frame.render(160);
			expect(state.centerWidthsSeen).toEqual([160]);
			expect(selectorResult).toBe(dialogLines);

			state.plainEditorActive = true;
			state.enabled = false;
			state.centerWidthsSeen = [];
			const disabledResult = frame.render(160);
			expect(state.centerWidthsSeen).toEqual([160]);
			expect(disabledResult).toBe(dialogLines);
		} finally {
			frame.dispose();
			collector.stop();
		}
	});

	it("renders clean workspace, completed subagents, normal quota pools, and inline-draft keycaps", () => {
		const { host } = createMockHost({
			draftEmpty: false,
			numberedPrediction: false,
			quotaCapsules: [
				{ provider: "google-antigravity", shortLabel: "AG", remainingPct: 86, resetText: "4h", severity: "ok" },
				{ provider: "zai-coding-plan", shortLabel: "GLM", remainingPct: 95, resetText: "3h", severity: "ok" },
			],
			todoPhases: [],
			subagents: {
				running: [],
				recent: [
					{ label: "ScoutA", status: "completed" },
					{ label: "WorkerB", status: "completed" },
				],
			},
		});
		const collector = createSeededCollector({
			gitBranch: "feat/hud",
			gitDirtyCount: 0,
			gitFiles: [],
		});
		const frame = new ComposerMarginHudFrame(host, collector);

		try {
			const plain = stripCursorAndAnsi(frame.render(160).join("\n"));
			expect(plain).not.toContain("🔥 临期:");
			expect(plain).toContain("AG 86%/4h · GLM 95%/3h");
			expect(plain).toContain("✓ 工作区干净");
			expect(plain).toContain("○ 暂无待办");
			expect(plain).toContain("✓ 2 subagents done");
			expect(plain).toContain("▼ git:feat/hud │ 服务 3/4 │ Tab 全采纳 · Ctrl+→ 逐词 · Alt+Q 额度舱 · Alt+H 四边舱");
		} finally {
			frame.dispose();
			collector.stop();
		}
	});

	it("emits omp-ui OSC-8 action markers with exact column spans across all 4 edges while keeping CURSOR_MARKER column math identical", () => {
		const { host } = createMockHost();
		const collector = createSeededCollector();
		const frame = new ComposerMarginHudFrame(host, collector);

		const spanOf = (plainRow: string, needle: string): { start: number; end: number } => {
			const idx = plainRow.indexOf(needle);
			expect(idx).toBeGreaterThanOrEqual(0);
			const start = visibleWidth(plainRow.slice(0, idx));
			return { start, end: start + visibleWidth(needle) };
		};

		try {
			setExtensionLinks(["omp-ui"]);
			const lines = frame.render(160);
			expect(lines).toHaveLength(6);
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(160);
			}

			// 1. Top Bar
			const topBar = lines[0] ?? "";
			const topPlain = stripCursorAndAnsi(topBar);
			const topLabels = extensionLinkLabels(topBar);
			const presetSpan = spanOf(topPlain, "▲ Preset: burn_expiring_gemini");
			// The "⚡智选" auto-quota chip is glued to the preset cell, leading space included:
			// it starts where the preset span ends (col 30) and is 7 cells wide -> [30, 37).
			const quotaAutoSpan = spanOf(topPlain, " ⚡智选");
			const hwSpan = spanOf(topPlain, "RTX 3090 2.7/24.0G 51°C · CPU 14% · RAM 18.2/64.0G");
			const quotaSpan = spanOf(topPlain, "🔥 临期: AG 28%/2h");
			expect(topLabels.map(l => ({ url: l.url, start: l.start, end: l.end }))).toEqual([
				{ url: "omp-ui:quota", ...presetSpan },
				{ url: "omp-ui:quota-auto", ...quotaAutoSpan },
				{ url: "omp-ui:hud-refresh", ...hwSpan },
				{ url: "omp-ui:quota", ...quotaSpan },
			]);

			// 2. Left Wing & Right Wing (no bleed across [28..130) center editor)
			for (const midRow of lines.slice(1, 5)) {
				const midLabels = extensionLinkLabels(midRow);
				expect(midLabels.filter(l => l.end > 28 && l.start < 130)).toEqual([]);
			}

			// Row 1: Left Wing header (`omp-ui:todo`)
			const row1 = lines[1] ?? "";
			expect(extensionLinkLabels(row1).map(l => ({ url: l.url, start: l.start, end: l.end }))).toEqual([
				{ url: "omp-ui:todo", start: 0, end: visibleWidth("◀ Git & 任务") },
			]);

			// Row 2: Left Wing dirty file (`omp-ui:insert-file:<fullPath>`), Center CURSOR_MARKER, Right Wing running subagent (`omp-ui:subagent:...`)
			const row2 = lines[2] ?? "";
			const cursorIdx = row2.indexOf(CURSOR_MARKER);
			expect(cursorIdx).toBeGreaterThan(0);
			expect(visibleWidth(row2.slice(0, cursorIdx))).toBe(28 + 3 + 2);
			expect(extensionLinkLabels(row2).map(l => ({ url: l.url, start: l.start, end: l.end }))).toEqual([
				{
					url: `omp-ui:insert-file:${encodeURIComponent("packages/tui/src/components/editor.ts")}`,
					start: 0,
					end: visibleWidth("M editor.ts"),
				},
				{
					url: "omp-ui:subagent:MarginHudWorker",
					start: 130,
					end: 130 + visibleWidth("● MarginHudWorker 14s"),
				},
				{
					url: "omp-ui:subagent-model:MarginHudWorker",
					start: 130 + visibleWidth("● MarginHudWorker 14s"),
					end: 130 + visibleWidth("● MarginHudWorker 14s [⇄]"),
				},
			]);

			// Row 3: Left Wing 2nd git file (`foo.ts`) & Right Wing MCP (`omp-ui:mcp`)
			const row3 = lines[3] ?? "";
			const row3Urls = extensionLinkLabels(row3).map(l => ({ url: l.url, start: l.start, end: l.end }));
			expect(row3Urls[0]?.url).toBe("omp-ui:insert-file:packages%2Fcoding-agent%2Fsrc%2Ffoo.ts");
			expect(row3Urls[0]?.start).toBe(0);
			expect(row3Urls[1]).toEqual({
				url: "omp-ui:mcp",
				start: 130,
				end: 130 + visibleWidth("MCP: ida · comp-use"),
			});

			// Row 4: Left Wing TODO (`omp-ui:todo`) & Right Wing individual daemon pills including `●HUD` -> `omp-ui:desktop-hud`
			const row4 = lines[4] ?? "";
			const row4Labels = extensionLinkLabels(row4);
			expect(row4Labels[0]?.url).toBe("omp-ui:todo");
			const rightDaemons = row4Labels.filter(l => l.start >= 130);
			expect(rightDaemons.map(l => ({ url: l.url, start: l.start, end: l.end }))).toEqual([
				{ url: "omp-ui:hud-refresh", start: 130, end: 135 },
				{ url: "omp-ui:hud-refresh", start: 136, end: 140 },
				{ url: "omp-ui:hud-refresh", start: 141, end: 147 },
				{ url: "omp-ui:desktop-hud", start: 148, end: 152 },
			]);

			// 3. Bottom Strip
			const bottomStrip = lines[5] ?? "";
			const bottomPlain = stripCursorAndAnsi(bottomStrip);
			expect(extensionLinkLabels(bottomStrip).map(l => ({ url: l.url, start: l.start, end: l.end }))).toEqual([
				{ url: "omp-ui:hud-refresh", ...spanOf(bottomPlain, "▼ git:main*2") },
				{ url: "omp-ui:hud-refresh", ...spanOf(bottomPlain, "服务 3/4") },
				{ url: "omp-ui:accept-pred:all", ...spanOf(bottomPlain, "Tab 全选") },
				{ url: "omp-ui:accept-pred:1", ...spanOf(bottomPlain, "1-3+Tab 选候选") },
				{ url: "omp-ui:quota", ...spanOf(bottomPlain, "Alt+Q 额度舱") },
				{ url: "omp-ui:hud-toggle", ...spanOf(bottomPlain, "Alt+H 四边舱") },
			]);
		} finally {
			setExtensionLinks([]);
			frame.dispose();
			collector.stop();
		}
	});
});

describe("MarginHudTelemetryCollector & parsers", () => {
	it("shortens GPU names and parses nvidia-smi CSV output", () => {
		expect(shortenGpuName("NVIDIA GeForce RTX 3090")).toBe("RTX 3090");
		expect(shortenGpuName("NVIDIA RTX 4090 Laptop GPU")).toBe("RTX 4090M");

		const parsed = parseNvidiaSmiCsv("NVIDIA GeForce RTX 3090, 2765, 24576, 52, 18\n");
		expect(parsed).toEqual({
			name: "RTX 3090",
			usedGb: "2.7",
			totalGb: "24.0",
			tempC: 52,
			utilPct: 18,
		});
	});

	it("parses git porcelain v1 branch and dirty file summary up to 8 files", () => {
		const sample = [
			"## feat/margin-hud...origin/feat/margin-hud [ahead 1]",
			" M packages/coding-agent/src/modes/interactive-mode.ts",
			"?? packages/coding-agent/src/modes/components/composer-margin-hud.ts",
			"A  src/new-file.ts",
		].join("\n");
		const parsed = parseGitStatusPorcelain(sample);
		expect(parsed.gitBranch).toBe("feat/margin-hud");
		expect(parsed.gitDirtyCount).toBe(3);
		expect(parsed.gitFiles).toEqual([
			{
				status: "M",
				path: "interactive-mode.ts",
				fullPath: "packages/coding-agent/src/modes/interactive-mode.ts",
			},
			{
				status: "?",
				path: "composer-margin-hud.ts",
				fullPath: "packages/coding-agent/src/modes/components/composer-margin-hud.ts",
			},
			{
				status: "A",
				path: "src/new-file.ts",
				fullPath: "src/new-file.ts",
			},
		]);
	});

	it("probes HUD loopback TCP port from omp-quota-hud.json and deduplicates unchanged snapshots", async () => {
		const tmp = TempDir.createSync("@omp-margin-hud-test-");
		const server = net.createServer(socket => {
			socket.end();
		});
		const listening = Promise.withResolvers<number>();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address && typeof address === "object") {
				listening.resolve(address.port);
			}
		});
		const port = await listening.promise;
		const hudStatePath = path.join(tmp.path(), "omp-quota-hud.json");
		fs.writeFileSync(hudStatePath, JSON.stringify({ pid: process.pid, port }), "utf8");

		let updates = 0;
		const hudUpSeen = Promise.withResolvers<void>();
		const collector = new MarginHudTelemetryCollector({
			cwd: () => tmp.path(),
			hudStatePath,
			autoStart: false,
			onUpdate: () => {
				updates += 1;
				const hudDaemon = collector.getSnapshot().daemons.find(daemon => daemon.label === "HUD");
				if (hudDaemon?.up && hudDaemon.port === port) {
					hudUpSeen.resolve();
				}
			},
		});

		try {
			collector.refreshNow();
			await hudUpSeen.promise;
			const snapshot = collector.getSnapshot();
			expect(snapshot.gitBranch).toBeUndefined();
			expect(snapshot.gitDirtyCount).toBe(0);
			const hudDaemon = snapshot.daemons.find(daemon => daemon.label === "HUD");
			expect(hudDaemon).toEqual({ label: "HUD", port, up: true });
			expect(updates).toBeGreaterThanOrEqual(1);
		} finally {
			collector.stop();
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
			tmp.removeSync();
		}
	});
});
