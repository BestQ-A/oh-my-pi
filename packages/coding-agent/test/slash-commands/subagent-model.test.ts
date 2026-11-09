import { describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import {
	executeBuiltinSlashCommand,
	lookupBuiltinSlashCommand,
	type SlashCommandRuntime,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { parseSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";

function createHarness() {
	const model = getBundledModel("openai", "gpt-5")!;
	const modelRegistry = { getAll: () => [model], getAvailable: () => [model] };
	const switchModelAndContinue = vi.fn(async () => ({ model: "openai/gpt-5", resumed: true }));
	const prompt = vi.fn(async () => true);
	const agentRegistry = new AgentRegistry();
	agentRegistry.register({
		id: "QA Worker",
		displayName: "QA Worker",
		kind: "sub",
		session: { switchModelAndContinue, prompt, modelRegistry } as unknown as AgentSessionHandle,
		status: "running",
		sessionFile: null,
	});
	const session = {
		settings: Settings.isolated(),
		agentRegistry,
		modelRegistry,
	};
	const showError = vi.fn();
	const showSubagentModelPicker = vi.fn();
	return {
		model,
		switchModelAndContinue,
		prompt,
		showError,
		showSubagentModelPicker,
		tui: {
			ctx: {
				session,
				editor: { setText: vi.fn() },
				statusLine: { invalidate: vi.fn() },
				showStatus: vi.fn(),
				showError,
				showSubagentModelPicker,
			} as unknown as InteractiveModeContext,
		},
		generic: { session, output: vi.fn() } as unknown as SlashCommandRuntime,
	};
}

describe("subagent model slash commands", () => {
	it("switches a space-containing agent ID in the TUI and retains the literal follow-up", async () => {
		const harness = createHarness();
		await executeBuiltinSlashCommand(`/subagent model "QA Worker" openai/gpt-5 Keep  'two spaces'`, harness.tui);
		expect(harness.showError).not.toHaveBeenCalled();
		expect(harness.switchModelAndContinue).toHaveBeenCalledWith(harness.model, expect.any(Object));
		expect(harness.prompt).toHaveBeenCalledWith("Keep  'two spaces'", expect.any(Object));
	});

	it("opens the TUI jobs model picker for the full quoted agent ID", async () => {
		const harness = createHarness();
		await executeBuiltinSlashCommand("/jobs model 'QA Worker'", harness.tui);
		expect(harness.showSubagentModelPicker).toHaveBeenCalledWith("QA Worker");
	});

	it("switches a quoted job target through the generic command handler", async () => {
		const harness = createHarness();
		const command = parseSlashCommand("/jobs model 'QA Worker' openai/gpt-5")!;
		const handle = lookupBuiltinSlashCommand(command.name)?.handle;
		if (!handle) throw new Error("/jobs generic handler missing");
		expect(await handle(command, harness.generic)).toEqual({ consumed: true });
		expect(harness.switchModelAndContinue).toHaveBeenCalledWith(harness.model, expect.any(Object));
	});
});
