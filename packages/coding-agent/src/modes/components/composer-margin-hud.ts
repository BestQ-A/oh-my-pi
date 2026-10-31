import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	type Component,
	CURSOR_MARKER,
	padding,
	replaceTabs,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { formatActionMarker } from "@oh-my-pi/pi-tui/render/extension-links";
import type { QuotaPoolCapsule } from "@oh-my-pi/pi-tui/status-line";
import { type ThemeColor, theme } from "@oh-my-pi/pi-tui/theme";
import type { TodoItem, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";

export interface MarginHudGitFile {
	status: string;
	path: string;
	fullPath?: string;
}

export interface MarginHudTelemetrySnapshot {
	gpu?: { name: string; usedGb: string; totalGb: string; tempC?: number; utilPct?: number };
	cpuPct?: number;
	ramUsedGb: string;
	ramTotalGb: string;
	gitBranch?: string;
	gitDirtyCount: number;
	gitFiles: readonly MarginHudGitFile[];
	daemons: ReadonlyArray<{ label: string; port?: number; up: boolean }>;
}

export interface MarginHudHostAccess {
	isEnabled(): boolean;
	isPlainEditorActive(): boolean;
	renderCenterEditor(width: number): readonly string[];
	getCwd(): string;
	getActivePresetName(): string | undefined;
	getQuotaCapsules(): readonly QuotaPoolCapsule[];
	getTodoPhases(): readonly TodoPhase[];
	getSubagentSummary(): {
		running: ReadonlyArray<{ id?: string; label: string; elapsed?: string }>;
		recent: ReadonlyArray<{ id?: string; label: string; status: string }>;
	};
	getMcpServers(): ReadonlyArray<{ name: string; tools: number }>;
	isDraftEmpty(): boolean;
	hasNumberedPrediction(): boolean;
	requestRender(): void;
	getPredictionSelectionStatus?(): { total: number; checked: number } | undefined;
}

export interface MarginHudTelemetryCollectorOptions {
	cwd?: () => string;
	onUpdate?: () => void;
	autoStart?: boolean;
	hudStatePath?: string;
	initialSnapshot?: Partial<MarginHudTelemetrySnapshot>;
}

const FAST_POLL_INTERVAL_MS = 5_000;
const GPU_POLL_INTERVAL_MS = 6_000;
const NVIDIA_SMI_TIMEOUT_MS = 2_000;
const GIT_STATUS_TIMEOUT_MS = 2_500;
const TCP_PROBE_TIMEOUT_MS = 350;
const MAX_GIT_FILES = 8;
const GIB_BYTES = 1024 ** 3;

const FULL_COCKPIT_MIN_WIDTH = 140;
const THREE_EDGE_MIN_WIDTH = 110;
const FULL_LEFT_WING_WIDTH = 28;
const FULL_RIGHT_WING_WIDTH = 30;
const THREE_EDGE_RIGHT_WING_WIDTH = 28;
const WING_DIVIDER_PLAIN = " │ ";
const WING_DIVIDER_WIDTH = 3;
const MIN_WING_ROWS = 4;

const FIXED_DAEMON_TARGETS: ReadonlyArray<{ label: string; port: number }> = [
	{ label: "Omni", port: 18799 },
	{ label: "IDA", port: 8745 },
	{ label: "Purge", port: 7788 },
];

const DEFAULT_DAEMONS: ReadonlyArray<{ label: string; port?: number; up: boolean }> = [
	{ label: "Omni", port: 18799, up: false },
	{ label: "IDA", port: 8745, up: false },
	{ label: "Purge", port: 7788, up: false },
	{ label: "HUD", up: false },
];

const QUOTA_SEVERITY_COLORS: Record<QuotaPoolCapsule["severity"], ThemeColor> = {
	ok: "success",
	warning: "warning",
	error: "error",
};

const GIT_STATUS_COLORS: Record<string, ThemeColor> = {
	A: "success",
	"+": "success",
	M: "warning",
	MM: "warning",
	AM: "warning",
	R: "warning",
	RM: "warning",
	C: "warning",
	"?": "warning",
	D: "error",
	U: "error",
	UU: "error",
	AA: "error",
	DD: "error",
};

interface CpuTotals {
	idle: number;
	total: number;
}

function fg(color: ThemeColor, text: string): string {
	return typeof theme === "undefined" ? text : theme.fg(color, text);
}

function bold(text: string): string {
	return typeof theme === "undefined" ? text : theme.bold(text);
}

function sanitizeSingleLine(value: string): string {
	return replaceTabs(sanitizeText(value))
		.replace(/\s*[\r\n]+\s*/g, " ")
		.trim();
}

function sampleCpuTotals(): CpuTotals | undefined {
	const cpus = os.cpus();
	if (cpus.length === 0) return undefined;
	let idle = 0;
	let total = 0;
	for (const cpu of cpus) {
		const times = cpu.times;
		const coreTotal = times.user + times.nice + times.sys + times.idle + times.irq;
		idle += times.idle;
		total += coreTotal;
	}
	return { idle, total };
}

function sampleMemoryGb(): { usedGb: string; totalGb: string } {
	const totalBytes = Math.max(0, os.totalmem());
	const freeBytes = Math.max(0, os.freemem());
	const usedBytes = Math.max(0, totalBytes - freeBytes);
	return {
		usedGb: (usedBytes / GIB_BYTES).toFixed(1),
		totalGb: (totalBytes / GIB_BYTES).toFixed(1),
	};
}

export function shortenGpuName(rawName: string): string {
	let name = sanitizeSingleLine(rawName);
	name = name.replace(/^NVIDIA\s+GeForce\s+/i, "");
	name = name.replace(/^NVIDIA\s+Quadro\s+/i, "");
	name = name.replace(/^NVIDIA\s+/i, "");
	name = name.replace(/\s+Laptop\s+GPU$/i, "M");
	name = name.replace(/\s+GPU$/i, "");
	const trimmed = name.trim();
	return trimmed.length > 0 ? trimmed : sanitizeSingleLine(rawName);
}

export function parseNvidiaSmiCsv(
	stdout: string,
): MarginHudTelemetrySnapshot["gpu"] | undefined {
	for (const rawLine of stdout.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0) continue;
		const parts = line.split(",").map(part => part.trim());
		if (parts.length < 3) continue;
		const rawName = parts[0] ?? "";
		const usedMib = Number.parseFloat(parts[1] ?? "");
		const totalMib = Number.parseFloat(parts[2] ?? "");
		if (!rawName || !Number.isFinite(usedMib) || !Number.isFinite(totalMib) || totalMib <= 0) {
			continue;
		}
		const tempRaw = Number.parseInt(parts[3] ?? "", 10);
		const utilRaw = Number.parseInt(parts[4] ?? "", 10);
		return {
			name: shortenGpuName(rawName),
			usedGb: (Math.max(0, usedMib) / 1024).toFixed(1),
			totalGb: (totalMib / 1024).toFixed(1),
			...(Number.isFinite(tempRaw) ? { tempC: tempRaw } : {}),
			...(Number.isFinite(utilRaw) ? { utilPct: Math.max(0, Math.min(100, utilRaw)) } : {}),
		};
	}
	return undefined;
}

function parseBranchHeader(headerLine: string): string | undefined {
	const body = headerLine.slice(2).trim();
	if (body.length === 0) return undefined;
	const initialMatch = /^(?:No commits yet on|Initial commit on)\s+(.+)$/.exec(body);
	if (initialMatch?.[1]) {
		const branchName = sanitizeSingleLine(initialMatch[1]);
		return branchName.length > 0 ? branchName : undefined;
	}
	if (body.startsWith("HEAD ")) {
		return "HEAD";
	}
	const dotIdx = body.indexOf("...");
	const beforeDots = dotIdx >= 0 ? body.slice(0, dotIdx) : body;
	const bracketIdx = beforeDots.indexOf(" [");
	const branch = sanitizeSingleLine(bracketIdx >= 0 ? beforeDots.slice(0, bracketIdx) : beforeDots);
	return branch.length > 0 ? branch : undefined;
}

function normalizeGitFilePath(rawPath: string): string {
	let cleaned = rawPath.trim();
	const arrowIdx = cleaned.indexOf(" -> ");
	if (arrowIdx >= 0) {
		cleaned = cleaned.slice(arrowIdx + 4).trim();
	}
	if (cleaned.startsWith('"') && cleaned.endsWith('"') && cleaned.length >= 2) {
		cleaned = cleaned.slice(1, -1);
	}
	return sanitizeSingleLine(cleaned.replaceAll("\\", "/"));
}

function shortenNormalizedGitFilePath(cleaned: string): string {
	if (cleaned.length <= 22) {
		return cleaned;
	}
	const base = path.posix.basename(cleaned);
	const parent = path.posix.basename(path.posix.dirname(cleaned));
	if (parent && parent !== "." && parent !== "/") {
		const candidate = `${parent}/${base}`;
		if (candidate.length <= 22) {
			return candidate;
		}
	}
	return base || cleaned;
}

export function parseGitStatusPorcelain(stdout: string): {
	gitBranch?: string;
	gitDirtyCount: number;
	gitFiles: MarginHudGitFile[];
} {
	let gitBranch: string | undefined;
	let gitDirtyCount = 0;
	const gitFiles: MarginHudGitFile[] = [];

	for (const rawLine of stdout.split(/\r?\n/)) {
		if (rawLine.length === 0) continue;
		if (rawLine.startsWith("##")) {
			gitBranch = parseBranchHeader(rawLine);
			continue;
		}
		if (rawLine.startsWith("!!")) {
			continue;
		}
		if (rawLine.length < 4) continue;
		const xy = rawLine.slice(0, 2);
		const rawPath = rawLine.slice(3);
		const status = xy === "??" ? "?" : xy.trim() || "?";
		const fullPath = normalizeGitFilePath(rawPath);
		const shortPath = shortenNormalizedGitFilePath(fullPath);
		if (shortPath.length === 0) continue;
		gitDirtyCount += 1;
		if (gitFiles.length < MAX_GIT_FILES) {
			gitFiles.push({ status, path: shortPath, fullPath });
		}
	}

	return {
		...(gitBranch !== undefined ? { gitBranch } : {}),
		gitDirtyCount,
		gitFiles,
	};
}

async function hasGitAncestor(startDir: string): Promise<boolean> {
	if (!startDir) return false;
	let current = path.resolve(startDir);
	for (let depth = 0; depth < 64; depth++) {
		try {
			await fs.promises.access(path.join(current, ".git"));
			return true;
		} catch {
			// Walk upward
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return false;
}

function execFileAsync(file: string, args: readonly string[], timeoutMs: number): Promise<string | undefined> {
	const { promise, resolve } = Promise.withResolvers<string | undefined>();
	try {
		execFile(
			file,
			[...args],
			{
				timeout: timeoutMs,
				windowsHide: true,
				maxBuffer: 1024 * 1024,
				encoding: "utf8",
			},
			(err, stdout) => {
				if (err) {
					resolve(undefined);
					return;
				}
				resolve(typeof stdout === "string" ? stdout : String(stdout ?? ""));
			},
		);
	} catch {
		resolve(undefined);
	}
	return promise;
}

function probeTcpLoopback(port: number, timeoutMs = TCP_PROBE_TIMEOUT_MS): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = new net.Socket();
	let settled = false;
	const finish = (up: boolean) => {
		if (settled) return;
		settled = true;
		socket.removeAllListeners();
		socket.destroy();
		resolve(up);
	};
	socket.setTimeout(timeoutMs);
	socket.once("connect", () => finish(true));
	socket.once("timeout", () => finish(false));
	socket.once("error", () => finish(false));
	try {
		socket.connect(port, "127.0.0.1");
	} catch {
		finish(false);
	}
	return promise;
}

async function readHudDaemonPort(statePath: string): Promise<number | undefined> {
	let raw: string;
	try {
		raw = await fs.promises.readFile(statePath, "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || typeof parsed.port !== "number" || !Number.isFinite(parsed.port)) {
		return undefined;
	}
	const port = Math.trunc(parsed.port);
	return port > 0 && port <= 65535 ? port : undefined;
}

export class MarginHudTelemetryCollector {
	readonly #getCwd: () => string;
	readonly #onUpdate?: () => void;
	readonly #hudStatePath: string;
	#prevCpu?: CpuTotals;
	#snapshot: MarginHudTelemetrySnapshot;
	#snapshotSignature: string;
	#fastTimer?: NodeJS.Timeout;
	#gpuTimer?: NodeJS.Timeout;
	#running = false;
	#generation = 0;
	#gitInFlight = false;
	#gpuInFlight = false;
	#daemonsInFlight = false;

	constructor(options?: MarginHudTelemetryCollectorOptions) {
		this.#getCwd = options?.cwd ?? (() => process.cwd());
		this.#onUpdate = options?.onUpdate;
		this.#hudStatePath =
			options?.hudStatePath ??
			(process.env.OMP_QUOTA_HUD_STATE_PATH?.trim() ||
				path.join(os.homedir(), ".omp", "cache", "omp-quota-hud.json"));
		this.#prevCpu = sampleCpuTotals();
		const mem = sampleMemoryGb();
		const seed = options?.initialSnapshot;
		this.#snapshot = {
			...(seed?.gpu !== undefined ? { gpu: seed.gpu } : {}),
			...(seed?.cpuPct !== undefined ? { cpuPct: seed.cpuPct } : {}),
			ramUsedGb: seed?.ramUsedGb ?? mem.usedGb,
			ramTotalGb: seed?.ramTotalGb ?? mem.totalGb,
			...(seed?.gitBranch !== undefined ? { gitBranch: seed.gitBranch } : {}),
			gitDirtyCount: seed?.gitDirtyCount ?? 0,
			gitFiles: seed?.gitFiles ? [...seed.gitFiles] : [],
			daemons: seed?.daemons ? [...seed.daemons] : DEFAULT_DAEMONS,
		};
		this.#snapshotSignature = JSON.stringify(this.#snapshot);

		if (options?.autoStart) {
			this.start();
		}
	}

	start(): void {
		if (this.#running) return;
		this.#running = true;
		this.refreshNow();
		this.#fastTimer = setInterval(() => {
			this.#tickFast(this.#generation);
		}, FAST_POLL_INTERVAL_MS);
		this.#fastTimer.unref?.();
		this.#gpuTimer = setInterval(() => {
			void this.#probeGpu(this.#generation);
		}, GPU_POLL_INTERVAL_MS);
		this.#gpuTimer.unref?.();
	}

	stop(): void {
		this.#running = false;
		this.#generation += 1;
		if (this.#fastTimer !== undefined) {
			clearInterval(this.#fastTimer);
			this.#fastTimer = undefined;
		}
		if (this.#gpuTimer !== undefined) {
			clearInterval(this.#gpuTimer);
			this.#gpuTimer = undefined;
		}
	}

	refreshNow(): void {
		const generation = this.#generation;
		this.#tickFast(generation);
		void this.#probeGpu(generation);
	}

	getSnapshot(): MarginHudTelemetrySnapshot {
		return this.#snapshot;
	}

	#commitPatch(generation: number, patch: Partial<MarginHudTelemetrySnapshot>, clearGit = false): void {
		if (generation !== this.#generation) return;
		const nextBranch = clearGit
			? undefined
			: "gitBranch" in patch
				? patch.gitBranch
				: this.#snapshot.gitBranch;
		const nextGpu = "gpu" in patch ? patch.gpu : this.#snapshot.gpu;
		const nextCpu = "cpuPct" in patch ? patch.cpuPct : this.#snapshot.cpuPct;
		const nextSnapshot: MarginHudTelemetrySnapshot = {
			...(nextGpu !== undefined ? { gpu: nextGpu } : {}),
			...(nextCpu !== undefined ? { cpuPct: nextCpu } : {}),
			ramUsedGb: patch.ramUsedGb ?? this.#snapshot.ramUsedGb,
			ramTotalGb: patch.ramTotalGb ?? this.#snapshot.ramTotalGb,
			...(nextBranch !== undefined ? { gitBranch: nextBranch } : {}),
			gitDirtyCount: patch.gitDirtyCount ?? this.#snapshot.gitDirtyCount,
			gitFiles: patch.gitFiles ?? this.#snapshot.gitFiles,
			daemons: patch.daemons ?? this.#snapshot.daemons,
		};
		const nextSignature = JSON.stringify(nextSnapshot);
		if (nextSignature === this.#snapshotSignature) {
			return;
		}
		this.#snapshot = nextSnapshot;
		this.#snapshotSignature = nextSignature;
		this.#onUpdate?.();
	}

	#tickFast(generation: number): void {
		const mem = sampleMemoryGb();
		const nextCpu = sampleCpuTotals();
		let cpuPct = this.#snapshot.cpuPct;
		if (nextCpu && this.#prevCpu) {
			const totalDelta = nextCpu.total - this.#prevCpu.total;
			const idleDelta = nextCpu.idle - this.#prevCpu.idle;
			if (totalDelta > 0) {
				const busy = Math.max(0, Math.min(1, 1 - idleDelta / totalDelta));
				cpuPct = Math.round(busy * 100);
			}
		}
		if (nextCpu) {
			this.#prevCpu = nextCpu;
		}
		this.#commitPatch(generation, {
			...(cpuPct !== undefined ? { cpuPct } : {}),
			ramUsedGb: mem.usedGb,
			ramTotalGb: mem.totalGb,
		});
		void this.#probeGit(generation);
		void this.#probeDaemons(generation);
	}

	async #probeGpu(generation: number): Promise<void> {
		if (this.#gpuInFlight) return;
		this.#gpuInFlight = true;
		try {
			const stdout = await execFileAsync(
				"nvidia-smi",
				[
					"--query-gpu=name,memory.used,memory.total,temperature.gpu,utilization.gpu",
					"--format=csv,noheader,nounits",
				],
				NVIDIA_SMI_TIMEOUT_MS,
			);
			if (generation !== this.#generation) return;
			const gpu = stdout !== undefined ? parseNvidiaSmiCsv(stdout) : undefined;
			if (gpu !== undefined) {
				this.#commitPatch(generation, { gpu });
			}
		} finally {
			this.#gpuInFlight = false;
		}
	}

	async #probeGit(generation: number): Promise<void> {
		if (this.#gitInFlight) return;
		this.#gitInFlight = true;
		try {
			let cwd = "";
			try {
				cwd = this.#getCwd();
			} catch {
				cwd = "";
			}
			if (!cwd || !(await hasGitAncestor(cwd))) {
				this.#commitPatch(
					generation,
					{
						gitBranch: undefined,
						gitDirtyCount: 0,
						gitFiles: [],
					},
					true,
				);
				return;
			}
			const stdout = await execFileAsync(
				"git",
				["-C", cwd, "--no-optional-locks", "status", "--porcelain=v1", "-b", "-uall"],
				GIT_STATUS_TIMEOUT_MS,
			);
			if (generation !== this.#generation) return;
			if (stdout === undefined) {
				return;
			}
			const parsed = parseGitStatusPorcelain(stdout);
			this.#commitPatch(
				generation,
				{
					gitBranch: parsed.gitBranch,
					gitDirtyCount: parsed.gitDirtyCount,
					gitFiles: parsed.gitFiles,
				},
				parsed.gitBranch === undefined,
			);
		} finally {
			this.#gitInFlight = false;
		}
	}

	async #probeDaemons(generation: number): Promise<void> {
		if (this.#daemonsInFlight) return;
		this.#daemonsInFlight = true;
		try {
			const fixedChecks = Promise.all(
				FIXED_DAEMON_TARGETS.map(async target => ({
					label: target.label,
					port: target.port,
					up: await probeTcpLoopback(target.port),
				})),
			);
			const hudCheck = (async (): Promise<{ label: string; port?: number; up: boolean }> => {
				const port = await readHudDaemonPort(this.#hudStatePath);
				if (port === undefined) {
					return { label: "HUD", up: false };
				}
				return {
					label: "HUD",
					port,
					up: await probeTcpLoopback(port),
				};
			})();
			const [fixedResults, hudResult] = await Promise.all([fixedChecks, hudCheck]);
			this.#commitPatch(generation, {
				daemons: [...fixedResults, hudResult],
			});
		} finally {
			this.#daemonsInFlight = false;
		}
	}
}

interface HudSegment {
	text: string;
	href?: string;
	key?: string;
}

function wrapAction(text: string, href: string | undefined, key: string | undefined): string {
	if (!href || text.length === 0) return text;
	return formatActionMarker(text, href, key ?? href);
}

function renderSegmentedCell(segments: readonly HudSegment[], targetWidth: number): string {
	if (targetWidth <= 0) return "";
	const nonEmpty: Array<{ seg: HudSegment; width: number }> = [];
	let totalWidth = 0;
	for (const seg of segments) {
		const width = visibleWidth(seg.text);
		if (width <= 0) continue;
		nonEmpty.push({ seg, width });
		totalWidth += width;
	}
	if (nonEmpty.length === 0) {
		return padding(targetWidth);
	}
	if (totalWidth <= targetWidth) {
		let out = "";
		for (const { seg } of nonEmpty) {
			out += wrapAction(seg.text, seg.href, seg.key);
		}
		return totalWidth < targetWidth ? `${out}${padding(targetWidth - totalWidth)}` : out;
	}

	let remaining = targetWidth;
	let out = "";
	for (const [i, entry] of nonEmpty.entries()) {
		if (remaining <= 0) break;
		const { seg, width } = entry;
		const hasMore = i < nonEmpty.length - 1;
		if (width < remaining || (width === remaining && !hasMore)) {
			out += wrapAction(seg.text, seg.href, seg.key);
			remaining -= width;
			continue;
		}
		const clipped = truncateToWidth(width > remaining ? seg.text : `${seg.text}…`, remaining);
		const clippedWidth = visibleWidth(clipped);
		if (clippedWidth > 0) {
			out += wrapAction(clipped, seg.href, seg.key);
			remaining -= clippedWidth;
		}
		break;
	}
	return remaining > 0 ? `${out}${padding(remaining)}` : out;
}

function fitCenterLine(line: string, targetWidth: number): string {
	if (targetWidth <= 0) {
		return line.includes(CURSOR_MARKER) ? CURSOR_MARKER : "";
	}
	const width = visibleWidth(line);
	if (width <= targetWidth) {
		return width < targetWidth ? `${line}${padding(targetWidth - width)}` : line;
	}
	const hadCursor = line.includes(CURSOR_MARKER);
	let fitted = truncateToWidth(line, targetWidth, "");
	if (hadCursor && !fitted.includes(CURSOR_MARKER)) {
		fitted += CURSOR_MARKER;
	}
	const fittedWidth = visibleWidth(fitted);
	return fittedWidth < targetWidth ? `${fitted}${padding(targetWidth - fittedWidth)}` : fitted;
}

function formatQuotaCapsule(capsule: QuotaPoolCapsule): string {
	const labelRaw = sanitizeSingleLine(capsule.shortLabel) || sanitizeSingleLine(capsule.provider) || "pool";
	const label = capsule.active ? bold(labelRaw) : labelRaw;
	const reset = capsule.resetText ? sanitizeSingleLine(capsule.resetText) : "";
	const metric = reset.length > 0 ? `${capsule.remainingPct}%/${reset}` : `${capsule.remainingPct}%`;
	return `${label} ${fg(QUOTA_SEVERITY_COLORS[capsule.severity], metric)}`;
}

function shortenMcpServerName(rawName: string): string {
	const clean = sanitizeSingleLine(rawName);
	if (clean.startsWith("computer_use") || clean.startsWith("computer-use")) {
		return "comp-use";
	}
	if (clean === "ida_headless" || clean === "ida-headless") {
		return "ida";
	}
	return clean.length > 12 ? `${clean.slice(0, 11)}…` : clean;
}

function formatGitFileRow(file: MarginHudGitFile): string {
	const code = sanitizeSingleLine(file.status) || "?";
	const color = GIT_STATUS_COLORS[code] ?? "warning";
	const filePath = sanitizeSingleLine(file.path);
	return `${fg(color, code)} ${fg("text", filePath)}`;
}

function collectTodoView(phases: readonly TodoPhase[]): {
	doneCount: number;
	totalCount: number;
	taskRows: string[];
} {
	const activeTasks: TodoItem[] = [];
	const blockedTasks: TodoItem[] = [];
	const pendingTasks: TodoItem[] = [];
	const completedTasks: TodoItem[] = [];
	let doneCount = 0;
	let totalCount = 0;

	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "abandoned") continue;
			totalCount += 1;
			if (task.status === "completed") {
				doneCount += 1;
				completedTasks.push(task);
			} else if (task.status === "in_progress") {
				activeTasks.push(task);
			} else if (task.status === "blocked") {
				blockedTasks.push(task);
			} else {
				pendingTasks.push(task);
			}
		}
	}

	const taskRows: string[] = [];
	for (const task of activeTasks) {
		taskRows.push(`${fg("accent", "▶")} ${fg("text", sanitizeSingleLine(task.content))}`);
	}
	for (const task of blockedTasks) {
		taskRows.push(`${fg("error", "!")} ${fg("warning", sanitizeSingleLine(task.content))}`);
	}
	for (const task of pendingTasks) {
		taskRows.push(`${fg("muted", "○")} ${fg("muted", sanitizeSingleLine(task.content))}`);
	}
	for (const task of completedTasks) {
		taskRows.push(`${fg("success", "✓")} ${fg("dim", sanitizeSingleLine(task.content))}`);
	}

	return { doneCount, totalCount, taskRows };
}

export class ComposerMarginHudFrame implements Component {
	readonly #host: MarginHudHostAccess;
	readonly #collector: MarginHudTelemetryCollector;
	readonly #ownsCollector: boolean;

	constructor(host: MarginHudHostAccess, collector?: MarginHudTelemetryCollector) {
		this.#host = host;
		if (collector) {
			this.#collector = collector;
			this.#ownsCollector = false;
		} else {
			this.#collector = new MarginHudTelemetryCollector({
				cwd: () => this.#host.getCwd(),
				onUpdate: () => this.#host.requestRender(),
				autoStart: true,
			});
			this.#ownsCollector = true;
		}
	}

	invalidate(): void {
		// Stateless frame layout: child editor invalidation is managed by host.
	}

	dispose(): void {
		if (this.#ownsCollector) {
			this.#collector.stop();
		}
	}

	render(width: number): readonly string[] {
		if (!this.#host.isEnabled() || !this.#host.isPlainEditorActive() || width <= 0) {
			return this.#host.renderCenterEditor(width);
		}

		const snapshot = this.#collector.getSnapshot();
		const topBar = this.#renderTopBar(width, snapshot);
		const middleRows = this.#renderMiddleBand(width, snapshot);
		const bottomStrip = this.#renderBottomStrip(width, snapshot);

		return [topBar, ...middleRows, bottomStrip];
	}

	#renderTopBar(width: number, snapshot: MarginHudTelemetrySnapshot): string {
		const sep = fg("dim", " │ ");
		const dot = fg("dim", " · ");
		const presetRaw = sanitizeSingleLine(this.#host.getActivePresetName() ?? "") || "default";
		const presetPart = `${fg("accent", "▲")} ${fg("muted", "Preset:")} ${bold(fg("accent", presetRaw))}`;

		const hwParts: string[] = [];
		if (snapshot.gpu) {
			const gpuTemp = snapshot.gpu.tempC !== undefined ? ` ${snapshot.gpu.tempC}°C` : "";
			const gpuColor: ThemeColor =
				(snapshot.gpu.tempC !== undefined && snapshot.gpu.tempC >= 82) ||
				(snapshot.gpu.utilPct !== undefined && snapshot.gpu.utilPct >= 95)
					? "warning"
					: "text";
			hwParts.push(
				fg(
					gpuColor,
					`${sanitizeSingleLine(snapshot.gpu.name)} ${snapshot.gpu.usedGb}/${snapshot.gpu.totalGb}G${gpuTemp}`,
				),
			);
		}
		const cpuText = snapshot.cpuPct !== undefined ? `${snapshot.cpuPct}%` : "--%";
		const cpuColor: ThemeColor =
			snapshot.cpuPct !== undefined && snapshot.cpuPct >= 85 ? "warning" : "muted";
		hwParts.push(fg(cpuColor, `CPU ${cpuText}`));
		hwParts.push(fg("muted", `RAM ${snapshot.ramUsedGb}/${snapshot.ramTotalGb}G`));
		const hwSection = hwParts.join(dot);

		const segments: HudSegment[] = [
			{ text: presetPart, href: "omp-ui:quota", key: "top:preset" },
			{ text: sep },
			{ text: hwSection, href: "omp-ui:hud-refresh", key: "top:hw" },
		];

		const capsules = this.#host.getQuotaCapsules();
		if (capsules.length > 0) {
			const urgent = capsules.filter(c => c.severity === "warning" || c.severity === "error");
			const quotaText =
				urgent.length > 0
					? `${fg("warning", "🔥 临期:")} ${urgent.slice(0, 3).map(formatQuotaCapsule).join(dot)}`
					: capsules.slice(0, 3).map(formatQuotaCapsule).join(dot);
			segments.push({ text: sep }, { text: quotaText, href: "omp-ui:quota", key: "top:quota" });
		}

		return renderSegmentedCell(segments, width);
	}

	#renderMiddleBand(width: number, snapshot: MarginHudTelemetrySnapshot): string[] {
		const showLeft = width >= FULL_COCKPIT_MIN_WIDTH;
		const showRight = width >= THREE_EDGE_MIN_WIDTH;
		const leftW = showLeft ? FULL_LEFT_WING_WIDTH : 0;
		const rightW = showLeft
			? FULL_RIGHT_WING_WIDTH
			: showRight
				? THREE_EDGE_RIGHT_WING_WIDTH
				: 0;
		const dividerCols = (showLeft ? WING_DIVIDER_WIDTH : 0) + (showRight ? WING_DIVIDER_WIDTH : 0);
		const centerW = Math.max(1, width - leftW - rightW - dividerCols);

		const centerLines = this.#host.renderCenterEditor(centerW);
		const showWings = showLeft || showRight;
		const rowCount = Math.max(centerLines.length, showWings ? MIN_WING_ROWS : centerLines.length, 1);

		const leftRows = showLeft ? this.#buildLeftWingRows(rowCount, snapshot) : [];
		const rightRows = showRight ? this.#buildRightWingRows(rowCount, snapshot) : [];
		const divider = fg("dim", WING_DIVIDER_PLAIN);

		const rows: string[] = [];
		for (let r = 0; r < rowCount; r++) {
			const rawCenter = centerLines[r] ?? padding(centerW);
			const centerCell = fitCenterLine(rawCenter, centerW);
			if (showLeft && showRight) {
				const leftCell = renderSegmentedCell(leftRows[r] ?? [], leftW);
				const rightCell = renderSegmentedCell(rightRows[r] ?? [], rightW);
				rows.push(`${leftCell}${divider}${centerCell}\x1b[0m${divider}${rightCell}`);
			} else if (showRight) {
				const rightCell = renderSegmentedCell(rightRows[r] ?? [], rightW);
				rows.push(`${centerCell}\x1b[0m${divider}${rightCell}`);
			} else {
				rows.push(centerCell);
			}
		}
		return rows;
	}

	#buildLeftWingRows(rowCount: number, snapshot: MarginHudTelemetrySnapshot): HudSegment[][] {
		const header: HudSegment[] = [
			{ text: bold(fg("accent", "◀ Git & 任务")), href: "omp-ui:todo", key: "left:header" },
		];
		const bodySlots = Math.max(1, rowCount - 1);
		const gitRows: HudSegment[][] = snapshot.gitFiles.map((file, index) => {
			const targetPath = file.fullPath ?? file.path;
			return [
				{
					text: formatGitFileRow(file),
					href: `omp-ui:insert-file:${encodeURIComponent(targetPath)}`,
					key: `left:git:${index}:${targetPath}`,
				},
			];
		});
		if (gitRows.length === 0 && snapshot.gitDirtyCount > 0) {
			gitRows.push([{ text: `${fg("warning", "M")} ${fg("muted", `${snapshot.gitDirtyCount} dirty files`)}` }]);
		}

		const todoView = collectTodoView(this.#host.getTodoPhases());
		const hasGitDirty = gitRows.length > 0;
		const hasTodos = todoView.totalCount > 0;
		const cleanRow: HudSegment[] = [{ text: `${fg("success", "✓")} ${fg("muted", "工作区干净")}` }];
		const noTodosRow: HudSegment[] = [{ text: fg("dim", "○ 暂无待办") }];

		if (!hasGitDirty && !hasTodos) {
			return [header, cleanRow, noTodosRow];
		}

		const todoSummary: HudSegment[] = [
			{
				text: `${fg("accent", "TODO")} ${fg("muted", `${todoView.doneCount}/${todoView.totalCount}`)}`,
				href: "omp-ui:todo",
				key: "left:todo:summary",
			},
		];
		const todoTaskEntries: HudSegment[][] = todoView.taskRows.map((row, index) => [
			{ text: row, href: "omp-ui:todo", key: `left:todo:${index}` },
		]);
		const todoEntries: HudSegment[][] = hasTodos ? [todoSummary, ...todoTaskEntries] : [];

		if (hasGitDirty && !hasTodos) {
			const gitLimit = gitRows.length < bodySlots ? gitRows.length : bodySlots;
			const body = gitRows.slice(0, gitLimit);
			if (body.length < bodySlots) {
				body.push(noTodosRow);
			}
			return [header, ...body];
		}

		if (!hasGitDirty && hasTodos) {
			const body: HudSegment[][] = [];
			if (bodySlots > todoEntries.length) {
				body.push(cleanRow);
			}
			body.push(...todoEntries.slice(0, Math.max(0, bodySlots - body.length)));
			return [header, ...body];
		}

		// Both dirty git files and todos exist: split body slots so both remain visible.
		const todoBudget = Math.min(todoEntries.length, Math.max(1, Math.floor(bodySlots / 2)));
		const gitBudget = Math.max(1, bodySlots - todoBudget);
		const selectedGit = gitRows.slice(0, gitBudget);
		const remainingForTodos = Math.max(0, bodySlots - selectedGit.length);
		const selectedTodos =
			remainingForTodos === 1 && todoTaskEntries.length > 0
				? [todoTaskEntries[0] ?? todoSummary]
				: todoEntries.slice(0, remainingForTodos);

		return [header, ...selectedGit, ...selectedTodos];
	}

	#buildRightWingRows(rowCount: number, snapshot: MarginHudTelemetrySnapshot): HudSegment[][] {
		const header: HudSegment[] = [{ text: bold(fg("accent", "▶ Agents & 服务")) }];
		const bodySlots = Math.max(1, rowCount - 1);

		const daemonRow: HudSegment[] = [];
		for (const [index, daemon] of snapshot.daemons.entries()) {
			if (index > 0) {
				daemonRow.push({ text: " " });
			}
			const label = sanitizeSingleLine(daemon.label);
			const pillText = daemon.up ? `${fg("success", "●")}${fg("text", label)}` : fg("dim", `○${label}`);
			const href = label.toUpperCase() === "HUD" ? "omp-ui:desktop-hud" : "omp-ui:hud-refresh";
			daemonRow.push({
				text: pillText,
				href,
				key: `right:daemon:${index}:${label}`,
			});
		}

		const mcpServers = this.#host.getMcpServers();
		const mcpRowText =
			mcpServers.length > 0
				? `${fg("muted", "MCP:")} ${mcpServers
						.map(server => fg("accent", shortenMcpServerName(server.name)))
						.join(fg("dim", " · "))}`
				: fg("dim", "MCP: none");
		const mcpRow: HudSegment[] = [{ text: mcpRowText, href: "omp-ui:mcp", key: "right:mcp" }];

		const reservedFooterRows = bodySlots >= 3 ? 2 : bodySlots === 2 ? 1 : 0;
		const subagentSlots = Math.max(1, bodySlots - reservedFooterRows);
		const subagents = this.#host.getSubagentSummary();
		const subagentRows: HudSegment[][] = [];

		if (subagents.running.length > 0) {
			for (const [index, running] of subagents.running.slice(0, subagentSlots).entries()) {
				const label = sanitizeSingleLine(running.label) || "agent";
				const elapsed = running.elapsed ? ` ${fg("muted", sanitizeSingleLine(running.elapsed))}` : "";
				const id = running.id?.trim();
				const href = id ? `omp-ui:subagent:${encodeURIComponent(id)}` : "omp-ui:jobs";
				subagentRows.push([
					{
						text: `${fg("warning", "●")} ${fg("accent", label)}${elapsed}`,
						href,
						key: `right:running:${index}:${id ?? label}`,
					},
				]);
			}
		} else if (subagents.recent.length > 0) {
			subagentRows.push([
				{
					text: `${fg("success", "✓")} ${fg("muted", `${subagents.recent.length} subagents done`)}`,
					href: "omp-ui:jobs",
					key: "right:recent:summary",
				},
			]);
			for (const [index, recent] of subagents.recent.slice(0, Math.max(0, subagentSlots - 1)).entries()) {
				const label = sanitizeSingleLine(recent.label) || "agent";
				const status = sanitizeSingleLine(recent.status) || "done";
				const id = recent.id?.trim();
				const href = id ? `omp-ui:subagent:${encodeURIComponent(id)}` : "omp-ui:jobs";
				subagentRows.push([
					{
						text: fg("dim", `↳ ${label} (${status})`),
						href,
						key: `right:recent:${index}:${id ?? label}`,
					},
				]);
			}
		} else {
			subagentRows.push([{ text: fg("dim", "○ 无在跑子代理") }]);
		}

		const body: HudSegment[][] = [...subagentRows];
		if (bodySlots >= 3) {
			body.push(mcpRow, daemonRow);
		} else if (bodySlots === 2) {
			body.push(daemonRow);
		}
		return [header, ...body.slice(0, bodySlots)];
	}

	#renderBottomStrip(width: number, snapshot: MarginHudTelemetrySnapshot): string {
		const sep = fg("dim", " │ ");
		const dot = fg("dim", " · ");
		const branch = sanitizeSingleLine(snapshot.gitBranch ?? "") || "—";
		const dirtySuffix = snapshot.gitDirtyCount > 0 ? fg("warning", `*${snapshot.gitDirtyCount}`) : "";
		const gitPart = `${fg("success", "▼")} ${fg("muted", "git:")}${fg("accent", branch)}${dirtySuffix}`;

		const totalDaemons = snapshot.daemons.length;
		const upDaemons = snapshot.daemons.filter(daemon => daemon.up).length;
		const svcColor: ThemeColor = upDaemons > 0 ? "success" : "muted";
		const servicePart = `${fg("muted", "服务")} ${fg(svcColor, `${upDaemons}/${totalDaemons}`)}`;

		const predStatus = this.#host.getPredictionSelectionStatus?.();
		let primarySegments: HudSegment[];
		if (predStatus && predStatus.total > 0) {
			if (predStatus.checked > 0) {
				primarySegments = [
					{
						text: `${fg("success", `✓ 已选 ${predStatus.checked}/${predStatus.total}`)} ${fg("accent", "⏎ 发送")}`,
						href: "omp-ui:pred-submit",
						key: "bottom:pred-submit",
					},
					{ text: dot },
					{
						text: `${fg("accent", "Esc")} ${fg("muted", "取消勾选")}`,
						href: "omp-ui:pred-clear",
						key: "bottom:pred-clear",
					},
				];
			} else {
				const rangeLabel = predStatus.total > 1 ? `Alt+1~${predStatus.total}` : "Alt+1";
				primarySegments = [
					{
						text: `${fg("accent", "Tab")} ${fg("muted", "全选候选")}`,
						href: "omp-ui:pred-toggle-all",
						key: "bottom:tab-pred",
					},
					{ text: dot },
					{
						text: `${fg("accent", rangeLabel)} ${fg("muted", "多选")}`,
						href: "omp-ui:pred-toggle:1",
						key: "bottom:pick-pred",
					},
				];
			}
		} else if (this.#host.isDraftEmpty() && this.#host.hasNumberedPrediction()) {
			primarySegments = [
				{
					text: `${fg("accent", "Tab")} ${fg("muted", "全选")}`,
					href: "omp-ui:accept-pred:all",
					key: "bottom:tab-pred",
				},
				{ text: dot },
				{
					text: `${fg("accent", "1-3+Tab")} ${fg("muted", "选候选")}`,
					href: "omp-ui:accept-pred:1",
					key: "bottom:pick-pred",
				},
			];
		} else {
			primarySegments = [
				{
					text: `${fg("accent", "Tab")} ${fg("muted", "全采纳")}`,
					href: "omp-ui:accept-pred:all",
					key: "bottom:tab-all",
				},
				{ text: dot },
				{
					text: `${fg("accent", "Ctrl+→")} ${fg("muted", "逐词")}`,
					href: "omp-ui:accept-chunk",
					key: "bottom:chunk",
				},
			];
		}

		const segments: HudSegment[] = [
			{ text: gitPart, href: "omp-ui:hud-refresh", key: "bottom:git" },
			{ text: sep },
			{ text: servicePart, href: "omp-ui:hud-refresh", key: "bottom:services" },
			{ text: sep },
			...primarySegments,
			{ text: dot },
			{
				text: `${fg("accent", "Alt+Q")} ${fg("muted", "额度舱")}`,
				href: "omp-ui:quota",
				key: "bottom:quota",
			},
			{ text: dot },
			{
				text: `${fg("accent", "Alt+H")} ${fg("muted", "四边舱")}`,
				href: "omp-ui:hud-toggle",
				key: "bottom:hud-toggle",
			},
		];

		return renderSegmentedCell(segments, width);
	}
}
