import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeTools } from "@oh-my-pi/pi-agent-core";
import { renderToolInventory } from "@oh-my-pi/pi-ai/dialect";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { AdviseTool } from "@oh-my-pi/pi-coding-agent/advisor/advise-tool";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSystemPrompt, buildSystemPromptToolMetadata } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { getBundledAgent, loadBundledAgents } from "@oh-my-pi/pi-coding-agent/task/agents";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import { taskItemSchema } from "@oh-my-pi/pi-coding-agent/task/types";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getAgentDir, prompt, setAgentDir } from "@oh-my-pi/pi-utils";
import advisorTemplate from "../src/prompts/advisor/system.md" with { type: "text" };
import systemTemplate from "../src/prompts/system/system-prompt.md" with { type: "text" };
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

type Role = "primary" | "scout" | "advisor_readonly";
type Mode = "inline" | "native";
interface Surface {
	role: Role;
	mode: Mode;
	prompt: string;
	tools: Tool[];
	definitions: string;
	text: string;
}

const ROLES: Role[] = ["primary", "scout", "advisor_readonly"];
const MODES: Mode[] = ["inline", "native"];
const ADVISOR_TOOLS = ["read", "grep", "glob", "find", "lsp", "ast_grep", "web_search"];
const MUTATING_TOOLS = ["write", "edit", "ast_edit", "bash"];

/** Frozen baselines, not the surface measured during this test. Ceilings add exactly 9% headroom. */
const BASELINE: Record<Role, Record<Mode, number>> = {
	primary: { inline: 43_220, native: 41_335 },
	scout: { inline: 17_338, native: 17_130 },
	advisor_readonly: { inline: 17_523, native: 16_498 },
};
const budget = (role: Role, mode: Mode) => Math.ceil((BASELINE[role][mode] * 109) / 100);

const BANNED_SURFACES = [
	{ rule: "Unresolved template placeholder", pattern: /\{\{[\s\S]*?\}\}/ },
	{ rule: "Undefined interpolation leak", pattern: /\bundefined\b/ },
];

// Exclude machine facts, as the reference test excludes deployment-specific values.
const stableText = (text: string) => text.replace(/^- (OS|Arch):[^\n]*/gm, "- $1: <host>");

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> {
	const properties = schema.properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
		throw new Error("Expected an object schema with properties");
	}
	return properties as Record<string, unknown>;
}

/** Keep prohibitions, but examine each independent clause for affirmative mutation instructions. */
function scoutMutationInstructions(text: string): string[] {
	return text.split(/\n|(?<=[.!?;])\s+|\bbut\b/i).filter(clause => {
		if (/\b(?:never|no|not|without)\b|\bdon['’]t\b/i.test(clause)) return false;
		return /\b(?:write|edit|modify|delete|create|overwrite|update|patch)\b.{0,35}\bfiles?\b|\b(?:use|call|invoke)\s+`(?:write|edit|ast_edit|bash)`/i.test(
			clause,
		);
	});
}

describe("model-facing role surface budgets", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;
	let originalAgentDir: string;
	const savedEnv = new Map<string, string | undefined>();
	const surfaces: Surface[] = [];
	let restoreDiscovery: (() => void) | undefined;
	let restoreHome: (() => void) | undefined;

	beforeAll(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-surface-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-surface-home-"));
		originalHome = process.env.HOME;
		originalAgentDir = getAgentDir();
		for (const key of [
			"PI_CODING_AGENT_DIR",
			"PI_PROFILE",
			"OMP_PROFILE",
			"NULL_PROMPT",
			"PI_NO_INTENT",
			"PI_INTENT_DESC",
			"PI_INTENT_PROMPT",
			"PI_PY",
			"PI_JS",
			"PI_EDIT_VARIANT",
		]) {
			savedEnv.set(key, process.env[key]);
			delete process.env[key];
		}
		process.env.HOME = tempHomeDir;
		const homeSpy = spyOn(os, "homedir").mockReturnValue(tempHomeDir);
		restoreHome = () => homeSpy.mockRestore();
		setAgentDir(path.join(tempHomeDir, ".omp", "agent"));
		const discoverySpy = spyOn(discovery, "discoverAgents").mockResolvedValue({
			agents: loadBundledAgents(),
			projectAgentsDir: null,
		});
		restoreDiscovery = () => discoverySpy.mockRestore();
		const scout = getBundledAgent("scout");
		if (!scout?.tools?.length) throw new Error("Bundled scout must declare its read-only tool subset");

		for (const role of ROLES) {
			// Flatten xd:// presentation to budget every built-in descriptor, including discoverable tools.
			// Pin host probes off; enable the search capabilities explicitly requested by these roles.
			const settings = Settings.isolated({
				"tools.xdev": false,
				"ida.enabled": false,
				"github.enabled": false,
				"find.enabled": "on",
				"astGrep.enabled": true,
				...(role === "scout" ? { "read.summarize.enabled": false } : {}),
			});
			const session: ToolSession = {
				cwd: tempDir,
				hasUI: false,
				settings,
				skills: [],
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				skipPythonPreflight: true,
				restrictToolNames: role !== "primary",
				lspReadOnly: role === "advisor_readonly",
			};
			const names = role === "scout" ? scout.tools : role === "advisor_readonly" ? ADVISOR_TOOLS : undefined;
			const tools = await createTools(session, names);
			if (role === "advisor_readonly") tools.unshift(new AdviseTool(() => {}));
			if (names) {
				expect(tools.map(tool => tool.name).sort()).toEqual(
					[...names, ...(role === "advisor_readonly" ? ["advise"] : [])].sort(),
				);
			}
			const metadata = buildSystemPromptToolMetadata(new Map(tools.map(tool => [tool.name, tool])));
			for (const mode of MODES) {
				const inlineToolDescriptors = mode === "inline";
				let blocks: string[];
				if (role === "advisor_readonly") {
					// Advisor loops use their own prompt and no intent tracing. Exercise the same
					// real catalog renderer for the inline projection as buildSystemPrompt uses.
					blocks = [prompt.render(advisorTemplate, { max_notes_per_update: 4 })];
					if (inlineToolDescriptors) blocks.push(renderToolInventory(tools));
				} else {
					({ systemPrompt: blocks } = await buildSystemPrompt({
						cwd: tempDir,
						systemPromptTemplate: systemTemplate,
						contextFiles: [],
						skills: [],
						rules: [],
						alwaysApplyRules: [],
						activeRepoContext: null,
						workspaceTree: {
							rootPath: tempDir,
							rendered: "",
							truncated: false,
							totalLines: 0,
							agentsMdFiles: [],
						},
						tools: metadata,
						toolNames: tools.map(tool => tool.name),
						nativeTools: true,
						inlineToolDescriptors,
						intentField: "i",
						personality: role === "scout" ? "none" : "default",
						subagent: role === "scout",
					}));
					if (role === "scout") blocks.push(`§ Role\n${scout.systemPrompt}`);
				}
				const wire =
					normalizeTools(tools, {
						injectIntent: role !== "advisor_readonly",
						pruneDescriptions: inlineToolDescriptors,
					}) ?? [];
				const definitions = JSON.stringify(
					wire.map(({ name, description, parameters }) => ({ name, description, parameters })),
				);
				const systemPrompt = stableText(blocks.join("\n\n"));
				surfaces.push({
					role,
					mode,
					prompt: systemPrompt,
					tools,
					definitions,
					text: `${systemPrompt}\n${definitions}`,
				});
			}
		}
	});

	afterAll(() => {
		restoreDiscovery?.();
		restoreHome?.();
		if (originalAgentDir) setAgentDir(originalAgentDir);
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome }))();
	});

	for (const role of ROLES) {
		for (const mode of MODES) {
			it(`keeps ${role}/${mode} within its character budget`, () => {
				const surface = surfaces.find(item => item.role === role && item.mode === mode)!;
				const actual = surface.prompt.length + surface.definitions.length;
				const ceiling = budget(role, mode);
				expect(
					actual,
					`${role}/${mode}: actual ${actual} vs budget ${ceiling} characters ` +
						`(${surface.prompt.length} prompt + ${surface.definitions.length} tools). ` +
						"Shrink model-facing prose, or intentionally raise the frozen baseline and " +
						"document the budget increase in the commit message.",
				).toBeLessThanOrEqual(ceiling);
			});
		}
	}

	it("keeps scout strictly smaller than primary in both modes", () => {
		for (const mode of MODES) {
			const size = (role: Role) => {
				const surface = surfaces.find(item => item.role === role && item.mode === mode)!;
				return surface.prompt.length + surface.definitions.length;
			};
			expect(size("scout"), `${mode}: scout must remain smaller than primary`).toBeLessThan(size("primary"));
		}
	});

	it("keeps file-mutating built-ins out of advisor schemas", () => {
		for (const surface of surfaces.filter(item => item.role === "advisor_readonly")) {
			const definitions = JSON.parse(surface.definitions) as Array<{ name: string }>;
			expect(definitions.filter(tool => MUTATING_TOOLS.includes(tool.name))).toEqual([]);
			expect(definitions.map(tool => tool.name).sort()).toEqual(["advise", ...ADVISOR_TOOLS].sort());
		}
	});

	it("leaves no template placeholders or undefined leaks in rendered surfaces", () => {
		const failures: string[] = [];
		for (const surface of surfaces) {
			// Inspect full descriptors too: inline mode strips these from the wire schema.
			const text = [surface.text, ...surface.tools.map(tool => tool.description)].join("\n");
			for (const { rule, pattern } of BANNED_SURFACES) {
				const match = pattern.exec(text);
				if (match) failures.push(`${surface.role}/${surface.mode}: ${rule}: ${match[0]}`);
			}
		}
		expect(failures).toEqual([]);
	});

	it("keeps scout instructions and callable tools read-only", () => {
		const scout = getBundledAgent("scout")!;
		expect(scout.systemPrompt).toMatch(/read-only/i);
		expect(scoutMutationInstructions(scout.systemPrompt)).toEqual([]);
		for (const surface of surfaces.filter(item => item.role === "scout")) {
			expect(surface.tools.filter(tool => MUTATING_TOOLS.includes(tool.name))).toEqual([]);
			const instructions = [surface.prompt, ...surface.tools.map(tool => tool.description)].join("\n");
			expect(scoutMutationInstructions(instructions)).toEqual([]);
		}
	});

	it("documents taskItemSchema keys and rejects dead parameter terminology", () => {
		const task = surfaces.find(item => item.role === "primary")!.tools.find(tool => tool.name === "task")!;
		const canonical = schemaProperties(
			toolWireSchema({ name: "task_item", description: "", parameters: taskItemSchema }),
		);
		const schema = toolWireSchema(task);
		const root = schemaProperties(schema);
		const tasks = root.tasks as { items?: Record<string, unknown> } | undefined;
		const live = tasks?.items ? schemaProperties(tasks.items) : root;
		// `outputSchema`/`schemaMode` are advertised only when `task.structured` is on (types.ts schemaFields);
		// they must appear together or not at all.
		const conditional = ["outputSchema", "schemaMode"];
		expect(conditional.filter(key => key in live).length % conditional.length).toBe(0);
		for (const key of Object.keys(canonical)) {
			if (conditional.includes(key) && !(key in live)) continue;
			expect(live, `task wire schema lost taskItemSchema.${key}`).toHaveProperty(key);
			expect(task.description, `task description must document ${key}`).toContain(`\`${key}\``);
		}
		const inputsSection = task.description.split(/^# Inputs\b/m)[1]?.split(/^# Available Agents\b/m)[0] ?? "";
		// Inputs are a bullet list (`- \`key\`: …`), optionally nested, though a bare `\`key\`: …` line is also accepted.
		const documented = [
			...inputsSection.matchAll(/(?:^|\n)\s*(?:[-*+]|\d+[.)])?\s*`([A-Za-z][A-Za-z0-9_]*)`\s*:/g),
		].map(match => match[1]!);
		expect(documented.length).toBeGreaterThan(0);
		for (const key of documented) {
			expect({ ...root, ...live }, `task documents stale parameter ${key}`).toHaveProperty(key);
		}
		expect(task.description).toContain("`solutionSpace`");
		expect(task.description).not.toMatch(/`(?:schema|subagent_type|description|prompt|run_in_background)`\s*:/);
	});
});
