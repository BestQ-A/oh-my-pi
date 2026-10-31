/**
 * Direct Connect-RPC Protobuf client for Cursor's proprietary Fusion `Tab` model
 * (`aiserver.v1.AiService/StreamCpp` on `https://api3.cursor.sh`).
 *
 * Reconstructed from Cursor v3.25.6 (`cursor_tab_cpp.proto`):
 * - Zero reasoning/thinking tokens (~450–700 ms warm HTTP keep-alive round-trip)
 * - Draws from Cursor's unlimited Tab autocomplete pool (zero chat-credit burn)
 * - Auto-discovers Bearer token from `CURSOR_ACCESS_TOKEN`, `omp` AuthStorage (`cursor`),
 *   or local Cursor IDE SQLite (`state.vscdb` `cursorAuth/accessToken`, cached by mtime).
 */
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const CURSOR_TAB_ENDPOINT = "https://api3.cursor.sh/aiserver.v1.AiService/StreamCpp";
const CURSOR_TAB_WARM_URL = "https://api3.cursor.sh";
const CURSOR_IDE_VERSION = "3.25.6";

export interface CursorTabCompletionInput {
	cwd: string;
	draftPrefix: string;
	currentLine: string;
	dirtyFiles?: readonly string[];
	workspaceFiles?: readonly string[];
	recentConversation?: readonly string[];
	overrideToken?: string;
	endpoint?: string;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}

interface CachedCursorIdeToken {
	dbPath: string;
	mtimeMs: number;
	token: string | undefined;
}

let cachedIdeToken: CachedCursorIdeToken | undefined;
let prewarmed = false;
const machineIdHex = createHash("sha256").update(`omp-cursor-tab:${os.hostname()}`).digest("hex");

/** Cursor's rolling 6-byte XOR-165 timestamp + SHA-256 machineId header (`x-cursor-checksum`). */
export function buildCursorChecksum(nowMs = Date.now(), midHex = machineIdHex): string {
	const ts = Math.floor(nowMs / 1_000_000);
	const bytes = new Uint8Array([
		Math.floor(ts / 2 ** 40) & 0xff,
		Math.floor(ts / 2 ** 32) & 0xff,
		(ts >>> 24) & 0xff,
		(ts >>> 16) & 0xff,
		(ts >>> 8) & 0xff,
		ts & 0xff,
	]);
	let prev = 165;
	for (let i = 0; i < bytes.length; i++) {
		const next = ((bytes[i]! ^ prev) + (i % 256)) & 0xff;
		bytes[i] = next;
		prev = next;
	}
	const tsB64 = Buffer.from(bytes).toString("base64url");
	return `${tsB64}${midHex}/${midHex}`;
}

function candidateCursorStateDbPaths(): string[] {
	const home = os.homedir();
	if (process.platform === "win32") {
		const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
		return [path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb")];
	}
	if (process.platform === "darwin") {
		return [path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")];
	}
	return [path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb")];
}

interface TokenRow {
	value?: unknown;
}

/** Read & cache `cursorAuth/accessToken` from local Cursor IDE `state.vscdb` (0 ms when mtime unchanged). */
export function readLocalCursorIdeAccessToken(): string | undefined {
	const envToken = process.env.CURSOR_ACCESS_TOKEN?.trim();
	if (envToken) return envToken;

	for (const dbPath of candidateCursorStateDbPaths()) {
		let stat: fs.Stats;
		try {
			stat = fs.statSync(dbPath);
		} catch {
			continue;
		}
		if (cachedIdeToken && cachedIdeToken.dbPath === dbPath && cachedIdeToken.mtimeMs === stat.mtimeMs) {
			return cachedIdeToken.token;
		}
		let db: Database | undefined;
		try {
			db = new Database(dbPath, { readonly: true });
			const query = db.query<TokenRow, [string]>("SELECT value FROM ItemTable WHERE key = ?");
			const row = query.get("cursorAuth/accessToken");
			const token = typeof row?.value === "string" && row.value.trim().length > 20 ? row.value.trim() : undefined;
			cachedIdeToken = { dbPath, mtimeMs: stat.mtimeMs, token };
			return token;
		} catch {
			cachedIdeToken = { dbPath, mtimeMs: stat.mtimeMs, token: undefined };
		} finally {
			db?.close();
		}
	}
	return undefined;
}

/** Pre-warm TLS/HTTP2 socket to `api3.cursor.sh` so the first keystroke avoids a cold handshake. */
export function prewarmCursorTabConnection(fetchImpl: typeof fetch = fetch): void {
	if (prewarmed) return;
	if (!readLocalCursorIdeAccessToken()) return;
	prewarmed = true;
	void fetchImpl(CURSOR_TAB_WARM_URL, {
		method: "HEAD",
		headers: { "user-agent": "connect-es/1.6.1" },
		signal: AbortSignal.timeout(4_000),
	}).catch(() => {});
}

// ─── Minimal Protobuf Wire Encoder / Decoder (`cursor_tab_cpp.proto`) ────────

function encodeVarint(value: number): Uint8Array {
	const out: number[] = [];
	let n = value >>> 0;
	while (n > 0x7f) {
		out.push((n & 0x7f) | 0x80);
		n >>>= 7;
	}
	out.push(n);
	return new Uint8Array(out);
}

function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
	let total = 0;
	for (const c of chunks) total += c.byteLength;
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		merged.set(c, offset);
		offset += c.byteLength;
	}
	return merged;
}

function pbVarintField(fieldNo: number, value: number): Uint8Array {
	return concatBytes(encodeVarint((fieldNo << 3) | 0), encodeVarint(value));
}

function pbBytesField(fieldNo: number, payload: Uint8Array): Uint8Array {
	return concatBytes(encodeVarint((fieldNo << 3) | 2), encodeVarint(payload.byteLength), payload);
}

function pbStringField(fieldNo: number, text: string): Uint8Array {
	return pbBytesField(fieldNo, Buffer.from(text, "utf8"));
}

/** Build the virtual Markdown buffer & 0-indexed `(line, col)` sent in `StreamCppRequest.current_file`. */
export function buildCursorTabVirtualDocument(input: CursorTabCompletionInput): {
	contents: string;
	cursorLineZeroIndexed: number;
	cursorColUtf16: number;
	totalLines: number;
} {
	const headerLines: string[] = [`# Workspace: ${input.cwd.replaceAll("\\", "/")}`];
	if (input.dirtyFiles && input.dirtyFiles.length > 0) {
		headerLines.push(`# Modified files: ${input.dirtyFiles.slice(0, 12).join(", ")}`);
	}
	if (input.workspaceFiles && input.workspaceFiles.length > 0) {
		headerLines.push(`# Relevant files: ${input.workspaceFiles.slice(0, 14).join(", ")}`);
	}
	if (input.recentConversation && input.recentConversation.length > 0) {
		for (const turn of input.recentConversation.slice(-3)) {
			headerLines.push(`# ${turn.replace(/[\r\n]+/g, " ").slice(0, 220)}`);
		}
	}

	const draftLines = input.draftPrefix.split(/\r?\n/);
	const allLines = [...headerLines, ...draftLines];
	const lastLine = allLines.at(-1) ?? "";
	return {
		contents: allLines.join("\n"),
		cursorLineZeroIndexed: Math.max(0, allLines.length - 1),
		cursorColUtf16: lastLine.length,
		totalLines: allLines.length,
	};
}

/** Encode `aiserver.v1.StreamCppRequest` wrapped in a 5-byte Connect-RPC uncompressed envelope. */
export function encodeStreamCppConnectFrame(input: CursorTabCompletionInput): Uint8Array {
	const doc = buildCursorTabVirtualDocument(input);
	const cursorPos = concatBytes(
		pbVarintField(1, doc.cursorLineZeroIndexed),
		pbVarintField(2, doc.cursorColUtf16),
	);
	const currentFile = concatBytes(
		pbStringField(1, "PROMPT.md"),
		pbStringField(2, doc.contents),
		pbBytesField(3, cursorPos),
		pbStringField(5, "markdown"),
		pbVarintField(8, doc.totalLines),
		pbVarintField(9, 1),
		pbVarintField(18, 0),
		pbStringField(19, input.cwd.replaceAll("\\", "/")),
	);
	const intentInfo = pbStringField(1, "typing");
	const reqProto = concatBytes(pbBytesField(1, currentFile), pbBytesField(16, intentInfo));

	const envelope = new Uint8Array(5 + reqProto.byteLength);
	envelope[0] = 0;
	const view = new DataView(envelope.buffer);
	view.setUint32(1, reqProto.byteLength, false);
	envelope.set(reqProto, 5);
	return envelope;
}

export interface DecodedStreamCppResult {
	text: string;
	rangeStartLineOneIndexed?: number;
	rangeEndLineInclusive?: number;
	trailerError?: string;
}

function readVarintAt(buf: Uint8Array, start: number): { value: number; next: number } | undefined {
	let value = 0;
	let shift = 0;
	let idx = start;
	while (idx < buf.byteLength) {
		const byte = buf[idx]!;
		idx++;
		value |= (byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) {
			return { value: value >>> 0, next: idx };
		}
		shift += 7;
		if (shift > 35) return undefined;
	}
	return undefined;
}

function decodeLineRange(buf: Uint8Array): { start?: number; end?: number } {
	let idx = 0;
	let start: number | undefined;
	let end: number | undefined;
	while (idx < buf.byteLength) {
		const tag = readVarintAt(buf, idx);
		if (!tag) break;
		idx = tag.next;
		const fno = tag.value >>> 3;
		const wt = tag.value & 7;
		if (wt === 0) {
			const val = readVarintAt(buf, idx);
			if (!val) break;
			idx = val.next;
			if (fno === 1) start = val.value;
			else if (fno === 2) end = val.value;
		} else if (wt === 2) {
			const len = readVarintAt(buf, idx);
			if (!len) break;
			idx = len.next + len.value;
		} else {
			break;
		}
	}
	return { start, end };
}

/** Decode a Connect-RPC `application/connect+proto` byte stream of `StreamCppResponse` frames. */
export function decodeStreamCppConnectStream(raw: Uint8Array): DecodedStreamCppResult {
	let pos = 0;
	let text = "";
	let rangeStartLineOneIndexed: number | undefined;
	let rangeEndLineInclusive: number | undefined;
	let trailerError: string | undefined;

	const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	while (pos + 5 <= raw.byteLength) {
		const flags = raw[pos]!;
		const frameLen = view.getUint32(pos + 1, false);
		pos += 5;
		if (pos + frameLen > raw.byteLength) break;
		const frame = raw.subarray(pos, pos + frameLen);
		pos += frameLen;

		if ((flags & 2) !== 0) {
			const trailerJson = Buffer.from(frame).toString("utf8");
			if (trailerJson.includes('"error"')) {
				trailerError = trailerJson;
			}
			continue;
		}

		let idx = 0;
		while (idx < frame.byteLength) {
			const tag = readVarintAt(frame, idx);
			if (!tag) break;
			idx = tag.next;
			const fieldNo = tag.value >>> 3;
			const wireType = tag.value & 7;

			if (wireType === 0) {
				const v = readVarintAt(frame, idx);
				if (!v) break;
				idx = v.next;
			} else if (wireType === 2) {
				const len = readVarintAt(frame, idx);
				if (!len || len.next + len.value > frame.byteLength) break;
				const sub = frame.subarray(len.next, len.next + len.value);
				idx = len.next + len.value;
				if (fieldNo === 1) {
					text += Buffer.from(sub).toString("utf8");
				} else if (fieldNo === 11) {
					const r = decodeLineRange(sub);
					if (r.start !== undefined) rangeStartLineOneIndexed = r.start;
					if (r.end !== undefined) rangeEndLineInclusive = r.end;
				}
			} else if (wireType === 1) {
				idx += 8;
			} else if (wireType === 5) {
				idx += 4;
			} else {
				break;
			}
		}
	}

	return { text, rangeStartLineOneIndexed, rangeEndLineInclusive, trailerError };
}

/**
 * Extract the inline ghost-text continuation suffix for `currentLine` from
 * `StreamCppResponse`'s replacement block.
 */
export function extractCursorTabInlineSuffix(
	currentLine: string,
	decoded: DecodedStreamCppResult,
	cursorLineOneIndexed: number,
): string | undefined {
	if (decoded.trailerError || !decoded.text) return undefined;

	const replacementLines = decoded.text.split(/\r?\n/);
	const startOne = decoded.rangeStartLineOneIndexed ?? 1;
	const targetIdx = cursorLineOneIndexed - startOne;

	// Locate the predicted version of the cursor's active line
	let candidateLine: string | undefined;
	if (targetIdx >= 0 && targetIdx < replacementLines.length) {
		candidateLine = replacementLines[targetIdx];
	}
	if (!candidateLine || !candidateLine.startsWith(currentLine)) {
		candidateLine = replacementLines.find(line => line.length > currentLine.length && line.startsWith(currentLine));
	}
	if (!candidateLine || !candidateLine.startsWith(currentLine)) return undefined;

	const suffix = candidateLine.slice(currentLine.length);
	return suffix.trim().length > 0 ? suffix : undefined;
}

/**
 * Request a sub-second inline ghost-text completion from Cursor's `StreamCpp` Tab model.
 * Returns `undefined` when no Cursor token is present or when Cursor Tab declines/errors,
 * allowing callers to fall back seamlessly.
 */
export async function requestCursorTabCompletion(input: CursorTabCompletionInput): Promise<string | undefined> {
	const token = input.overrideToken?.trim() || readLocalCursorIdeAccessToken();
	if (!token || input.signal?.aborted) return undefined;

	const doc = buildCursorTabVirtualDocument(input);
	const body = encodeStreamCppConnectFrame(input);
	const fetchFn = input.fetchImpl ?? fetch;

	const response = await fetchFn(input.endpoint ?? CURSOR_TAB_ENDPOINT, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/connect+proto",
			"connect-protocol-version": "1",
			"user-agent": "connect-es/1.6.1",
			"x-cursor-streaming": "true",
			"x-cursor-client-version": CURSOR_IDE_VERSION,
			"x-cursor-client-type": "ide",
			"x-cursor-checksum": buildCursorChecksum(),
			"x-ghost-mode": "true",
			"x-request-id": randomUUID(),
		},
		body,
		signal: input.signal,
	});

	if (!response.ok) return undefined;
	const raw = new Uint8Array(await response.arrayBuffer());
	const decoded = decodeStreamCppConnectStream(raw);
	return extractCursorTabInlineSuffix(input.currentLine, decoded, doc.cursorLineZeroIndexed + 1);
}
