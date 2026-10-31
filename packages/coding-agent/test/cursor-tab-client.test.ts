import { describe, expect, it } from "bun:test";
import {
	buildCursorChecksum,
	buildCursorTabVirtualDocument,
	decodeStreamCppConnectStream,
	encodeStreamCppConnectFrame,
	extractCursorTabInlineSuffix,
	requestCursorTabCompletion,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/cursor-tab-client";

function encodeVarint(v: number): Uint8Array {
	const out: number[] = [];
	let n = v >>> 0;
	while (n > 0x7f) {
		out.push((n & 0x7f) | 0x80);
		n >>>= 7;
	}
	out.push(n);
	return new Uint8Array(out);
}

function buildMockStreamCppConnectReply(linesText: string, startLine = 1, endLine = 4): Uint8Array {
	const textBytes = Buffer.from(linesText, "utf8");
	const field1 = Buffer.concat([encodeVarint((1 << 3) | 2), encodeVarint(textBytes.length), textBytes]);
	const rangeProto = Buffer.concat([
		encodeVarint((1 << 3) | 0),
		encodeVarint(startLine),
		encodeVarint((2 << 3) | 0),
		encodeVarint(endLine),
	]);
	const field11 = Buffer.concat([encodeVarint((11 << 3) | 2), encodeVarint(rangeProto.length), rangeProto]);
	const msg = Buffer.concat([field1, field11]);

	const dataFrame = Buffer.alloc(5 + msg.length);
	dataFrame[0] = 0;
	dataFrame.writeUInt32BE(msg.length, 1);
	msg.copy(dataFrame, 5);

	const trailerBytes = Buffer.from("{}", "utf8");
	const trailerFrame = Buffer.alloc(5 + trailerBytes.length);
	trailerFrame[0] = 2;
	trailerFrame.writeUInt32BE(trailerBytes.length, 1);
	trailerBytes.copy(trailerFrame, 5);

	return new Uint8Array(Buffer.concat([dataFrame, trailerFrame]));
}

describe("Cursor Tab (StreamCpp) Connect-RPC client", () => {
	it("generates deterministic rolling XOR-165 x-cursor-checksum headers", () => {
		const mid = "a".repeat(64);
		const cs = buildCursorChecksum(1_793_446_000_000, mid);
		expect(cs).toEndWith(`${mid}/${mid}`);
		expect(cs.length).toBeGreaterThan(64 * 2 + 6);
	});

	it("encodes StreamCppRequest Connect frames and extracts clean inline ghost suffixes from StreamCppResponse", async () => {
		const input = {
			cwd: "E:/DevTools/oh-my-pi",
			draftPrefix: "帮我运行 bun test 检查 usage-dashboard",
			currentLine: "帮我运行 bun test 检查 usage-dashboard",
			dirtyFiles: ["M packages/tui/src/overlays/usage-dashboard.ts"],
			workspaceFiles: ["packages/tui/test/usage-dashboard.test.ts"],
			recentConversation: ["ASSISTANT: 已完成多账号额度重构"],
			overrideToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mock_cursor_token_payload",
		};

		const doc = buildCursorTabVirtualDocument(input);
		expect(doc.totalLines).toBe(5);
		expect(doc.cursorLineZeroIndexed).toBe(4);

		const frame = encodeStreamCppConnectFrame(input);
		expect(frame[0]).toBe(0);
		const payloadLen = new DataView(frame.buffer).getUint32(1, false);
		expect(payloadLen).toBe(frame.byteLength - 5);

		const predictedDoc = `${doc.contents}.test.ts 并确认类型检查通过`;
		const mockRaw = buildMockStreamCppConnectReply(predictedDoc, 1, doc.totalLines);
		const decoded = decodeStreamCppConnectStream(mockRaw);
		expect(decoded.rangeStartLineOneIndexed).toBe(1);
		expect(decoded.rangeEndLineInclusive).toBe(5);
		expect(extractCursorTabInlineSuffix(input.currentLine, decoded, doc.totalLines)).toBe(
			".test.ts 并确认类型检查通过",
		);

		let seenHeaders: Headers | undefined;
		const suffix = await requestCursorTabCompletion({
			...input,
			endpoint: "https://api3.cursor.sh/aiserver.v1.AiService/StreamCpp",
			fetchImpl: (async (_url, init) => {
				seenHeaders = new Headers(init?.headers);
				return new Response(mockRaw, { status: 200 });
			}) as typeof fetch,
		});
		expect(suffix).toBe(".test.ts 并确认类型检查通过");
		expect(seenHeaders?.get("content-type")).toBe("application/connect+proto");
		expect(seenHeaders?.get("x-cursor-client-type")).toBe("ide");
		expect(seenHeaders?.get("x-cursor-streaming")).toBe("true");
	});

	it("reassembles multi-chunk Connect frames with non-1 startLine offsets and returns undefined on trailer or HTTP errors", async () => {
		const chunkA = Buffer.from("帮我提交 git ", "utf8");
		const chunkB = Buffer.from("并推送到远端分支", "utf8");
		const f1A = Buffer.concat([encodeVarint((1 << 3) | 2), encodeVarint(chunkA.length), chunkA]);
		const rangeProto = Buffer.concat([
			encodeVarint((1 << 3) | 0),
			encodeVarint(4),
			encodeVarint((2 << 3) | 0),
			encodeVarint(4),
		]);
		const f11 = Buffer.concat([encodeVarint((11 << 3) | 2), encodeVarint(rangeProto.length), rangeProto]);
		const msgA = Buffer.concat([f11, f1A]);
		const frameA = Buffer.alloc(5 + msgA.length);
		frameA[0] = 0;
		frameA.writeUInt32BE(msgA.length, 1);
		msgA.copy(frameA, 5);

		const f1B = Buffer.concat([encodeVarint((1 << 3) | 2), encodeVarint(chunkB.length), chunkB]);
		const frameB = Buffer.alloc(5 + f1B.length);
		frameB[0] = 0;
		frameB.writeUInt32BE(f1B.length, 1);
		f1B.copy(frameB, 5);

		const okTrailer = Buffer.from("{}", "utf8");
		const frameT = Buffer.alloc(5 + okTrailer.length);
		frameT[0] = 2;
		frameT.writeUInt32BE(okTrailer.length, 1);
		okTrailer.copy(frameT, 5);

		const multiFrameStream = new Uint8Array(Buffer.concat([frameA, frameB, frameT]));
		const decoded = decodeStreamCppConnectStream(multiFrameStream);
		expect(decoded.rangeStartLineOneIndexed).toBe(4);
		expect(extractCursorTabInlineSuffix("帮我提交 git ", decoded, 4)).toBe("并推送到远端分支");

		// Connect trailer carrying an RPC error must reject cleanly -> undefined
		const errTrailer = Buffer.from('{"error":{"code":"unauthenticated","message":"invalid token"}}', "utf8");
		const errFrameT = Buffer.alloc(5 + errTrailer.length);
		errFrameT[0] = 2;
		errFrameT.writeUInt32BE(errTrailer.length, 1);
		errTrailer.copy(errFrameT, 5);
		const errDecoded = decodeStreamCppConnectStream(new Uint8Array(Buffer.concat([frameA, frameB, errFrameT])));
		expect(extractCursorTabInlineSuffix("帮我提交 git ", errDecoded, 4)).toBeUndefined();

		// Non-200 HTTP response returns undefined so caller falls back to fast LLM
		const httpFail = await requestCursorTabCompletion({
			cwd: "E:/DevTools/oh-my-pi",
			draftPrefix: "帮我提交 git ",
			currentLine: "帮我提交 git ",
			overrideToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.mock_token_payload",
			fetchImpl: (async () => new Response("Forbidden", { status: 403 })) as unknown as typeof fetch,
		});
		expect(httpFail).toBeUndefined();
	});
});
