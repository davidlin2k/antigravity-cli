import {
  displayWidth,
  graphemeDisplayWidth,
  padVisible,
  sanitizeInlineText,
  sanitizeInputText,
  splitGraphemes,
  truncateVisible,
} from "./ansi.ts";
import type { AnsiTheme } from "./ansi.ts";
import { TAB_IDS } from "./state.ts";
import type { TextInputState, TuiState } from "./state.ts";
import type { CellTone, KeyHint, SummaryCard } from "./tab-registry.ts";
import { TAB_REGISTRY } from "./tabs.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function applyTone(
  theme: AnsiTheme,
  tone: CellTone | undefined,
  text: string,
): string {
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

export function boxLine(theme: AnsiTheme, content: string, innerCols: number): string {
  const padded = padVisible(content, innerCols, "left");
  const border = theme.dim("│");
  return `${border} ${padded} ${border}`;
}

export function renderTopBorder(theme: AnsiTheme, cols: number): string {
  return theme.dim(`┌${"─".repeat(Math.max(0, cols - 2))}┐`);
}

export function renderDivider(theme: AnsiTheme, cols: number): string {
  return theme.dim(`├${"─".repeat(Math.max(0, cols - 2))}┤`);
}

export function renderBottomBorder(theme: AnsiTheme, cols: number): string {
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

export function renderHeaderLine(
  state: TuiState,
  theme: AnsiTheme,
  innerCols: number,
): string {
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

export function renderTextInputInline(
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

export function renderSearchSubheader(
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

export function renderCompactStatsLine(
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

export function renderStatsCardsLines(
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

export function renderFooterLine(
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

export function renderToastLine(
  state: TuiState,
  theme: AnsiTheme,
  innerCols: number,
): string | null {
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
