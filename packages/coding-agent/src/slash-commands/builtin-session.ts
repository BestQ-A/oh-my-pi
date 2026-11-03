import { clearSubmittedText } from "./helpers/draft";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { journalJudgmentUsage, resolveJudge, sharedJudgmentCache } from "../judgment";
import type { AgentSession } from "../session/agent-session";
import type { SessionOAuthAccountList } from "../session/agent-session-types";
import {
	getChangelogPath,
	parseChangelog,
	parseChangelogView,
	renderChangelogEntries,
	selectChangelogEntries,
} from "../utils/changelog";
import { formatTokenCount, refreshStatusLine } from "./builtin-modes";
import { buildContextReportText } from "./helpers/context-report";
import { formatCoarseDuration } from "@oh-my-pi/pi-tui/chrome/format";
import { truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { buildJobTree, jobTreeGuide, jobTreeIndent } from "@oh-my-pi/pi-tui/overlays/job-tree";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { handleMcpAcp } from "./helpers/mcp";
import { markdownFenceFor } from "../utils/markdown-fence";
import { openLocalFileInEditor } from "../modes/local-file-editor";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./helpers/parse";
import {
	describeRedeemOutcome,
	formatResetUsageAccountLine,
	oneLine,
	resolveResetUsageTarget,
	toResetUsageAccounts,
} from "./helpers/reset-usage";
import type { ResetUsageAccount } from "@oh-my-pi/pi-tui/overlays/reset-usage-selector";
import { matchSessionPinAccounts, toSessionPinAccounts } from "./helpers/session-pin";
import {
	launchStatsDashboard,
	parseStatsDashboardArgs,
	type StatsDashboardArgs,
	type StatsDashboardLaunchResult,
} from "./helpers/stats-dashboard";
import { StatsNotice } from "@oh-my-pi/pi-tui/overlays/stats-notice";
import { handleTodoAcp } from "./helpers/todo";
import { buildUsageReportText } from "./helpers/usage-report";
import type { SlashCommandRuntime, SlashCommandSpec } from "./types";
import {
	canUseDefaultFinopsUsageCache,
	launchDesktopQuotaHud,
	readCachedFinopsUsageReports,
	writeCachedFinopsUsageReports,
} from "../modes/quota-hud-bridge";
import {
	applyModelRecommendations,
	formatModelRecommendationReport,
	probeMagpieGatewayUp,
	recommendModelsForSession,
} from "../config/model-recommender";
import { cfgComposerMarginHud } from "../modes/settings";
import { switchSubagentModel } from "../task/subagent-model-switch";

const QUOTA_SUBCOMMANDS: Record<string, true> = {
	show: true,
	popup: true,
	hud: true,
	mini: true,
	close: true,
	refresh: true,
	recommend: true,
	auto: true,
};

const HUD_SUBCOMMANDS: Record<string, true> = {
	on: true,
	off: true,
	toggle: true,
	refresh: true,
};

async function handleUsageResetCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	let accounts: ResetUsageAccount[];
	try {
		accounts = toResetUsageAccounts(await session.listResetCredits());
	} catch (error) {
		await output(`Could not load saved resets: ${oneLine(errorMessage(error))}`);
		return;
	}
	if (accounts.length === 0) {
		await output("No provider accounts found. Use /login to add one.");
		return;
	}
	if (!arg.trim()) {
		const lines = ["Saved rate-limit resets:", ...accounts.map(formatResetUsageAccountLine)];
		lines.push("", "Spend one with `/usage reset <provider>/<credential id>` or `/usage reset <provider>/active`.");
		await output(lines.join("\n"));
		return;
	}
	const resolved = resolveResetUsageTarget(accounts, arg, "/usage reset");
	if ("error" in resolved) {
		await output(resolved.error);
		return;
	}
	const outcome = await session.redeemResetCredit(resolved.account.target);
	await output(oneLine(describeRedeemOutcome(outcome, resolved.account.label)));
}

/**
 * `/jobs kill <id>|all`: cancel one running background job this session owns,
 * or every running one. Routes through the same owner-scoped
 * `AgentSession.cancelAsyncJob` the jobs sheet's `x`-to-cancel and
 * `proc://<id>/kill` use, so it can only touch jobs `/jobs` lists.
 */
async function handleJobsKillCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	const target = arg.trim();
	if (!target) {
		await output("Usage: /jobs kill <id>|all");
		return;
	}
	const snapshot = session.getAsyncJobSnapshot({ recentLimit: 0 });
	if (!snapshot) {
		await output("Async background jobs are unavailable in this session.");
		return;
	}
	if (target === "all") {
		let cancelled = 0;
		for (const job of snapshot.running) {
			if (session.cancelAsyncJob(job.id)) cancelled += 1;
		}
		await output(
			cancelled === 0
				? "No running background jobs to cancel."
				: `Cancelled ${cancelled} background job${cancelled === 1 ? "" : "s"}.`,
		);
		return;
	}
	const safeTarget = truncateToWidth(sanitizeText(target).replace(/\s+/g, " ").trim(), 60);
	if (!snapshot.running.some(job => job.id === target)) {
		await output(`No running background job with id "${safeTarget}".`);
		return;
	}
	await output(
		session.cancelAsyncJob(target)
			? `Cancelled background job ${safeTarget}.`
			: `Could not cancel background job ${safeTarget}.`,
	);
}

async function handleSessionPinCommand(
	arg: string,
	session: AgentSession,
	output: SlashCommandRuntime["output"],
): Promise<void> {
	if (session.isStreaming) {
		await output("Cannot pin an account while the session is streaming.");
		return;
	}
	let accountList: SessionOAuthAccountList | undefined;
	try {
		accountList = await session.listCurrentProviderOAuthAccounts();
	} catch (error) {
		await output(`Could not load provider accounts: ${errorMessage(error)}`);
		return;
	}
	if (!accountList) {
		await output("Select a model before pinning a provider account.");
		return;
	}
	const provider = getOAuthProviders().find(candidate => candidate.id === accountList.provider);
	const providerName = provider?.name ?? accountList.provider;
	const accounts = toSessionPinAccounts(accountList.accounts);
	if (accounts.length === 0) {
		const source = session.modelRegistry.authStorage.keys.describe(accountList.provider, session.sessionId);
		await output(
			source
				? `No stored OAuth accounts for ${providerName}. Current auth comes from ${source}.`
				: `No stored OAuth accounts for ${providerName}. Use /login to add one.`,
		);
		return;
	}

	const selector = arg.trim();
	if (!selector) {
		const lines = [`OAuth accounts for ${providerName}:`];
		for (const account of accounts) {
			lines.push(`${account.position + 1}. ${account.label}${account.active ? " (active)" : ""}`);
		}
		lines.push("", "Pin one with `/session pin <number|email|account id>`.");
		await output(lines.join("\n"));
		return;
	}

	const matches = matchSessionPinAccounts(accounts, selector);
	if (matches.length === 0) {
		await output(`No ${providerName} account matches "${selector}".`);
		return;
	}
	if (matches.length > 1) {
		await output(
			`"${selector}" matches multiple ${providerName} accounts: ${matches
				.map(account => `${account.position + 1}. ${account.label}`)
				.join(", ")}. Use the account number.`,
		);
		return;
	}
	const account = matches[0];
	if (!account || !session.pinCurrentProviderOAuthAccount(account.credentialId)) {
		await output(`${account?.label ?? selector} is no longer available to pin.`);
		return;
	}
	await output(`Pinned ${account.label} to this session for ${providerName}.`);
}

/**
 * Start (or reuse) the stats dashboard for this session. The Frustration page
 * judges through this session's settings and registry; its cost lands on this
 * session's ledger.
 */
function launchSessionStatsDashboard(
	args: StatsDashboardArgs,
	owner: Pick<SlashCommandRuntime, "settings" | "session" | "sessionManager">,
): Promise<StatsDashboardLaunchResult> {
	const judge = resolveJudge({
		settings: owner.settings,
		registry: owner.session.modelRegistry,
		sessionId: owner.session.sessionId,
		purpose: "stats_frustration",
		onUsage: journalJudgmentUsage(owner.sessionManager),
		telemetry: owner.session.agent.telemetry,
		cache: sharedJudgmentCache(),
	});
	return launchStatsDashboard(args, async () => judge);
}

export const BUILTIN_SESSION_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "todo",
		icon: "todo",
		description: "View or modify the agent's todo list",
		acpDescription: "Manage todos",
		acpInputHint: "<subcommand>",
		subcommands: [
			{ name: "edit", description: "Open todos in $EDITOR (Markdown round-trip)" },
			{ name: "copy", description: "Copy todos as Markdown to clipboard" },
			{ name: "expand", description: "Show every phase and task in the HUD" },
			{ name: "collapse", description: "Restore the bounded HUD preview" },
			{ name: "export", description: "Write todos as Markdown to a file (default: TODO.md)", usage: "[<path>]" },
			{ name: "import", description: "Replace todos from a Markdown file (default: TODO.md)", usage: "[<path>]" },
			{
				name: "append",
				description: "Append a task; phase fuzzy-matched or auto-created",
				usage: "[<phase>] <task...>",
			},
			{ name: "start", description: "Mark task in_progress (fuzzy-matched)", usage: "<task>" },
			{ name: "done", description: "Mark task/phase/all completed (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "drop", description: "Mark task/phase/all abandoned (fuzzy-matched)", usage: "[<task|phase>]" },
			{ name: "rm", description: "Remove task/phase/all (fuzzy-matched)", usage: "[<task|phase>]" },
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const tasks = runtime.ctx.todoPhases.flatMap(phase => phase.tasks);
			if (tasks.length === 0) return "Todos: none";
			const pending = tasks.filter(task => task.status === "pending").length;
			const inProgress = tasks.filter(task => task.status === "in_progress").length;
			const completed = tasks.filter(task => task.status === "completed").length;
			return `Todos: ${pending + inProgress} open (${inProgress} in progress, ${completed} done)`;
		},
		handle: handleTodoAcp,
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleTodoCommand(command.args);
			clearSubmittedText(runtime);
		},
	},
	{
		name: "session",
		icon: "session",
		description: "Session management commands",
		acpDescription: "Show or configure the current session",
		acpInputHint: "[info|delete|pin [account]]",
		subcommands: [
			{ name: "info", description: "Show session info and stats" },
			{ name: "delete", description: "Delete current session and return to selector" },
			{
				name: "pin",
				description: "Pin a stored OAuth account to the current provider for this session",
				usage: "[account]",
			},
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "info" && !rest)) {
				await runtime.output(
					[
						`Session: ${runtime.session.sessionId}`,
						`Title: ${runtime.session.sessionName}`,
						`CWD: ${runtime.cwd}`,
					].join("\n"),
				);
				return commandConsumed();
			}
			if (verb === "delete" && !rest) {
				if (runtime.session.isStreaming) return usage("Cannot delete the session while streaming.", runtime);
				const sessionFile = runtime.sessionManager.getSessionFile();
				if (!sessionFile) return usage("No session file to delete (in-memory session).", runtime);
				// Route through the active SessionManager so the persist writer is
				// closed before the file is deleted. Constructing a fresh
				// FileSessionStorage and calling deleteSessionWithArtifacts leaves
				// the active writer attached to the now-deleted path, so the next
				// prompt would silently resurrect or corrupt the "deleted" file.
				try {
					await runtime.sessionManager.dropSession(sessionFile);
				} catch (err) {
					return usage(`Failed to delete session: ${errorMessage(err)}`, runtime);
				}
				await runtime.output(
					`Session deleted: ${sessionFile}. Use ACP \`session/load\` to switch to another session.`,
				);
				return commandConsumed();
			}
			if (verb === "pin") {
				await handleSessionPinCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			return usage("Usage: /session [info|delete|pin [account]]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "delete" && !rest) {
				clearSubmittedText(runtime);
				await runtime.ctx.handleSessionDeleteCommand();
				return;
			}
			if (verb === "pin") {
				if (rest) {
					await handleSessionPinCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
					refreshStatusLine(runtime.ctx);
				} else {
					await runtime.ctx.showSessionPinSelector();
				}
				clearSubmittedText(runtime);
				return;
			}
			if (!verb || (verb === "info" && !rest)) {
				await runtime.ctx.handleSessionCommand();
			} else {
				runtime.ctx.showStatus("Usage: /session [info|delete|pin [account]]");
			}
			clearSubmittedText(runtime);
		},
	},
	{
		name: "jobs",
		icon: "jobs",
		description: "Show async background jobs status",
		acpDescription: "Show background jobs",
		acpInputHint: "[full|kill <id>|kill all|model <id> <model>]",
		subcommands: [
			{ name: "full", description: "Show full, untruncated command lines" },
			{ name: "kill", description: "Cancel a running background job", usage: "<id>|all" },
			{
				name: "model",
				description: "Switch a subagent's model mid-flight and continue",
				usage: "<id> [model] [prompt...]",
			},
		],
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const snapshot = runtime.ctx.session.getAsyncJobSnapshot({ recentLimit: 5 });
			if (!snapshot || (snapshot.running.length === 0 && snapshot.recent.length === 0)) return "Jobs: none";
			return `Jobs: ${snapshot.running.length} running, ${snapshot.recent.length} recent`;
		},
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "kill") {
				await handleJobsKillCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			if (verb === "model") {
				const { verb: agentId, rest: modelAndPrompt } = parseSubcommand(rest);
				const { verb: modelSelector, rest: followUpPrompt } = parseSubcommand(modelAndPrompt);
				if (!agentId || !modelSelector) {
					return usage("Usage: /jobs model <subagent-id> <model> [prompt...]", runtime);
				}
				try {
					const switched = await switchSubagentModel({
						caller: runtime.session,
						targetId: agentId,
						modelSelector,
						prompt: followUpPrompt.trim() || undefined,
					});
					await runtime.output(
						switched.warning ? `${switched.summary}\nNote: ${switched.warning}` : switched.summary,
					);
					return commandConsumed();
				} catch (err) {
					return usage(`Failed to switch subagent model: ${errorMessage(err)}`, runtime);
				}
			}
			if (rest || (verb && verb !== "full"))
				return usage("Usage: /jobs [full|kill <id>|kill all|model <id> <model>]", runtime);
			const full = verb === "full";
			const tree = runtime.session.getAsyncJobTree();
			if (!tree || (tree.running.length === 0 && tree.recent.length === 0)) {
				await runtime.output(
					"No background jobs running. (Background jobs run async tools — e.g. long-running bash, debug, or task subagents that would otherwise tie up a turn. They appear here while alive and briefly after (until their result is delivered; at most ~5 minutes).)",
				);
				return commandConsumed();
			}
			// One fenced block keeps the tree rails aligned; the fence outgrows any run inside a command.
			const now = Date.now();
			const rows: string[] = [];
			for (const row of buildJobTree([...tree.running, ...tree.recent], tree.agents, tree.rootId)) {
				const guide = jobTreeGuide(row, theme);
				if (row.kind === "agent") {
					rows.push(`${guide}${row.agent.id}`);
					continue;
				}
				const { job } = row;
				// A spawned subagent's task job takes the agent's id as its id and label: name it once.
				const agent = row.agent && row.agent.id !== job.id ? ` ${row.agent.id}` : "";
				rows.push(
					`${guide}[${job.id}] ${job.type} (${job.status}) — ${formatCoarseDuration((job.endTime ?? now) - job.startTime)}${agent}`,
				);
				const text = sanitizeText(full ? (job.command ?? job.label) : job.label);
				if (text === job.id) continue;
				const indent = jobTreeIndent(row, theme);
				for (const line of full ? text.split("\n") : [text]) rows.push(`${indent}${line}`);
			}
			const body = rows.join("\n");
			const fence = markdownFenceFor(body);
			await runtime.output(
				["Background Jobs", `Running: ${tree.running.length}`, "", `${fence}text`, body, fence].join("\n"),
			);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "kill") {
				await handleJobsKillCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
			} else if (verb === "model") {
				const { verb: agentId, rest: modelAndPrompt } = parseSubcommand(rest);
				const { verb: modelSelector, rest: followUpPrompt } = parseSubcommand(modelAndPrompt);
				if (!agentId) {
					runtime.ctx.showStatus("Usage: /jobs model <subagent-id> [model] [prompt...]");
				} else if (!modelSelector) {
					runtime.ctx.showSubagentModelPicker(agentId);
				} else {
					try {
						const switched = await switchSubagentModel({
							caller: runtime.ctx.session,
							targetId: agentId,
							modelSelector,
							prompt: followUpPrompt.trim() || undefined,
						});
						runtime.ctx.statusLine.invalidate();
						runtime.ctx.showStatus(switched.summary);
					} catch (err) {
						runtime.ctx.showError(`Failed to switch subagent model: ${errorMessage(err)}`);
					}
				}
			} else if (rest || (verb && verb !== "full")) {
				runtime.ctx.showStatus("Usage: /jobs [full|kill <id>|kill all|model <id> [model]]");
			} else {
				await runtime.ctx.handleJobsCommand({ full: verb === "full" });
			}
			clearSubmittedText(runtime);
		},
	},
	{
		name: "subagent",
		icon: "agents",
		description: "Switch a running or parked subagent's model mid-flight and continue, or open Agent Hub",
		acpDescription: "Switch subagent model mid-flight",
		acpInputHint: "[model] <subagent-id> [model] [prompt...]",
		subcommands: [
			{
				name: "model",
				description: "Switch a subagent's model mid-flight and continue",
				usage: "<subagent-id> [model] [prompt...]",
			},
			{
				name: "hub",
				description: "Open Agent Hub",
			},
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			const payload = verb === "model" || verb === "switch" ? rest : command.args;
			const { verb: agentId, rest: modelAndPrompt } = parseSubcommand(payload);
			const { verb: modelSelector, rest: followUpPrompt } = parseSubcommand(modelAndPrompt);
			if (!agentId || !modelSelector) {
				return usage("Usage: /subagent [model] <subagent-id> <model> [prompt...]", runtime);
			}
			try {
				const switched = await switchSubagentModel({
					caller: runtime.session,
					targetId: agentId,
					modelSelector,
					prompt: followUpPrompt.trim() || undefined,
				});
				await runtime.output(
					switched.warning ? `${switched.summary}\nNote: ${switched.warning}` : switched.summary,
				);
				return commandConsumed();
			} catch (err) {
				return usage(`Failed to switch subagent model: ${errorMessage(err)}`, runtime);
			}
		},
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			const trimmed = command.args.trim();
			if (!trimmed || trimmed === "hub") {
				runtime.ctx.showAgentHub();
				return;
			}
			const { verb, rest } = parseSubcommand(trimmed);
			const payload = verb === "model" || verb === "switch" ? rest : trimmed;
			const { verb: agentId, rest: modelAndPrompt } = parseSubcommand(payload);
			const { verb: modelSelector, rest: followUpPrompt } = parseSubcommand(modelAndPrompt);
			if (!agentId) {
				runtime.ctx.showStatus("Usage: /subagent [model] <subagent-id> [model] [prompt...]");
				return;
			}
			if (!modelSelector) {
				runtime.ctx.showSubagentModelPicker(agentId);
				return;
			}
			try {
				const switched = await switchSubagentModel({
					caller: runtime.ctx.session,
					targetId: agentId,
					modelSelector,
					prompt: followUpPrompt.trim() || undefined,
				});
				runtime.ctx.statusLine.invalidate();
				runtime.ctx.showStatus(switched.summary);
			} catch (err) {
				runtime.ctx.showError(`Failed to switch subagent model: ${errorMessage(err)}`);
			}
		},
	},
	{
		name: "usage",
		icon: "gauge",
		description: "Show provider usage and limits",
		acpDescription: "Show token usage",
		acpInputHint: "[show|reset [provider/credential-id|provider/active]]",
		subcommands: [
			{ name: "show", description: "Show provider usage and limits" },
			{
				name: "reset",
				description: "Spend a saved provider rate-limit reset",
				usage: "[provider/credential-id|provider/active]",
			},
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.output(await buildUsageReportText(runtime));
				return commandConsumed();
			}
			if (verb === "reset") {
				await handleUsageResetCommand(rest, runtime.session, runtime.output);
				return commandConsumed();
			}
			return usage("Usage: /usage [show|reset [provider/credential-id|provider/active]]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.ctx.handleUsageCommand();
				clearSubmittedText(runtime);
				return;
			}
			if (verb === "reset") {
				if (rest) {
					await handleUsageResetCommand(rest, runtime.ctx.session, text => runtime.ctx.showStatus(text));
				} else {
					await runtime.ctx.showResetUsageSelector();
				}
				clearSubmittedText(runtime);
				return;
			}
			runtime.ctx.showStatus("Usage: /usage [show|reset [provider/credential-id|provider/active]]");
			clearSubmittedText(runtime);
		},
	},
	{
		name: "quota",
		icon: "gauge",
		description: "Open live multi-pool quota overlay or desktop HUD",
		acpDescription: "Show or control multi-pool quota HUD",
		acpInputHint: "[show|recommend|auto|popup|hud|mini|close|refresh]",
		subcommands: [
			{ name: "show", description: "Open TUI multi-pool quota overlay (0ms cached + live refresh)" },
			{
				name: "recommend",
				description: "Recommend optimal models per role based on quota pools and model capabilities",
			},
			{
				name: "auto",
				description: "Auto-apply optimal models and fallback chains based on quota pools and capabilities",
			},
			{ name: "popup", description: "Launch Windows always-on-top Desktop Quota HUD (full cards)" },
			{ name: "hud", description: "Launch Windows always-on-top Desktop Quota HUD (full cards)" },
			{ name: "mini", description: "Launch Windows Desktop Quota HUD in Mini Capsule Strip mode" },
			{ name: "close", description: "Close Windows Desktop Quota HUD" },
			{ name: "refresh", description: "Force live usage probe and update cache, status bar, and HUD" },
		],
		subcommandOptional: true,
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb || (verb === "show" && !rest)) {
				await runtime.output(await buildUsageReportText(runtime));
				return commandConsumed();
			}
			if ((verb === "popup" || verb === "hud") && !rest) {
				const res = launchDesktopQuotaHud("full");
				await runtime.output(res.message);
				return commandConsumed({ failed: !res.ok });
			}
			if (verb === "mini" && !rest) {
				const res = launchDesktopQuotaHud("mini");
				await runtime.output(res.message);
				return commandConsumed({ failed: !res.ok });
			}
			if (verb === "close" && !rest) {
				const res = launchDesktopQuotaHud("close");
				await runtime.output(res.message);
				return commandConsumed({ failed: !res.ok });
			}
			if (verb === "refresh" && !rest) {
				const fresh = await runtime.session.fetchUsageReports();
				if (fresh && fresh.length > 0 && canUseDefaultFinopsUsageCache()) {
					writeCachedFinopsUsageReports(fresh);
				}
				launchDesktopQuotaHud("refresh");
				const count = fresh?.length ?? 0;
				await runtime.output(`Refreshed quota pools (${count} account report${count === 1 ? "" : "s"}).`);
				return commandConsumed();
			}
			if ((verb === "recommend" || verb === "auto") && !rest) {
				let reports = canUseDefaultFinopsUsageCache() ? readCachedFinopsUsageReports() : [];
				if (reports.length === 0) {
					const fresh = await runtime.session.fetchUsageReports();
					if (fresh && fresh.length > 0) {
						reports = fresh;
						if (canUseDefaultFinopsUsageCache()) writeCachedFinopsUsageReports(fresh);
					}
				}
				const magpieGatewayUp = await probeMagpieGatewayUp();
				const rec = recommendModelsForSession({
					models: runtime.session.getAvailableModels(),
					reports,
					settings: runtime.settings,
					magpieGatewayUp,
				});
				if (verb === "auto") {
					const res = await applyModelRecommendations(runtime.settings, runtime.session, rec);
					await runtime.output(`${res.message}\n\n${formatModelRecommendationReport(rec, runtime.settings)}`);
					return commandConsumed({ failed: !res.ok });
				}
				await runtime.output(formatModelRecommendationReport(rec, runtime.settings));
				return commandConsumed();
			}
			return usage("Usage: /quota [show|recommend|auto|popup|hud|mini|close|refresh]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!rest && (!verb || Object.hasOwn(QUOTA_SUBCOMMANDS, verb))) {
				if (runtime.ctx.handleQuotaCommand) {
					await runtime.ctx.handleQuotaCommand(verb || "show");
				} else if (!verb || verb === "show") {
					await runtime.ctx.handleUsageCommand();
				}
				clearSubmittedText(runtime);
				return;
			}
			runtime.ctx.showStatus("Usage: /quota [show|recommend|auto|popup|hud|mini|close|refresh]");
			clearSubmittedText(runtime);
		},
	},
	{
		name: "hud",
		icon: "gauge",
		description: "Toggle or refresh the 4-Edge Terminal Margin HUD around the composer",
		acpDescription: "Toggle 4-Edge Margin HUD",
		acpInputHint: "[on|off|toggle|refresh]",
		subcommands: [
			{ name: "toggle", description: "Toggle the 4-Edge Margin HUD on or off (Alt+H)" },
			{ name: "on", description: "Show the 4-Edge Margin HUD around the composer" },
			{ name: "off", description: "Hide the 4-Edge Margin HUD around the composer" },
			{ name: "refresh", description: "Force refresh hardware, git, daemon, and quota HUD telemetry" },
		],
		subcommandOptional: true,
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!rest && (!verb || Object.hasOwn(HUD_SUBCOMMANDS, verb))) {
				const action = verb || "toggle";
				if (action === "refresh") {
					await runtime.output("Refreshed 4-Edge Margin HUD telemetry.");
					return commandConsumed();
				}
				const next =
					action === "on" ? true : action === "off" ? false : !cfgComposerMarginHud.get(runtime.settings);
				cfgComposerMarginHud.override(runtime.settings, next);
				await runtime.output(next ? "4-Edge Margin HUD enabled." : "4-Edge Margin HUD hidden.");
				return commandConsumed();
			}
			return usage("Usage: /hud [on|off|toggle|refresh]", runtime);
		},
		handleTui: (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (!rest && (!verb || Object.hasOwn(HUD_SUBCOMMANDS, verb))) {
				runtime.ctx.handleHudCommand?.(verb || "toggle");
				clearSubmittedText(runtime);
				return;
			}
			runtime.ctx.showStatus("Usage: /hud [on|off|toggle|refresh]");
			clearSubmittedText(runtime);
		},
	},
	{
		name: "stats",
		icon: "stats",
		description: "Launch the local stats dashboard",
		inlineHint: "[--port <port>] [--host <host>]",
		allowArgs: true,
		handle: async (command, runtime) => {
			const parsed = parseStatsDashboardArgs(command.args);
			if ("error" in parsed) return usage(parsed.error, runtime);

			await runtime.output("Syncing session files...");
			try {
				const result = await launchSessionStatsDashboard(parsed, runtime);
				await runtime.output(result.message);
			} catch (error) {
				await runtime.output(`Stats dashboard failed: ${errorMessage(error)}`);
				// Mark the failure like `usage()` does, for hosts that report a
				// failed builtin (print mode does not dispatch `/stats`).
				return commandConsumed({ failed: true });
			}
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const parsed = parseStatsDashboardArgs(command.args);
			if ("error" in parsed) {
				ctx.showStatus(parsed.error);
				return;
			}
			try {
				const result = await launchSessionStatsDashboard(parsed, ctx);
				ctx.presentCommandOutput(new StatsNotice(result.message, result.url));
			} catch (error) {
				ctx.showError(`Stats dashboard failed: ${errorMessage(error)}`);
			}
		},
	},
	{
		name: "changelog",
		icon: "news",
		description: "Show changelog entries",
		acpDescription: "Show changelog",
		acpInputHint: "[full|last [N]]",
		subcommands: [
			{ name: "full", description: "Show complete changelog" },
			{ name: "last", description: "Show the last N releases (default 1)", usage: "[N]" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const view = parseChangelogView(command.args);
			if ("error" in view) return usage(view.error, runtime);
			const changelogPath = getChangelogPath();
			const allEntries = await parseChangelog(changelogPath);
			const entriesToShow = selectChangelogEntries(allEntries, view);
			if (entriesToShow.length === 0) {
				await runtime.output("No changelog entries found.");
				return commandConsumed();
			}
			await runtime.output(renderChangelogEntries(entriesToShow).markdown);
			return commandConsumed();
		},
		handleTui: async (command, runtime) => {
			await runtime.ctx.handleChangelogCommand(command.args);
			clearSubmittedText(runtime);
		},
	},
	{
		name: "hotkeys",
		icon: "keyboard",
		description: "Show all keyboard shortcuts",
		handleTui: (_command, runtime) => {
			runtime.ctx.handleHotkeysCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "tools",
		icon: "tools",
		description: "Show tools currently visible to the agent",
		acpDescription: "Show available tools",
		getTuiAutocompleteDescription: runtime => {
			const active = runtime.ctx.session.getActiveToolNames().length;
			const all = runtime.ctx.session.getAllToolNames().length;
			return all === 0 ? "Tools: none available" : `Tools: ${active} active / ${all} available`;
		},
		handle: async (_command, runtime) => {
			const active = runtime.session.getActiveToolNames();
			const all = runtime.session.getAllToolNames();
			if (all.length === 0) {
				await runtime.output("No tools are available.");
				return commandConsumed();
			}
			const lines = all.map(name => `${active.includes(name) ? "*" : "-"} ${name}`);
			for (const mounted of runtime.session.getXdevToolEntries()) {
				lines.push(`~ xd://${mounted.name}`);
			}
			await runtime.output(lines.join("\n"));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleToolsCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "context",
		icon: "context",
		description: "Browse context usage and detailed content",
		acpDescription: "Show context usage",
		getTuiAutocompleteDescription: runtime => {
			const usage = runtime.ctx.session.getContextUsage();
			if (!usage) return "Context: unavailable";
			return `Context: ${Math.round(usage.percent)}% (${formatTokenCount(usage.tokens)}/${formatTokenCount(usage.contextWindow)})`;
		},
		handle: async (_command, runtime) => {
			await runtime.output(buildContextReportText(runtime));
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.handleContextCommand();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "extensions",
		aliases: ["status"],
		icon: "extension",
		description: "Open Extension Control Center dashboard",
		handleTui: (_command, runtime) => {
			runtime.ctx.showExtensionsDashboard();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "agents",
		icon: "agents",
		description: "Open the agents hub (per-agent model, prewalk, and advisor)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showAgentsDashboard();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "git",
		icon: "branch",
		description: "Open the git UI (split diff viewer, staging, commit composer)",
		inlineHint: "[revision]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			runtime.ctx.showGitUi(command.args.trim() || undefined);
			clearSubmittedText(runtime);
		},
	},
	{
		name: "local",
		icon: "pencil",
		description: "Open a session local:// file in $EDITOR (picker when no name given)",
		inlineHint: "[name]",
		allowArgs: true,
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			await openLocalFileInEditor(runtime.ctx, command.args);
		},
	},
	{
		name: "hub",
		aliases: ["subagents"],
		icon: "agents",
		description: "Open the live Agent Hub (subagents, including finished ones)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showAgentHub({ initialSection: "activity" });
			clearSubmittedText(runtime);
		},
	},
	{
		name: "branch",
		aliases: ["rewind"],
		icon: "branch",
		description: "Rewind to a previous message, keeping the old path as a branch",
		handleTui: (_command, runtime) => {
			runtime.ctx.showUserMessageSelector();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "fork",
		icon: "branch",
		description: "Fork this session, or open it in a multiplexer pane or window",
		subcommands: [
			{ name: "pane", description: "Open the fork in a new terminal pane" },
			{ name: "window", description: "Open the fork in a new multiplexer window" },
			{ name: "tab", description: "Alias for window" },
		],
		subcommandOptional: true,
		allowArgs: true,
		handleTui: async (command, runtime) => {
			const args = command.args.trim();
			let placement: "pane" | "window" | undefined;
			if (args) {
				const [keyword, ...extra] = args.split(/\s+/);
				if (extra.length > 0) {
					clearSubmittedText(runtime);
					runtime.ctx.showError("Usage: /fork [pane|window|tab]");
					return;
				}
				switch (keyword?.toLowerCase()) {
					case "pane":
						placement = "pane";
						break;
					case "window":
					case "tab":
						placement = "window";
						break;
					default:
						clearSubmittedText(runtime);
						runtime.ctx.showError("Usage: /fork [pane|window|tab]");
						return;
				}
			}
			clearSubmittedText(runtime);
			if (placement) await runtime.ctx.handleForkCommand(placement);
			else await runtime.ctx.handleForkCommand();
		},
	},
	{
		name: "tree",
		icon: "tree",
		description: "Navigate session tree (switch branches)",
		handleTui: (_command, runtime) => {
			runtime.ctx.showTreeSelector();
			clearSubmittedText(runtime);
		},
	},
	{
		name: "login",
		icon: "signIn",
		description: "Login with OAuth provider",
		inlineHint: "[provider|redirect URL]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime =>
			runtime.ctx.oauthManualInput.hasPending()
				? `Login: waiting for ${runtime.ctx.oauthManualInput.pendingProviderId ?? "OAuth"} callback`
				: "Login: choose provider",
		handleTui: (command, runtime) => {
			const manualInput = runtime.ctx.oauthManualInput;
			const args = command.args.trim();
			if (args.length > 0) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === args);
				if (matchedProvider) {
					if (manualInput.hasPending()) {
						const pendingProvider = manualInput.pendingProviderId;
						const message = pendingProvider
							? `OAuth login already in progress for ${pendingProvider}. Paste the redirect URL with /login <url>.`
							: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
						runtime.ctx.showWarning(message);
						clearSubmittedText(runtime);
						return;
					}
					void runtime.ctx.showOAuthSelector("login", matchedProvider.id);
					clearSubmittedText(runtime);
					return;
				}
				const submitted = manualInput.submit(args);
				if (submitted) {
					runtime.ctx.showStatus("OAuth callback received; completing login…");
				} else {
					runtime.ctx.showWarning("No OAuth login is waiting for a manual callback.");
				}
				clearSubmittedText(runtime);
				return;
			}

			if (manualInput.hasPending()) {
				const provider = manualInput.pendingProviderId;
				const message = provider
					? `OAuth login already in progress for ${provider}. Paste the redirect URL with /login <url>.`
					: "OAuth login already in progress. Paste the redirect URL with /login <url>.";
				runtime.ctx.showWarning(message);
				clearSubmittedText(runtime);
				return;
			}

			void runtime.ctx.showOAuthSelector("login");
			clearSubmittedText(runtime);
		},
	},
	{
		name: "logout",
		icon: "signOut",
		description: "Logout from OAuth provider",
		inlineHint: "[provider]",
		allowArgs: true,
		handleTui: (command, runtime) => {
			const providerId = command.args.trim();
			if (providerId) {
				const matchedProvider = getOAuthProviders().find(provider => provider.id === providerId);
				if (!matchedProvider) {
					runtime.ctx.showWarning(`Unknown OAuth provider: ${providerId}`);
					clearSubmittedText(runtime);
					return;
				}
				void runtime.ctx.showOAuthSelector("logout", matchedProvider.id);
				clearSubmittedText(runtime);
				return;
			}
			void runtime.ctx.showOAuthSelector("logout");
			clearSubmittedText(runtime);
		},
	},
	{
		name: "mcp",
		icon: "mcp",
		description: "Manage MCP servers (add, list, remove, test)",
		acpDescription: "Manage MCP servers",
		inlineHint: "<subcommand>",
		subcommands: [
			{
				name: "add",
				description: "Add a new MCP server",
				usage: "<name> [--scope project|user] [--url <url>] [-- <command...>]",
			},
			{ name: "list", description: "List all configured MCP servers" },
			{ name: "remove", description: "Remove an MCP server", usage: "<name> [--scope project|user]" },
			{ name: "test", description: "Test connection to a server", usage: "<name>" },
			{ name: "reauth", description: "Reauthorize OAuth for a server", usage: "<name>" },
			{ name: "unauth", description: "Remove OAuth auth from a server", usage: "<name>" },
			{ name: "enable", description: "Enable an MCP server", usage: "<name>" },
			{ name: "disable", description: "Disable an MCP server", usage: "<name>" },
			{
				name: "smithery-search",
				description: "Search Smithery registry and deploy an MCP server",
				usage: "<keyword> [--scope project|user] [--limit <1-100>] [--semantic]",
			},
			{ name: "smithery-login", description: "Login to Smithery and cache API key" },
			{ name: "smithery-logout", description: "Remove cached Smithery API key" },
			{ name: "reconnect", description: "Reconnect to a specific MCP server", usage: "<name>" },
			{ name: "reload", description: "Force reload MCP runtime tools" },
			{ name: "resources", description: "List available resources from connected servers" },
			{ name: "prompts", description: "List available prompts from connected servers" },
			{ name: "notifications", description: "Show notification capabilities and subscriptions" },
			{ name: "help", description: "Show help message" },
		],
		allowArgs: true,
		handle: handleMcpAcp,
		handleTui: async (command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleMCPCommand(command.text);
		},
	},
];
