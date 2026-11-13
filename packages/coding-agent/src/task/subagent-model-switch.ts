import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { formatModelString, getModelMatchPreferences, resolveCliModel } from "../config/model-resolver";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { executeSend, isIrcEnabled } from "../irc/messaging";
import { AgentLifecycleManager, type AgentLifecycleApi } from "../registry/agent-lifecycle";
import {
	type AgentRef,
	AgentRegistry,
	type AgentRegistryApi,
	type AgentStatus,
	MAIN_AGENT_ID,
} from "../registry/agent-registry";
import { ensurePersistedRoster } from "../registry/persisted-agents";
import type { SwitchModelAndContinueResult } from "../session/agent-session";
import { type AgentSessionHandle, isAgentViewSession, isLocalAgentSession } from "../session/agent-session-handle";
import type { ToolSession } from "../tools";

export interface SubagentModelCallerContext {
	settings: Settings;
	modelRegistry?: ModelRegistry;
	agentRegistry?: AgentRegistryApi;
	agentLifecycle?: () => AgentLifecycleApi;
	asyncJobManager?: ToolSession["asyncJobManager"];
	getAgentId?: () => string | null | undefined;
	getSessionFile?: () => string | null | undefined;
	sessionFile?: string | null | undefined;
	enableIrc?: boolean;
	taskDepth?: number;
	scopedModels?: ReadonlyArray<{ model: Model<Api> }>;
}

export interface SubagentModelInspection {
	id: string;
	status: AgentStatus;
	model: string | undefined;
	thinkingLevel: string | undefined;
	isStreaming: boolean;
}

export interface SwitchSubagentModelOptions {
	caller: SubagentModelCallerContext;
	targetId: string;
	/** Model selector (`provider/id`, fuzzy id, `@role`, `role`, `:thinkingLevel`) when `model` is not pre-resolved. */
	modelSelector?: string;
	/** Pre-resolved model (e.g. from the interactive Model Picker). */
	model?: Model<Api>;
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Optional steering or continuation instruction delivered on the new model. */
	prompt?: string;
	/**
	 * When the subagent is settled (`idle`/`parked`/`aborted`) with no unfinished or
	 * failed turn tail and no explicit `prompt`, send a continuation directive so it
	 * resumes work on the newly selected model. Default: `false`.
	 */
	continueIfSettled?: boolean;
	/** Also interrupt active local tool calls instead of waiting for them to finish. Default: `false`. */
	interruptTools?: boolean;
}

export interface SubagentModelSwitchResult extends SwitchModelAndContinueResult {
	agentId: string;
	statusBefore: AgentStatus;
	revived: boolean;
	promptSent: boolean;
	warning?: string;
	summary: string;
}

const DEFAULT_SETTLED_CONTINUE_PROMPT =
	"Your model has been switched. Review your progress so far and continue any remaining work.";

function getRegistry(caller: SubagentModelCallerContext): AgentRegistryApi {
	return caller.agentRegistry ?? AgentRegistry.global();
}

function getLifecycle(caller: SubagentModelCallerContext): AgentLifecycleApi {
	return caller.agentLifecycle?.() ?? AgentLifecycleManager.global();
}

/**
 * Resolve `targetId` (subagent ID, case-insensitive subagent ID, or owning `task` job ID)
 * to its {@link AgentRef}. Rejects non-task background jobs, `Main`, and read-only advisors.
 */
export async function resolveSubagentTargetRef(
	caller: SubagentModelCallerContext,
	rawTargetId: string,
): Promise<AgentRef> {
	const requested = rawTargetId.trim();
	if (!requested) {
		throw new Error("Subagent ID is required.");
	}
	if (requested === MAIN_AGENT_ID || requested.toLowerCase() === "main") {
		throw new Error(`"${MAIN_AGENT_ID}" is the primary session; use /model or /switch instead.`);
	}

	const registry = getRegistry(caller);
	const ownerId = caller.getAgentId?.() ?? undefined;
	const jobs = caller.asyncJobManager?.getAllJobs(ownerId ? { ownerId } : undefined) ?? [];
	const matchedJob = jobs.find(job => job.id === requested);
	if (matchedJob && matchedJob.type !== "task") {
		throw new Error(`Job "${requested}" is a ${matchedJob.type} job, not a subagent.`);
	}
	const resolvedId = matchedJob ? (matchedJob.agentId ?? matchedJob.id) : requested;

	let ref = registry.get(resolvedId);
	if (!ref) {
		const sessionFile = caller.getSessionFile?.() ?? caller.sessionFile ?? undefined;
		if (sessionFile) {
			await ensurePersistedRoster(registry, sessionFile);
			ref = registry.get(resolvedId);
		}
	}
	if (!ref) {
		const lower = resolvedId.toLowerCase();
		ref = registry.list().find(candidate => candidate.id !== MAIN_AGENT_ID && candidate.id.toLowerCase() === lower);
	}
	if (!ref) {
		const available = registry
			.list()
			.filter(candidate => candidate.id !== MAIN_AGENT_ID && candidate.kind !== "advisor")
			.map(candidate => candidate.id);
		const hint = available.length > 0 ? ` Known subagents: ${available.slice(0, 8).join(", ")}.` : "";
		throw new Error(`Subagent not found: ${requested}.${hint}`);
	}
	if (ref.id === MAIN_AGENT_ID) {
		throw new Error(`"${MAIN_AGENT_ID}" is the primary session; use /model or /switch instead.`);
	}
	if (ref.kind === "advisor") {
		throw new Error(`"${ref.id}" is a read-only advisor transcript; its model cannot be switched.`);
	}
	return ref;
}

/** Read a subagent's current model, thinking level, and status without mutating or reviving it. */
export async function inspectSubagentModel(
	caller: SubagentModelCallerContext,
	targetId: string,
): Promise<SubagentModelInspection> {
	const ref = await resolveSubagentTargetRef(caller, targetId);
	const liveSession = ref.session;
	const model = liveSession?.model ? formatModelString(liveSession.model) : ref.history?.resolvedModel;
	// A view session reports its configured level (`auto` included); a plain handle reports the effective one.
	const thinkingLevel = liveSession
		? isAgentViewSession(liveSession)
			? liveSession.configuredThinkingLevel()
			: liveSession.thinkingLevel
		: undefined;
	return {
		id: ref.id,
		status: ref.status,
		model,
		thinkingLevel: thinkingLevel !== undefined ? String(thinkingLevel) : undefined,
		isStreaming: liveSession?.isStreaming === true,
	};
}

function resolveRequestedModel(
	selector: string,
	caller: SubagentModelCallerContext,
	subSession?: AgentSessionHandle | null,
): { model: Model<Api>; thinkingLevel?: ConfiguredThinkingLevel; warning?: string } {
	const trimmed = selector.trim();
	if (!trimmed) {
		throw new Error("Model selector is required (e.g. provider/model, fuzzy model id, or @role).");
	}
	// Only a session homed here owns a registry the caller may resolve against.
	const modelRegistry =
		subSession && isLocalAgentSession(subSession) ? subSession.modelRegistry : caller.modelRegistry;
	if (!modelRegistry) {
		throw new Error("Model registry is unavailable in this session.");
	}
	const scoped = caller.scopedModels?.map(entry => entry.model) ?? [];
	const resolved = resolveCliModel({
		cliModel: trimmed,
		modelRegistry,
		availableModels: scoped.length > 0 ? scoped : undefined,
		settings: caller.settings,
		preferences: getModelMatchPreferences(caller.settings),
	});
	if (!resolved.model) {
		throw new Error(resolved.error || `Unknown model selector: ${trimmed}`);
	}
	return {
		model: resolved.model,
		thinkingLevel: resolved.thinkingLevel,
		warning: resolved.warning,
	};
}

/**
 * Switch a subagent's active model mid-flight (or revive a parked/killed subagent onto
 * the new model) and continue from its existing transcript & tool state.
 */
export async function switchSubagentModel(options: SwitchSubagentModelOptions): Promise<SubagentModelSwitchResult> {
	const { caller } = options;
	const ref = await resolveSubagentTargetRef(caller, options.targetId);
	const statusBefore = ref.status;
	const registry = getRegistry(caller);

	let targetModel = options.model;
	let targetThinking = options.thinkingLevel;
	let warning: string | undefined;

	if (!targetModel) {
		const resolved = resolveRequestedModel(options.modelSelector ?? "", caller, ref.session);
		targetModel = resolved.model;
		targetThinking ??= resolved.thinkingLevel;
		warning = resolved.warning;
	}

	const revived = ref.session === null;
	const subSession = ref.session ?? (await getLifecycle(caller).ensureLive(ref.id));

	const outcome = await subSession.switchModelAndContinue(targetModel, {
		thinkingLevel: targetThinking,
		interruptTools: options.interruptTools,
	});

	registry.setHistory(ref.id, {
		resolvedModel: outcome.model,
		resolvedModelIsFallback: false,
	});

	const explicitPrompt = options.prompt?.trim();
	const needsSettledPrompt =
		!explicitPrompt && options.continueIfSettled === true && !outcome.resumed && !subSession.isStreaming;
	const followUpText = explicitPrompt || (needsSettledPrompt ? DEFAULT_SETTLED_CONTINUE_PROMPT : undefined);

	let promptSent = false;
	if (followUpText) {
		const senderId = caller.getAgentId?.() ?? undefined;
		const canUseIrc =
			Boolean(senderId) &&
			senderId !== ref.id &&
			caller.enableIrc !== false &&
			isIrcEnabled(caller.settings, caller.taskDepth ?? 0);
		if (canUseIrc && senderId) {
			const sendResult = await executeSend(
				{
					registry,
					senderId,
					sessionFileHint: caller.getSessionFile?.() ?? caller.sessionFile,
				},
				{
					to: ref.id,
					message: followUpText,
				},
			);
			if (sendResult.isError) {
				const errText =
					sendResult.content.find(item => item.type === "text")?.text ?? "Failed to deliver continuation message.";
				throw new Error(errText);
			}
			promptSent = true;
		} else {
			void subSession.prompt(followUpText, {
				streamingBehavior: "steer",
				attribution: "user",
				userInitiated: true,
			});
			promptSent = true;
		}
	}

	const fromClause =
		outcome.previousModel && outcome.previousModel !== outcome.model ? ` from ${outcome.previousModel}` : "";
	const thinkingClause = outcome.thinkingLevel ? ` (thinking: ${outcome.thinkingLevel})` : "";
	let actionClause: string;
	if (outcome.interruptedLlm) {
		actionClause = outcome.resumed
			? "interrupted in-flight turn and resumed immediately on new model"
			: "interrupted in-flight turn and switched model";
	} else if (outcome.deferredAfterActiveTools) {
		actionClause = "active tool call preserved; next turn runs on new model";
	} else if (revived && (outcome.resumed || promptSent)) {
		actionClause = "revived subagent and continued on new model";
	} else if (outcome.resumed) {
		actionClause = "resumed unfinished turn on new model";
	} else if (promptSent) {
		actionClause = "switched model and dispatched continuation";
	} else if (revived) {
		actionClause = "revived subagent on new model";
	} else {
		actionClause = "next turn will use new model";
	}

	const summary = `Switched subagent ${ref.id}${fromClause} to ${outcome.model}${thinkingClause} — ${actionClause}.`;

	return {
		...outcome,
		agentId: ref.id,
		statusBefore,
		revived,
		promptSent,
		warning,
		summary,
	};
}
