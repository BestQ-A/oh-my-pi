Read, edit, or submit OMP's own interactive input draft.

- `read` returns expanded text, pending image count, and whether the main composer is available.
- `set` replaces text; `append` adds text at the end. Both require `text` and preserve pending attachments. `clear` removes the whole draft, including attachments.
- `submit` uses the same input hooks, slash commands, and message routing as Enter. Optional `text` replaces the draft atomically before submitting. While the agent is running, ordinary messages are queued as steering input. The result is an acceptance receipt, not confirmation that the command or next agent turn completed.
- Pass `expectedText` from a preceding read to reject an edit or submission if the draft has changed. Do not overwrite a user's draft without authorization.
- Only the main local TUI composer is supported. Dialogs, approvals, focused subagents, and active dictation block mutation. Empty submissions are rejected.
