/**
 * Seamless `tmux`-style mouse-wheel scrollback overlay for `tui.mouse: true`.
 *
 * When VT mouse tracking (`?1000h`) is active on the normal buffer, terminals
 * send SGR wheel reports (`\x1b[<64;…M` / `\x1b[<65;…M`) to the application
 * instead of scrolling native terminal scrollback. Rolling the wheel UP on the
 * main chat screen mounts this fullscreen `ScrollView` over the full colored
 * session transcript (already scrolled up by `WHEEL_STEP` lines), and rolling
 * the wheel DOWN back to the bottom (or pressing `Esc` / `q` / `End` / clicking
 * `[▼ 回到底部]`) automatically closes it back to the live composer.
 */
import {
	type Component,
	Ellipsis,
	matchesKey,
	padding,
	routeSgrMouseInput,
	ScrollView,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { actionMarkerAt, formatActionMarker } from "@oh-my-pi/pi-tui/render/extension-links";
import { theme } from "@oh-my-pi/pi-tui/theme";

const WHEEL_LINES_PER_NOTCH = 5;
const STREAM_REFRESH_INTERVAL_MS = 500;

export interface TranscriptScrollbackOverlayOptions {
	renderTranscriptLines: (contentWidth: number) => readonly string[];
	getTerminalSize: () => { columns: number; rows: number };
	isStreaming: () => boolean;
	requestRender: () => void;
	onClose: () => void;
	initialScrollUpLines?: number;
}

export class TranscriptScrollbackOverlay implements Component {
	readonly #options: TranscriptScrollbackOverlayOptions;
	readonly #scrollView: ScrollView;
	#lastWidth = 0;
	#lastSnapAt = 0;
	#lastFooterLine = "";
	#closed = false;

	constructor(options: TranscriptScrollbackOverlayOptions) {
		this.#options = options;
		const { columns, rows } = options.getTerminalSize();
		const bodyHeight = Math.max(1, rows - 1);
		const contentWidth = Math.max(1, columns - 1);
		const initialLines = options.renderTranscriptLines(contentWidth);
		this.#lastWidth = contentWidth;
		this.#lastSnapAt = Date.now();

		this.#scrollView = new ScrollView(initialLines, {
			height: bodyHeight,
			scrollbar: "always",
			ellipsis: Ellipsis.Omit,
			theme: {
				track: t => theme.fg("dim", t),
				thumb: t => theme.fg("accent", t),
			},
		});

		const maxOffset = this.#scrollView.getMaxScrollOffset();
		const step = Math.max(1, options.initialScrollUpLines ?? WHEEL_LINES_PER_NOTCH);
		this.#scrollView.setScrollOffset(Math.max(0, maxOffset - step));
	}

	invalidate(): void {
		this.#scrollView.invalidate();
	}

	dispose(): void {
		this.#closed = true;
	}

	#refreshSnapshotIfNeeded(contentWidth: number): void {
		const widthChanged = contentWidth !== this.#lastWidth;
		const now = Date.now();
		const shouldRefreshStream =
			this.#options.isStreaming() && now - this.#lastSnapAt >= STREAM_REFRESH_INTERVAL_MS;
		if (!widthChanged && !shouldRefreshStream) return;

		const prevOffset = this.#scrollView.getScrollOffset();
		const nextLines = this.#options.renderTranscriptLines(contentWidth);
		this.#lastWidth = contentWidth;
		this.#lastSnapAt = now;
		this.#scrollView.setLines(nextLines);
		this.#scrollView.setScrollOffset(prevOffset);
	}

	handleInput(data: string): void {
		if (this.#closed) return;

		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				if (event.wheel !== null) {
					this.#handleWheel(event.wheel);
					return true;
				}
				if (event.leftClick) {
					const { rows } = this.#options.getTerminalSize();
					if (event.row >= rows - 1 && actionMarkerAt(this.#lastFooterLine, event.col) === "omp-scroll:close") {
						this.#close();
					}
					return true;
				}
				return true;
			});
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "return") || matchesKey(data, "end")) {
			this.#close();
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.#scrollView.scroll(-1);
			this.#options.requestRender();
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.#stepDown(1);
			return;
		}
		if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
			this.#scrollView.page(-1);
			this.#options.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown") || matchesKey(data, "space") || matchesKey(data, "ctrl+d")) {
			const maxOffset = this.#scrollView.getMaxScrollOffset();
			if (this.#scrollView.getScrollOffset() >= maxOffset) {
				this.#close();
				return;
			}
			this.#scrollView.page(1);
			if (this.#scrollView.getScrollOffset() >= this.#scrollView.getMaxScrollOffset()) {
				this.#close();
				return;
			}
			this.#options.requestRender();
			return;
		}
		if (matchesKey(data, "home") || matchesKey(data, "g")) {
			this.#scrollView.setScrollOffset(0);
			this.#options.requestRender();
		}
	}

	#handleWheel(direction: -1 | 1): void {
		if (direction < 0) {
			this.#scrollView.scroll(-WHEEL_LINES_PER_NOTCH);
			this.#options.requestRender();
			return;
		}
		this.#stepDown(WHEEL_LINES_PER_NOTCH);
	}

	#stepDown(lines: number): void {
		const maxOffset = this.#scrollView.getMaxScrollOffset();
		const current = this.#scrollView.getScrollOffset();
		if (current + lines >= maxOffset) {
			// Seamless exit back to live composer once scrolled down to the bottom
			this.#close();
			return;
		}
		this.#scrollView.scroll(lines);
		this.#options.requestRender();
	}

	#close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#options.onClose();
	}

	render(width: number): readonly string[] {
		const { rows } = this.#options.getTerminalSize();
		const safeWidth = Math.max(1, width);
		const bodyHeight = Math.max(1, rows - 1);
		const contentWidth = Math.max(1, safeWidth - 1);

		this.#scrollView.setHeight(bodyHeight);
		this.#refreshSnapshotIfNeeded(contentWidth);

		const bodyLines = this.#scrollView.render(safeWidth);
		const range = this.#scrollView.getVisibleRange();
		const maxOffset = this.#scrollView.getMaxScrollOffset();
		const totalRows = maxOffset + bodyHeight;

		const streamingBadge = this.#options.isStreaming()
			? `${theme.fg("warning", " ● AI 输出中")} ${theme.fg("dim", "│")}`
			: "";
		const leftInfo = `${theme.fg("accent", "▲ 历史回看")} ${theme.fg("muted", `(${Math.min(totalRows, range.start + 1)}–${Math.min(totalRows, range.end)} / ${totalRows} 行)`)} ${theme.fg("dim", "│")}${streamingBadge} ${theme.fg("muted", "滚轮/PgUp/PgDn 翻阅 · 滚到底部或按 Esc 返回输入")}`;
		const closeBtnRaw = theme.bold(theme.fg("success", "[▼ 回到底部]"));
		const closeBtnWidth = visibleWidth(closeBtnRaw);

		const leftBudget = Math.max(1, safeWidth - closeBtnWidth - 2);
		const leftFitted =
			visibleWidth(leftInfo) > leftBudget ? truncateToWidth(leftInfo, leftBudget) : leftInfo;
		const gapCols = Math.max(1, safeWidth - visibleWidth(leftFitted) - closeBtnWidth);
		const closeBtnMarked = formatActionMarker(closeBtnRaw, "omp-scroll:close", "scrollback:close");
		const footer =
			safeWidth > closeBtnWidth + 4
				? `${leftFitted}${padding(gapCols)}${closeBtnMarked}`
				: truncateToWidth(leftInfo, safeWidth);
		this.#lastFooterLine = footer;

		return [...bodyLines, footer];
	}
}
