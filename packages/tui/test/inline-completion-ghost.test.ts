import { describe, expect, it } from "bun:test";
import {
	Editor,
	type EditorTextAssistProvider,
	nextGhostCompletionChunk,
	parseNumberedPredictionItems,
} from "@oh-my-pi/pi-tui";
import { defaultEditorTheme } from "./test-themes";

function collectChunks(input: string): string[] {
	const chunks: string[] = [];
	let rest = input;
	while (rest.length > 0) {
		const chunk = nextGhostCompletionChunk(rest);
		expect(chunk.length).toBeGreaterThan(0);
		chunks.push(chunk);
		rest = rest.slice(chunk.length);
	}
	return chunks;
}

describe("nextGhostCompletionChunk", () => {
	it("splits mixed Chinese and English clauses into 1-2 Han chunks, tokens, and punctuation", () => {
		expect(collectChunks("请帮我修复editor.ts里的bug，然后运行测试！")).toEqual([
			"请帮",
			"我修",
			"复",
			"editor.ts",
			"里的",
			"bug",
			"，",
			"然后",
			"运行",
			"测试",
			"！",
		]);
	});

	it("consumes leading horizontal whitespace with CLI flags, model IDs, and file paths", () => {
		expect(collectChunks(" --model magpie/deepseek --file packages/tui/src/components/editor.ts:120")).toEqual([
			" --model",
			" magpie/deepseek",
			" --file",
			" packages/tui/src/components/editor.ts:120",
		]);
		expect(collectChunks(" @oh-my-pi/pi-tui ./src/index.ts")).toEqual([" @oh-my-pi/pi-tui", " ./src/index.ts"]);
	});

	it("handles punctuation runs and never returns empty string for non-empty input", () => {
		expect(collectChunks(", then => ()?!")).toEqual([",", " then", " =>", " ()?!"]);
		expect(nextGhostCompletionChunk("")).toBe("");
		expect(nextGhostCompletionChunk("   ")).toBe("   ");
	});
});

describe("Editor inlineCompletion ghost text", () => {
	it("renders inline ghost text on single-line and multi-line drafts while stripping trailing lines", () => {
		const single = new Editor(defaultEditorTheme);
		single.placeholder = () => "Ask anything";
		single.inlineCompletion = () => "run bun test\nextra line";

		const emptyFrame = single.render(80).join("\n");
		expect(emptyFrame).toContain("run bun test");
		expect(emptyFrame).not.toContain("Ask anything");
		expect(emptyFrame).not.toContain("extra line");

		const multi = new Editor(defaultEditorTheme);
		const seenCalls: Array<[readonly string[], number, number]> = [];
		multi.setText("First paragraph\nCheck packages/tui");
		multi.inlineCompletion = (lines, cursorLine, cursorCol) => {
			seenCalls.push([[...lines], cursorLine, cursorCol]);
			return cursorLine === 1 ? " with inline ghost text\r\nignored" : undefined;
		};

		const multiFrame = multi.render(80).join("\n");
		expect(multiFrame).toContain("First paragraph");
		expect(multiFrame).toContain("with inline ghost text");
		expect(multiFrame).not.toContain("ignored");
		expect(seenCalls[0]).toEqual([["First paragraph", "Check packages/tui"], 1, 18]);

		// Moving cursor mid-line hides the ghost text without invoking inlineCompletion.
		multi.handleInput("\x1b[D");
		expect(multi.render(80).join("\n")).not.toContain("with inline ghost text");
	});

	it("accepts the full inline ghost completion via Tab and Right without submitting", () => {
		const events: Array<[string, string | undefined]> = [];
		const submitted: string[] = [];
		const tabEditor = new Editor(defaultEditorTheme);
		tabEditor.onSubmit = text => {
			submitted.push(text);
		};
		tabEditor.onInlineCompletionEvent = (event, text) => {
			events.push([event, text]);
		};
		const target = "bun test packages/tui";
		tabEditor.inlineCompletion = lines => {
			const draft = lines.join("\n");
			return target.startsWith(draft) ? target.slice(draft.length) : undefined;
		};
		tabEditor.setText("bun test");

		tabEditor.handleInput("\t");
		expect(tabEditor.getText()).toBe("bun test packages/tui");
		expect(events).toEqual([["accept", " packages/tui"]]);
		expect(submitted).toEqual([]);

		const rightEvents: Array<[string, string | undefined]> = [];
		const rightEditor = new Editor(defaultEditorTheme);
		rightEditor.setText("First line\ngit status");
		rightEditor.inlineCompletion = (lines, line, col) =>
			line === 1 && col === (lines[1] ?? "").length && lines[1] === "git status" ? " --short" : undefined;
		rightEditor.onInlineCompletionEvent = (event, text) => {
			rightEvents.push([event, text]);
		};

		// Mid-line Right moves the cursor rather than accepting.
		rightEditor.handleInput("\x1b[D");
		rightEditor.handleInput("\x1b[C");
		expect(rightEditor.getText()).toBe("First line\ngit status");
		expect(rightEvents).toEqual([]);

		// End-of-line Right accepts the inline ghost completion.
		rightEditor.handleInput("\x1b[C");
		expect(rightEditor.getText()).toBe("First line\ngit status --short");
		expect(rightEvents).toEqual([["accept", " --short"]]);
	});

	it("partially accepts chunk by chunk via Ctrl+Right while keeping remaining ghost live", () => {
		const events: Array<[string, string | undefined]> = [];
		const editor = new Editor(defaultEditorTheme);
		let ghost = " --model magpie/deepseek，快试一下";
		editor.setText("omp");
		editor.inlineCompletion = () => (ghost.length > 0 ? ghost : undefined);
		editor.onInlineCompletionEvent = (event, text) => {
			events.push([event, text]);
			if (event === "partial-accept" && text) {
				ghost = ghost.slice(text.length);
			}
		};

		editor.handleInput("\x1b[1;5C");
		expect(editor.getText()).toBe("omp --model");
		expect(editor.render(80).join("\n")).toContain("magpie/deepseek，快试一下");

		editor.handleInput("\x1b[1;5C");
		expect(editor.getText()).toBe("omp --model magpie/deepseek");
		expect(editor.render(80).join("\n")).toContain("，快试一下");

		editor.handleInput("\x1b[1;5C");
		expect(editor.getText()).toBe("omp --model magpie/deepseek，");

		editor.handleInput("\x1b[1;5C");
		expect(editor.getText()).toBe("omp --model magpie/deepseek，快试");

		editor.handleInput("\x1b[1;5C");
		expect(editor.getText()).toBe("omp --model magpie/deepseek，快试一下");

		expect(events).toEqual([
			["partial-accept", " --model"],
			["partial-accept", " magpie/deepseek"],
			["partial-accept", "，"],
			["partial-accept", "快试"],
			["partial-accept", "一下"],
		]);
	});

	it("supports chunk acceptance on word completion and dismissInlineCompletion lifecycle", () => {
		const feedback: Array<[string, boolean]> = [];
		const assist: EditorTextAssistProvider = {
			getWordCompletion: (lines, line, col) => ((lines[line] ?? "").slice(0, col).endsWith("weath") ? "er" : null),
			wordCompletionFeedback: (_lines, _line, _col, suggestion, accepted) => {
				feedback.push([suggestion, accepted]);
			},
		};
		const wordEditor = new Editor(defaultEditorTheme);
		wordEditor.setTextAssistProvider(assist);
		wordEditor.setText("The weath");
		wordEditor.handleInput("\x1b[1;5C");
		expect(wordEditor.getText()).toBe("The weather");
		expect(feedback).toEqual([["er", true]]);

		const dismissEvents: Array<[string, string | undefined]> = [];
		const editor = new Editor(defaultEditorTheme);
		let activeSuffix: string | undefined = " --verbose";
		editor.setText("omp");
		editor.inlineCompletion = () => activeSuffix;
		editor.onInlineCompletionEvent = (event, text) => {
			dismissEvents.push([event, text]);
			if (event === "dismiss") activeSuffix = undefined;
		};

		expect(editor.dismissInlineCompletion()).toBe(true);
		expect(dismissEvents).toEqual([["dismiss", " --verbose"]]);
		expect(editor.dismissInlineCompletion()).toBe(false);
		expect(dismissEvents).toHaveLength(1);
	});
});

describe("Numbered empty-composer prediction menu (1. 内容1  2. 内容2  3. 内容3)", () => {
	it("parses numbered menus without splitting version numbers inside options", () => {
		expect(parseNumberedPredictionItems("1.提交改动 2.跑全量测试 3.查看git diff")).toEqual([
			{ index: 1, text: "提交改动" },
			{ index: 2, text: "跑全量测试" },
			{ index: 3, text: "查看git diff" },
		]);
		expect(parseNumberedPredictionItems("1. 升级 IDA Pro 9.5 配置  2. 测试 2.0 接口  3. 查看 diff")).toEqual([
			{ index: 1, text: "升级 IDA Pro 9.5 配置" },
			{ index: 2, text: "测试 2.0 接口" },
			{ index: 3, text: "查看 diff" },
		]);
		expect(parseNumberedPredictionItems("1.0 版本发布说明")).toBeNull();
		expect(parseNumberedPredictionItems('use "bun test" here')).toBeNull();
	});

	it("selects all options on Tab in empty box, selects single option N via 'N' + Tab, and supports Ctrl+Right chunk accept", () => {
		const theme = { ...defaultEditorTheme, hintStyle: (s: string) => `<<${s}>>` };
		const editor = new Editor(theme);
		editor.setPaddingX(0);
		editor.prediction = () => "1. 提交当前改动  2. 查看 git diff  3. 继续优化补全延迟";

		// 1) Empty box renders the full numbered menu; pressing Tab selects all items by default
		expect(Bun.stripANSI(editor.render(100)[1] ?? "")).toContain(
			"<<1. 提交当前改动>>  <<2. 查看 git diff>>  <<3. 继续优化补全延迟>>",
		);
		editor.handleInput("\t");
		expect(editor.getText()).toBe("1. 提交当前改动\n2. 查看 git diff\n3. 继续优化补全延迟");
		// 2) Typing '2' previews option #2 and pressing Tab replaces '2' with clean option #2
		editor.setText("");
		editor.handleInput("2");
		expect(editor.render(100)[1]).toContain("2|<<. 查看 git diff>>");
		editor.handleInput("\t");
		expect(editor.getText()).toBe("查看 git diff");

		// 3) Typing '3' + Ctrl+Right replaces '3' with first chunk of option #3 and keeps remainder live
		editor.setText("");
		editor.handleInput("3");
		editor.handleInput("\x1b[1;5C");
		expect(editor.getText()).toBe("继续");
		expect(editor.render(100)[1]).toContain("继续|<<优化补全延迟>>");

		// 4) Typing multi-digit number ('200') gets out of the way cleanly
		editor.setText("");
		for (const ch of "200") editor.handleInput(ch);
		expect(editor.render(100)[1]).not.toContain("<<");
	});
});
