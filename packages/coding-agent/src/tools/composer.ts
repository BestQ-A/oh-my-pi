import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ComposerSnapshot } from "../extensibility/extensions/types";
import composerDescription from "../prompts/tools/composer.md" with { type: "text" };
import type { ToolSession } from ".";
import { throwIfAborted } from "./tool-errors";

const composerSchema = type({
	action: "'read' | 'set' | 'append' | 'clear' | 'submit'",
	"text?": "string",
	"expectedText?": "string",
});

type ComposerParams = typeof composerSchema.infer;

export class ComposerTool implements AgentTool<typeof composerSchema, ComposerSnapshot> {
	readonly name = "composer";
	readonly label = "Composer";
	readonly summary = "Read, edit, or submit the interactive input draft";
	readonly description = composerDescription;
	readonly parameters = composerSchema;
	readonly strict = false;
	readonly concurrency = "exclusive" as const;
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const action = args !== null && typeof args === "object" && "action" in args ? args.action : undefined;
		return action === "read" ? "read" : action === "submit" ? "exec" : "write";
	};

	static createIf(session: ToolSession): ComposerTool | null {
		return session.tuiTranscript === true && (session.taskDepth ?? 0) === 0 ? new ComposerTool() : null;
	}

	async execute(
		_id: string,
		params: ComposerParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<ComposerSnapshot>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<ComposerSnapshot>> {
		throwIfAborted(signal);
		if (!context?.hasUI || !context.ui?.controlEditor) {
			throw new ToolError("Composer operations require the local interactive TUI.");
		}
		const details = context.ui.controlEditor(params);
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	}
}
