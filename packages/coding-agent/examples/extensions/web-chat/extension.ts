import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import description from "./description.md" with { type: "text" };
import { WebChatRunner, type WebChatProvider } from "./runtime";

/** Logged-in website UI tools; only the supplied prompt is sent to the selected site. */
export default function webChatExtension(pi: ExtensionAPI) {
	const z = pi.zod;
	const runner = new WebChatRunner();
	for (const provider of ["chatgpt", "gemini"] satisfies WebChatProvider[]) {
		const label = provider === "chatgpt" ? "ChatGPT Web" : "Gemini Web";
		pi.registerTool({
			name: `${provider}_web`,
			label,
			description,
			approval: args =>
				args && typeof args === "object" && "action" in args && args.action === "status" ? "read" : "exec",
			parameters: z.object({
				action: z
					.enum(["status", "ask"])
					.describe("status inspects without sending; ask sends the explicit prompt once."),
				prompt: z
					.string()
					.optional()
					.describe("Required for ask. Exact text to send; no context is added automatically."),
				conversationUrl: z
					.string()
					.optional()
					.describe("Optional returned HTTPS conversation URL to continue; omit for a new chat."),
				timeout: z
					.number()
					.min(1)
					.max(600)
					.optional()
					.describe(
						"Total timeout in seconds including browser queue wait; defaults to 120. An uncertain send is never retried.",
					),
			}),
			async execute(_toolCallId, params, signal) {
				const result = await runner.invoke(provider, params, { signal });
				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: result,
					isError: result.status === "error" || result.status === "login_required" || result.status === "limited",
				};
			},
		});
	}
	pi.on("session_shutdown", async () => {
		const result = await runner.finish();
		if (result.status === "error")
			pi.logger.warn("Web chat browser goal could not finish", { reason: result.reason, message: result.message });
	});
}
