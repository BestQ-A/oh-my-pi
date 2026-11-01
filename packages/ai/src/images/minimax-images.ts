import type { Model } from "@oh-my-pi/pi-catalog/types";
import { isRecord } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import {
	emptyUsage,
	ImageApiError,
	imageBaseUrl,
	postJson,
	sniffBase64ImageMimeType,
	toDataUrl,
	validateImageInput,
} from "./shared";
import type { GeneratedImage, ImageGenerationOptions, ImageGenerationRequest, ImageGenerationResult } from "./types";

const MINIMAX_PROVIDERS = new Set(["minimax", "minimax-cn", "minimax-code", "minimax-code-cn"]);
const MINIMAX_MAX_PROMPT_CHARS = 1500;
const MINIMAX_MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const MINIMAX_REFERENCE_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png"]);

export function isMiniMaxImageModel(
	model: Pick<Model, "provider" | "baseUrl" | "api" | "kind" | "id" | "requestModelId">,
): boolean {
	const base = model.baseUrl?.toLowerCase() ?? "";
	const isMiniMaxHost =
		MINIMAX_PROVIDERS.has(model.provider) || base.includes("api.minimax.io") || base.includes("api.minimaxi.com");
	if (!isMiniMaxHost) return false;
	const wireId = model.requestModelId ?? model.id;
	return model.kind === "image" || model.api === "openai-images" || /^image-01/i.test(wireId);
}

function resolveMiniMaxImageEndpoint(model: Model): string {
	const raw = imageBaseUrl(model).replace(/\/(?:anthropic|v1)\/?$/i, "");
	return `${raw}/v1/image_generation`;
}

function clampPrompt(prompt: string): string {
	if (prompt.length <= MINIMAX_MAX_PROMPT_CHARS) return prompt;
	// Avoid splitting a UTF-16 surrogate pair at the boundary.
	let sliced = prompt.slice(0, MINIMAX_MAX_PROMPT_CHARS);
	const lastCode = sliced.charCodeAt(sliced.length - 1);
	if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
		sliced = sliced.slice(0, -1);
	}
	return sliced;
}

function parseDimensions(imageSize?: string): { width: number; height: number } | undefined {
	if (!imageSize) return undefined;
	const match = /^(\d+)x(\d+)$/i.exec(imageSize.trim());
	if (!match) return undefined;
	const width = Number.parseInt(match[1]!, 10);
	const height = Number.parseInt(match[2]!, 10);
	if (
		!Number.isInteger(width) ||
		!Number.isInteger(height) ||
		width < 512 ||
		width > 2048 ||
		height < 512 ||
		height > 2048 ||
		width % 8 !== 0 ||
		height % 8 !== 0
	) {
		return undefined;
	}
	return { width, height };
}

function mapMiniMaxStatusToHttp(statusCode: number): number {
	switch (statusCode) {
		case 1002:
			return 429;
		case 1004:
		case 2049:
			return 401;
		case 1008:
			return 402;
		case 1026:
		case 2013:
			return 400;
		default:
			return 502;
	}
}

/**
 * MiniMax `image-01` / `image-01-live` client (`POST /v1/image_generation` on
 * `api.minimax.io` and `api.minimaxi.com`), supporting both text-to-image and
 * single-image character reference (`subject_reference`).
 */
export async function generateMiniMaxImage(
	model: Model,
	request: ImageGenerationRequest,
	options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
	const fetchImpl = options.fetch ?? fetch;
	const wireModelId = model.requestModelId ?? model.id;
	const inputImages = request.inputImages ?? [];

	if (inputImages.length > 1) {
		throw new AIError.ValidationError(
			`${model.provider}/${model.id} supports at most 1 reference image (received ${inputImages.length})`,
		);
	}

	let subjectReference: Array<{ type: "character"; image_file: string }> | undefined;
	if (inputImages.length === 1) {
		const ref = inputImages[0]!;
		validateImageInput(ref);
		const normalizedMime = ref.mimeType.toLowerCase();
		if (!MINIMAX_REFERENCE_MIME_TYPES.has(normalizedMime)) {
			throw new AIError.ValidationError(
				`${model.provider}/${model.id} reference image must be JPEG or PNG (received ${ref.mimeType})`,
			);
		}
		const approxBytes = Buffer.byteLength(ref.data, "base64");
		if (approxBytes > MINIMAX_MAX_REFERENCE_BYTES) {
			throw new AIError.ValidationError(`${model.provider}/${model.id} reference image exceeds 10 MB limit`);
		}
		subjectReference = [
			{
				type: "character",
				image_file: toDataUrl({
					data: ref.data,
					mimeType: normalizedMime === "image/jpg" ? "image/jpeg" : normalizedMime,
				}),
			},
		];
	}

	const dims = !request.aspectRatio && wireModelId === "image-01" ? parseDimensions(request.imageSize) : undefined;
	const body: Record<string, unknown> = {
		model: wireModelId,
		prompt: clampPrompt(request.prompt),
		response_format: "base64",
		n: Math.min(9, Math.max(1, request.count ?? 1)),
		...(request.aspectRatio
			? { aspect_ratio: request.aspectRatio }
			: dims
				? { width: dims.width, height: dims.height }
				: { aspect_ratio: "1:1" }),
		...(subjectReference ? { subject_reference: subjectReference } : {}),
	};

	const rawResponse = await postJson({
		model,
		url: resolveMiniMaxImageEndpoint(model),
		body,
		apiKey: options.apiKey,
		fetch: fetchImpl,
		signal: options.signal,
	});

	if (!isRecord(rawResponse)) {
		throw new AIError.ProviderResponseError("MiniMax Image API returned a non-object JSON payload", {
			provider: model.provider,
			kind: "envelope",
		});
	}

	const baseResp = isRecord(rawResponse.base_resp) ? rawResponse.base_resp : undefined;
	const statusCode = typeof baseResp?.status_code === "number" ? baseResp.status_code : 0;
	if (statusCode !== 0) {
		const statusMsg = typeof baseResp?.status_msg === "string" ? baseResp.status_msg : "MiniMax image request failed";
		throw new ImageApiError(
			`${model.provider}/${model.id} image request failed (${statusCode}): ${statusMsg}`,
			mapMiniMaxStatusToHttp(statusCode),
		);
	}

	const dataObj = isRecord(rawResponse.data) ? rawResponse.data : undefined;
	const base64List = Array.isArray(dataObj?.image_base64) ? dataObj.image_base64 : [];
	const images: GeneratedImage[] = [];
	for (const entry of base64List) {
		if (typeof entry !== "string" || entry.length === 0) continue;
		images.push({
			data: entry,
			mimeType: sniffBase64ImageMimeType(entry) ?? "image/jpeg",
			...(dims ? { size: `${dims.width}x${dims.height}` } : {}),
		});
	}

	if (images.length === 0) {
		throw new AIError.ProviderResponseError("MiniMax Image API returned no image data", {
			provider: model.provider,
			kind: "envelope",
		});
	}

	return {
		images,
		model: wireModelId,
		usage: emptyUsage(),
	};
}
