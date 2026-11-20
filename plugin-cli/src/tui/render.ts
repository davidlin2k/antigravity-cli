import {
  CLEAR_LINE,
  CLEAR_SCREEN,
  CURSOR_HIDE,
  SYNC_END,
  SYNC_START,
  createTheme,
  displayWidth,
  moveTo,
  overlaySegmentOnLine,
  padVisible,
  sanitizeInlineText,
  truncateVisible,
  wrapText,
} from "./ansi.ts";
import type { AnsiTheme } from "./ansi.ts";
import { computeFooterHints, resolveActiveSelectedIndex } from "./reduce.ts";
import {
  applyTone,
  boxLine,
  renderBottomBorder,
  renderCompactStatsLine,
  renderDivider,
  renderFooterLine,
  renderHeaderLine,
  renderSearchSubheader,
  renderStatsCardsLines,
  renderToastLine,
  renderTopBorder,
} from "./render-chrome.ts";
import { renderOverlayLines } from "./render-modals.ts";
import type { RenderedFrame, TuiState, Viewport } from "./state.ts";
import type { PreparedColumnHeader } from "./tab-registry.ts";
import { TAB_REGISTRY } from "./tabs.ts";

export function clampViewport(rawCols: number, rawRows: number): Viewport {
  const safeCols = Number.isFinite(rawCols) ? Math.floor(rawCols) : 80;
  const safeRows = Number.isFinite(rawRows) ? Math.floor(rawRows) : 24;
  return {
    cols: Math.max(1, Math.min(400, safeCols)),
    rows: Math.max(1, Math.min(160, safeRows)),
  };
}

function computeColumnWidths(
  columns: readonly PreparedColumnHeader[],
  availableWidth: number,
): readonly number[] {
  const count = columns.length;
  if (count === 0) {
    return [];
  }
  const gaps = Math.max(0, count - 1);
  const target = Math.max(count, availableWidth - gaps);

  const widths = columns.map((col) =>
    col.width.kind === "fixed" ? col.width.chars : col.width.min,
  );

  let sum = widths.reduce((a, b) => a + b, 0);
  if (sum > target) {
    let idx = 0;
    while (sum > target) {
      const cur = widths[idx] ?? 1;
      if (cur > 2) {
        widths[idx] = cur - 1;
        sum -= 1;
      }
      idx = (idx + 1) % count;
      if (widths.every((w) => w <= 2) && sum > target) {
        for (let j = 0; j < count && sum > target; j += 1) {
          const w = widths[j] ?? 1;
          if (w > 1) {
            widths[j] = w - 1;
            sum -= 1;
          }
        }
        break;
      }
    }
    return widths;
  }

  const remaining = target - sum;
  if (remaining > 0) {
    let totalWeight = 0;
    const flexIndices: number[] = [];
    for (let i = 0; i < columns.length; i += 1) {
      const col = columns[i];
      if (col !== undefined && col.width.kind === "flex") {
        totalWeight += col.width.weight;
        flexIndices.push(i);
      }
    }
    if (flexIndices.length > 0 && totalWeight > 0) {
      let distributed = 0;
      for (const idx of flexIndices) {
        const col = columns[idx];
        if (col !== undefined && col.width.kind === "flex") {
          const extra = Math.floor((remaining * col.width.weight) / totalWeight);
          widths[idx] = (widths[idx] ?? 0) + extra;
          distributed += extra;
        }
      }
      let leftover = remaining - distributed;
      let f = 0;
      while (leftover > 0) {
        const idx = flexIndices[f % flexIndices.length];
        if (idx !== undefined) {
          widths[idx] = (widths[idx] ?? 0) + 1;
        }
        leftover -= 1;
        f += 1;
      }
    } else {
      const last = count - 1;
      widths[last] = (widths[last] ?? 0) + remaining;
    }
  }

  return widths;
}

function renderTooSmallFrame(viewport: Viewport, theme: AnsiTheme): RenderedFrame {
  const message = `Terminal too small (${viewport.cols}x${viewport.rows}). Resize to at least 40x12. Esc/q to quit.`;
  const lines: string[] = [];

  if (viewport.cols >= 12 && viewport.rows >= 5) {
    const inner = viewport.cols - 4;
    const wrapped = wrapText(message, inner);
    const contentRows = viewport.rows - 2;
    const shown = wrapped.slice(0, contentRows);
    const topPad = Math.max(0, Math.floor((contentRows - shown.length) / 2));

    lines.push(renderTopBorder(theme, viewport.cols));
    for (let r = 0; r < contentRows; r += 1) {
      const text = shown[r - topPad];
      lines.push(
        boxLine(
          theme,
          text !== undefined ? theme.yellow(padVisible(text, inner, "center")) : "",
          inner,
        ),
      );
    }
    lines.push(renderBottomBorder(theme, viewport.cols));
  } else {
    const wrapped =
      viewport.rows === 1
        ? [truncateVisible(message, viewport.cols, "")]
        : wrapText(message, viewport.cols);
    for (let r = 0; r < viewport.rows; r += 1) {
      const rowText = wrapped[r] ?? "";
      lines.push(theme.yellow(truncateVisible(rowText, viewport.cols, "")));
    }
  }

  return {
    viewport,
    lines: lines.map((line) =>
      displayWidth(line) > viewport.cols ? truncateVisible(line, viewport.cols, "") : line,
    ),
    cursor: null,
  };
}

export function renderFrame(state: TuiState, rawViewport: Viewport): RenderedFrame {
  const viewport = clampViewport(rawViewport.cols, rawViewport.rows);
  const theme = createTheme(state.colorEnabled);

  if (viewport.cols < 40 || viewport.rows < 12) {
    return renderTooSmallFrame(viewport, theme);
  }

  const innerCols = Math.max(10, viewport.cols - 4);
  const prepared = TAB_REGISTRY[state.activeTab].prepare(state);
  const selectedIndex = resolveActiveSelectedIndex(state, prepared);

  const topLines: string[] = [
    renderTopBorder(theme, viewport.cols),
    renderHeaderLine(state, theme, innerCols),
    renderDivider(theme, viewport.cols),
  ];

  if (state.activeTab === "stats" && prepared.summaryCards.length > 0) {
    const modeText = prepared.modeBadge?.text ?? "";
    topLines.push(
      ...(viewport.rows <= 15
        ? renderCompactStatsLine(prepared.summaryCards, modeText, theme, innerCols)
        : renderStatsCardsLines(prepared.summaryCards, modeText, theme, innerCols)),
    );
  } else {
    topLines.push(
      renderSearchSubheader(
        state,
        prepared.modeBadge?.text ?? "",
        prepared.modeBadge?.tone,
        theme,
        innerCols,
      ),
    );
  }
  topLines.push(renderDivider(theme, viewport.cols));

  const toastLine = renderToastLine(state, theme, innerCols);
  const hints = computeFooterHints(state, prepared, selectedIndex);
  const bottomLines: string[] = [renderDivider(theme, viewport.cols)];
  if (toastLine !== null) {
    bottomLines.push(toastLine);
  }
  bottomLines.push(renderFooterLine(hints, theme, innerCols));
  bottomLines.push(renderBottomBorder(theme, viewport.cols));

  const tableHeaderChrome = 2;
  const bodyRows = Math.max(
    1,
    viewport.rows - topLines.length - bottomLines.length - tableHeaderChrome,
  );

  const needsScrollbar = prepared.rowCount > bodyRows;
  const tableWidth = Math.max(8, innerCols - (needsScrollbar ? 2 : 0));
  const prefixCols = 2;
  const colWidths = computeColumnWidths(prepared.columns, Math.max(4, tableWidth - prefixCols));

  const headerCells = prepared.columns.map((col, idx) =>
    theme.dim(padVisible(sanitizeInlineText(col.header), colWidths[idx] ?? 1, col.align)),
  );
  const headerLine = boxLine(
    theme,
    `  ${headerCells.join(" ")}${needsScrollbar ? "  " : ""}`,
    innerCols,
  );
  const tableSepLine = boxLine(theme, theme.dim("─".repeat(innerCols)), innerCols);

  const bodyLines: string[] = [];
  if (prepared.rowCount === 0) {
    const emptyLineIdx = Math.floor(bodyRows / 2);
    const safeEmpty = sanitizeInlineText(prepared.emptyMessage);
    for (let r = 0; r < bodyRows; r += 1) {
      if (r === emptyLineIdx) {
        bodyLines.push(
          boxLine(theme, theme.dim(padVisible(safeEmpty, innerCols, "center")), innerCols),
        );
      } else {
        bodyLines.push(boxLine(theme, "", innerCols));
      }
    }
  } else {
    const safeSelected = Math.max(0, Math.min(prepared.rowCount - 1, selectedIndex));
    const maxScroll = Math.max(0, prepared.rowCount - bodyRows);
    let scrollStart = Math.max(0, Math.min(maxScroll, safeSelected - Math.floor(bodyRows / 2)));
    if (safeSelected < scrollStart) {
      scrollStart = safeSelected;
    } else if (safeSelected >= scrollStart + bodyRows) {
      scrollStart = safeSelected - bodyRows + 1;
    }

    const thumbSize = needsScrollbar
      ? Math.max(1, Math.round((bodyRows * bodyRows) / prepared.rowCount))
      : 0;
    const thumbStart =
      needsScrollbar && maxScroll > 0
        ? Math.round((scrollStart / maxScroll) * Math.max(0, bodyRows - thumbSize))
        : 0;

    for (let r = 0; r < bodyRows; r += 1) {
      const rowIdx = scrollStart + r;
      const scrollChar = !needsScrollbar
        ? ""
        : r >= thumbStart && r < thumbStart + thumbSize
          ? theme.cyan("█")
          : theme.dim("│");

      if (rowIdx >= prepared.rowCount) {
        bodyLines.push(
          boxLine(
            theme,
            needsScrollbar ? `${" ".repeat(Math.max(0, innerCols - 1))}${scrollChar}` : "",
            innerCols,
          ),
        );
        continue;
      }

      const cells = prepared.cellsAt(rowIdx);
      const isSelected = rowIdx === safeSelected;
      const renderedCells: string[] = [];
      for (let c = 0; c < prepared.columns.length; c += 1) {
        const col = prepared.columns[c];
        const cell = cells[c];
        const width = colWidths[c] ?? 1;
        const safeCellText = sanitizeInlineText(cell?.text ?? "");
        const rawPadded = padVisible(safeCellText, width, col?.align ?? "left");
        renderedCells.push(isSelected ? rawPadded : applyTone(theme, cell?.tone, rawPadded));
      }

      const rowBody = `${isSelected ? "▸ " : "  "}${renderedCells.join(" ")}`;
      const styledRow = isSelected
        ? theme.selectedRow(padVisible(rowBody, tableWidth, "left"))
        : padVisible(rowBody, tableWidth, "left");
      const fullContent = needsScrollbar ? `${styledRow} ${scrollChar}` : styledRow;
      bodyLines.push(boxLine(theme, fullContent, innerCols));
    }
  }

  let frameLines = [...topLines, headerLine, tableSepLine, ...bodyLines, ...bottomLines];
  if (frameLines.length > viewport.rows) {
    frameLines = [
      ...frameLines.slice(0, Math.max(0, viewport.rows - bottomLines.length)),
      ...bottomLines.slice(0, Math.min(bottomLines.length, viewport.rows)),
    ].slice(0, viewport.rows);
  }
  while (frameLines.length < viewport.rows) {
    frameLines.push(boxLine(theme, "", innerCols));
  }

  if (state.overlay.kind !== "none" && state.overlay.kind !== "search-input") {
    const spaceBetweenBars = viewport.rows - topLines.length - bottomLines.length;
    const bandTop = spaceBetweenBars >= 7 ? topLines.length : Math.min(topLines.length, 3);
    const bandBottom = Math.max(bandTop, viewport.rows - bottomLines.length);
    const maxModalHeight = Math.max(1, bandBottom - bandTop);
    const modalLines = renderOverlayLines(state, state.overlay, viewport, maxModalHeight, theme);
    const modalHeight = Math.min(modalLines.length, maxModalHeight);
    const modalW = displayWidth(modalLines[0] ?? "");
    const startCol = Math.max(0, Math.floor((viewport.cols - modalW) / 2));
    const startRow = bandTop + Math.max(0, Math.floor((maxModalHeight - modalHeight) / 2));
    const composited = [...frameLines];
    for (let i = 0; i < modalHeight; i += 1) {
      const targetRow = startRow + i;
      const modalLine = modalLines[i];
      const bgLine = composited[targetRow];
      if (
        targetRow < bandTop ||
        targetRow >= bandBottom ||
        modalLine === undefined ||
        bgLine === undefined
      ) {
        continue;
      }
      composited[targetRow] = overlaySegmentOnLine(
        bgLine,
        startCol,
        modalLine,
        viewport.cols,
        state.colorEnabled,
      );
    }
    frameLines = composited;
  }

  const normalizedLines = frameLines.map((line) =>
    displayWidth(line) > viewport.cols ? truncateVisible(line, viewport.cols, "") : line,
  );

  return {
    viewport,
    lines: normalizedLines,
    cursor: null,
  };
}

export function diffFrames(prev: RenderedFrame | null, next: RenderedFrame): string {
  const fullRepaint =
    prev === null ||
    prev.viewport.cols !== next.viewport.cols ||
    prev.viewport.rows !== next.viewport.rows ||
    prev.lines.length !== next.lines.length;

  const chunks: string[] = [];
  if (fullRepaint) {
    chunks.push(CURSOR_HIDE, CLEAR_SCREEN);
    for (let i = 0; i < next.lines.length; i += 1) {
      chunks.push(moveTo(i + 1, 1), CLEAR_LINE, next.lines[i] ?? "");
    }
  } else {
    for (let i = 0; i < next.lines.length; i += 1) {
      const nextLine = next.lines[i] ?? "";
      if (prev.lines[i] !== nextLine) {
        chunks.push(moveTo(i + 1, 1), CLEAR_LINE, nextLine);
      }
    }
  }

  if (chunks.length === 0) {
    return "";
  }
  return `${SYNC_START}${chunks.join("")}${SYNC_END}`;
}
