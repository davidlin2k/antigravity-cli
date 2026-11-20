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
  moveTo,
  overlaySegmentOnLine,
  padVisible,
  truncateVisible,
  wrapText,
} from "./ansi.ts";
import type { AnsiTheme } from "./ansi.ts";
import {
  computeFooterHints,
  findInstalledForEntryInScope,
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
    cols: Math.max(40, Math.min(400, safeCols)),
    rows: Math.max(12, Math.min(200, safeRows)),
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

function renderHeaderLine(state: TuiState, theme: AnsiTheme, innerCols: number): string {
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
    const badgeText = badge !== null ? ` ${badge}` : "";
    const label =
      innerCols < 66 && tabId !== state.activeTab
        ? compactTabLabel(tabId, desc.label)
        : desc.label;
    const rawLabel = `${desc.number} ${label}${badgeText}`;
    if (tabId === state.activeTab) {
      tabTokens.push(theme.cyanBold(`[${rawLabel}]`));
    } else {
      const hasErrorBadge = tabId === "errors" && badge !== null;
      tabTokens.push(hasErrorBadge ? theme.yellow(rawLabel) : theme.dim(rawLabel));
    }
  }

  let busyBadge = "";
  if (state.pending.kind === "running") {
    const glyph = SPINNER_FRAMES[state.spinnerTick % SPINNER_FRAMES.length] ?? "⠋";
    busyBadge = `  ${theme.yellow(`${glyph} ${state.pending.label}`)}`;
  }

  const separator = innerCols >= 84 ? "  " : " ";
  const line = `${titleStyled}${tabTokens.join(separator)}${busyBadge}`;
  return boxLine(theme, line, innerCols);
}

function renderTextInputInline(
  input: TextInputState,
  focused: boolean,
  placeholder: string,
  maxWidth: number,
  theme: AnsiTheme,
): string {
  if (input.value.length === 0) {
    if (focused) {
      const hint = maxWidth > 2 ? ` ${placeholder}` : "";
      return truncateVisible(`${theme.cyanBold("▏")}${theme.dim(hint)}`, maxWidth, "");
    }
    return theme.dim(truncateVisible(placeholder, maxWidth));
  }
  if (!focused) {
    return truncateVisible(input.value, maxWidth);
  }
  const chars = Array.from(input.value);
  const cursor = Math.max(0, Math.min(chars.length, input.cursor));
  const before = chars.slice(0, cursor).join("");
  const atCursor = chars[cursor];
  const after = atCursor !== undefined ? chars.slice(cursor + 1).join("") : "";
  const cursorGlyph =
    atCursor !== undefined ? theme.inverse(atCursor) : theme.cyanBold("_");

  const full = `${before}${cursorGlyph}${after}`;
  if (displayWidth(full) <= maxWidth) {
    return full;
  }
  const keepTail = Math.max(1, maxWidth - 2);
  const tailChars = chars.slice(Math.max(0, cursor - keepTail + 1), cursor);
  return truncateVisible(`…${tailChars.join("")}${cursorGlyph}${after}`, maxWidth, "");
}

function renderSearchSubheader(
  state: TuiState,
  modeBadgeText: string,
  modeTone: CellTone | undefined,
  theme: AnsiTheme,
  innerCols: number,
): string {
  if (state.activeTab === "stats") {
    return boxLine(theme, applyTone(theme, modeTone, modeBadgeText), innerCols);
  }
  const searchState = state.searchByTab[state.activeTab];
  const isSearchFocused = state.overlay.kind === "search-input";
  const prefixPlain = "Search [/]: ";
  const prefixStyled = isSearchFocused
    ? theme.cyanBold(prefixPlain)
    : theme.dim(prefixPlain);

  const badgeStyled =
    modeBadgeText.length > 0 ? applyTone(theme, modeTone, modeBadgeText) : "";
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

function renderStatsCardsLines(
  cards: readonly SummaryCard[],
  modeBadgeText: string,
  theme: AnsiTheme,
  innerCols: number,
): readonly string[] {
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
    labelCells.push(theme.dim(padVisible(card.label, width, "left")));
    valueCells.push(applyTone(theme, card.tone, padVisible(card.value, width, "left")));
    subCells.push(theme.dim(padVisible(card.subtext ?? "", width, "left")));
  }

  const sep = " ".repeat(gapWidth);
  const line1 = boxLine(theme, labelCells.join(sep), innerCols);
  const line2 = boxLine(theme, valueCells.join(sep), innerCols);
  const subWithMode =
    modeBadgeText.length > 0 ? theme.cyan(modeBadgeText) : subCells.join(sep);
  const line3 = boxLine(
    theme,
    innerCols >= 80 && modeBadgeText.length > 0
      ? `${padVisible(subCells.slice(0, 3).join(sep), Math.max(20, innerCols - displayWidth(modeBadgeText) - 2), "left")}  ${theme.cyan(modeBadgeText)}`
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
  return boxLine(theme, applyTone(theme, cellTone, `${prefix}${text}`), innerCols);
}

function renderButton(
  label: string,
  focused: boolean,
  theme: AnsiTheme,
): string {
  const text = `[ ${label} ]`;
  return focused ? theme.focusedButton(text) : theme.dim(text);
}

function buildModalBoxLines(
  title: string,
  bodyLines: readonly string[],
  buttonsLine: string | null,
  modalWidth: number,
  maxModalHeight: number,
  theme: AnsiTheme,
): readonly string[] {
  const inner = Math.max(10, modalWidth - 4);
  const borderV = theme.cyan("│");
  const top = theme.cyan(`┌${"─".repeat(modalWidth - 2)}┐`);
  const mid = theme.cyan(`├${"─".repeat(modalWidth - 2)}┤`);
  const bot = theme.cyan(`└${"─".repeat(modalWidth - 2)}┘`);

  const titleLabel = truncateVisible(title, Math.max(4, inner - 6));
  const escBadge = theme.dim("[Esc]");
  const titlePad = Math.max(1, inner - displayWidth(titleLabel) - 5);
  const titleRow = `${borderV} ${theme.whiteBold(titleLabel)}${" ".repeat(titlePad)}${escBadge} ${borderV}`;

  const chromeRows = buttonsLine !== null ? 6 : 4;
  const maxBodyRows = Math.max(1, maxModalHeight - chromeRows);
  const clippedBody = bodyLines.slice(0, maxBodyRows);

  const lines: string[] = [top, titleRow, mid];
  for (const row of clippedBody) {
    lines.push(`${borderV} ${padVisible(row, inner, "left")} ${borderV}`);
  }
  if (buttonsLine !== null) {
    lines.push(mid);
    lines.push(`${borderV} ${padVisible(buttonsLine, inner, "left")} ${borderV}`);
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
  theme: AnsiTheme,
): readonly string[] {
  const modalWidth = Math.max(
    Math.min(44, viewport.cols - 2),
    Math.min(82, viewport.cols - 6),
  );
  const inner = Math.max(10, modalWidth - 4);
  const maxModalHeight = Math.max(8, viewport.rows - 2);

  switch (overlay.kind) {
    case "discover-detail": {
      const entry = state.snapshot.catalogById.get(overlay.entryId);
      if (entry === undefined) {
        return buildModalBoxLines("Plugin Details", ["Plugin no longer in catalog."], null, modalWidth, maxModalHeight, theme);
      }
      const installed = findInstalledForEntryInScope(state.snapshot, entry, overlay.targetScope);
      const primaryLabel = installed !== undefined ? "Uninstall" : "Install";
      const meta = `Version: ${entry.version ?? "-"}   Author: ${entry.author ?? "-"}   Format: ${entry.sourceFormat}`;
      const body: string[] = [
        theme.dim(meta),
        ...wrapText(`Summary: ${entry.description || "No description provided."}`, inner),
        ...wrapText(`Components: ${describeCatalogEntryComponents(entry)}`, inner),
      ];
      if (entry.componentsPreview !== null && entry.componentsPreview.skills.length > 0) {
        const names = entry.componentsPreview.skills.slice(0, 8).map((s) => s.name);
        const suffix =
          entry.componentsPreview.skills.length > 8
            ? `, +${entry.componentsPreview.skills.length - 8} more`
            : "";
        body.push(...wrapText(`Skills: ${names.join(", ")}${suffix}`, inner));
      }
      const userDir = joinAbsolutePath(
        state.snapshot.paths.userPluginsDir,
        entry.slug,
      );
      const projDir = joinAbsolutePath(
        state.snapshot.paths.projectPluginsDir,
        entry.slug,
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
      ].join("   ");
      return buildModalBoxLines(
        `Plugin Details: ${entry.name} (${entry.id})`,
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
        return buildModalBoxLines("Installed Plugin", ["Plugin was removed."], null, modalWidth, maxModalHeight, theme);
      }
      const body: string[] = [];
      if (plugin.kind === "valid") {
        const stateText =
          plugin.activation.kind === "shadowed"
            ? `shadowed by ${plugin.activation.shadowedBy}`
            : plugin.activation.kind;
        body.push(
          `Scope: ${plugin.scope}   State: ${stateText}   Version: ${plugin.manifest.version ?? "-"}`,
        );
        body.push(`Path: ${plugin.installPath}`);
        body.push(
          `Footprint: ${formatBytes(plugin.diskBytes)} · ~${plugin.estimatedDescriptionTokens} desc tokens`,
        );
        if (plugin.manifest.description !== undefined) {
          body.push(...wrapText(`Summary: ${plugin.manifest.description}`, inner));
        }
        const c = plugin.components.counts;
        body.push(
          `Components: ${c.skills} skills, ${c.agents} agents, ${c.rules} rules, ${c.hooks} hooks, ${c.mcpServers} MCP`,
        );
        if (plugin.updateAvailable !== null) {
          body.push(
            theme.yellow(
              `Update available: ${plugin.updateAvailable.latestVersion} (${plugin.updateAvailable.sourceEntryId})`,
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
          `Installed: ${plugin.manifest.name} (${plugin.id})`,
          body,
          btns.join("  "),
          modalWidth,
          maxModalHeight,
          theme,
        );
      }
      body.push(theme.red(`Status: BROKEN (${plugin.diagnosticIds.length} diagnostic(s))`));
      body.push(`Path: ${plugin.installPath}`);
      body.push(`Disk: ${formatBytes(plugin.diskBytes)}`);
      const btns = [
        renderButton("Uninstall", overlay.focusedAction === "uninstall", theme),
        renderButton("Close", overlay.focusedAction === "close", theme),
      ].join("   ");
      return buildModalBoxLines(
        `Broken Plugin: ${plugin.dirName} (${plugin.id})`,
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
        return buildModalBoxLines("Marketplace", ["Marketplace was removed."], null, modalWidth, maxModalHeight, theme);
      }
      const body: string[] = [
        `ID: ${mkt.id}   Kind: ${mkt.source.kind}`,
        `Source: ${formatMarketplaceSource(mkt.source)}`,
        `Added: ${mkt.addedAt}`,
      ];
      if (mkt.localMirrorPath !== null) {
        body.push(`Mirror: ${mkt.localMirrorPath}`);
      }
      if (mkt.sync.kind === "synced") {
        body.push(
          theme.green(
            `Sync: synced (${mkt.sync.pluginCount} plugins · ${mkt.sync.format} · ${mkt.sync.syncedAt})`,
          ),
        );
        if (mkt.sync.resolvedRef !== null) {
          body.push(`Ref: ${mkt.sync.resolvedRef} (${mkt.sync.resolvedSha ?? "-"})`);
        }
      } else if (mkt.sync.kind === "never-synced") {
        body.push(theme.yellow("Sync: never synced"));
      } else {
        body.push(...wrapText(theme.red(`Sync failed: ${mkt.sync.reason}`), inner));
      }
      const buttons = [
        renderButton("Update", overlay.focusedAction === "update", theme),
        renderButton("Remove", overlay.focusedAction === "remove", theme),
        renderButton("Close", overlay.focusedAction === "close", theme),
      ].join("   ");
      return buildModalBoxLines(
        `Marketplace: ${mkt.id}`,
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
            ? overlay.idInput.value.trim()
            : overlay.preview.suggestedId;
        body.push(
          theme.green(
            `Detected: ${overlay.preview.source.kind}   ID: ${chosenId}`,
          ),
        );
        body.push(theme.dim(`Resolved: ${formatMarketplaceSource(overlay.preview.source)}`));
      } else {
        body.push(...wrapText(theme.red(`Invalid source: ${overlay.preview.message}`), inner));
      }

      const buttons = [
        renderButton("Add Marketplace", overlay.focusedField === "submit", theme),
        renderButton("Cancel", overlay.focusedField === "cancel", theme),
      ].join("   ");
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
        return buildModalBoxLines("Diagnostic", ["Diagnostic resolved."], null, modalWidth, maxModalHeight, theme);
      }
      const body: string[] = [
        `Severity: ${diag.severity.toUpperCase()}   Code: ${diag.detail.kind}`,
        ...wrapText(`Message: ${diag.message}`, inner),
        ...wrapText(`Hint: ${diag.hint}`, inner),
      ];
      if (diag.remediation !== undefined) {
        body.push(theme.green(`Auto-fix: ${diag.remediation.label}`));
      }
      const btns: string[] = [];
      if (diag.remediation !== undefined) {
        btns.push(renderButton(`Fix: ${diag.remediation.label}`, overlay.focusedAction === "fix", theme));
      }
      btns.push(renderButton("Close", overlay.focusedAction === "close", theme));
      return buildModalBoxLines(
        `Diagnostic: ${diag.detail.kind}`,
        body,
        btns.join("   "),
        modalWidth,
        maxModalHeight,
        theme,
      );
    }

    case "confirm": {
      const body = wrapText(overlay.message, inner);
      const buttons = [
        renderButton(overlay.confirmLabel, overlay.focusedChoice === "confirm", theme),
        renderButton("Cancel", overlay.focusedChoice === "cancel", theme),
      ].join("   ");
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
        renderButton("Close", true, theme),
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

export function renderFrame(state: TuiState, rawViewport: Viewport): RenderedFrame {
  const viewport = clampViewport(rawViewport.cols, rawViewport.rows);
  const innerCols = Math.max(10, viewport.cols - 4);
  const theme = createTheme(state.colorEnabled);

  const prepared = TAB_REGISTRY[state.activeTab].prepare(state);
  const selectedIndex = resolveActiveSelectedIndex(state, prepared);

  const topLines: string[] = [
    renderTopBorder(theme, viewport.cols),
    renderHeaderLine(state, theme, innerCols),
    renderDivider(theme, viewport.cols),
  ];

  if (state.activeTab === "stats" && prepared.summaryCards.length > 0) {
    topLines.push(
      ...renderStatsCardsLines(
        prepared.summaryCards,
        prepared.modeBadge?.text ?? "",
        theme,
        innerCols,
      ),
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
    theme.dim(padVisible(col.header, colWidths[idx] ?? 1, col.align)),
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
    for (let r = 0; r < bodyRows; r += 1) {
      if (r === emptyLineIdx) {
        bodyLines.push(
          boxLine(theme, theme.dim(padVisible(prepared.emptyMessage, innerCols, "center")), innerCols),
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
        const rawPadded = padVisible(cell?.text ?? "", width, col?.align ?? "left");
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
    const modalLines = renderOverlayLines(state, state.overlay, viewport, theme);
    const modalW = displayWidth(modalLines[0] ?? "");
    const startCol = Math.max(0, Math.floor((viewport.cols - modalW) / 2));
    const startRow = Math.max(1, Math.floor((viewport.rows - modalLines.length) / 2));
    const composited = [...frameLines];
    for (let i = 0; i < modalLines.length; i += 1) {
      const targetRow = startRow + i;
      const modalLine = modalLines[i];
      const bgLine = composited[targetRow];
      if (targetRow >= viewport.rows - 1 || modalLine === undefined || bgLine === undefined) {
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
