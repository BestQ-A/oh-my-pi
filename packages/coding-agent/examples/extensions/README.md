# Extension Examples

Example extensions for pi-coding-agent.

## Usage

```bash
# Load an extension with --extension flag
pi --extension examples/extensions/permission-gate.ts

# Or copy to extensions directory for auto-discovery
cp permission-gate.ts ~/.omp/agent/extensions/
```

## Examples

### Lifecycle & Safety

| Extension                | Description                                                                  |
| ------------------------ | ---------------------------------------------------------------------------- |
| `permission-gate.ts`     | Prompts for confirmation before dangerous bash commands (rm -rf, sudo, etc.) |
| `protected-paths.ts`     | Blocks writes to protected paths (.env, .git/, node_modules/)                |
| `confirm-destructive.ts` | Confirms before destructive session actions (clear, switch, branch)          |
| `dirty-repo-guard.ts`    | Prevents session changes with uncommitted git changes                        |

### Custom Tools

| Extension     | Description                                                                   |
| ------------- | ----------------------------------------------------------------------------- |
| `todo.ts`     | Todo list tool + `/todos` command with custom rendering and state persistence |
| `hello.ts`    | Minimal custom tool example                                                   |
| `question.ts` | Demonstrates `ctx.ui.select()` for asking the user questions                  |
| `subagent/`   | Delegate tasks to specialized subagents with isolated context windows         |
| `web-chat/extension.ts` | `chatgpt_web` and `gemini_web` tools using signed-in Ego Browser website sessions |

### Commands & UI

| Extension          | Description                                                                    |
| ------------------ | ------------------------------------------------------------------------------ |
| `plan-mode.ts`     | Claude Code-style plan mode for read-only exploration with `/plan` command     |
| `tools.ts`         | Interactive `/tools` command to enable/disable tools with session persistence  |
| `handoff.ts`       | Transfer context to a new focused session via `/handoff <goal>`                |
| `qna.ts`           | Extracts questions from last response into editor via `ctx.ui.setEditorText()` |
| `status-line.ts`   | Shows turn progress in footer via `ctx.ui.setStatus()` with themed colors      |
| `thinking-note.ts` | Adds display-only supplemental UI below assistant thinking blocks              |
| `snake.ts`         | Snake game with custom UI, keyboard handling, and session persistence          |

### Git Integration

| Extension                | Description                                                               |
| ------------------------ | ------------------------------------------------------------------------- |
| `git-checkpoint.ts`      | Creates git stash checkpoints at each turn for code restoration on branch |
| `auto-commit-on-exit.ts` | Auto-commits on exit using last assistant message for commit message      |

### System Prompt & Compaction

| Extension              | Description                                                           |
| ---------------------- | --------------------------------------------------------------------- |
| `pirate.ts`            | Demonstrates `systemPromptAppend` to dynamically modify system prompt |
| `custom-compaction.ts` | Custom compaction that summarizes entire conversation                 |

### External Dependencies

| Extension         | Description                                                               |
| ----------------- | ------------------------------------------------------------------------- |
| `chalk-logger.ts` | Uses chalk from parent node_modules (demonstrates jiti module resolution) |
| `with-deps/`      | Extension with its own package.json and dependencies                      |
| `file-trigger.ts` | Watches a trigger file and injects contents into conversation             |

## ChatGPT and Gemini website tools

Load `web-chat/extension.ts` with `omp -e` or create a source-linked extension
that re-exports its default factory. Keep the whole `web-chat` directory together;
the runtime loads its sibling browser adapters. Requires `ego-browser` on PATH
and website login in Ego Lite. Keep the Ego window restored while running:
Gemini may defer rendering its answer while the window is minimized.
API credentials are not used by this extension.

To pin Gemini to one signed-in Google account, call the factory from your local
extension as `webChatExtension(pi, { geminiAccount: { email: "you@example.com", index: 1 } })`.
The index is the account slot in its `/u/1/app` URL. The runner keeps that slot in
home and conversation URLs and verifies the visible email before editing or
sending. A missing, ambiguous, or different account returns `account_mismatch`;
it never falls back to another Google account if slots change after login.

Both tools accept these calls:

```json
{"action":"status","timeout":30}
{"action":"ask","prompt":"Review this proposed API: ...","timeout":120}
```

Results contain `status`, `url`, and, after an answer, `text`. Visible account
emails, model/plan labels, and limit messages are included when available. Website labels such as
`Pro` or `Thinking` do not identify an API model. Numeric remaining quota is not
inferred. To continue, pass the returned URL as `conversationUrl` on the next ask;
omitting it starts a new chat. Only the supplied prompt is sent, without automatic
session/repository context. Answers are ordinary untrusted tool results.

Each extension session owns one browser TaskSpace and serializes operations.
`status` is a read-tier tool operation; `ask` uses the exec tier. The default
deadline is 120 seconds (1–600 accepted). A send is never retried automatically.
The same deadline covers queue wait, guide loading, and browser startup. After
that cutoff, the runner allows one second for the child's final result before
forcing process cleanup. Active cancellation waits for subprocess cleanup and
returns the known TaskSpace/Page; cancellation while queued returns immediately.
Login, visible rate limits, cancellation, and timeout are surfaced explicitly;
inspect the returned conversation before resubmitting after an uncertain send.
User takeover stops automation. After login/control recovery, reload the
extension for a new explicitly requested browser goal. Successful owned spaces
are finished on session shutdown; caller-owned spaces are never finished by the
runner. Website DOM changes may require updating the corresponding adapter.

## Writing Extensions

See [docs/extensions.md](../../docs/extensions.md) for full documentation.

```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const z = pi.zod;

	// Subscribe to lifecycle events
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
			const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
			if (!ok) return { block: true, reason: "Blocked by user" };
		}
	});

	// Register custom tools
	pi.registerTool({
		name: "greet",
		label: "Greeting",
		description: "Generate a greeting",
		parameters: z.object({
			name: z.string().describe("Name to greet"),
		}),
		async execute(toolCallId, params, onUpdate, ctx, signal) {
			return {
				content: [{ type: "text", text: `Hello, ${params.name}!` }],
				details: {},
			};
		},
	});

	// Register commands
	pi.registerCommand("hello", {
		description: "Say hello",
		handler: async (args, ctx) => {
			ctx.ui.notify("Hello!", "info");
		},
	});
}
```

## Key Patterns

**Use `z.enum` for discriminated string tool args:**

```typescript
const z = pi.zod;

parameters: z.object({
	action: z.enum(["list", "add"]),
});
```

**State persistence via details:**

```typescript
// Store state in tool result details for proper branching support
return {
	content: [{ type: "text", text: "Done" }],
	details: { todos: [...todos], nextId }, // Persisted in session
};

// Reconstruct on session events
pi.on("session_start", async (_event, ctx) => {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.toolName === "my_tool") {
			const details = entry.message.details;
			// Reconstruct state from details
		}
	}
});
```
