import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { ProcProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/proc-protocol";
import { createAgentHubRuntime } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { attachIrcWakeTurnMonitor, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

const TEST_AGENT: AgentDefinition = {
	name: "worker",
	description: "Mid-flight model switch test worker",
	systemPrompt: "You are a worker subagent.",
	source: "bundled",
};

describe("Subagent mid-flight model switch and continuation", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let modelA: Model;
	let createSessionSpy: { mockRestore(): void } | undefined;
	const sessionsToDispose: AgentSession[] = [];

	beforeEach(async () => {
		initTheme();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AsyncJobManager.resetForTests();

		tempDir = TempDir.createSync("@pi-subagent-model-switch-");
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage);
		spyOn(modelRegistry, "refreshSelectedModelMetadata").mockImplementation(async model => model);

		const foundA = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		const foundB = modelRegistry.find("openai", "gpt-5");
		if (!foundA || !foundB) {
			throw new Error("Expected built-in anthropic/claude-sonnet-4-5 and openai/gpt-5 models in registry");
		}
		modelA = foundA;
	});

	afterEach(async () => {
		createSessionSpy?.mockRestore();
		createSessionSpy = undefined;
		for (const sess of sessionsToDispose.splice(0)) {
			await sess.dispose({ drainTimeoutMs: 50 }).catch(() => {});
		}
		authStorage.close();
		tempDir.removeSync();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		AsyncJobManager.resetForTests();
	});

	function createParentToolSession(manager?: AsyncJobManager): ToolSession {
		return {
			cwd: tempDir.path(),
			hasUI: false,
			getAgentId: () => "Main",
			getSessionId: () => "Main",
			getSessionFile: () => null,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "launch.enabled": false }),
			modelRegistry,
			authStorage,
			agentRegistry: AgentRegistry.global(),
			agentLifecycle: () => AgentLifecycleManager.global(),
			asyncJobManager: manager,
		} as unknown as ToolSession;
	}

	it("aborts a stalled in-flight LLM turn via proc://<id>/model and seamlessly finishes runSubprocess on the new model with tool history intact", async () => {
		const turn2StalledOnModelA = Promise.withResolvers<void>();
		let modelAAborted = false;
		const seenCalls: Array<{ model: string; messagesJson: string }> = [];

		const probeTool: AgentTool = {
			name: "probe_fact",
			label: "Probe",
			description: "Returns a durable workspace fact",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text", text: "FACT_TOKEN_991" }] }),
		};

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});

		const spy = spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: modelA,
					systemPrompt: ["You are a worker."],
					tools: [probeTool],
					messages: [],
				},
				convertToLlm,
				streamFn: (activeModel, context, streamOpts) => {
					const selector = `${activeModel.provider}/${activeModel.id}`;
					seenCalls.push({ model: selector, messagesJson: JSON.stringify(context.messages) });
					const stream = new AssistantMessageEventStream();

					if (seenCalls.length === 1) {
						// Turn 1 on Model A: execute probe_fact tool cleanly
						const msg: AssistantMessage = {
							role: "assistant",
							content: [{ type: "toolCall", id: "tc-probe-1", name: "probe_fact", arguments: {} }],
							api: activeModel.api,
							provider: activeModel.provider,
							model: activeModel.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						};
						queueMicrotask(() => {
							stream.push({ type: "start", partial: msg });
							stream.push({ type: "done", reason: "toolUse", message: msg });
						});
						return stream;
					}

					if (activeModel.provider === "anthropic") {
						// Turn 2 on Model A: emit partial text and stall until mid-flight model switch aborts it!
						const partial: AssistantMessage = {
							role: "assistant",
							content: [{ type: "text", text: "STUCK_PARTIAL_FROM_OLD_MODEL" }],
							api: activeModel.api,
							provider: activeModel.provider,
							model: activeModel.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
						queueMicrotask(() => {
							stream.push({ type: "start", partial });
							turn2StalledOnModelA.resolve();
						});
						streamOpts?.signal?.addEventListener(
							"abort",
							() => {
								modelAAborted = true;
								const abortedMsg: AssistantMessage = {
									...partial,
									stopReason: "aborted",
									errorMessage: "Model switched mid-flight",
								};
								stream.push({ type: "error", reason: "aborted", error: abortedMsg });
							},
							{ once: true },
						);
						return stream;
					}

					// Resumed Turn 2 on Model B (`openai/gpt-5`): finishes cleanly using Turn 1's tool result!
					const finalMsg: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "COMPLETED_ON_GPT5_WITH_FACT_TOKEN_991" }],
						api: activeModel.api,
						provider: activeModel.provider,
						model: activeModel.id,
						usage: zeroUsage,
						stopReason: "stop",
						timestamp: Date.now(),
					};
					queueMicrotask(() => {
						stream.push({ type: "start", partial: finalMsg });
						stream.push({ type: "done", reason: "stop", message: finalMsg });
					});
					return stream;
				},
			});

			const subSession = new AgentSession({
				agent,
				sessionManager: options.sessionManager ?? SessionManager.inMemory(tempDir.path()),
				settings,
				modelRegistry,
				toolRegistry: new Map([[probeTool.name, probeTool]]),
			});

			const regId = options.agentId ?? "Worker";
			AgentRegistry.global().register({
				id: regId,
				displayName: regId,
				kind: "sub",
				parentId: options.parentAgentId ?? "Main",
				session: subSession,
				sessionFile: options.sessionManager?.getSessionFile() ?? null,
				status: "running",
			});

			return {
				session: subSession,
				extensionsResult: { extensions: [], errors: [], runtime: {} } as never,
				setToolUIContext: () => {},
				mcpManager: options.mcpManager,
				eventBus: options.eventBus ?? new EventBus(),
			} as unknown as sdkModule.CreateAgentSessionResult;
		});
		createSessionSpy = spy;

		const runPromise = runSubprocess({
			cwd: tempDir.path(),
			agent: TEST_AGENT,
			task: "Probe fact and report result",
			index: 0,
			id: "Worker",
			settings,
			authStorage,
			modelRegistry,
			enableLsp: false,
			structured: false,
			eventBus: new EventBus(),
		});

		await turn2StalledOnModelA.promise;

		const procHandler = new ProcProtocolHandler();
		const parentSession = createParentToolSession();

		const beforeRead = await procHandler.resolve(parseInternalUrl("proc://Worker/model"), {
			session: parentSession,
		});
		expect(beforeRead.content).toContain("Worker: anthropic/claude-sonnet-4-5");
		expect(beforeRead.content).toContain("streaming");

		const switchRes = await procHandler.write(parseInternalUrl("proc://Worker/model"), "openai/gpt-5", {
			session: parentSession,
		});
		const switchText = switchRes.content[0]?.type === "text" ? switchRes.content[0].text : "";
		expect(switchText).toContain("Switched subagent Worker from anthropic/claude-sonnet-4-5 to openai/gpt-5");
		expect(switchText).toContain("interrupted in-flight turn and resumed immediately");

		const finalResult = await runPromise;
		expect(spy).toHaveBeenCalledTimes(1);
		expect(modelAAborted).toBe(true);
		expect(finalResult.exitCode).toBe(0);
		expect(finalResult.aborted).not.toBe(true);
		expect(finalResult.output).toBe("COMPLETED_ON_GPT5_WITH_FACT_TOKEN_991");
		expect(finalResult.output).not.toContain("STUCK_PARTIAL_FROM_OLD_MODEL");

		// Confirm GPT-5 received Turn 1's completed `FACT_TOKEN_991` tool result in its context!
		const gpt5Call = seenCalls.find(call => call.model === "openai/gpt-5");
		expect(gpt5Call).toBeDefined();
		expect(gpt5Call!.messagesJson).toContain("FACT_TOKEN_991");
	});

	it("preserves active local tool execution when switched via agent://<id>?model=... and routes the next LLM turn to the new model", async () => {
		const toolStarted = Promise.withResolvers<void>();
		const releaseTool = Promise.withResolvers<void>();
		let toolSignalAborted = false;
		const modelsUsedPerTurn: string[] = [];

		const slowBuildTool: AgentTool = {
			name: "slow_build",
			label: "Slow Build",
			description: "Simulates an active compilation step",
			parameters: type({}),
			execute: async (_id, _params, signal) => {
				signal?.addEventListener("abort", () => {
					toolSignalAborted = true;
				});
				toolStarted.resolve();
				await releaseTool.promise;
				return { content: [{ type: "text", text: "BUILD_ARTIFACT_READY" }] };
			},
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: modelA,
				systemPrompt: ["Worker"],
				tools: [slowBuildTool],
				messages: [],
			},
			convertToLlm,
			streamFn: activeModel => {
				modelsUsedPerTurn.push(`${activeModel.provider}/${activeModel.id}`);
				const stream = new AssistantMessageEventStream();
				const isFirst = modelsUsedPerTurn.length === 1;
				const msg: AssistantMessage = isFirst
					? {
							role: "assistant",
							content: [{ type: "toolCall", id: "tc-build", name: "slow_build", arguments: {} }],
							api: activeModel.api,
							provider: activeModel.provider,
							model: activeModel.id,
							usage: zeroUsage,
							stopReason: "toolUse",
							timestamp: Date.now(),
						}
					: {
							role: "assistant",
							content: [{ type: "text", text: "BUILD_VERIFIED_BY_NEW_MODEL" }],
							api: activeModel.api,
							provider: activeModel.provider,
							model: activeModel.id,
							usage: zeroUsage,
							stopReason: "stop",
							timestamp: Date.now(),
						};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: isFirst ? "toolUse" : "stop", message: msg });
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		const subSession = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[slowBuildTool.name, slowBuildTool]]),
		});
		sessionsToDispose.push(subSession);

		AgentRegistry.global().register({
			id: "ToolWorker",
			displayName: "ToolWorker",
			kind: "sub",
			parentId: "Main",
			session: subSession,
			sessionFile: null,
			status: "running",
		});

		const promptRun = subSession.prompt("Run slow_build and verify");
		await toolStarted.promise;

		const agentHandler = new AgentProtocolHandler();
		const writeRes = await agentHandler.write(parseInternalUrl("agent://ToolWorker?model=openai/gpt-5"), "", {
			session: createParentToolSession(),
		});
		const summary = writeRes.content[0]?.type === "text" ? writeRes.content[0].text : "";
		expect(summary).toContain("active tool call preserved; next turn runs on new model");
		expect(toolSignalAborted).toBe(false);

		releaseTool.resolve();
		await promptRun;
		await subSession.waitForIdle();

		expect(modelsUsedPerTurn).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
		expect(AgentRegistry.global().get("ToolWorker")?.history?.resolvedModel).toBe("openai/gpt-5");
	});

	it("retries an idle errored subagent turn immediately when switched via agent://<id>/model", async () => {
		const modelsCalled: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: modelA, systemPrompt: ["Worker"], tools: [], messages: [] },
			convertToLlm,
			streamFn: activeModel => {
				modelsCalled.push(`${activeModel.provider}/${activeModel.id}`);
				const stream = new AssistantMessageEventStream();
				if (activeModel.provider === "anthropic") {
					const errMsg: AssistantMessage = {
						role: "assistant",
						content: [],
						api: activeModel.api,
						provider: activeModel.provider,
						model: activeModel.id,
						usage: zeroUsage,
						stopReason: "error",
						errorMessage: "429 quota exhausted on anthropic",
						timestamp: Date.now(),
					};
					queueMicrotask(() => {
						stream.push({ type: "start", partial: errMsg });
						stream.push({ type: "error", reason: "error", error: errMsg });
					});
					return stream;
				}
				const okMsg: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "RECOVERED_ON_GPT5" }],
					api: activeModel.api,
					provider: activeModel.provider,
					model: activeModel.id,
					usage: zeroUsage,
					stopReason: "stop",
					timestamp: Date.now(),
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: okMsg });
					stream.push({ type: "done", reason: "stop", message: okMsg });
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		const subSession = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
		});
		sessionsToDispose.push(subSession);

		AgentRegistry.global().register({
			id: "FailedWorker",
			displayName: "FailedWorker",
			kind: "sub",
			parentId: "Main",
			session: subSession,
			sessionFile: null,
			status: "idle",
		});

		await subSession.prompt("Solve hard problem");
		await subSession.waitForIdle();
		expect(subSession.getLastAssistantMessage()?.stopReason).toBe("error");

		const agentHandler = new AgentProtocolHandler();
		const res = await agentHandler.write(parseInternalUrl("agent://FailedWorker/model"), "openai/gpt-5", {
			session: createParentToolSession(),
		});
		const text = res.content[0]?.type === "text" ? res.content[0].text : "";
		expect(text).toContain("resumed unfinished turn on new model");

		await subSession.waitForIdle();
		expect(modelsCalled).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
		expect(subSession.getLastAssistantMessage()?.stopReason).toBe("stop");
	});

	it("wires the `m` key in AgentHubOverlayComponent to switchAgentModel and rejects Main / bash jobs on proc://<id>/model", async () => {
		const agents = new AgentRegistry();
		agents.register({
			id: "ScoutAlpha",
			displayName: "ScoutAlpha",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile: null,
			status: "running",
		});

		const pickedIds: string[] = [];
		const hub = new AgentHubOverlayComponent({
			...createAgentHubRuntime({ settings: Settings.isolated(), registry: agents }),
			observers: new SessionObserverRegistry(),
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			switchAgentModel: (id, setNotice) => {
				pickedIds.push(id);
				setNotice(`Switched subagent ${id} to openai/gpt-5`);
			},
		});
		try {
			hub.render(120);
			hub.handleInput("m");
			expect(pickedIds).toEqual(["ScoutAlpha"]);
			const rendered = hub
				.render(120)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).toContain("Switched subagent ScoutAlpha to openai/gpt-5");
		} finally {
			hub.dispose();
		}

		// Guardrails: Main and bash jobs reject proc://<id>/model cleanly
		const procHandler = new ProcProtocolHandler();
		const manager = new AsyncJobManager({ onJobComplete: async () => {} });
		manager.register("bash", "sleep 10", async () => ({ text: "ok" }), { id: "bg_bash_1", ownerId: "Main" });
		const parentSession = createParentToolSession(manager);

		await expect(
			procHandler.write(parseInternalUrl("proc://Main/model"), "openai/gpt-5", { session: parentSession }),
		).rejects.toThrow("primary session");
		await expect(
			procHandler.write(parseInternalUrl("proc://bg_bash_1/model"), "openai/gpt-5", { session: parentSession }),
		).rejects.toThrow("bash job, not a subagent");
	});

	it("delivers the recovered result to the parent AsyncJobManager when parent switches a failed child via proc://<id>/model with only a model selector", async () => {
		const deliveredToParent = Promise.withResolvers<{ jobId: string; text: string }>();
		const manager = new AsyncJobManager({
			onJobComplete: async (jobId, text) => {
				deliveredToParent.resolve({ jobId, text });
			},
		});
		manager.registerDeliverySink("Main", async (jobId, text) => {
			deliveredToParent.resolve({ jobId, text });
		});

		const modelsCalled: string[] = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: modelA, systemPrompt: ["Worker"], tools: [], messages: [] },
			convertToLlm,
			streamFn: activeModel => {
				modelsCalled.push(`${activeModel.provider}/${activeModel.id}`);
				const stream = new AssistantMessageEventStream();
				if (activeModel.provider === "anthropic") {
					const errMsg: AssistantMessage = {
						role: "assistant",
						content: [],
						api: activeModel.api,
						provider: activeModel.provider,
						model: activeModel.id,
						usage: zeroUsage,
						stopReason: "error",
						errorMessage: "529 provider overloaded",
						timestamp: Date.now(),
					};
					queueMicrotask(() => {
						stream.push({ type: "start", partial: errMsg });
						stream.push({ type: "error", reason: "error", error: errMsg });
					});
					return stream;
				}
				const okMsg: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "PARENT_RECEIVED_RECOVERED_CHILD_OUTPUT" }],
					api: activeModel.api,
					provider: activeModel.provider,
					model: activeModel.id,
					usage: zeroUsage,
					stopReason: "stop",
					timestamp: Date.now(),
				};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: okMsg });
					stream.push({ type: "done", reason: "stop", message: okMsg });
				});
				return stream;
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		const subSession = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			asyncJobManager: manager,
		});
		sessionsToDispose.push(subSession);

		AgentRegistry.global().register({
			id: "RecoverWorker",
			displayName: "RecoverWorker",
			kind: "sub",
			parentId: "Main",
			session: subSession,
			sessionFile: null,
			status: "idle",
		});

		// Child failed on its initial run; attachIrcWakeTurnMonitor now owns subsequent wake/resume turns
		await subSession.prompt("Finish the migration");
		await subSession.waitForIdle();
		expect(subSession.getLastAssistantMessage()?.stopReason).toBe("error");

		attachIrcWakeTurnMonitor(subSession, {
			id: "RecoverWorker",
			agent: TEST_AGENT,
			structured: false,
			artifactsDir: tempDir.path(),
			eventBus: new EventBus(),
		});

		const procHandler = new ProcProtocolHandler();
		const parentToolSession = createParentToolSession(manager);
		const writeRes = await procHandler.write(parseInternalUrl("proc://RecoverWorker/model"), "openai/gpt-5", {
			session: parentToolSession,
		});
		const summary = writeRes.content[0]?.type === "text" ? writeRes.content[0].text : "";
		expect(summary).toContain("resumed unfinished turn on new model");

		const delivery = await deliveredToParent.promise;
		expect(delivery.jobId).toContain("RecoverWorker");
		expect(delivery.text).toContain("PARENT_RECEIVED_RECOVERED_CHILD_OUTPUT");
		expect(modelsCalled).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
	});
});
