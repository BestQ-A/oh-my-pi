import { describe, expect, it } from "bun:test";
import { runningTaskProgressSuffix } from "@oh-my-pi/pi-coding-agent/async/job-control";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveMaxRuntimeMs } from "@oh-my-pi/pi-coding-agent/task/executor";
import { cfgTaskAgentMaxRuntimeMs } from "@oh-my-pi/pi-coding-agent/task/settings";
import { deriveSubagentHealth, SUBAGENT_STALL_THRESHOLD_MS } from "@oh-my-pi/pi-tui/tools/task";
import type { JobSnapshot } from "@oh-my-pi/pi-tui/tools/wait";

describe("task.agentMaxRuntimeMs", () => {
	it("rejects entries that are not non-negative integer milliseconds", () => {
		for (const value of [-1, 1.5, "60000", [60000]]) {
			expect(() => Settings.isolated({ "task.agentMaxRuntimeMs": { scout: value } })).toThrow(
				"Invalid task.agentMaxRuntimeMs.scout",
			);
		}
		expect(() => Settings.isolated({ "task.agentMaxRuntimeMs": [1] })).toThrow("Invalid task.agentMaxRuntimeMs:");
		const settings = Settings.isolated({ "task.agentMaxRuntimeMs": { scout: 900_000, lead: null } });
		expect(cfgTaskAgentMaxRuntimeMs.get(settings)).toEqual({ scout: 900_000, lead: null });
	});

	it("resolves explicit override, then agent entry, then the global cap", () => {
		const agents = { scout: 900_000, task: 0, lead: null };
		expect(resolveMaxRuntimeMs("scout", 3_600_000, agents, 5_000)).toBe(5_000);
		expect(resolveMaxRuntimeMs("scout", 3_600_000, agents, 0)).toBe(0);
		expect(resolveMaxRuntimeMs("scout", 3_600_000, agents)).toBe(900_000);
		// An agent entry of 0 lifts the global cap for that agent only.
		expect(resolveMaxRuntimeMs("task", 3_600_000, agents)).toBe(0);
		// A null entry (cleared layer) and an unknown agent fall back to the global cap.
		expect(resolveMaxRuntimeMs("lead", 3_600_000, agents)).toBe(3_600_000);
		expect(resolveMaxRuntimeMs("reviewer", 3_600_000, agents)).toBe(3_600_000);
		expect(resolveMaxRuntimeMs("reviewer", -5, agents)).toBe(0);
	});
});

describe("deriveSubagentHealth", () => {
	const now = 10_000_000;
	const base = { status: "running" as const, lastActivityMs: now };

	it("is undefined for runs that are not running", () => {
		for (const status of ["pending", "completed", "failed", "aborted"] as const) {
			expect(deriveSubagentHealth({ ...base, status, lastActivityMs: 0 }, now)).toBeUndefined();
		}
	});

	it("applies the first matching row: rate_limited, retrying, stalled, working", () => {
		const retryState = { attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "429", startedAtMs: 0 };
		const retryFailure = { attempt: 3, errorMessage: "quota" };
		const idle = now - SUBAGENT_STALL_THRESHOLD_MS;
		expect(deriveSubagentHealth({ ...base, lastActivityMs: idle, retryState, retryFailure }, now)).toBe(
			"rate_limited",
		);
		expect(deriveSubagentHealth({ ...base, lastActivityMs: idle, retryState }, now)).toBe("retrying");
		expect(deriveSubagentHealth({ ...base, lastActivityMs: idle }, now)).toBe("stalled");
		expect(deriveSubagentHealth({ ...base, lastActivityMs: idle + 1 }, now)).toBe("working");
		// A long-running tool call is activity in flight, not a stall.
		expect(deriveSubagentHealth({ ...base, lastActivityMs: idle, currentTool: "bash" }, now)).toBe("working");
	});
});

describe("runningTaskProgressSuffix health", () => {
	const job: JobSnapshot = {
		id: "Scout",
		type: "task",
		status: "running",
		label: "Scout",
		durationMs: 60_000,
		requests: 30,
	};

	it("stays quiet for healthy runs and surfaces degraded health first", () => {
		expect(runningTaskProgressSuffix(job, { duration: false })).toBe(" — 30 req");
		expect(runningTaskProgressSuffix({ ...job, derivedHealth: "working" }, { duration: false })).toBe(" — 30 req");
		expect(runningTaskProgressSuffix({ ...job, derivedHealth: "stalled" }, { duration: false })).toBe(
			" — health: stalled · 30 req",
		);
		expect(runningTaskProgressSuffix({ ...job, derivedHealth: "rate_limited" }, { duration: false })).toBe(
			" — health: rate_limited · 30 req",
		);
	});
});
