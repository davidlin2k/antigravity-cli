import { formatBytes, formatMarketplaceSource } from "../domain/query.ts";
import { joinAbsolutePath } from "../domain/types.ts";
import type { CatalogEntry, Diagnostic } from "../domain/types.ts";
import {
  CLEAR_LINE,
  CLEAR_SCREEN,
  CURSOR_HIDE,
  SYNC_END,
  SYNC_START,
  createTheme,
  displayWidth,
  graphemeDisplayWidth,
  moveTo,
  overlaySegmentOnLine,
  padVisible,
  sanitizeInlineText,
  sanitizeInputText,
  splitGraphemes,
  truncateVisible,
  wrapText,
} from "./ansi.ts";
import type { AnsiTheme } from "./ansi.ts";
import {
  computeFooterHints,
  findInstalledForEntryInScope,
  findSameNameCollisionInScope,
  resolveActiveSelectedIndex,
} from "./reduce.ts";
import { TAB_IDS } from "./state.ts";
import type {
  OverlayState,
  RenderedFrame,
  TextInputState,
  TuiState,
  Viewport,
} from "./state.ts";
import type {
  CellTone,
  KeyHint,
  PreparedColumnHeader,
  SummaryCard,
} from "./tab-registry.ts";
import { TAB_REGISTRY } from "./tabs.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function clampViewport(rawCols: number, rawRows: number): Viewport {
  const safeCols = Number.isFinite(rawCols) ? Math.floor(rawCols) : 80;
  const safeRows = Number.isFinite(rawRows) ? Math.floor(rawRows) : 24;
  return {
    cols: Math.max(1, Math.min(400, safeCols)),
    rows: Math.max(1, Math.min(160, safeRows)),
  };
}

function applyTone(theme: AnsiTheme, tone: CellTone | undefined, text: string): string {
  switch (tone) {
    case "muted":
      return theme.dim(text);
    case "accent":
      return theme.cyan(text);
    case "success":
      return theme.green(text);
    case "warning":
      return theme.yellow(text);
    case "error":
      return theme.red(text);
    case "default":
    case undefined:
      return text;
    default: {
      const _exhaustive: never = tone;
      return _exhaustive;
    }
  }
}

function boxLine(theme: AnsiTheme, content: string, innerCols: number): string {
  const padded = padVisible(content, innerCols, "left");
  const border = theme.dim("│");
  return `${border} ${padded} ${border}`;
}

function renderTopBorder(theme: AnsiTheme, cols: number): string {
  return theme.dim(`┌${"─".repeat(Math.max(0, cols - 2))}┐`);
}

function renderDivider(theme: AnsiTheme, cols: number): string {
  return theme.dim(`├${"─".repeat(Math.max(0, cols - 2))}┤`);
}

function renderBottomBorder(theme: AnsiTheme, cols: number): string {
  return theme.dim(`└${"─".repeat(Math.max(0, cols - 2))}┘`);
}

function compactTabLabel(tabId: (typeof TAB_IDS)[number], fullLabel: string): string {
  switch (tabId) {
    case "discover":
      return "Disc";
    case "installed":
      return "Inst";
    case "marketplaces":
      return "Mkts";
    case "errors":
      return "Err";
    case "stats":
      return fullLabel;
    default: {
      const _exhaustive: never = tabId;
      return _exhaustive;
    }
  }
}

function ultraCompactTabLetter(tabId: (typeof TAB_IDS)[number]): string {
  switch (tabId) {
    case "discover":
      return "D";
    case "installed":
      return "I";
    case "marketplaces":
      return "M";
    case "errors":
      return "E";
    case "stats":
      return "S";
    default: {
      const _exhaustive: never = tabId;
      return _exhaustive;
    }
  }
}

function renderHeaderLine(state: TuiState, theme: AnsiTheme, innerCols: number): string {
  if (innerCols <= 48) {
    const buildNarrowTokens = (includeInactiveBadges: boolean): readonly string[] =>
      TAB_IDS.map((tabId) => {
        const desc = TAB_REGISTRY[tabId];
        const rawBadge = desc.badge(state.snapshot);
        const safeBadge = rawBadge !== null ? sanitizeInlineText(rawBadge) : "";
        if (tabId === state.activeTab) {
          const badgeText = safeBadge.length > 0 ? ` ${safeBadge}` : "";
          return theme.cyanBold(`[${desc.number} ${compactTabLabel(tabId, desc.label)}${badgeText}]`);
        }
        const badgeSuffix = includeInactiveBadges && safeBadge.length > 0 ? `:${safeBadge}` : "";
        const token = `${desc.number}${ultraCompactTabLetter(tabId)}${badgeSuffix}`;
        const hasErrorBadge = tabId === "errors" && safeBadge.length > 0;
        return hasErrorBadge ? theme.yellow(token) : theme.dim(token);
      });

    let tokens = buildNarrowTokens(true);
    let line = tokens.join(" ");
    if (displayWidth(line) > innerCols) {
      tokens = buildNarrowTokens(false);
      line = tokens.join(" ");
    }
    if (state.pending.kind === "running") {
      const glyph = SPINNER_FRAMES[state.spinnerTick % SPINNER_FRAMES.length] ?? "⠋";
      const remaining = innerCols - displayWidth(line) - 2;
      if (remaining >= 4) {
        const busyText = truncateVisible(`${glyph} ${sanitizeInlineText(state.pending.label)}`, remaining);
        line = `${line}  ${theme.yellow(busyText)}`;
      }
    }
    return boxLine(theme, line, innerCols);
  }

  const titleText =
    innerCols >= 88
      ? "Antigravity Plugins"
      : innerCols >= 68
        ? "Plugins"
        : "";
  const titleStyled = titleText.length > 0 ? `${theme.whiteBold(titleText)}  ` : "";

  const tabTokens: string[] = [];
  for (const tabId of TAB_IDS) {
    const desc = TAB_REGISTRY[tabId];
    const badge = desc.badge(state.snapshot);
    const safeBadge = badge !== null ? sanitizeInlineText(badge) : null;
    const badgeText = safeBadge !== null && safeBadge.length > 0 ? ` ${safeBadge}` : "";
    const label =
      innerCols < 66 && tabId !== state.activeTab
        ? compactTabLabel(tabId, desc.label)
        : desc.label;
    const rawLabel = `${desc.number} ${label}${badgeText}`;
    if (tabId === state.activeTab) {
      tabTokens.push(theme.cyanBold(`[${rawLabel}]`));
    } else {
      const hasErrorBadge = tabId === "errors" && safeBadge !== null;
      tabTokens.push(hasErrorBadge ? theme.yellow(rawLabel) : theme.dim(rawLabel));
    }
  }

  let busyBadge = "";
  if (state.pending.kind === "running") {
    const glyph = SPINNER_FRAMES[state.spinnerTick % SPINNER_FRAMES.length] ?? "⠋";
    busyBadge = `  ${theme.yellow(`${glyph} ${sanitizeInlineText(state.pending.label)}`)}`;
  }

  const separator = innerCols >= 84 ? "  " : " ";
  const line = `${titleStyled}${tabTokens.join(separator)}${busyBadge}`;
  return boxLine(theme, line, innerCols);
}

function sumSliceWidths(widths: readonly number[], start: number, end: number): number {
  let total = 0;
  for (let i = start; i < end; i += 1) {
    total += widths[i] ?? 0;
  }
  return total;
}

function renderTextInputInline(
  input: TextInputState,
  focused: boolean,
  placeholder: string,
  maxWidth: number,
  theme: AnsiTheme,
): string {
  if (maxWidth <= 0) {
    return "";
  }
  const safePlaceholder = sanitizeInlineText(placeholder);
  const safeValue = sanitizeInputText(input.value);
  if (safeValue.length === 0) {
    if (focused) {
      const hint = maxWidth > 2 ? ` ${safePlaceholder}` : "";
      return truncateVisible(`${theme.cyanBold("▏")}${theme.dim(hint)}`, maxWidth, "");
    }
    return theme.dim(truncateVisible(safePlaceholder, maxWidth));
  }
  if (!focused) {
    return truncateVisible(safeValue, maxWidth);
  }

  const graphemes = splitGraphemes(safeValue);
  const widths = graphemes.map(graphemeDisplayWidth);
  const cursor = Math.max(0, Math.min(graphemes.length, input.cursor));
  const cursorGlyph = cursor < graphemes.length ? theme.cyanBold("▏") : theme.cyanBold("_");

  const totalWidth = sumSliceWidths(widths, 0, graphemes.length) + 1;
  if (totalWidth <= maxWidth) {
    return `${graphemes.slice(0, cursor).join("")}${cursorGlyph}${graphemes.slice(cursor).join("")}`;
  }

  if (maxWidth <= 3) {
    const afterText = graphemes.slice(cursor).join("");
    return truncateVisible(`${cursorGlyph}${afterText}`, maxWidth, "");
  }

  const prefixWidthToCursor = sumSliceWidths(widths, 0, cursor);
  const atCursorWidth = cursor < graphemes.length ? (widths[cursor] ?? 0) : 0;
  const needsTrailAfterCursor = cursor + 1 < graphemes.length;
  const minNeedFromStart =
    prefixWidthToCursor + 1 + atCursorWidth + (needsTrailAfterCursor ? 1 : 0);

  let windowStart = 0;
  let windowEnd = graphemes.length;

  if (minNeedFromStart <= maxWidth) {
    windowStart = 0;
    let used = prefixWidthToCursor + 1;
    windowEnd = cursor;
    while (windowEnd < graphemes.length) {
      const w = widths[windowEnd] ?? 0;
      const trailCost = windowEnd + 1 === graphemes.length ? 0 : 1;
      if (used + w + trailCost <= maxWidth) {
        used += w;
        windowEnd += 1;
      } else {
        break;
      }
    }
  } else if (cursor === graphemes.length) {
    windowEnd = graphemes.length;
    let budget = Math.max(0, maxWidth - 2);
    windowStart = graphemes.length;
    while (windowStart > 0) {
      const w = widths[windowStart - 1] ?? 0;
      if (w <= budget) {
        budget -= w;
        windowStart -= 1;
      } else {
        break;
      }
    }
  } else {
    const trailReserve = cursor + 1 < graphemes.length ? 1 : 0;
    let used = 1 + 1 + atCursorWidth;
    windowEnd = cursor + 1;
    if (used + trailReserve > maxWidth) {
      windowStart = cursor;
      windowEnd = cursor;
    } else {
      let budgetBefore = maxWidth - used - trailReserve;
      windowStart = cursor;
      while (windowStart > 0) {
        const w = widths[windowStart - 1] ?? 0;
        if (w <= budgetBefore) {
          budgetBefore -= w;
          used += w;
          windowStart -= 1;
        } else {
          break;
        }
      }
      while (windowEnd < graphemes.length) {
        const w = widths[windowEnd] ?? 0;
        const trailCost = windowEnd + 1 === graphemes.length ? 0 : 1;
        if (used + w + trailCost <= maxWidth) {
          used += w;
          windowEnd += 1;
        } else {
          break;
        }
      }
    }
  }

  const lead = windowStart > 0 ? "…" : "";
  const trail = windowEnd < graphemes.length ? "…" : "";
  const before = graphemes.slice(windowStart, cursor).join("");
  const after = graphemes.slice(cursor, windowEnd).join("");
  return truncateVisible(`${lead}${before}${cursorGlyph}${after}${trail}`, maxWidth, "");
}

function renderSearchSubheader(
  state: TuiState,
  modeBadgeText: string,
  modeTone: CellTone | undefined,
  theme: AnsiTheme,
  innerCols: number,
): string {
  const safeMode = sanitizeInlineText(modeBadgeText);
  if (state.activeTab === "stats") {
    return boxLine(theme, applyTone(theme, modeTone, safeMode), innerCols);
  }
  const searchState = state.searchByTab[state.activeTab];
  const isSearchFocused = state.overlay.kind === "search-input";
  const prefixPlain = "Search [/]: ";
  const prefixStyled = isSearchFocused
    ? theme.cyanBold(prefixPlain)
    : theme.dim(prefixPlain);

  const badgeStyled =
    safeMode.length > 0 ? applyTone(theme, modeTone, safeMode) : "";
  const badgeWidth = displayWidth(badgeStyled);
  const gap = badgeWidth > 0 ? 2 : 0;
  const inputMax = Math.max(8, innerCols - prefixPlain.length - badgeWidth - gap);
  const inputDisplay = renderTextInputInline(
    searchState,
    isSearchFocused,
    "type to filter",
    inputMax,
    theme,
  );

  const leftPart = `${prefixStyled}${inputDisplay}`;
  const leftWidth = displayWidth(leftPart);
  const rightSpace = Math.max(1, innerCols - leftWidth - badgeWidth);
  const composed =
    badgeWidth > 0 ? `${leftPart}${" ".repeat(rightSpace)}${badgeStyled}` : leftPart;
  return boxLine(theme, composed, innerCols);
}

function renderCompactStatsLine(
  cards: readonly SummaryCard[],
  modeBadgeText: string,
  theme: AnsiTheme,
  innerCols: number,
): readonly string[] {
  const val = (index: number): string => sanitizeInlineText(cards[index]?.value ?? "-");
  const shortMode = sanitizeInlineText(modeBadgeText).replace(/^View\s+\[m\]:\s*/i, "[m] ");
  const rightPart = shortMode.length > 0 ? theme.cyan(shortMode) : "";
  const rightWidth = displayWidth(rightPart);
  const leftMax = Math.max(8, innerCols - (rightWidth > 0 ? rightWidth + 1 : 0));
  const leftRaw =
    innerCols >= 64
      ? `Disc: ${val(0)} · Inst: ${val(1)} · Tokens: ${val(3)} · Disk: ${val(4)}`
      : `D:${val(0)} I:${val(1)} ${val(4)}`;
  const leftPart = truncateVisible(leftRaw, leftMax);
  const leftWidth = displayWidth(leftPart);
  const composed =
    rightWidth > 0
      ? `${leftPart}${" ".repeat(Math.max(1, innerCols - leftWidth - rightWidth))}${rightPart}`
      : leftPart;
  return [boxLine(theme, composed, innerCols)];
}

function renderStatsCardsLines(
  cards: readonly SummaryCard[],
  modeBadgeText: string,
  theme: AnsiTheme,
  innerCols: number,
): readonly string[] {
  const safeMode = sanitizeInlineText(modeBadgeText);
  const count = Math.max(1, cards.length);
  const gapWidth = 2;
  const totalGaps = (count - 1) * gapWidth;
  const cardWidth = Math.max(4, Math.floor((innerCols - totalGaps) / count));

  const labelCells: string[] = [];
  const valueCells: string[] = [];
  const subCells: string[] = [];

  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i];
    if (card === undefined) continue;
    const isLast = i === cards.length - 1;
    const width = isLast
      ? Math.max(8, innerCols - (cardWidth + gapWidth) * (cards.length - 1))
      : cardWidth;
    labelCells.push(theme.dim(padVisible(sanitizeInlineText(card.label), width, "left")));
    valueCells.push(applyTone(theme, card.tone, padVisible(sanitizeInlineText(card.value), width, "left")));
    subCells.push(theme.dim(padVisible(sanitizeInlineText(card.subtext ?? ""), width, "left")));
  }

  const sep = " ".repeat(gapWidth);
  const line1 = boxLine(theme, labelCells.join(sep), innerCols);
  const line2 = boxLine(theme, valueCells.join(sep), innerCols);
  const subWithMode =
    safeMode.length > 0 ? theme.cyan(safeMode) : subCells.join(sep);
  const line3 = boxLine(
    theme,
    innerCols >= 80 && safeMode.length > 0
      ? `${padVisible(subCells.slice(0, 3).join(sep), Math.max(20, innerCols - displayWidth(safeMode) - 2), "left")}  ${theme.cyan(safeMode)}`
      : subWithMode,
    innerCols,
  );
  return [line1, line2, line3];
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

function renderFooterLine(
  hints: readonly KeyHint[],
  theme: AnsiTheme,
  innerCols: number,
): string {
  if (hints.length === 0) {
    return boxLine(theme, "", innerCols);
  }
  const formatHint = (hint: KeyHint): { readonly styled: string; readonly width: number } => ({
    styled: `${theme.cyanBold(hint.keys)} ${theme.dim(hint.label)}`,
    width: displayWidth(`${hint.keys} ${hint.label}`),
  });

  const lastHint = hints[hints.length - 1];
  const preserveLast =
    hints.length > 1 && lastHint !== undefined && lastHint.keys.startsWith("Esc");
  const middleHints = preserveLast ? hints.slice(0, -1) : hints;
  const reservedTail = preserveLast && lastHint !== undefined ? formatHint(lastHint) : null;
  const reservedWidth = reservedTail !== null ? reservedTail.width + 2 : 0;

  const parts: string[] = [];
  let usedWidth = 0;

  for (const hint of middleHints) {
    const formatted = formatHint(hint);
    const gap = parts.length > 0 ? 2 : 0;
    if (parts.length > 0 && usedWidth + gap + formatted.width + reservedWidth > innerCols) {
      continue;
    }
    if (parts.length === 0 && formatted.width + reservedWidth > innerCols && reservedTail !== null) {
      continue;
    }
    parts.push(formatted.styled);
    usedWidth += gap + formatted.width;
  }

  if (reservedTail !== null) {
    const gap = parts.length > 0 ? 2 : 0;
    if (usedWidth + gap + reservedTail.width <= innerCols || parts.length === 0) {
      parts.push(reservedTail.styled);
    }
  }

  return boxLine(theme, parts.join("  "), innerCols);
}

function renderToastLine(state: TuiState, theme: AnsiTheme, innerCols: number): string | null {
  if (state.toast === null) {
    return null;
  }
  const { tone, text } = state.toast;
  const safeText = sanitizeInlineText(text);
  const prefix =
    tone === "error"
      ? "✖ "
      : tone === "warning"
        ? "▲ "
        : tone === "success"
          ? "✔ "
          : "ℹ ";
  const cellTone: CellTone =
    tone === "error"
      ? "error"
      : tone === "warning"
        ? "warning"
        : tone === "success"
          ? "success"
          : "accent";
  return boxLine(theme, applyTone(theme, cellTone, `${prefix}${safeText}`), innerCols);
}

function renderButton(
  label: string,
  focused: boolean,
  theme: AnsiTheme,
): string {
  const prefix = focused ? "▸ " : "  ";
  const bracketed = `[ ${sanitizeInlineText(label)} ]`;
  return focused
    ? `${theme.cyanBold(prefix)}${theme.focusedButton(bracketed)}`
    : `${prefix}${theme.dim(bracketed)}`;
}

function layoutModalButtons(
  buttons: readonly string[],
  innerWidth: number,
): readonly string[] {
  if (buttons.length === 0) {
    return [];
  }
  const twoSpace = buttons.join("  ");
  if (displayWidth(twoSpace) <= innerWidth) {
    return [twoSpace];
  }
  const oneSpace = buttons.join(" ");
  if (displayWidth(oneSpace) <= innerWidth) {
    return [oneSpace];
  }

  const rows: string[] = [];
  let current = "";
  for (const btn of buttons) {
    if (current.length === 0) {
      current = btn;
      continue;
    }
    const candidate = `${current} ${btn}`;
    if (displayWidth(candidate) <= innerWidth) {
      current = candidate;
    } else {
      rows.push(current);
      current = btn;
    }
  }
  if (current.length > 0) {
    rows.push(current);
  }
  return rows;
}

function wrapStyledText(
  text: string,
  maxWidth: number,
  style: (line: string) => string,
): readonly string[] {
  return wrapText(sanitizeInlineText(text), maxWidth).map(style);
}

function buildModalBoxLines(
  title: string,
  bodyLines: readonly string[],
  buttons: readonly string[],
  modalWidth: number,
  maxModalHeight: number,
  theme: AnsiTheme,
): readonly string[] {
  const safeTitle = sanitizeInlineText(title);
  const inner = Math.max(10, modalWidth - 4);
  const borderV = theme.cyan("│");
  const bot = theme.cyan(`└${"─".repeat(Math.max(0, modalWidth - 2))}┘`);
  const buttonLines = layoutModalButtons(buttons, inner);
  const compact = maxModalHeight <= 6;

  if (compact) {
    const maxTitleW = Math.max(4, modalWidth - 11);
    const titleLabel = truncateVisible(safeTitle, maxTitleW);
    const dashCount = Math.max(1, modalWidth - 10 - displayWidth(titleLabel));
    const topTitle =
      `${theme.cyan("┌─ ")}${theme.whiteBold(titleLabel)} ${theme.cyan("─".repeat(dashCount))}${theme.dim("[Esc]")}${theme.cyan("┐")}`;
    const chromeRows = 2 + buttonLines.length;
    const maxBodyRows = Math.max(0, maxModalHeight - chromeRows);
    const clippedBody = bodyLines.slice(0, maxBodyRows);

    const lines: string[] = [topTitle];
    for (const row of clippedBody) {
      lines.push(`${borderV} ${padVisible(row, inner, "left")} ${borderV}`);
    }
    for (const btnRow of buttonLines) {
      lines.push(`${borderV} ${padVisible(btnRow, inner, "left")} ${borderV}`);
    }
    lines.push(bot);
    return lines;
  }

  const top = theme.cyan(`┌${"─".repeat(Math.max(0, modalWidth - 2))}┐`);
  const mid = theme.cyan(`├${"─".repeat(Math.max(0, modalWidth - 2))}┤`);
  const titleLabel = truncateVisible(safeTitle, Math.max(4, inner - 6));
  const escBadge = theme.dim("[Esc]");
  const titlePad = Math.max(1, inner - displayWidth(titleLabel) - 5);
  const titleRow = `${borderV} ${theme.whiteBold(titleLabel)}${" ".repeat(titlePad)}${escBadge} ${borderV}`;

  const chromeRows = buttonLines.length > 0 ? 5 + buttonLines.length : 4;
  const maxBodyRows = Math.max(1, maxModalHeight - chromeRows);
  const clippedBody = bodyLines.slice(0, maxBodyRows);

  const lines: string[] = [top, titleRow, mid];
  for (const row of clippedBody) {
    lines.push(`${borderV} ${padVisible(row, inner, "left")} ${borderV}`);
  }
  if (buttonLines.length > 0) {
    lines.push(mid);
    for (const btnRow of buttonLines) {
      lines.push(`${borderV} ${padVisible(btnRow, inner, "left")} ${borderV}`);
    }
  }
  lines.push(bot);
  return lines;
}

function describeCatalogEntryComponents(entry: CatalogEntry): string {
  if (entry.componentCounts === null) {
    return "Component counts available after install";
  }
  const c = entry.componentCounts;
  const parts: string[] = [];
  if (c.skills > 0) parts.push(`${c.skills} skills`);
  if (c.agents > 0) parts.push(`${c.agents} agents`);
  if (c.rules > 0) parts.push(`${c.rules} rules`);
  if (c.hooks > 0) parts.push(`${c.hooks} hooks`);
  if (c.mcpServers > 0) parts.push(`${c.mcpServers} MCP servers`);
  return parts.length > 0 ? parts.join(", ") : "None detected";
}

function renderOverlayLines(
  state: TuiState,
  overlay: Exclude<OverlayState, { readonly kind: "none" | "search-input" }>,
  viewport: Viewport,
  maxModalHeight: number,
  theme: AnsiTheme,
): readonly string[] {
  const modalWidth = Math.max(
    Math.min(44, viewport.cols - 2),
    Math.min(82, viewport.cols - 6),
  );
  const inner = Math.max(10, modalWidth - 4);

  switch (overlay.kind) {
    case "discover-detail": {
      const entry = state.snapshot.catalogById.get(overlay.entryId);
      if (entry === undefined) {
        return buildModalBoxLines("Plugin Details", ["Plugin no longer in catalog."], [], modalWidth, maxModalHeight, theme);
      }
      const installed = findInstalledForEntryInScope(state.snapshot, entry, overlay.targetScope);
      const collision =
        installed === undefined
          ? findSameNameCollisionInScope(state.snapshot, entry, overlay.targetScope)
          : undefined;
      const primaryLabel = installed !== undefined ? "Uninstall" : "Install";
      const safeName = sanitizeInlineText(entry.name);
      const safeId = sanitizeInlineText(entry.id);
      const safeVer = sanitizeInlineText(entry.version ?? "-");
      const safeAuthor = sanitizeInlineText(entry.author ?? "-");
      const safeDesc = sanitizeInlineText(entry.description || "No description provided.");
      const meta =
        maxModalHeight <= 6
          ? `Scope: ${overlay.targetScope} · Ver: ${safeVer} · ${entry.sourceFormat}`
          : `Version: ${safeVer}   Author: ${safeAuthor}   Format: ${entry.sourceFormat}`;

      const body: string[] = [];
      if (collision !== undefined) {
        const sourceDesc =
          collision.provenance.kind === "marketplace"
            ? collision.provenance.entryId
            : collision.provenance.kind === "direct"
              ? `direct (${collision.provenance.installSource.kind})`
              : "unmanaged local plugin";
        body.push(
          ...wrapStyledText(
            `Collision in ${overlay.targetScope} scope: "${safeName}" is installed as ${collision.id} from ${sourceDesc}.`,
            inner,
            (line) => theme.yellow(line),
          ),
        );
      }
      body.push(
        theme.dim(meta),
        ...wrapText(`Summary: ${safeDesc}`, inner),
        ...wrapText(`Components: ${describeCatalogEntryComponents(entry)}`, inner),
      );
      if (entry.componentsPreview !== null && entry.componentsPreview.skills.length > 0) {
        const names = entry.componentsPreview.skills
          .slice(0, 8)
          .map((s) => sanitizeInlineText(s.name));
        const suffix =
          entry.componentsPreview.skills.length > 8
            ? `, +${entry.componentsPreview.skills.length - 8} more`
            : "";
        body.push(...wrapText(`Skills: ${names.join(", ")}${suffix}`, inner));
      }
      const userDir = sanitizeInlineText(
        joinAbsolutePath(state.snapshot.paths.userPluginsDir, entry.slug),
      );
      const projDir = sanitizeInlineText(
        joinAbsolutePath(state.snapshot.paths.projectPluginsDir, entry.slug),
      );
      body.push("");
      body.push(
        `${overlay.targetScope === "user" ? theme.cyanBold("(*) user") : theme.dim("( ) user")} ${theme.dim(truncateVisible(userDir, Math.max(12, inner - 14)))}`,
      );
      body.push(
        `${overlay.targetScope === "project" ? theme.cyanBold("(*) project") : theme.dim("( ) project")} ${theme.dim(truncateVisible(projDir, Math.max(12, inner - 17)))}`,
      );
      const buttons = [
        renderButton(primaryLabel, overlay.focusedButton === "primary", theme),
        renderButton("Switch Scope", overlay.focusedButton === "scope", theme),
        renderButton("Close", overlay.focusedButton === "close", theme),
      ];
      return buildModalBoxLines(
        `Plugin Details: ${safeName} (${safeId})`,
        body,
        buttons,
        modalWidth,
        maxModalHeight,
        theme,
      );
    }

    case "installed-detail": {
      const plugin = state.snapshot.installedById.get(overlay.pluginId);
      if (plugin === undefined) {
        return buildModalBoxLines("Installed Plugin", ["Plugin was removed."], [], modalWidth, maxModalHeight, theme);
      }
      const body: string[] = [];
      const safeId = sanitizeInlineText(plugin.id);
      const safePath = sanitizeInlineText(plugin.installPath);
      if (plugin.kind === "valid") {
        const safeName = sanitizeInlineText(plugin.manifest.name);
        const safeVer = sanitizeInlineText(plugin.manifest.version ?? "-");
        const stateText =
          plugin.activation.kind === "shadowed"
            ? `shadowed by ${sanitizeInlineText(plugin.activation.shadowedBy)}`
            : plugin.activation.kind;
        body.push(`Scope: ${plugin.scope}   State: ${stateText}   Version: ${safeVer}`);
        body.push(`Path: ${safePath}`);
        body.push(
          `Footprint: ${formatBytes(plugin.diskBytes)} · ~${plugin.estimatedDescriptionTokens} desc tokens`,
        );
        if (plugin.manifest.description !== undefined) {
          body.push(
            ...wrapText(`Summary: ${sanitizeInlineText(plugin.manifest.description)}`, inner),
          );
        }
        const c = plugin.components.counts;
        body.push(
          `Components: ${c.skills} skills, ${c.agents} agents, ${c.rules} rules, ${c.hooks} hooks, ${c.mcpServers} MCP`,
        );
        if (plugin.updateAvailable !== null) {
          body.push(
            ...wrapStyledText(
              `Update available: ${plugin.updateAvailable.latestVersion} (${plugin.updateAvailable.sourceEntryId})`,
              inner,
              (line) => theme.yellow(line),
            ),
          );
        }
        const toggleLabel = plugin.activation.kind === "disabled" ? "Enable" : "Disable";
        const btns = [renderButton(toggleLabel, overlay.focusedAction === "toggle", theme)];
        if (plugin.provenance.kind !== "unmanaged") {
          btns.push(renderButton("Update", overlay.focusedAction === "update", theme));
        }
        btns.push(renderButton("Uninstall", overlay.focusedAction === "uninstall", theme));
        btns.push(renderButton("Close", overlay.focusedAction === "close", theme));
        return buildModalBoxLines(
          `Installed: ${safeName} (${safeId})`,
          body,
          btns,
          modalWidth,
          maxModalHeight,
          theme,
        );
      }
      const safeDirName = sanitizeInlineText(plugin.dirName);
      body.push(theme.red(`Status: BROKEN (${plugin.diagnosticIds.length} diagnostic(s))`));
      body.push(`Path: ${safePath}`);
      body.push(`Disk: ${formatBytes(plugin.diskBytes)}`);
      const btns = [
        renderButton("Uninstall", overlay.focusedAction === "uninstall", theme),
        renderButton("Close", overlay.focusedAction === "close", theme),
      ];
      return buildModalBoxLines(
        `Broken Plugin: ${safeDirName} (${safeId})`,
        body,
        btns,
        modalWidth,
        maxModalHeight,
        theme,
      );
    }

    case "marketplace-detail": {
      const mkt = state.snapshot.marketplacesById.get(overlay.marketplaceId);
      if (mkt === undefined) {
        return buildModalBoxLines("Marketplace", ["Marketplace was removed."], [], modalWidth, maxModalHeight, theme);
      }
      const safeMktId = sanitizeInlineText(mkt.id);
      const safeSource = sanitizeInlineText(formatMarketplaceSource(mkt.source));
      const safeAdded = sanitizeInlineText(mkt.addedAt);
      const body: string[] = [
        `ID: ${safeMktId}   Kind: ${mkt.source.kind}`,
        `Source: ${safeSource}`,
        `Added: ${safeAdded}`,
      ];
      if (mkt.localMirrorPath !== null) {
        body.push(`Mirror: ${sanitizeInlineText(mkt.localMirrorPath)}`);
      }
      if (mkt.sync.kind === "synced") {
        body.push(
          ...wrapStyledText(
            `Sync: synced (${mkt.sync.pluginCount} plugins · ${mkt.sync.format} · ${mkt.sync.syncedAt})`,
            inner,
            (line) => theme.green(line),
          ),
        );
        if (mkt.sync.resolvedRef !== null) {
          body.push(
            `Ref: ${sanitizeInlineText(mkt.sync.resolvedRef)} (${sanitizeInlineText(mkt.sync.resolvedSha ?? "-")})`,
          );
        }
      } else if (mkt.sync.kind === "never-synced") {
        body.push(theme.yellow("Sync: never synced"));
      } else {
        body.push(
          ...wrapStyledText(`Sync failed: ${mkt.sync.reason}`, inner, (line) => theme.red(line)),
        );
      }
      const buttons = [
        renderButton("Update", overlay.focusedAction === "update", theme),
        renderButton("Remove", overlay.focusedAction === "remove", theme),
        renderButton("Close", overlay.focusedAction === "close", theme),
      ];
      return buildModalBoxLines(
        `Marketplace: ${safeMktId}`,
        body,
        buttons,
        modalWidth,
        maxModalHeight,
        theme,
      );
    }

    case "add-marketplace": {
      const srcFocused = overlay.focusedField === "source";
      const idFocused = overlay.focusedField === "id";
      const srcBox = renderTextInputInline(
        overlay.sourceInput,
        srcFocused,
        "owner/repo, git@..., https://..., or ./path",
        Math.max(12, inner - 10),
        theme,
      );
      const idPlaceholder =
        overlay.preview.kind === "valid"
          ? `auto: ${overlay.preview.suggestedId}`
          : "optional custom id";
      const idBox = renderTextInputInline(
        overlay.idInput,
        idFocused,
        idPlaceholder,
        Math.max(12, inner - 10),
        theme,
      );
      const body: string[] = [
        `${srcFocused ? theme.cyanBold("▸ Source:") : theme.dim("  Source:")} ${srcBox}`,
        `${idFocused ? theme.cyanBold("▸ ID:    ") : theme.dim("  ID:    ")} ${idBox}`,
        "",
      ];
      if (overlay.preview.kind === "empty") {
        body.push(theme.dim("Examples:"));
        body.push(theme.dim("  GitHub : cursor/plugins or https://github.com/org/repo"));
        body.push(theme.dim("  SSH    : git@github.com:org/repo.git"));
        body.push(theme.dim("  HTTPS  : https://example.com/plugins.git or .../marketplace.json"));
        body.push(theme.dim("  Local  : ~/dev/plugins or ./local-marketplace"));
      } else if (overlay.preview.kind === "valid") {
        const chosenId =
          overlay.idInput.value.trim().length > 0
            ? sanitizeInlineText(overlay.idInput.value)
            : sanitizeInlineText(overlay.preview.suggestedId);
        body.push(
          theme.green(
            `Detected: ${overlay.preview.source.kind}   ID: ${chosenId}`,
          ),
        );
        body.push(
          theme.dim(
            `Resolved: ${sanitizeInlineText(formatMarketplaceSource(overlay.preview.source))}`,
          ),
        );
      } else {
        body.push(
          ...wrapStyledText(`Invalid source: ${overlay.preview.message}`, inner, (line) =>
            theme.red(line),
          ),
        );
      }

      const buttons = [
        renderButton("Add Marketplace", overlay.focusedField === "submit", theme),
        renderButton("Cancel", overlay.focusedField === "cancel", theme),
      ];
      return buildModalBoxLines(
        "Add Marketplace",
        body,
        buttons,
        modalWidth,
        maxModalHeight,
        theme,
      );
    }

    case "diagnostic-detail": {
      const diag: Diagnostic | undefined = state.snapshot.diagnosticsById.get(overlay.diagnosticId);
      if (diag === undefined) {
        return buildModalBoxLines("Diagnostic", ["Diagnostic resolved."], [], modalWidth, maxModalHeight, theme);
      }
      const safeKind = sanitizeInlineText(diag.detail.kind);
      const body: string[] = [
        `Severity: ${diag.severity.toUpperCase()}   Code: ${safeKind}`,
        ...wrapText(`Message: ${sanitizeInlineText(diag.message)}`, inner),
        ...wrapText(`Hint: ${sanitizeInlineText(diag.hint)}`, inner),
      ];
      if (diag.remediation !== undefined) {
        body.push(
          ...wrapStyledText(
            `Auto-fix: ${diag.remediation.label}`,
            inner,
            (line) => theme.green(line),
          ),
        );
      }
      const btns: string[] = [];
      if (diag.remediation !== undefined) {
        const maxFixLabel = Math.max(8, inner - 19);
        const fixLabel = truncateVisible(
          `Fix: ${sanitizeInlineText(diag.remediation.label)}`,
          maxFixLabel,
        );
        btns.push(renderButton(fixLabel, overlay.focusedAction === "fix", theme));
      }
      btns.push(renderButton("Close", overlay.focusedAction === "close", theme));
      return buildModalBoxLines(
        `Diagnostic: ${safeKind}`,
        body,
        btns,
        modalWidth,
        maxModalHeight,
        theme,
      );
    }

    case "confirm": {
      const body = wrapText(sanitizeInlineText(overlay.message), inner);
      const buttons = [
        renderButton(overlay.confirmLabel, overlay.focusedChoice === "confirm", theme),
        renderButton("Cancel", overlay.focusedChoice === "cancel", theme),
      ];
      return buildModalBoxLines(
        overlay.title,
        body,
        buttons,
        modalWidth,
        maxModalHeight,
        theme,
      );
    }

    case "help": {
      const body: string[] = [
        theme.cyanBold("Global & Navigation"),
        "  ←/→, Tab/Shift+Tab   Switch between the 5 workspace tabs",
        "  1..5                 Jump directly to Discover, Installed, Marketplaces, Errors, Stats",
        "  ↑/↓, j/k, PgUp/PgDn  Move table cursor (selection stays pinned by ID)",
        "  /                    Focus live search textbox (Enter keeps filter, Esc resets)",
        "  Esc / q              Close modal or exit TUI",
        "",
        theme.cyanBold("Tab Shortcuts"),
        "  Discover      Enter open detail · i quick install · f filter · a add marketplace",
        "  Installed     Enter inspect · Space enable/disable · u update · U all · x remove",
        "  Marketplaces  a add · Enter inspect · u update · U update all · d remove",
        "  Errors        Enter inspect · f auto-fix · m level filter · r re-check",
        "  Stats         m cycle breakdown (By Plugin / By Marketplace / By Scope) · r refresh",
      ];
      return buildModalBoxLines(
        "Antigravity Plugin Manager Help",
        body,
        [renderButton("Close", true, theme)],
        modalWidth,
        maxModalHeight,
        theme,
      );
    }

    default: {
      const _exhaustive: never = overlay;
      return _exhaustive;
    }
  }
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
