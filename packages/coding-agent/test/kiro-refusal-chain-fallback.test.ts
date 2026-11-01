// Session-level proof for Kiro classifier refusals served through Magpie: the gateway answers
// HTTP 400 `<model> refused this request (safety filter: <category>) via Kiro` with no
// `stop_details`. The real openai-completions provider must normalize it so the session walks
// the `magpie/kiro/*` chain, switches off the Claude family, and keeps the refusal out of replay.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { FetchImpl, Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const REFUSAL_BODY = JSON.stringify({
	error: {
		message: "claude-opus-5.5 refused this request (safety filter: content_filter) via Kiro",
		type: "invalid_request_error",
	},
});

describe("Kiro refusal via Magpie walks the magpie/kiro/* chain", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-kiro-refusal-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
		const modelsPath = path.join(tempDir.path(), "models.json");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					magpie: {
						baseUrl: "http://127.0.0.1:3425/v1",
						apiKey: "magpie",
						api: "openai-completions",
						models: [{ id: "kiro/claude-opus-5.5", name: "Kiro Opus" }],
					},
				},
			}),
		);
		modelRegistry = new ModelRegistry(authStorage, modelsPath);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	beforeEach(() => {
		modelRegistry.clearSuppressedSelectors();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		vi.restoreAllMocks();
	});

	it("switches to the first chain entry, pins it, and drops the refusal from replay", async () => {
		const primary = modelRegistry.find("magpie", "kiro/claude-opus-5.5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected test models to resolve");
		expect(primary.api).toBe("openai-completions");

		const requested: string[] = [];
		const replayed: Message[][] = [];
		let primaryRequests = 0;
		const mock = createMockModel();
		const refusingFetch: FetchImpl = (async () => {
			primaryRequests += 1;
			return new Response(REFUSAL_BODY, { status: 400, headers: { "content-type": "application/json" } });
		}) as unknown as FetchImpl;

		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requested.push(`${model.provider}/${model.id}`);
				if (model.provider === primary.provider) {
					return streamOpenAICompletions(primary as Model<"openai-completions">, context, {
						...options,
						apiKey: typeof options?.apiKey === "string" ? options.apiKey : "magpie-test-key",
						fetch: refusingFetch,
					});
				}
				replayed.push(context.messages);
				mock.push({ content: ["answered on fallback"] });
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxRetries": 3,
			"retry.fallbackChains": {
				"magpie/kiro/*": [`${fallback.provider}/${fallback.id}`],
			},
			"retry.fallbackRevertPolicy": "cooldown-expiry",
		});
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);

		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });
		const applied: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") applied.push(event);
		});
		let now = Date.now();
		vi.spyOn(Date, "now").mockImplementation(() => now);

		await session.prompt("Trigger the Kiro refusal");
		await session.waitForIdle();

		// One refused request on Kiro, no same-model retries, then the chain's first entry.
		expect(requested).toEqual([`${primary.provider}/${primary.id}`, `${fallback.provider}/${fallback.id}`]);
		expect(primaryRequests).toBe(1);
		expect(applied).toHaveLength(1);
		expect(applied[0]).toMatchObject({
			from: `${primary.provider}/${primary.id}`,
			to: `${fallback.provider}/${fallback.id}`,
			role: "magpie/kiro/*",
			reason: expect.stringContaining("refused this request"),
		});
		expect(session.model?.provider).toBe(fallback.provider);
		expect(session.model?.id).toBe(fallback.id);
		expect(JSON.stringify(replayed[0])).not.toContain("refused this request");

		// A refusal pins the fallback: the next turn does not return to the refusing model.
		now += 10 * 60 * 1000;
		await session.prompt("Next turn stays on the fallback");
		await session.waitForIdle();
		expect(requested.at(-1)).toBe(`${fallback.provider}/${fallback.id}`);
		expect(primaryRequests).toBe(1);
	}, 30_000);
});
