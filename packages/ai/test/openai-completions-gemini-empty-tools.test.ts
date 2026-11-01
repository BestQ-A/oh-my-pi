// Regression coverage for Gemini / OpenCode-Go OpenAI-compat proxy quirks:
// 1. Resolved Gemini `openai-completions` routes (both `gemini-*` model IDs and
//    gateway routing groups named after Gemini) receive
//    `compat.geminiEmptyToolArrayWorkaround === true`.
// 2. When tools are declared, silent 0-tool turns emitting literal `"[]"` with
//    `finish_reason: "content_filter"` normalize to `"stop"` without mutating
//    `output.content` (preserving streamed `contentIndex` alignment across
//    interleaved thinking/text blocks and avoiding fabricated `"OK"` prose).
// 3. Zero-text `content_filter` stops, toolless `"[]"` `content_filter` stops,
//    and non-empty prose `content_filter` stops on Gemini routes still surface
//    as `stopReason: "error"`.
// 4. Replaying a literal `"[]"` assistant turn on Gemini routes rewrites wire
//    content to `"OK."` so Gemini's function-calling decoder is not poisoned,
//    whereas non-Gemini models (`gpt-4o-mini`, etc.) preserve `"[]"` unchanged.
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "bun:test";
import { convertMessages, streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { AssistantMessage, Context, FetchImpl, Model, ModelSpec, Tool } from "@oh-my-pi/pi-ai/types";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function materializeCompletionsModel(spec: ModelSpec<"openai-completions">): Model<"openai-completions"> {
	const policy = resolveModelPolicy(spec);
	return {
		...spec,
		identity: policy.identity,
		compat: policy.compat,
	};
}

const nonGeminiModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

const geminiProxyModel = materializeCompletionsModel({
	id: "acp-agy/google:gemini-4-argon-high",
	name: "Gemini 4 Argon High",
	api: "openai-completions",
	provider: "magpie",
	baseUrl: "http://127.0.0.1:3425/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 65_536,
});

const geminiRoutingGroupModel = materializeCompletionsModel({
	id: "group/claude-opus-argon",
	name: "Gemini 4 Argon (Opus 槽) · routing group",
	api: "openai-completions",
	provider: "magpie",
	baseUrl: "http://127.0.0.1:3425/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 65_536,
});

const readOnlyTools: Tool[] = [
	{
		name: "read",
		description: "Read a file",
		parameters: Type.Object({ path: Type.String() }),
	},
];

function createSseFetch(events: unknown[]): FetchImpl {
	async function mockFetch(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const event of events) {
					const data = typeof event === "string" ? event : JSON.stringify(event);
					controller.enqueue(encoder.encode(`data: ${data}\n\n`));
				}
				controller.close();
			},
		});
		return new Response(stream, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	return mockFetch as typeof fetch;
}

function completionChunk(modelId: string, extra: Record<string, unknown>): unknown {
	return {
		id: "chatcmpl-gemini-quirk",
		object: "chat.completion.chunk",
		created: 0,
		model: modelId,
		...extra,
	};
}

function makeAssistantBracketTurn(model: Model<"openai-completions">, text = "[]"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("Gemini / OpenCode-Go empty-tool '[]' content_filter and replay quirk", () => {
	it("enables geminiEmptyToolArrayWorkaround only on Gemini-backed chat-completions models", () => {
		expect(geminiProxyModel.compat.geminiEmptyToolArrayWorkaround).toBe(true);
		expect(geminiRoutingGroupModel.compat.geminiEmptyToolArrayWorkaround).toBe(true);
		expect(nonGeminiModel.compat.geminiEmptyToolArrayWorkaround).toBeUndefined();
	});

	it("normalizes tool-enabled '[]' content_filter turns to stop while keeping exact streamed block indices and text", async () => {
		const fetch = createSseFetch([
			completionChunk(geminiProxyModel.id, {
				choices: [{ index: 0, delta: { reasoning_content: "a" }, finish_reason: null }],
			}),
			completionChunk(geminiProxyModel.id, {
				choices: [{ index: 0, delta: { content: "[]" }, finish_reason: null }],
			}),
			completionChunk(geminiProxyModel.id, {
				choices: [{ index: 0, delta: { reasoning_content: "b" }, finish_reason: "content_filter" }],
			}),
			"[DONE]",
		]);

		const context: Context = {
			messages: [{ role: "user", content: "Review this diff", timestamp: Date.now() }],
			tools: readOnlyTools,
		};

		const events = await Array.fromAsync(
			streamOpenAICompletions(geminiProxyModel, context, { apiKey: "test-key", fetch }),
		);
		const doneEvent = events.find(event => event.type === "done");
		expect(doneEvent?.type).toBe("done");
		if (doneEvent?.type !== "done") return;

		expect(doneEvent.message.stopReason).toBe("stop");
		expect(doneEvent.message.errorMessage).toBeUndefined();
		expect(doneEvent.message.content).toEqual([
			{ type: "thinking", thinking: "a", thinkingSignature: "reasoning_content", summary: false },
			{ type: "text", text: "[]" },
			{ type: "thinking", thinking: "b", thinkingSignature: "reasoning_content", summary: false },
		]);

		for (const event of events) {
			if (event.type === "thinking_end") {
				const block = doneEvent.message.content[event.contentIndex];
				expect(block?.type).toBe("thinking");
				if (block?.type === "thinking") {
					expect(block.thinking).toBe(event.content);
				}
			} else if (event.type === "text_end") {
				const block = doneEvent.message.content[event.contentIndex];
				expect(block?.type).toBe("text");
				if (block?.type === "text") {
					expect(block.text).toBe(event.content);
				}
			}
		}
	});

	it("reports an error for zero-text safety blocks, toolless '[]' stops, and non-empty content_filter on Gemini routes", async () => {
		// 1. Zero-text content_filter (even when tools are declared)
		const emptySafetyFetch = createSseFetch([
			completionChunk(geminiProxyModel.id, {
				choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
			}),
			"[DONE]",
		]);
		const emptySafetyResult = await streamOpenAICompletions(
			geminiProxyModel,
			{ messages: [{ role: "user", content: "Test", timestamp: Date.now() }], tools: readOnlyTools },
			{ apiKey: "test-key", fetch: emptySafetyFetch },
		).result();
		expect(emptySafetyResult.stopReason).toBe("error");
		expect(emptySafetyResult.errorMessage).toContain("content_filter");

		// 2. Toolless request emitting "[]" + content_filter
		const toollessFetch = createSseFetch([
			completionChunk(geminiProxyModel.id, {
				choices: [{ index: 0, delta: { content: "[]" }, finish_reason: "content_filter" }],
			}),
			"[DONE]",
		]);
		const toollessResult = await streamOpenAICompletions(
			geminiProxyModel,
			{ messages: [{ role: "user", content: "Test", timestamp: Date.now() }] },
			{ apiKey: "test-key", fetch: toollessFetch },
		).result();
		expect(toollessResult.stopReason).toBe("error");
		expect(toollessResult.errorMessage).toContain("content_filter");

		// 3. Genuine non-empty prose + content_filter
		const blockedProseFetch = createSseFetch([
			completionChunk(geminiProxyModel.id, {
				choices: [{ index: 0, delta: { content: "Partial blocked response" }, finish_reason: "content_filter" }],
			}),
			"[DONE]",
		]);
		const blockedProseResult = await streamOpenAICompletions(
			geminiProxyModel,
			{ messages: [{ role: "user", content: "Test", timestamp: Date.now() }], tools: readOnlyTools },
			{ apiKey: "test-key", fetch: blockedProseFetch },
		).result();
		expect(blockedProseResult.stopReason).toBe("error");
		expect(blockedProseResult.errorMessage).toContain("content_filter");
	});

	it("rewrites literal '[]' 0-tool assistant text to 'OK.' only on tool-enabled Gemini replay", () => {
		for (const model of [geminiProxyModel, geminiRoutingGroupModel]) {
			const withTools = convertMessages(
				model,
				{
					messages: [
						{ role: "user", content: "First turn", timestamp: Date.now() },
						makeAssistantBracketTurn(model, "  []  "),
						{ role: "user", content: "Second turn", timestamp: Date.now() },
					],
					tools: readOnlyTools,
				},
				model.compat,
			);
			const replayedWithTools = withTools[1];
			expect(replayedWithTools?.role).toBe("assistant");
			if (replayedWithTools?.role === "assistant") {
				expect(replayedWithTools.content).toBe("OK.");
			}

			const withoutTools = convertMessages(
				model,
				{
					messages: [
						{ role: "user", content: "Return an empty JSON array", timestamp: Date.now() },
						makeAssistantBracketTurn(model, "[]"),
						{ role: "user", content: "Follow up", timestamp: Date.now() },
					],
				},
				model.compat,
			);
			const replayedWithoutTools = withoutTools[1];
			expect(replayedWithoutTools?.role).toBe("assistant");
			if (replayedWithoutTools?.role === "assistant") {
				expect(replayedWithoutTools.content).toBe("[]");
			}
		}
	});

	it("preserves literal '[]' assistant replies unchanged and keeps '[]' content_filter errors on non-Gemini models", async () => {
		const converted = convertMessages(
			nonGeminiModel,
			{
				messages: [
					{ role: "user", content: "Return an empty JSON list", timestamp: Date.now() },
					makeAssistantBracketTurn(nonGeminiModel, "[]"),
					{ role: "user", content: "Follow up", timestamp: Date.now() },
				],
				tools: readOnlyTools,
			},
			nonGeminiModel.compat,
		);

		const replayed = converted[1];
		expect(replayed?.role).toBe("assistant");
		if (replayed?.role === "assistant") {
			expect(replayed.content).toBe("[]");
		}

		const fetch = createSseFetch([
			completionChunk(nonGeminiModel.id, {
				choices: [{ index: 0, delta: { content: "[]" }, finish_reason: "content_filter" }],
			}),
			"[DONE]",
		]);
		const result = await streamOpenAICompletions(
			nonGeminiModel,
			{ messages: [{ role: "user", content: "Test", timestamp: Date.now() }], tools: readOnlyTools },
			{ apiKey: "test-key", fetch },
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("content_filter");
	});
});
