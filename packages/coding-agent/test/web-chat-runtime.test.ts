import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import * as utils from "@oh-my-pi/pi-utils";
import * as ptree from "@oh-my-pi/pi-utils/ptree";
import { WebChatRunner } from "../examples/extensions/web-chat/runtime";

const guide: ptree.ExecResult = {
	stdout: "[ego-browser:skill] end of guide\n",
	stderr: "",
	exitCode: 0,
	ok: true,
};

function browserOutput(spaceId: number): ptree.ExecResult {
	return {
		stdout: [
			{ kind: "context", context: { spaceId, pages: { chatgpt: "p1" } } },
			{ kind: "result", result: { status: "ready", url: "https://chatgpt.com/" } },
		]
			.map(record => `OMP_WEB_CHAT:${JSON.stringify(record)}`)
			.join("\n"),
		stderr: "",
		exitCode: 0,
		ok: true,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("web chat invocation lifecycle", () => {
	it("waits for active cancellation cleanup and returns the recoverable conversation context", async () => {
		spyOn(utils, "$which").mockReturnValue("ego-browser");
		const entered = Promise.withResolvers<void>();
		const cleanup = Promise.withResolvers<void>();
		spyOn(ptree, "exec").mockImplementation(async command => {
			if (command[1] === "skill") return guide;
			entered.resolve();
			await cleanup.promise;
			return browserOutput(42);
		});
		const runner = new WebChatRunner();
		const controller = new AbortController();
		let settled = false;
		const invocation = runner.invoke("chatgpt", { action: "status" }, { signal: controller.signal }).then(result => {
			settled = true;
			return result;
		});
		try {
			await entered.promise;
			controller.abort();
			// Drain promise reactions while subprocess cleanup stays explicitly gated.
			await scheduler.yield();
			expect(settled).toBe(false);
			cleanup.resolve();
			expect(await invocation).toMatchObject({ reason: "cancelled", taskSpaceId: 42, pageLabel: "p1" });
			expect(await runner.invoke("chatgpt", { action: "status" })).toMatchObject({ reason: "runner_stopped" });
		} finally {
			controller.abort();
			cleanup.resolve();
			await invocation;
			await runner.invoke("chatgpt", { action: "status" });
		}
	});

	it("cancels queued work without waiting for another runner or poisoning the unused runner", async () => {
		spyOn(utils, "$which").mockReturnValue("ego-browser");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let browserCalls = 0;
		spyOn(ptree, "exec").mockImplementation(async command => {
			if (command[1] === "skill") return guide;
			browserCalls++;
			if (browserCalls === 1) {
				entered.resolve();
				await release.promise;
			}
			return browserOutput(42);
		});
		const first = new WebChatRunner().invoke("chatgpt", { action: "status" });
		const queued = new WebChatRunner();
		const controller = new AbortController();
		try {
			await entered.promise;
			const invocation = queued.invoke("chatgpt", { action: "status" }, { signal: controller.signal });
			controller.abort();
			expect(await invocation).toMatchObject({ reason: "cancelled" });
			expect(browserCalls).toBe(1);
			release.resolve();
			await first;
			expect(await queued.invoke("chatgpt", { action: "status" })).toMatchObject({ status: "ready" });
			expect(browserCalls).toBe(2);
		} finally {
			release.resolve();
			await first;
		}
	});

	it("deducts queue and guide time from the browser's usable deadline", async () => {
		spyOn(utils, "$which").mockReturnValue("ego-browser");
		let now = 1_000_000;
		spyOn(Date, "now").mockImplementation(() => now);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let guides = 0;
		let browsers = 0;
		let remaining: number | undefined;
		spyOn(ptree, "exec").mockImplementation(async (command, options) => {
			if (command[1] === "skill") {
				if (++guides === 2) now += 2000;
				return guide;
			}
			if (++browsers === 1) {
				entered.resolve();
				await release.promise;
			} else {
				const input = String(options?.input);
				const encoded = input.match(/Buffer\.from\("([A-Za-z0-9+/=]+)",\s*"base64"\)/)?.[1];
				if (!encoded) throw new Error("Missing browser payload");
				const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
				remaining = payload.deadline - now;
			}
			return browserOutput(42);
		});
		const first = new WebChatRunner().invoke("chatgpt", { action: "status", timeout: 10 });
		let second: Promise<unknown> | undefined;
		try {
			await entered.promise;
			second = new WebChatRunner().invoke("chatgpt", { action: "status", timeout: 10 });
			now += 3000;
			release.resolve();
			await Promise.all([first, second]);
			expect(remaining).toBe(5000);
		} finally {
			release.resolve();
			await Promise.all([first, second]);
		}
	});

	it("does not start browser actions when reading the guide consumes the deadline", async () => {
		spyOn(utils, "$which").mockReturnValue("ego-browser");
		let now = 1_000_000;
		spyOn(Date, "now").mockImplementation(() => now);
		let browserStarted = false;
		spyOn(ptree, "exec").mockImplementation(async command => {
			if (command[1] === "skill") {
				now += 1001;
				return guide;
			}
			browserStarted = true;
			return browserOutput(42);
		});
		const result = await new WebChatRunner().invoke("chatgpt", { action: "status", timeout: 1 });
		expect(result.reason).toBe("timeout");
		expect(browserStarted).toBe(false);
	});
});
