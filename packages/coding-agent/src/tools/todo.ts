import {
	countTodoLeaves,
	flattenAllTodoItems,
	flattenTodoLeaves,
	todoMatchesAnyDescription,
	type TodoStatus,
	type TodoOperation,
	type TodoItem,
	type TodoPhase,
	type TodoCompletionTransition,
	type TodoToolDetails,
} from "@oh-my-pi/pi-tui/tools/todo";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";

import { isRecord, prompt } from "@oh-my-pi/pi-utils";

import todoDescription from "../prompts/tools/todo.md" with { type: "text" };
import type { ToolSession } from "../sdk";
import type { SessionEntry } from "../session/session-entries";

import { normalizePathLikeInput, resolveToCwd } from "./path-utils";

/** Whether an unknown value is a persisted todo phase. */
function isTodoItem(value: unknown): value is TodoItem {
	if (
		!isRecord(value) ||
		typeof value.content !== "string" ||
		(value.status !== "pending" &&
			value.status !== "in_progress" &&
			value.status !== "completed" &&
			value.status !== "abandoned" &&
			value.status !== "blocked")
	) {
		return false;
	}
	if (value.children !== undefined) {
		if (!Array.isArray(value.children) || !value.children.every(isTodoItem)) return false;
	}
	return true;
}

export function isTodoPhase(value: unknown): value is TodoPhase {
	if (!isRecord(value) || typeof value.name !== "string" || !Array.isArray(value.tasks)) return false;
	return value.tasks.every(isTodoItem);
}

/**
 * Phases a successful, state-changing `todo` result committed, or undefined
 * for errors and pure `view` reads. A direct call lands these on the branch
 * through its own toolResult entry; a caller that produces no `todo`
 * toolResult (the eval bridge) must persist them itself or the next branch
 * rehydration (resume, rewind, fork, /btw) silently reverts the change.
 */
export function committedTodoPhases(result: AgentToolResult): TodoPhase[] | undefined {
	if (result.isError || !isRecord(result.details)) return undefined;
	const { op, phases } = result.details;
	if (op === "view" || !Array.isArray(phases) || !phases.every(isTodoPhase)) return undefined;
	return phases;
}

// =============================================================================
// Schema
// =============================================================================

const TodoOp = type('"init" | "start" | "done" | "rm" | "drop" | "block" | "unblock" | "append" | "view"');

const InitListEntry = type({
	phase: type("string"),
	items: type("string").array().atLeastLength(1),
});

const todoSchema = type({
	op: TodoOp,
	"list?": InitListEntry.array().describe("phases for init"),
	"task?": type("string").describe("verbatim task content"),
	"phase?": type("string"),
	"parent?": type("string").describe("parent task content to nest subtasks under (for append)"),
	// No `atLeastLength(1)` here: `items` is only meaningful for `init`/`append`,
	// and both enforce non-empty with op-specific errors. A stray `items: []` on
	// an op that ignores it (e.g. `view`) must not be a hard schema rejection.
	"items?": type("string").array().describe("tasks for flat init or append"),
	"reason?": type("string").describe("blocker note for block"),
});

type TodoParams = TodoSchema;
type TodoSchema = typeof todoSchema.infer;
/** A single todo op entry (the params object itself). */
type TodoOpEntryValue = TodoParams;

// =============================================================================
// State helpers
// =============================================================================

interface TaskLookupHit {
	task: TodoItem;
	phase: TodoPhase;
	container: TodoItem[];
	parent?: TodoItem;
}

function findTaskInList(
	list: TodoItem[],
	phase: TodoPhase,
	content: string,
	parent?: TodoItem,
): TaskLookupHit | undefined {
	for (const item of list) {
		if (item.content === content) return { task: item, phase, container: list, parent };
		if (item.children?.length) {
			const nested = findTaskInList(item.children, phase, content, item);
			if (nested) return nested;
		}
	}
	return undefined;
}

function findTaskByContent(phases: TodoPhase[], content: string): TaskLookupHit | undefined {
	for (const phase of phases) {
		const hit = findTaskInList(phase.tasks, phase, content);
		if (hit) return hit;
	}
	return undefined;
}

function findPhaseByName(phases: TodoPhase[], name: string): TodoPhase | undefined {
	return phases.find(phase => phase.name === name);
}

function cloneTask(task: TodoItem): TodoItem {
	const cloned: TodoItem =
		task.blocker !== undefined
			? { content: task.content, status: task.status, blocker: task.blocker }
			: { content: task.content, status: task.status };
	if (task.children?.length) {
		cloned.children = task.children.map(cloneTask);
	}
	return cloned;
}

function clonePhases(phases: TodoPhase[]): TodoPhase[] {
	return phases.map(phase => ({ name: phase.name, tasks: phase.tasks.map(cloneTask) }));
}

function todoTransitionKey(phase: string, content: string): string {
	return `${phase}\u0000${content}`;
}

function getCompletionTransitions(previous: TodoPhase[], updated: TodoPhase[]): TodoCompletionTransition[] {
	const previousStatuses = new Map<string, TodoStatus>();
	for (const phase of previous) {
		for (const task of flattenAllTodoItems(phase.tasks)) {
			previousStatuses.set(todoTransitionKey(phase.name, task.content), task.status);
		}
	}

	const transitions: TodoCompletionTransition[] = [];
	for (const phase of updated) {
		for (const task of flattenAllTodoItems(phase.tasks)) {
			if (task.status !== "completed") continue;
			const previousStatus = previousStatuses.get(todoTransitionKey(phase.name, task.content));
			if (previousStatus && previousStatus !== "completed") {
				transitions.push({ phase: phase.name, content: task.content });
			}
		}
	}
	return transitions;
}

/** Derive every parent node's status bottom-up from its children. */
function syncParentStatuses(list: TodoItem[]): void {
	for (const item of list) {
		if (!item.children?.length) continue;
		syncParentStatuses(item.children);
		const children = item.children;
		if (children.every(c => c.status === "completed" || c.status === "abandoned")) {
			item.status = children.every(c => c.status === "abandoned") ? "abandoned" : "completed";
			item.blocker = undefined;
		} else if (children.some(c => c.status === "in_progress")) {
			item.status = "in_progress";
			item.blocker = undefined;
		} else {
			const openChildren = children.filter(c => c.status !== "completed" && c.status !== "abandoned");
			if (openChildren.length > 0 && openChildren.every(c => c.status === "blocked")) {
				item.status = "blocked";
				item.blocker ??= openChildren.find(c => c.blocker)?.blocker;
			} else {
				item.status = "pending";
				item.blocker = undefined;
			}
		}
	}
}

function normalizeInProgressTask(phases: TodoPhase[]): void {
	for (const phase of phases) syncParentStatuses(phase.tasks);
	const orderedLeaves = phases.flatMap(phase => flattenTodoLeaves(phase.tasks));
	if (orderedLeaves.length === 0) return;

	const inProgressLeaves = orderedLeaves.filter(task => task.status === "in_progress");
	if (inProgressLeaves.length > 1) {
		for (const task of inProgressLeaves.slice(1)) {
			task.status = "pending";
		}
	}

	if (inProgressLeaves.length === 0) {
		const firstPendingLeaf = orderedLeaves.find(task => task.status === "pending");
		if (firstPendingLeaf) firstPendingLeaf.status = "in_progress";
	}

	for (const phase of phases) syncParentStatuses(phase.tasks);
}

/** Return the active leaf todo task, preferring an in-progress leaf over the first pending leaf. */
export function nextActionableTask(phases: readonly TodoPhase[]): TodoItem | undefined {
	let firstPending: TodoItem | undefined;
	for (const phase of phases) {
		for (const task of flattenTodoLeaves(phase.tasks)) {
			if (task.status === "in_progress") return task;
			if (!firstPending && task.status === "pending") firstPending = task;
		}
	}
	return firstPending;
}

export const USER_TODO_EDIT_CUSTOM_TYPE = "user_todo_edit";

export const TODO_HUD_STATE_CUSTOM_TYPE = "todo_hud_state";

export type TodoHudVisibility = "dismissed" | "revealed";

export interface TodoSnapshotIdentity {
	sourceEntryId: string;
	fingerprint: string;
}

export interface TodoHudStateEntryData extends TodoSnapshotIdentity {
	visibility: TodoHudVisibility;
}

function serializeTaskForFingerprint(task: TodoItem): Record<string, unknown> {
	const base: Record<string, unknown> =
		task.blocker === undefined
			? { content: task.content, status: task.status }
			: { content: task.content, status: task.status, blocker: task.blocker };
	if (task.children?.length) {
		base.children = task.children.map(serializeTaskForFingerprint);
	}
	return base;
}

function todoPhasesFingerprint(phases: readonly TodoPhase[]): string {
	return JSON.stringify(
		phases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(serializeTaskForFingerprint),
		})),
	);
}

function canonicalTodoPhases(entry: SessionEntry): TodoPhase[] | undefined {
	if (entry.type === "custom" && entry.customType === USER_TODO_EDIT_CUSTOM_TYPE) {
		const phases = (entry.data as { phases?: unknown } | undefined)?.phases;
		return Array.isArray(phases) ? (phases as TodoPhase[]) : undefined;
	}
	if (entry.type !== "message") return undefined;
	const message = entry.message as {
		role?: string;
		toolName?: string;
		details?: { op?: unknown; phases?: unknown };
		isError?: boolean;
	};
	if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError) return undefined;
	if (message.details?.op === "view") return undefined;
	const phases = message.details?.phases;
	return Array.isArray(phases) ? (phases as TodoPhase[]) : undefined;
}

/** Identify the latest durable canonical todo snapshot on the active branch. */
export function getLatestTodoSnapshotIdentity(entries: SessionEntry[]): TodoSnapshotIdentity | undefined {
	let latest: TodoPhase[] | undefined;
	let sourceEntryId: string | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const phases = canonicalTodoPhases(entries[i]);
		if (phases) {
			latest = phases;
			sourceEntryId = entries[i].id;
			break;
		}
	}
	if (!latest || !sourceEntryId) return undefined;
	return { sourceEntryId, fingerprint: todoPhasesFingerprint(latest) };
}

/** Return the persisted HUD choice only when it targets the current canonical snapshot exactly. */
export function getTodoHudVisibility(
	entries: SessionEntry[],
	phases: readonly TodoPhase[],
): TodoHudVisibility | undefined {
	const snapshot = getLatestTodoSnapshotIdentity(entries);
	if (!snapshot || snapshot.fingerprint !== todoPhasesFingerprint(phases)) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "custom" || entry.customType !== TODO_HUD_STATE_CUSTOM_TYPE) continue;
		const data = entry.data as Partial<TodoHudStateEntryData> | undefined;
		if (
			data?.sourceEntryId === snapshot.sourceEntryId &&
			data.fingerprint === snapshot.fingerprint &&
			(data.visibility === "dismissed" || data.visibility === "revealed")
		) {
			return data.visibility;
		}
	}
	return undefined;
}

/** Build persisted HUD metadata only for phases matching the latest durable canonical snapshot. */
export function createTodoHudStateData(
	entries: SessionEntry[],
	phases: readonly TodoPhase[],
	visibility: TodoHudVisibility,
): TodoHudStateEntryData | undefined {
	const snapshot = getLatestTodoSnapshotIdentity(entries);
	if (!snapshot || snapshot.fingerprint !== todoPhasesFingerprint(phases)) return undefined;
	return { ...snapshot, visibility };
}

export function getLatestTodoPhasesFromEntries(entries: SessionEntry[]): TodoPhase[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		const phases = canonicalTodoPhases(entries[i]);
		if (phases) return clonePhases(phases);
	}
	return [];
}

function resolveTaskOrError(
	phases: TodoPhase[],
	content: string | undefined,
	errors: string[],
): TaskLookupHit | undefined {
	if (!content) {
		errors.push("Missing task content");
		return undefined;
	}
	const hit = findTaskByContent(phases, content);
	if (!hit) {
		if (/^task-\d+$/.test(content)) {
			errors.push(
				`Task "${content}" not found. Tasks are referenced by content, not by IDs — pass the task's full text from the previous result.`,
			);
		} else {
			const totalTasks = phases.reduce((sum, phase) => sum + countTodoLeaves(phase.tasks).total, 0);
			const hint = totalTasks === 0 ? " (todo list is empty — was it replaced or not yet created?)" : "";
			errors.push(`Task "${content}" not found${hint}`);
		}
	}
	return hit;
}

function resolvePhaseOrError(phases: TodoPhase[], name: string | undefined, errors: string[]): TodoPhase | undefined {
	if (!name) {
		errors.push("Missing phase name");
		return undefined;
	}
	const phase = findPhaseByName(phases, name);
	if (!phase) errors.push(`Phase "${name}" not found`);
	return phase;
}

function collectSubtreeTargets(item: TodoItem): TodoItem[] {
	return flattenAllTodoItems([item]);
}

function getTaskTargets(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoItem[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		return hit ? collectSubtreeTargets(hit.task) : [];
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		return phase ? flattenAllTodoItems(phase.tasks) : [];
	}
	return phases.flatMap(phase => flattenAllTodoItems(phase.tasks));
}

/** Phase name for `init` given a flat `items` list with no explicit `phase`. */
const DEFAULT_INIT_PHASE = "Tasks";

const INDENTED_OUTLINE_LINE_RE = /^([ \t]+)(?:[-*+]|\d+[.)])\s+(.+?)\s*$/;
const ROOT_BULLET_PREFIX_RE = /^(?:[-*+]\s+)\S/;

function measureIndentColumns(ws: string): number {
	let cols = 0;
	for (const ch of ws) cols += ch === "\t" ? 2 : 1;
	return cols;
}

/**
 * Parse flat or indented outline strings into a multi-level `TodoItem[]` forest.
 * Plain unindented single-line strings pass through verbatim so existing callers
 * see zero content mutation; multi-line or indented bullet entries (`"  - Subtask"`)
 * nest under the preceding less-indented item.
 */
function parseOutlineItems(rawItems: readonly string[]): TodoItem[] {
	const hasHierarchy = rawItems.some(raw => raw.includes("\n") || INDENTED_OUTLINE_LINE_RE.test(raw));
	if (!hasHierarchy) {
		return rawItems.map<TodoItem>(content => ({ content, status: "pending" }));
	}

	const roots: TodoItem[] = [];
	const stack: Array<{ indent: number; list: TodoItem[] }> = [{ indent: -1, list: roots }];

	for (const rawEntry of rawItems) {
		const subLines = rawEntry.includes("\n") ? rawEntry.split(/\r?\n/) : [rawEntry];
		const multiLine = subLines.length > 1;
		for (const line of subLines) {
			if (!line.trim()) continue;
			const indentedMatch = INDENTED_OUTLINE_LINE_RE.exec(line);
			let indent = 0;
			let content = line;
			if (indentedMatch) {
				indent = measureIndentColumns(indentedMatch[1]!);
				content = indentedMatch[2]!.trim();
			} else if (multiLine) {
				const leadingWs = /^([ \t]*)/.exec(line)?.[1] ?? "";
				indent = measureIndentColumns(leadingWs);
				const trimmed = line.trim();
				content = ROOT_BULLET_PREFIX_RE.test(trimmed) ? trimmed.replace(/^[-*+]\s+/, "").trim() : trimmed;
			}

			while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
				stack.pop();
			}
			const targetList = stack[stack.length - 1]!.list;
			const node: TodoItem = { content, status: "pending" };
			targetList.push(node);
			node.children = [];
			stack.push({ indent, list: node.children });
		}
	}

	const pruneEmptyChildren = (list: TodoItem[]) => {
		for (const item of list) {
			if (item.children && item.children.length === 0) {
				delete item.children;
			} else if (item.children) {
				pruneEmptyChildren(item.children);
			}
		}
	};
	pruneEmptyChildren(roots);
	return roots;
}
function initPhases(entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	// Models routinely flatten the single-phase init into `{op:"init", items:[...]}`
	// (optionally with a bare `phase`) instead of the canonical
	// `list: [{phase, items}]`. Accept that shape by synthesizing a one-phase list
	// so a common, recoverable mistake isn't a hard error. Models also fill unused
	// params with `[]`, so an empty `list` must not shadow non-empty `items`.
	const flat =
		entry.items && entry.items.length > 0
			? [{ phase: entry.phase ?? DEFAULT_INIT_PHASE, items: entry.items }]
			: undefined;
	const list = entry.list?.length ? entry.list : (flat ?? entry.list);
	if (!list) {
		errors.push("Missing list for init operation");
		return [];
	}
	// Duplicate phase names / task contents would be permanently unaddressable
	// (every targeting op resolves the first match), so reject them up front.
	const seenPhases = new Set<string>();
	const seenTasks = new Set<string>();
	const builtPhases: TodoPhase[] = [];
	for (const listEntry of list) {
		if (seenPhases.has(listEntry.phase)) {
			errors.push(`Duplicate phase "${listEntry.phase}" in init list`);
		}
		seenPhases.add(listEntry.phase);
		const tasks = parseOutlineItems(listEntry.items);
		for (const node of flattenAllTodoItems(tasks)) {
			if (seenTasks.has(node.content)) {
				errors.push(`Duplicate task "${node.content}" in init list`);
			}
			seenTasks.add(node.content);
		}
		builtPhases.push({ name: listEntry.phase, tasks });
	}
	return builtPhases;
}

function appendItems(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (!entry.phase && !entry.parent) {
		errors.push("Missing phase or parent name for append operation");
		return phases;
	}
	if (!entry.items || entry.items.length === 0) {
		errors.push("Missing items for append operation");
		return phases;
	}

	let parentHit: TaskLookupHit | undefined;
	if (entry.parent) {
		parentHit = resolveTaskOrError(phases, entry.parent, errors);
		if (!parentHit) return phases;
		if (entry.phase && parentHit.phase.name !== entry.phase) {
			errors.push(`Parent task "${entry.parent}" belongs to phase "${parentHit.phase.name}", not "${entry.phase}"`);
			return phases;
		}
	}

	const parsedNodes = parseOutlineItems(entry.items);
	const allNewNodes = flattenAllTodoItems(parsedNodes);
	const seen = new Set<string>();
	let hasDuplicate = false;
	for (const node of allNewNodes) {
		if (seen.has(node.content) || findTaskByContent(phases, node.content)) {
			errors.push(`Task "${node.content}" already exists`);
			hasDuplicate = true;
		}
		seen.add(node.content);
	}
	if (hasDuplicate) return phases;

	if (parentHit) {
		parentHit.task.children ??= [];
		parentHit.task.children.push(...parsedNodes);
		return phases;
	}

	let phase = findPhaseByName(phases, entry.phase!);
	if (!phase) {
		phase = { name: entry.phase!, tasks: [] };
		phases.push(phase);
	}
	phase.tasks.push(...parsedNodes);
	return phases;
}

function removeTasks(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	if (entry.task) {
		const hit = resolveTaskOrError(phases, entry.task, errors);
		if (!hit) return phases;
		const idx = hit.container.indexOf(hit.task);
		if (idx >= 0) hit.container.splice(idx, 1);
		if (hit.parent && hit.parent.children && hit.parent.children.length === 0) {
			delete hit.parent.children;
		}
		return phases;
	}
	if (entry.phase) {
		const phase = resolvePhaseOrError(phases, entry.phase, errors);
		if (!phase) return phases;
		phase.tasks = [];
		return phases;
	}
	for (const phase of phases) {
		phase.tasks = [];
	}
	return phases;
}

function applyEntry(phases: TodoPhase[], entry: TodoOpEntryValue, errors: string[]): TodoPhase[] {
	switch (entry.op) {
		case "init":
			return initPhases(entry, errors);
		case "start": {
			const hit = resolveTaskOrError(phases, entry.task, errors);
			if (!hit) return phases;
			const targetLeaf = hit.task.children?.length
				? (flattenTodoLeaves(hit.task.children).find(t => t.status === "pending" || t.status === "in_progress") ??
					hit.task)
				: hit.task;
			for (const phase of phases) {
				for (const candidate of flattenAllTodoItems(phase.tasks)) {
					if (candidate.status === "in_progress" && candidate !== targetLeaf) {
						candidate.status = "pending";
					}
				}
			}
			targetLeaf.status = "in_progress";
			return phases;
		}
		case "done": {
			for (const task of getTaskTargets(phases, entry, errors)) {
				task.status = "completed";
			}
			return phases;
		}
		case "drop": {
			for (const task of getTaskTargets(phases, entry, errors)) {
				task.status = "abandoned";
			}
			return phases;
		}
		case "block": {
			if (!entry.task && !entry.phase) {
				errors.push("block requires a task or phase target");
				return phases;
			}
			// Collapse whitespace runs (incl. newlines) to single spaces: a blocker
			// note rides on one Markdown checklist line (as a trailing HTML comment)
			// and one HUD/summary line, so an embedded newline from a multi-line
			// external error or user question would corrupt the round-trip parse and
			// the rendered line. Normalizing here keeps every consumer one-line-safe.
			const reason = entry.reason?.replace(/\s+/g, " ").trim() || undefined;
			for (const task of getTaskTargets(phases, entry, errors)) {
				// Only actionable open work can be blocked: blocking a phase must not
				// reopen completed/abandoned tasks or erase finished progress. An
				// already-blocked task stays eligible so a later block can refine its
				// blocker note (e.g. first blocked without a reason, then with one).
				if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "blocked") continue;
				task.status = "blocked";
				task.blocker = reason;
			}
			return phases;
		}
		case "unblock": {
			if (!entry.task && !entry.phase) {
				errors.push("unblock requires a task or phase target");
				return phases;
			}
			for (const task of getTaskTargets(phases, entry, errors)) {
				if (task.status === "blocked") {
					task.status = "pending";
					task.blocker = undefined;
				}
			}
			return phases;
		}
		case "rm":
			return removeTasks(phases, entry, errors);
		case "append":
			return appendItems(phases, entry, errors);
		case "view":
			return phases;
	}
}

/**
 * Infer a missing `op` from the raw argument shape. Only unambiguous shapes
 * are inferred:
 * - `list` → `init` (list is init-only)
 * - `items` + `phase` → `append` (lazily creates the phase, so the result
 *   matches a single-phase init when nothing exists yet)
 * - bare `items` with no existing todos → `init` (nothing to overwrite)
 * Targeting args alone (`task`/`phase`) map to several ops and stay an error.
 */
function inferTodoOp(args: Record<string, unknown>, hasExistingPhases: boolean): TodoOperation | undefined {
	if (Array.isArray(args.list) && args.list.length > 0) return "init";
	if (Array.isArray(args.items) && args.items.length > 0) {
		if ((typeof args.phase === "string" && args.phase) || (typeof args.parent === "string" && args.parent)) {
			return "append";
		}
		if (!hasExistingPhases) return "init";
	}
	return undefined;
}

/**
 * Validate execute-time arguments, repairing an omitted `op`. The tool sets
 * `lenientArgValidation`, so the agent loop hands `execute()` the raw
 * arguments when schema validation fails; the only failure repaired here is
 * a missing `op` alongside an unambiguous payload (models routinely send
 * `{list:[...]}` with no op). Anything else returns the schema error text
 * for a normal model retry.
 */
function resolveTodoParams(raw: unknown, hasExistingPhases: boolean): TodoOpEntryValue | string {
	const direct = todoSchema(raw);
	if (!(direct instanceof type.errors)) return direct;
	if (isRecord(raw) && raw.op === undefined) {
		const inferred = inferTodoOp(raw, hasExistingPhases);
		if (inferred) {
			const repaired = todoSchema({ ...raw, op: inferred });
			if (!(repaired instanceof type.errors)) return repaired;
		}
	}
	return `Invalid todo arguments: ${direct.summary}`;
}

function applyParams(phases: TodoPhase[], params: TodoOpEntryValue): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const next = applyEntry(phases, params, errors);
	normalizeInProgressTask(next);
	return { phases: next, errors };
}

/** Apply an array of `todo`-style ops to existing phases. Used by /todo slash command. */
export function applyOpsToPhases(
	currentPhases: TodoPhase[],
	ops: TodoOpEntryValue[],
): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	let next = clonePhases(currentPhases);
	for (const op of ops) {
		next = applyEntry(next, op, errors);
	}
	normalizeInProgressTask(next);
	return { phases: next, errors };
}

/**
 * Reconcile open todo nodes (at any nesting depth, including parents with
 * grandchildren) against completed subagent descriptions: cascades completion
 * through the matched node's entire descendant subtree and runs
 * {@link normalizeInProgressTask} so parent rollup and next-actionable leaf
 * promotion stay consistent. Returns `undefined` when nothing matched.
 */
export function reconcileTodoPhasesWithCompletedDescriptions(
	currentPhases: readonly TodoPhase[],
	completedDescs: readonly string[],
): TodoPhase[] | undefined {
	if (completedDescs.length === 0) return undefined;
	const next = clonePhases(currentPhases as TodoPhase[]);
	let mutated = false;

	const completeSubtree = (node: TodoItem): void => {
		if (node.status === "pending" || node.status === "in_progress" || node.status === "blocked") {
			node.status = "completed";
			node.blocker = undefined;
			mutated = true;
		}
		if (node.children?.length) {
			for (const child of node.children) completeSubtree(child);
		}
	};

	const visitList = (list: TodoItem[]): void => {
		for (const item of list) {
			const open = item.status === "pending" || item.status === "in_progress" || item.status === "blocked";
			if (open && todoMatchesAnyDescription(item.content, completedDescs)) {
				completeSubtree(item);
				continue;
			}
			if (item.children?.length) visitList(item.children);
		}
	};

	for (const phase of next) visitList(phase.tasks);
	if (!mutated) return undefined;
	normalizeInProgressTask(next);
	return next;
}

// =============================================================================
// Markdown round-trip
// =============================================================================

const STATUS_TO_MARKER: Record<TodoStatus, string> = {
	pending: " ",
	in_progress: "/",
	completed: "x",
	abandoned: "-",
	blocked: "!",
};

export function resolveTodoMarkdownPath(input: string, cwd: string): string {
	const raw = normalizePathLikeInput(input) || "TODO.md";
	return resolveToCwd(raw, cwd);
}

/** Render todo phases as a Markdown checklist suitable for editing/copying. */
export function phasesToMarkdown(phases: TodoPhase[]): string {
	if (phases.length === 0) return "# Todos\n";
	const out: string[] = [];
	const emitTasks = (tasks: readonly TodoItem[], depth: number) => {
		const pad = "  ".repeat(depth);
		for (const task of tasks) {
			const blockerNote = task.status === "blocked" && task.blocker ? ` <!-- blocker: ${task.blocker} -->` : "";
			out.push(`${pad}- [${STATUS_TO_MARKER[task.status]}] ${task.content}${blockerNote}`);
			if (task.children?.length) emitTasks(task.children, depth + 1);
		}
	};
	for (let i = 0; i < phases.length; i++) {
		if (i > 0) out.push("");
		out.push(`# ${phases[i].name}`);
		emitTasks(phases[i].tasks, 0);
	}
	return `${out.join("\n")}\n`;
}

const MARKER_TO_STATUS: Record<string, TodoStatus> = {
	" ": "pending",
	"": "pending",
	x: "completed",
	X: "completed",
	"/": "in_progress",
	">": "in_progress",
	"-": "abandoned",
	"~": "abandoned",
	"!": "blocked",
};

/** Parse a Markdown checklist back into todo phases. */
export function markdownToPhases(md: string): { phases: TodoPhase[]; errors: string[] } {
	const errors: string[] = [];
	const phases: TodoPhase[] = [];
	let currentPhase: TodoPhase | undefined;
	let indentStack: Array<{ indent: number; list: TodoItem[] }> = [];

	const lines = md.split(/\r?\n/);
	for (let lineNum = 0; lineNum < lines.length; lineNum++) {
		const raw = lines[lineNum];
		const trimmed = raw.trim();
		if (!trimmed) continue;

		const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
		if (headingMatch) {
			currentPhase = { name: headingMatch[1].trim(), tasks: [] };
			phases.push(currentPhase);
			indentStack = [{ indent: -1, list: currentPhase.tasks }];
			continue;
		}

		const taskMatch = /^[-*+]\s*\\?\[(.?)\\?\]\s+(.+?)\s*$/.exec(trimmed);
		if (taskMatch) {
			if (!currentPhase) {
				currentPhase = { name: "Todos", tasks: [] };
				phases.push(currentPhase);
				indentStack = [{ indent: -1, list: currentPhase.tasks }];
			}
			const marker = taskMatch[1];
			const status = MARKER_TO_STATUS[marker];
			if (!status) {
				errors.push(`Line ${lineNum + 1}: unknown status marker "[${marker}]" (use [ ], [x], [/], [-], [!])`);
				continue;
			}
			const leadingWs = /^([ \t]*)/.exec(raw)?.[1] ?? "";
			const indent = measureIndentColumns(leadingWs);
			while (indentStack.length > 1 && indent <= indentStack[indentStack.length - 1]!.indent) {
				indentStack.pop();
			}
			const targetList = indentStack[indentStack.length - 1]!.list;
			const rawContent = taskMatch[2].trim();
			const blockerMatch = /^(.*?)\s*<!--\s*blocker:\s*(.*?)\s*-->$/.exec(rawContent);
			const node: TodoItem =
				status === "blocked" && blockerMatch
					? { content: blockerMatch[1].trim(), status, blocker: blockerMatch[2].trim() }
					: { content: rawContent, status };
			targetList.push(node);
			node.children = [];
			indentStack.push({ indent, list: node.children });
			continue;
		}

		errors.push(`Line ${lineNum + 1}: unrecognized syntax "${trimmed}"`);
	}

	const pruneEmpty = (list: TodoItem[]) => {
		for (const item of list) {
			if (item.children && item.children.length === 0) delete item.children;
			else if (item.children) pruneEmpty(item.children);
		}
	};
	for (const phase of phases) pruneEmpty(phase.tasks);

	normalizeInProgressTask(phases);
	return { phases, errors };
}

function formatSummary(phases: TodoPhase[], errors: string[], readOnly = false): string {
	const leafTasks = phases.flatMap(phase => flattenTodoLeaves(phase.tasks));
	if (leafTasks.length === 0) {
		if (errors.length > 0) return `Errors: ${errors.join("; ")}`;
		return readOnly ? "Todo list is empty." : "Todo list cleared.";
	}

	const remainingByPhase = phases
		.map(phase => ({
			name: phase.name,
			tasks: flattenTodoLeaves(phase.tasks).filter(
				task => task.status === "pending" || task.status === "in_progress",
			),
		}))
		.filter(phase => phase.tasks.length > 0);
	const remainingTasks = remainingByPhase.flatMap(phase => phase.tasks.map(task => ({ ...task, phase: phase.name })));

	let currentIdx = phases.findIndex(phase =>
		flattenTodoLeaves(phase.tasks).some(task => task.status === "pending" || task.status === "in_progress"),
	);
	if (currentIdx === -1) currentIdx = phases.length - 1;
	const current = phases[currentIdx];
	const currentCounts = countTodoLeaves(current.tasks);

	const lines: string[] = [];
	if (errors.length > 0) lines.push(`Errors: ${errors.join("; ")}`);
	if (remainingTasks.length === 0) {
		lines.push("Remaining items: none.");
	} else {
		lines.push(`Remaining items (${remainingTasks.length}):`);
		for (const task of remainingTasks) {
			lines.push(`  - ${task.content} [${task.status}] (${task.phase})`);
		}
	}
	const closedAll = leafTasks.filter(task => task.status === "completed" || task.status === "abandoned").length;
	const blockedAll = leafTasks.filter(task => task.status === "blocked").length;
	const workedAhead = phases.some(
		(phase, idx) =>
			idx > currentIdx &&
			flattenTodoLeaves(phase.tasks).some(task => task.status === "completed" || task.status === "abandoned"),
	);
	lines.push(
		`Overall: ${closedAll}/${leafTasks.length} done, ${remainingTasks.length} open${blockedAll > 0 ? `, ${blockedAll} blocked` : ""}.`,
	);
	lines.push(
		`Active phase ${currentIdx + 1}/${phases.length} "${current.name}" (${currentCounts.done}/${currentCounts.total})${
			workedAhead
				? " — earliest phase with open tasks; the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed)."
				: "."
		}`,
	);
	const emitPhaseTree = (tasks: readonly TodoItem[], depth: number) => {
		const pad = "    " + "  ".repeat(depth);
		for (const task of tasks) {
			const checkbox = task.status === "completed" ? "[X]" : "[ ]";
			const childBadge = task.children?.length
				? (() => {
						const c = countTodoLeaves(task.children);
						return ` [${c.done}/${c.total}]`;
					})()
				: "";
			const tag =
				task.status === "in_progress"
					? " (in progress)"
					: task.status === "abandoned"
						? " (dropped)"
						: task.status === "blocked"
							? task.blocker
								? ` (blocked: ${task.blocker})`
								: " (blocked)"
							: "";
			lines.push(`${pad}- ${checkbox} ${task.content}${childBadge}${tag}`);
			if (task.children?.length) emitPhaseTree(task.children, depth + 1);
		}
	};
	for (const phase of phases) {
		lines.push(`  ${phase.name}:`);
		emitPhaseTree(phase.tasks, 0);
	}
	return lines.join("\n");
}

// =============================================================================
// Tool Class
// =============================================================================

export class TodoTool implements AgentTool<typeof todoSchema, TodoToolDetails> {
	readonly name = "todo";
	readonly approval = "read" as const;
	readonly label = "Todo";
	readonly summary = "Write a structured todo list to track progress within a session";
	readonly description: string;
	readonly parameters = todoSchema;
	readonly concurrency = "exclusive";
	readonly strict = true;
	// Raw args reach execute() on schema failure; resolveTodoParams re-validates
	// and repairs the one recoverable shape (missing `op`, unambiguous payload).
	readonly lenientArgValidation = true;

	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(todoDescription);
	}

	async execute(
		_toolCallId: string,
		params: TodoParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TodoToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TodoToolDetails>> {
		const previousPhases = clonePhases(this.session.getTodoPhases?.() ?? []);
		const storage = this.session.getSessionFile() ? "session" : "memory";
		const resolved = resolveTodoParams(params, previousPhases.length > 0);
		if (typeof resolved === "string") {
			return {
				content: [{ type: "text", text: resolved }],
				details: { phases: previousPhases, storage },
				isError: true,
			};
		}
		const entry = resolved;
		const op = entry.op;
		// Pure-view calls are reads: no normalization, no state write.
		const readOnly = op === "view";
		const { phases: updated, errors } = readOnly
			? { phases: previousPhases, errors: [] as string[] }
			: applyParams(clonePhases(previousPhases), entry);
		// A batch with any error is discarded wholesale: persisting a
		// half-applied batch makes the natural retry hit "already exists" for
		// the ops that did land. State and rendered summary stay at previous.
		const failed = errors.length > 0;
		const effective = failed ? previousPhases : updated;
		const completedTasks = readOnly || failed ? [] : getCompletionTransitions(previousPhases, updated);
		if (!readOnly && !failed) this.session.setTodoPhases?.(updated);
		const details: TodoToolDetails = { op, phases: effective, storage };
		if (completedTasks.length > 0) details.completedTasks = completedTasks;

		return {
			content: [{ type: "text", text: formatSummary(effective, errors, readOnly) }],
			details,
			isError: errors.length > 0 ? true : undefined,
		};
	}
}
