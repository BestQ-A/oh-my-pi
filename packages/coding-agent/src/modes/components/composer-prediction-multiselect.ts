/**
 * Auto Non-Blocking Multi-Select Candidate Bar for Composer Predictions.
 *
 * Lifecycle & Interaction:
 * - Automatically mounts compact clickable checkbox pills (`☐/☑ 1. ...`) right
 *   above the composer whenever `composerPrediction` or `emptyPrediction` produces
 *   suggested next steps, without stealing typing focus from the editor.
 * - Default `Tab` selects ALL candidates (`☑ 1..N`) in one keystroke (pressing
 *   `Tab` again when all are checked toggles them off).
 * - Mouse left-click (`omp-ui:pred-toggle:<index>`) or `Alt+1..9` toggles
 *   individual items at any time — even while typing inside the editor.
 * - Whatever the user types inside the editor acts as **additional prompt
 *   instructions (`附加提示信息`)** attached to the checked items when pressing
 *   `Enter` or clicking `[⏎ 发送]`.
 * - If `0` items are checked, `Enter` submits the editor text untouched and
 *   dismisses the old candidates so unrelated prompts are never polluted.
 */
import { type NumberedPredictionItem, padding, parseNumberedPredictionItems, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatActionMarker } from "@oh-my-pi/pi-tui/render/extension-links";
import { type ThemeColor, theme } from "@oh-my-pi/pi-tui/theme";

export interface ComposerPredictionMultiSelectOptions {
	getRawPrediction: () => string | undefined;
	requestRender: () => void;
	maxRows?: number;
}

export interface PredictionSelectionStatus {
	total: number;
	checked: number;
}

interface PillSegment {
	text: string;
	href?: string;
	key?: string;
}

function fg(color: ThemeColor, text: string): string {
	return theme.fg(color, text);
}

function bold(text: string): string {
	return theme.bold(text);
}

function sanitizeLine(text: string): string {
	return text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function parseCandidateItems(raw: string | undefined): NumberedPredictionItem[] {
	if (!raw) return [];
	const trimmed = raw.trim();
	if (!trimmed) return [];
	const numbered = parseNumberedPredictionItems(trimmed);
	if (numbered && numbered.length > 0) {
		return numbered.map(item => ({ index: item.index, text: sanitizeLine(item.text) })).filter(it => it.text.length > 0);
	}
	const single = sanitizeLine(trimmed);
	return single.length > 0 ? [{ index: 1, text: single }] : [];
}

/**
 * Format checked candidates + optional additional editor prompt text into the
 * final user prompt submitted on `Enter` / `[⏎ 发送]`.
 */
export function formatMultiSelectPromptSubmission(
	checkedItems: readonly NumberedPredictionItem[],
	additionalPromptText: string,
): string {
	const extra = additionalPromptText.trim();
	if (checkedItems.length === 0) {
		return additionalPromptText;
	}
	if (checkedItems.length === 1) {
		const single = checkedItems[0]!.text;
		return extra.length > 0 ? `${single}\n\n附加提示信息：${extra}` : single;
	}
	const numberedList = checkedItems.map((item, idx) => `${idx + 1}. ${item.text}`).join("\n");
	return extra.length > 0
		? `请执行以下已选事项：\n${numberedList}\n\n附加提示信息：${extra}`
		: `请执行以下已选事项：\n${numberedList}`;
}

export class ComposerPredictionMultiSelect {
	readonly #getRawPrediction: () => string | undefined;
	readonly #requestRender: () => void;
	readonly #maxRows: number;

	#lastRaw: string | undefined;
	#items: NumberedPredictionItem[] = [];
	#checkedIndices = new Set<number>();
	#dismissed = false;

	constructor(options: ComposerPredictionMultiSelectOptions) {
		this.#getRawPrediction = options.getRawPrediction;
		this.#requestRender = options.requestRender;
		this.#maxRows = Math.max(1, options.maxRows ?? 3);
	}

	/** Synchronize internal candidate list with the latest raw prediction string. */
	sync(): readonly NumberedPredictionItem[] {
		const raw = this.#getRawPrediction()?.trim() || undefined;
		if (raw !== this.#lastRaw) {
			this.#lastRaw = raw;
			this.#items = parseCandidateItems(raw);
			this.#checkedIndices.clear();
			this.#dismissed = false;
		}
		if (this.#dismissed || this.#items.length === 0) {
			return [];
		}
		return this.#items;
	}

	hasVisibleCandidates(): boolean {
		return this.sync().length > 0;
	}

	getStatus(): PredictionSelectionStatus | undefined {
		const items = this.sync();
		if (items.length === 0) return undefined;
		return { total: items.length, checked: this.#checkedIndices.size };
	}

	getCheckedCount(): number {
		const items = this.sync();
		return items.length === 0 ? 0 : this.#checkedIndices.size;
	}

	getCheckedItems(): NumberedPredictionItem[] {
		const items = this.sync();
		if (items.length === 0 || this.#checkedIndices.size === 0) return [];
		return items.filter(item => this.#checkedIndices.has(item.index));
	}

	/**
	 * Default `Tab` action: select ALL candidates (`☑ 1..N`) when fewer than all
	 * are checked, or clear all when all are already checked.
	 */
	toggleAll(): boolean {
		const items = this.sync();
		if (items.length === 0) return false;
		if (this.#checkedIndices.size < items.length) {
			for (const item of items) {
				this.#checkedIndices.add(item.index);
			}
		} else {
			this.#checkedIndices.clear();
		}
		this.#requestRender();
		return true;
	}

	selectAll(): boolean {
		const items = this.sync();
		if (items.length === 0) return false;
		for (const item of items) {
			this.#checkedIndices.add(item.index);
		}
		this.#requestRender();
		return true;
	}

	/** Clear active `☑` selections (`Esc` or `[清空]`). Returns `true` if any were cleared. */
	clearChecked(): boolean {
		this.sync();
		if (this.#checkedIndices.size === 0) return false;
		this.#checkedIndices.clear();
		this.#requestRender();
		return true;
	}

	/** Toggle candidate matching display `index` (or 1-based ordinal fallback). */
	toggleItem(index: number): boolean {
		const items = this.sync();
		if (items.length === 0) return false;
		const target = items.find(it => it.index === index) ?? items[index - 1];
		if (!target) return false;
		if (this.#checkedIndices.has(target.index)) {
			this.#checkedIndices.delete(target.index);
		} else {
			this.#checkedIndices.add(target.index);
		}
		this.#requestRender();
		return true;
	}

	/** Hide the candidate bar for the current prediction snapshot (`[✕]`). */
	dismiss(): boolean {
		const items = this.sync();
		if (items.length === 0 && this.#checkedIndices.size === 0) return false;
		this.#checkedIndices.clear();
		this.#dismissed = true;
		this.#requestRender();
		return true;
	}

	/**
	 * Contextual placeholder hint displayed inside the empty input box so the
	 * user always sees that `Tab` selects all and typed text acts as additional
	 * prompt instructions (`附加提示信息`).
	 */
	getPlaceholderHint(): string | undefined {
		const items = this.sync();
		if (items.length === 0) return undefined;
		const total = items.length;
		const checked = this.#checkedIndices.size;
		if (checked > 0) {
			return `✓ 已选 ${checked}/${total} 项 — 直接回车立即发送，或在此输入附加提示信息（Esc 清空勾选）`;
		}
		const altHint = total > 1 ? ` · 点击或 Alt+1~${total} 多选` : " · 点击勾选";
		return `Tab 全选上方候选${altHint} · 输入框内容将作为已选项的附加提示`;
	}

	/**
	 * Combine checked candidates with `editorText` on `Enter` / `[⏎ 发送]` and
	 * reset selection state. Slash commands (`/…`), shell (`!…`), and Python
	 * (`$…`) inputs bypass combination so utility commands never eat selections.
	 */
	consumeSubmission(editorText: string): { text: string; consumedSelection: boolean } {
		const trimmed = editorText.trim();
		if (trimmed.startsWith("/") || trimmed.startsWith("!") || trimmed.startsWith("$")) {
			return { text: editorText, consumedSelection: false };
		}
		const checked = this.getCheckedItems();
		if (checked.length === 0) {
			if (trimmed.length > 0 && this.#items.length > 0) {
				this.#dismissed = true;
			}
			return { text: editorText, consumedSelection: false };
		}
		const combined = formatMultiSelectPromptSubmission(checked, trimmed);
		this.#checkedIndices.clear();
		this.#dismissed = true;
		return { text: combined, consumedSelection: true };
	}

	/**
	 * Render 0..maxRows padded lines of clickable multi-select pills directly
	 * above the composer status/editor box.
	 */
	render(width: number): string[] {
		const items = this.sync();
		if (items.length === 0 || width < 20) return [];

		const total = items.length;
		const checked = this.#checkedIndices.size;
		const pills: PillSegment[] = [];

		// 1. Header + Select-All / Clear control pills
		if (checked === 0) {
			pills.push({
				text: `${fg("accent", "✦")} ${fg("muted", "候选")}`,
			});
			pills.push({
				text: fg("accent", "[Tab 全选]"),
				href: "omp-ui:pred-toggle-all",
				key: "pred:toggle-all",
			});
		} else if (checked === total) {
			pills.push({
				text: `${fg("success", "✦")} ${bold(fg("success", `已全选 ${checked}/${total}`))}`,
			});
			pills.push({
				text: fg("muted", "[Tab 清空]"),
				href: "omp-ui:pred-clear",
				key: "pred:clear",
			});
		} else {
			pills.push({
				text: `${fg("success", "✦")} ${bold(fg("success", `已选 ${checked}/${total}`))}`,
			});
			pills.push({
				text: fg("accent", "[全选]"),
				href: "omp-ui:pred-select-all",
				key: "pred:select-all",
			});
			pills.push({
				text: fg("muted", "[清空]"),
				href: "omp-ui:pred-clear",
				key: "pred:clear",
			});
		}

		// 2. Individual candidate checkbox pills (`☐/☑ 1. ...`)
		const maxSingleItemCols = Math.max(12, Math.min(46, width - 8));
		for (const item of items) {
			const isChecked = this.#checkedIndices.has(item.index);
			const prefixPlain = `${isChecked ? "☑" : "☐"} ${item.index}. `;
			const prefixCols = visibleWidth(prefixPlain);
			const bodyBudget = Math.max(6, maxSingleItemCols - prefixCols);
			const cleanText =
				visibleWidth(item.text) > bodyBudget ? truncateToWidth(item.text, bodyBudget) : item.text;
			const pillText = isChecked
				? `${bold(fg("success", `☑ ${item.index}.`))} ${fg("text", cleanText)}`
				: `${fg("muted", `☐ ${item.index}.`)} ${fg("muted", cleanText)}`;
			pills.push({
				text: pillText,
				href: `omp-ui:pred-toggle:${item.index}`,
				key: `pred:item:${item.index}`,
			});
		}

		// 3. Action pills (`[⏎ 发送]` when >=1 checked, plus `[✕]` dismiss)
		if (checked > 0) {
			pills.push({
				text: bold(fg("success", "[⏎ 发送]")),
				href: "omp-ui:pred-submit",
				key: "pred:submit",
			});
		}
		pills.push({
			text: fg("dim", "[✕]"),
			href: "omp-ui:pred-dismiss",
			key: "pred:dismiss",
		});

		// Wrap pills cleanly across 1..#maxRows lines without splitting any pill's OSC-8 marker
		const gap = "  ";
		const gapWidth = 2;
		const lines: string[] = [];
		let rowParts: string[] = [];
		let rowUsed = 1; // 1 leading space indent

		const flushRow = (): void => {
			if (rowParts.length === 0) return;
			const content = ` ${rowParts.join(gap)}`;
			const rem = Math.max(0, width - visibleWidth(content));
			lines.push(rem > 0 ? content + padding(rem) : content);
			rowParts = [];
			rowUsed = 1;
		};

		for (const pill of pills) {
			const pillWidth = visibleWidth(pill.text);
			const sepCols = rowParts.length > 0 ? gapWidth : 0;
			if (rowParts.length > 0 && rowUsed + sepCols + pillWidth > width) {
				if (lines.length + 1 >= this.#maxRows) {
					// Fit remaining space on the last allowed row if possible
					const avail = width - rowUsed - sepCols;
					if (avail >= 4) {
						const fitted = truncateToWidth(pill.text, avail);
						const wrapped = pill.href ? formatActionMarker(fitted, pill.href, pill.key ?? pill.href) : fitted;
						rowParts.push(wrapped);
						rowUsed += sepCols + visibleWidth(fitted);
					}
					break;
				}
				flushRow();
			}

			const avail = Math.max(1, width - rowUsed - (rowParts.length > 0 ? gapWidth : 0));
			const fitted = pillWidth > avail ? truncateToWidth(pill.text, avail) : pill.text;
			const wrapped = pill.href ? formatActionMarker(fitted, pill.href, pill.key ?? pill.href) : fitted;
			rowParts.push(wrapped);
			rowUsed += (rowParts.length > 1 ? gapWidth : 0) + visibleWidth(fitted);
		}
		flushRow();

		return lines;
	}
}
