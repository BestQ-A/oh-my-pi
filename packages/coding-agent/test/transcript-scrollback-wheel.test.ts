import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgTuiMouse } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { Text, visibleWidth } from "@oh-my-pi/pi-tui";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

describe("Mouse wheel scrollback under tui.mouse: true", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-wheel-scrollback-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "tui.mouse": true }),
			modelRegistry,
		});
		term = new VirtualTerminal(120, 24);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", () => {}, undefined, undefined, new EventBus(), composer);
		cfgTuiMouse.set(mode.settings, true);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("opens fullscreen scrollback on Wheel Up, scrolls smoothly, and auto-returns to live editor on Wheel Down to bottom or clicking [▼ 回到底部]", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();

		// Populate chatContainer with 45 lines so it overflows the 24-row terminal
		const lines = Array.from({ length: 45 }, (_, idx) => `Transcript歷史消息行 #${idx + 1}`);
		mode.chatContainer.addChild(new Text(lines.join("\n"), 0, 0));
		mode.ui.requestRender();
		await term.waitForRender();
		expect(mode.ui.hasOverlay()).toBe(false);

		// 1. Send SGR Wheel Up (`button 64`: `\x1b[<64;20;10M`) -> opens fullscreen scrollback overlay!
		term.sendInput("\x1b[<64;20;10M");
		await term.waitForRender(() => mode.ui.hasOverlay());
		expect(mode.ui.hasOverlay()).toBe(true);
		const scrolledView = term
			.getViewport()
			.map(r => Bun.stripANSI(r))
			.join("\n");
		expect(scrolledView).toContain("▲ 历史回看");
		expect(scrolledView).toContain("[▼ 回到底部]");

		// 2. Roll Wheel Up once more (`\x1b[<64;20;10M`) -> stays in overlay and scrolls further up
		term.sendInput("\x1b[<64;20;10M");
		await term.waitForRender();
		expect(mode.ui.hasOverlay()).toBe(true);

		// 3. Roll Wheel Down twice (`button 65`: `\x1b[<65;20;10M`) -> reaches bottom and auto-closes back to live editor!
		term.sendInput("\x1b[<65;20;10M");
		await term.waitForRender();
		term.sendInput("\x1b[<65;20;10M");
		await term.waitForRender(() => !mode.ui.hasOverlay());
		expect(mode.ui.hasOverlay()).toBe(false);
		expect(mode.ui.getFocused()).toBe(mode.editor);

		// 4. Open again via Wheel Up, then click `[▼ 回到底部]` on the footer row -> closes immediately!
		term.sendInput("\x1b[<64;20;10M");
		await term.waitForRender(() => mode.ui.hasOverlay());
		const vp = term.getViewport().map(r => Bun.stripANSI(r));
		const footerRow0 = vp.findIndex(r => r.includes("[▼ 回到底部]"));
		expect(footerRow0).toBeGreaterThanOrEqual(0);
		const btnIdx = vp[footerRow0]!.indexOf("[▼ 回到底部]");
		const btnCol1Based = visibleWidth(vp[footerRow0]!.slice(0, btnIdx)) + 2;
		term.sendInput(`\x1b[<0;${btnCol1Based};${footerRow0 + 1}M`);
		await term.waitForRender(() => !mode.ui.hasOverlay());
		expect(mode.ui.hasOverlay()).toBe(false);
	});
});
