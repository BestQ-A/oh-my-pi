import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";
import { generateImage } from "../src/images";
import { ImageApiError } from "../src/images/shared";

// Minimal valid 1x1 PNG base64
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("MiniMax Token Plan image generation (image-01 / image-01-live)", () => {
	it("bundles image-01 and image-01-live with kind=image on minimax-code and minimax-code-cn", () => {
		const intl = getBundledModel("minimax-code", "image-01");
		const cn = getBundledModel("minimax-code-cn", "image-01");
		const live = getBundledModel("minimax-code", "image-01-live");
		expect(intl).toBeDefined();
		expect(intl.kind).toBe("image");
		expect(intl.baseUrl).toBe("https://api.minimax.io");
		expect(cn).toBeDefined();
		expect(cn.kind).toBe("image");
		expect(cn.baseUrl).toBe("https://api.minimaxi.com");
		expect(live?.kind).toBe("image");
	});

	it("sends text-to-image and single-image character reference requests to /v1/image_generation", async () => {
		const model: Model = {
			...getBundledModel("minimax-code", "image-01"),
			// Also verify trailing /anthropic is normalized cleanly to root /v1/image_generation
			baseUrl: "https://api.minimax.io/anthropic",
		};
		const captured: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
		const fetchStub: FetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			captured.push({
				url: String(input),
				auth: new Headers(init?.headers).get("authorization"),
				body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
			});
			return new Response(
				JSON.stringify({
					id: "trace-123",
					data: { image_base64: [PNG_1X1] },
					metadata: { success_count: 1, failed_count: 0 },
					base_resp: { status_code: 0, status_msg: "success" },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as unknown as FetchImpl;

		const t2i = await generateImage(
			model,
			{ prompt: "a neon cyberpunk terminal", aspectRatio: "16:9", count: 1 },
			{ apiKey: "sk-minimax-plan", fetch: fetchStub },
		);
		expect(t2i.images).toHaveLength(1);
		expect(t2i.images[0]?.mimeType).toBe("image/png");
		expect(captured[0]).toEqual({
			url: "https://api.minimax.io/v1/image_generation",
			auth: "Bearer sk-minimax-plan",
			body: {
				model: "image-01",
				prompt: "a neon cyberpunk terminal",
				response_format: "base64",
				n: 1,
				aspect_ratio: "16:9",
			},
		});

		const i2i = await generateImage(
			model,
			{
				prompt: "standing in a snowy mountain station",
				imageSize: "1536x1024",
				inputImages: [{ data: PNG_1X1, mimeType: "image/png" }],
			},
			{ apiKey: "sk-minimax-plan", fetch: fetchStub },
		);
		expect(i2i.images[0]?.size).toBe("1536x1024");
		expect(captured[1]?.body).toMatchObject({
			model: "image-01",
			width: 1536,
			height: 1024,
			subject_reference: [
				{
					type: "character",
					image_file: `data:image/png;base64,${PNG_1X1}`,
				},
			],
		});
	});

	it("maps MiniMax base_resp non-zero status codes to ImageApiError for fallback chain traversal and validates reference limits", async () => {
		const model = getBundledModel("minimax-code", "image-01");
		const rateLimitedFetch: FetchImpl = (async () =>
			new Response(
				JSON.stringify({
					base_resp: { status_code: 1002, status_msg: "rate limit triggered" },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as FetchImpl;

		const err = await generateImage(
			model,
			{ prompt: "test" },
			{ apiKey: "sk-minimax-plan", fetch: rateLimitedFetch },
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ImageApiError);
		expect((err as ImageApiError).status).toBe(429);

		await expect(
			generateImage(
				model,
				{
					prompt: "two refs",
					inputImages: [
						{ data: PNG_1X1, mimeType: "image/png" },
						{ data: PNG_1X1, mimeType: "image/png" },
					],
				},
				{ apiKey: "sk-minimax-plan", fetch: rateLimitedFetch },
			),
		).rejects.toThrow("at most 1 reference image");
	});
});
