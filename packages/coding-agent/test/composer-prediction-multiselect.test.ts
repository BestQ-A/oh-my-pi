import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ComposerPredictionMultiSelect,
	formatMultiSelectPromptSubmission,
} from "@oh-my-pi/pi-coding-agent/modes/components/composer-prediction-multiselect";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgComposerMarginHud, cfgTuiMouse } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import {
	extensionLinkLabels,
	setExtensionLinks,
	stripExtensionLinkMarkers,
} from "@oh-my-pi/pi-tui/render/extension-links";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

describe("ComposerPredictionMultiSelect", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	afterEach(() => {
		setExtensionLinks([]);
	});

	it("auto-renders clickable checkbox pills, selects all on Tab, toggles individual items, and attaches editor text as additional prompt note", () => {
		setExtensionLinks(["omp-ui"]);
		let raw: string | undefined = "1. 跑全量测试验收  2. 检查 oxlint 报错  3. 提交这些改动";
		let renders = 0;
		const bar = new ComposerPredictionMultiSelect({
			getRawPrediction: () => raw,
			requestRender: () => {
				renders++;
			},
		});

		// 1. Initial state: 0/3 checked, exposes [Tab 全选] + 3 item toggles + [✕]
		expect(bar.getStatus()).toEqual({ total: 3, checked: 0 });
		const initialRows = bar.render(120);
		expect(initialRows.length).toBeGreaterThanOrEqual(1);
		const initialUrls = initialRows.flatMap(r => extensionLinkLabels(r).map(l => l.url));
		expect(initialUrls).toEqual([
			"omp-ui:pred-toggle-all",
			"omp-ui:pred-toggle:1",
			"omp-ui:pred-toggle:2",
			"omp-ui:pred-toggle:3",
			"omp-ui:pred-dismiss",
		]);
		for (const row of initialRows) {
			expect(stripExtensionLinkMarkers(row)).not.toContain("omp-extension-link");
		}

		// 2. Default Tab action (`toggleAll()`) checks ALL 3 items (`3/3`)
		expect(bar.toggleAll()).toBe(true);
		expect(bar.getStatus()).toEqual({ total: 3, checked: 3 });
		expect(renders).toBe(1);
		const allCheckedRows = bar.render(120);
		const allCheckedPlain = allCheckedRows.map(r => Bun.stripANSI(r)).join("\n");
		expect(allCheckedPlain).toContain("已全选 3/3");
		expect(allCheckedPlain).toContain("☑ 1.");
		expect(allCheckedPlain).toContain("☑ 2.");
		expect(allCheckedPlain).toContain("☑ 3.");
		expect(allCheckedRows.flatMap(r => extensionLinkLabels(r).map(l => l.url))).toContain("omp-ui:pred-submit");

		// 3. Uncheck item #3 (`toggleItem(3)`) -> 2/3 checked
		expect(bar.toggleItem(3)).toBe(true);
		expect(bar.getStatus()).toEqual({ total: 3, checked: 2 });

		// 4. Slash commands bypass consumption without clearing checked items
		const slashRes = bar.consumeSubmission("/quota");
		expect(slashRes).toEqual({ text: "/quota", consumedSelection: false });
		expect(bar.getStatus()).toEqual({ total: 3, checked: 2 });

		// 5. Normal Enter submission combines checked items (#1, #2) + input box additional prompt note!
		const sub = bar.consumeSubmission("先不要 commit，重点看 Windows 路径兼容");
		expect(sub.consumedSelection).toBe(true);
		expect(sub.text).toBe(
			"请执行以下已选事项：\n1. 跑全量测试验收\n2. 检查 oxlint 报错\n\n附加提示信息：先不要 commit，重点看 Windows 路径兼容",
		);
		expect(bar.hasVisibleCandidates()).toBe(false);

		// 6. When next turn produces a new prediction, bar auto-mounts again; 0-checked submit passes unrelated prompt untouched
		raw = "1. 更新 CHANGELOG  2. 推送远端分支";
		expect(bar.getStatus()).toEqual({ total: 2, checked: 0 });
		const unrelated = bar.consumeSubmission("帮我排查另一个内存泄漏");
		expect(unrelated).toEqual({ text: "帮我排查另一个内存泄漏", consumedSelection: false });
		expect(bar.hasVisibleCandidates()).toBe(false);
	});

	it("formats single and multi-item submissions cleanly with and without additional prompt text", () => {
		expect(formatMultiSelectPromptSubmission([{ index: 2, text: "检查 oxlint 报错" }], "")).toBe("检查 oxlint 报错");
		expect(formatMultiSelectPromptSubmission([{ index: 2, text: "检查 oxlint 报错" }], "只检查 packages/tui")).toBe(
			"检查 oxlint 报错\n\n附加提示信息：只检查 packages/tui",
		);
		expect(
			formatMultiSelectPromptSubmission(
				[
					{ index: 1, text: "跑单测" },
					{ index: 3, text: "提交代码" },
				],
				"",
			),
		).toBe("请执行以下已选事项：\n1. 跑单测\n2. 提交代码");
	});
});

describe("InteractiveMode Multi-Select Bar + Tab Select-All + Additional Prompt Note E2E", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-pred-multiselect-e2e-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "tui.mouse": true, "composer.marginHud": true }),
			modelRegistry,
		});
		term = new VirtualTerminal(160, 32);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, new EventBus(), composer);
		cfgTuiMouse.set(mode.settings, true);
		cfgComposerMarginHud.set(mode.settings, true);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("selects all on Tab, toggles item via SGR mouse click, and submits checked items + editor additional note on Enter", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const userInputPromise = mode.getUserInput();
		await term.waitForRender();

		// Seed empty-composer prediction menu on EventController's inline completion controller
		Object.defineProperty(mode.eventController.composerInlineCompletion, "emptyPrediction", {
			get: () => "1. 跑全量测试验收  2. 检查 oxlint 报错  3. 提交这些改动",
			configurable: true,
		});
		mode.ui.requestRender();
		await term.waitForRender(() =>
			term.getViewport().some(row => Bun.stripANSI(row).includes("☐ 1. 跑全量测试验收")),
		);

		// 1. Press Tab -> immediately selects ALL 3 candidates (`已全选 3/3`)!
		term.sendInput("\t");
		await term.waitForRender(() => term.getViewport().some(row => Bun.stripANSI(row).includes("已全选 3/3")));

		// 2. Mouse left-click on `☑ 3. 提交这些改动` to uncheck item #3 (`已选 2/3`)
		const vpBeforeClick = term.getViewport().map(r => Bun.stripANSI(r));
		const item3Row0 = vpBeforeClick.findIndex(r => r.includes("☑ 3."));
		expect(item3Row0).toBeGreaterThanOrEqual(0);
		const item3CharIdx = vpBeforeClick[item3Row0]!.indexOf("☑ 3.");
		const item3Col1Based = visibleWidth(vpBeforeClick[item3Row0]!.slice(0, item3CharIdx)) + 2;
		term.sendInput(`\x1b[<0;${item3Col1Based};${item3Row0 + 1}M`);
		await term.waitForRender(() => term.getViewport().some(row => Bun.stripANSI(row).includes("已选 2/3")));

		// 3. Type additional prompt instructions in the input box — multi-select bar stays visible!
		mode.editor.insertText("只跑 tui 和 coding-agent 两个包");
		mode.ui.requestRender();
		await term.waitForRender(() =>
			term.getViewport().some(row => Bun.stripANSI(row).includes("只跑 tui 和 coding-agent 两个包")),
		);
		expect(term.getViewport().some(row => Bun.stripANSI(row).includes("已选 2/3"))).toBe(true);

		// 4. Press Enter -> combines checked items (#1, #2) + editor additional prompt note!
		term.sendInput("\r");
		const submitted = await userInputPromise;
		expect(submitted.text).toBe(
			"请执行以下已选事项：\n1. 跑全量测试验收\n2. 检查 oxlint 报错\n\n附加提示信息：只跑 tui 和 coding-agent 两个包",
		);
	});
});
