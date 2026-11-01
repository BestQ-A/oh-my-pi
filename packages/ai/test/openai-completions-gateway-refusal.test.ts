// Magpie reports an upstream Claude classifier refusal (Kiro) as a plain HTTP 400
// whose message reads `<model> refused this request (safety filter: <category>) via <backend>`.
// The wire carries no `stop_details`, so without normalization the session classifies it as a
// terminal content-blocked error and never walks the fallback chain.
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const completionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

function rejectWith(status: number, message: string): FetchImpl {
	async function mockFetch(): Promise<Response> {
		return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
			status,
			headers: { "content-type": "application/json" },
		});
	}
	return mockFetch as unknown as FetchImpl;
}

async function run(fetch: FetchImpl) {
	return streamOpenAICompletions(completionsModel, context, { apiKey: "test-key", fetch }).result();
}

describe("gateway classifier refusal", () => {
	it.each(["content_filter", "refusal"])(
		"normalizes a %s refusal to stopDetails.type=refusal",
		async category => {
			const result = await run(
				rejectWith(400, `claude-opus-5.5 refused this request (safety filter: ${category}) via Kiro`),
			);

			expect(result.stopReason).toBe("error");
			expect(result.stopDetails?.type).toBe("refusal");
			expect(result.stopDetails?.category).toBe(category);
		},
		10_000,
	);

	it("normalizes a refusal delivered as a plain-text body", async () => {
		async function plainTextFetch(): Promise<Response> {
			return new Response("claude-opus-5.5 refused this request (safety filter: refusal) via Kiro", {
				status: 400,
				headers: { "content-type": "text/plain" },
			});
		}
		const result = await run(plainTextFetch as unknown as FetchImpl);

		expect(result.stopReason).toBe("error");
		expect(result.stopDetails?.type).toBe("refusal");
		expect(result.stopDetails?.category).toBe("refusal");
	}, 10_000);

	it("leaves an ordinary 400 without refusal details", async () => {
		const result = await run(rejectWith(400, "invalid_request_error: unknown field 'temperaturee'"));

		expect(result.stopReason).toBe("error");
		expect(result.stopDetails).toBeUndefined();
	}, 10_000);
});
