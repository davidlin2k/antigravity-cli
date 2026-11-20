import { formatBytes, formatMarketplaceSource } from "../domain/query.ts";
import { joinAbsolutePath } from "../domain/types.ts";
import type { CatalogEntry, Diagnostic } from "../domain/types.ts";
import {
  displayWidth,
  padVisible,
  sanitizeInlineText,
  truncateVisible,
  wrapText,
} from "./ansi.ts";
import type { AnsiTheme } from "./ansi.ts";
import {
  findInstalledForEntryInScope,
  findSameNameCollisionInScope,
} from "./reduce-modals.ts";
import { renderTextInputInline } from "./render-chrome.ts";
import type { OverlayState, TuiState, Viewport } from "./state.ts";

export function renderButton(
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

export function wrapStyledText(
  text: string,
  maxWidth: number,
  style: (line: string) => string,
): readonly string[] {
  return wrapText(sanitizeInlineText(text), maxWidth).map(style);
}

export function buildModalBoxLines(
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

export function renderOverlayLines(
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
