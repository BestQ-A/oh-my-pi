import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ComposerOperation, ComposerSnapshot } from "../extensibility/extensions/types";
import type { InteractiveModeContext } from "./types";

/** Operate on the main composer synchronously, so draft checks and mutations cannot interleave. */
export function controlComposer(ctx: InteractiveModeContext, operation: ComposerOperation): ComposerSnapshot {
	if ((operation.action === "set" || operation.action === "append") && operation.text === undefined) {
		throw new ToolError(`${operation.action} requires text.`);
	}
	if ((operation.action === "read" || operation.action === "clear") && operation.text !== undefined) {
		throw new ToolError(`${operation.action} does not accept text.`);
	}
	const editor = ctx.editor;
	const text = editor.getExpandedText();
	const dictation = editor.composerState().dictation;
	const blockedReason = ctx.focusedAgentId
		? "The composer is attached to a subagent. Return to the main session first."
		: ctx.approvalOwnsComposer ||
			  ctx.ui.hasOverlay() ||
			  ctx.ui.getFocused() !== editor ||
			  ctx.editorContainer.children.length !== 1 ||
			  ctx.editorContainer.children[0] !== editor
			? "A dialog or another UI surface owns the composer."
			: editor.disableSubmit || !editor.onSubmit
				? "The composer is not ready for submission."
				: dictation === "recording" || dictation === "transcribing"
					? "Dictation is still updating the draft."
					: undefined;
	const snapshot = (): ComposerSnapshot => ({
		text: editor.getExpandedText(),
		imageCount: editor.pendingImages.length,
		available: blockedReason === undefined,
		...(blockedReason ? { blockedReason } : {}),
	});
	if (operation.action === "read") return snapshot();
	if (blockedReason) throw new ToolError(blockedReason);
	if (operation.expectedText !== undefined && operation.expectedText !== text) {
		throw new ToolError("The composer draft changed. Read it again before editing or submitting.");
	}
	if (operation.action === "submit" && !(operation.text ?? text).trim() && editor.pendingImages.length === 0) {
		throw new ToolError("The composer draft is empty.");
	}
	if (operation.action === "clear") {
		editor.clearDraft();
	} else if (operation.action === "append") {
		editor.setCollapsedText(text + operation.text);
	} else if (operation.text !== undefined) {
		editor.setCollapsedText(operation.text);
	}
	if (operation.action === "submit") editor.submit();
	ctx.ui.requestRender();
	return { ...snapshot(), ...(operation.action === "submit" ? { submitted: true } : {}) };
}
