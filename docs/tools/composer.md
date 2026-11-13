# composer

> Read, edit, or submit omp's own interactive input draft from the main TUI session.

## Source

- Entry: `packages/coding-agent/src/tools/composer.ts` (`ComposerTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/composer.md`
- Draft control: `packages/coding-agent/src/modes/composer.ts` (`controlComposer`)
- Wire types: `packages/coding-agent/src/extensibility/extensions/types.ts` (`ComposerOperation`, `ComposerSnapshot`)
- Registration: `packages/coding-agent/src/tools/index.ts`

## Registration / Visibility

- Appears only when the session is a local interactive TUI at the top level: `session.tuiTranscript === true && (session.taskDepth ?? 0) === 0` (`tools/index.ts`, `ComposerTool.createIf`). It is absent in print, RPC, ACP and subagent sessions, and no setting turns it on or off.
- `--help` lists it as enabled by default, conditional on running an interactive TUI session at the top level.
- Metadata: `strict = false`, `concurrency = "exclusive"`. Approval tier follows the action: `read` → read, `submit` → exec, `set` / `append` / `clear` → write.
- Calls fail with `Composer operations require the local interactive TUI.` when the host provides no UI or no editor control.

## Inputs

| Field          | Type                                                     | Required | Description                                                                                   |
| -------------- | -------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------- |
| `action`       | `"read" \| "set" \| "append" \| "clear" \| "submit"`      | Yes      | Operation to perform on the main draft.                                                       |
| `text`         | `string`                                                 | By action | Replacement draft for `set`/`append`, or text that replaces the draft before `submit`.        |
| `expectedText` | `string`                                                 | No       | Guard taken from a preceding `read`; the operation is rejected when the draft no longer matches. |

`set` and `append` require `text`; `read` and `clear` reject it.

## Outputs

- Returns the resulting `ComposerSnapshot` as JSON in `content[0].text` and as `details`: `text` (expanded draft), `imageCount` (pending attachments), `available`, `blockedReason` when unavailable, and `submitted: true` after `submit` is handed to the Enter pipeline.
- The result of `submit` is an acceptance receipt. It means the draft was handed over; downstream slash-command or message execution may still be pending, and an ordinary message sent while the agent is running is queued as steering input.

## Flow and Side Effects

1. Validate that `text` matches the action, then read the draft and compute the blocked reason synchronously, so a check and its mutation cannot interleave.
2. `read` returns the snapshot without mutating anything.
3. Any other action refuses while the draft is blocked, and rejects a stale `expectedText` with `The composer draft changed. Read it again before editing or submitting.`
4. `submit` refuses an empty draft (no text and no pending images) with `The composer draft is empty.`
5. Mutations go through the editor: `clear` drops the whole draft including attachments, `append` extends the current text, `set` replaces it, and pending images are preserved by `set`/`append`.
6. `submit` calls the editor's own submit hook, so the same input hooks, slash commands and message routing as pressing Enter apply. The UI is re-rendered before returning.

## Limits and Errors

- Refusal reasons surfaced as `blockedReason` (and thrown by every mutating action): the composer is attached to a focused subagent; a dialog, approval or other UI surface owns the composer; the editor is not ready for submission; or dictation is still recording/transcribing.
- Operations are synchronous and exclusive; a blocked or stale draft never mutates state.
- Errors are thrown as `ToolError` and carry the reason text above.

See [write](write.md) for file writes and [ask](ask.md) for questions that are not draft edits.
