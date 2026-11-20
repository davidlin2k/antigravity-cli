import {
  formatBytes,
  formatComponentsCompact,
  formatMarketplaceSource,
} from "../domain/query.ts";
import type { CatalogMatch } from "../domain/query.ts";
import type {
  Diagnostic,
  EngineError,
  EngineResult,
  InstalledPlugin,
  MarketplaceRecord,
  ParseError,
  WorkspaceSnapshot,
} from "../domain/types.ts";
import type {
  BulkSyncReport,
  InstallReport,
  MarketplaceSyncReport,
  RemoveMarketplaceReport,
  ToggleReport,
  UninstallReport,
  UpdateReport,
  ValidationReport,
} from "../engine/contract.ts";
import { padVisible } from "../tui/ansi.ts";
import type { AnsiTheme } from "../tui/ansi.ts";
import { formatEngineError } from "../tui/state.ts";
import type { ExitCode, JsonEnvelope, OutputMode } from "./args.ts";

export interface FormatContext {
  readonly mode: OutputMode;
  readonly theme: AnsiTheme;
}

export interface FormattedOutput {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  readonly exitCode: ExitCode;
}

export function getSimpleHelpText(version: string): string {
  return `agy-plugin v${version} — Antigravity local multi-marketplace plugin manager

Usage:
  agy-plugin [global-flags] [command]

Commands:
  (none) | tui                          Launch interactive 5-tab TUI
  discover [query] [flags]              Search synced marketplace catalogs
    --marketplace <id> --category <cat> --installed | --available
  install <target> [flags]              Install and adapt a plugin atomically
    --scope user|project --dir-name <dir> --force
  uninstall <scope:dir|name> [flags]    Uninstall a plugin (--scope user|project)
  enable <scope:dir|name> [flags]       Enable a plugin (--scope user|project)
  disable <scope:dir|name> [flags]      Disable a plugin (--scope user|project)
  list [flags]                          List installed plugins
    --scope user|project --state active|disabled|shadowed|broken
  update [<scope:dir|name>|--all]       Update one or all managed plugins
    --scope user|project
  validate [<path-or-url>|<sel>]        Validate workspace, source, or installed plugin
    --strict --scope user|project
  errors [text] [--severity error|warning]
  stats                                 Show catalog, token, and disk footprint
  marketplace add <source> [--id <id>]  Register GitHub/SSH/HTTPS/local marketplace
  marketplace list                      List configured marketplaces
  marketplace update [<id>|--all]       Sync one or all marketplaces
  marketplace remove <id>               Remove a marketplace registration

Global Flags (accepted before or after commands):
  --config-dir <path>   Override AGY_CONFIG_DIR (default ~/.gemini/config)
  --workspace <path>    Override workspace root (default cwd)
  --json                Emit single-object JSON output without ANSI codes
  -h, --help            Print this help text and exit 0
  -v, --version         Print package version and exit 0

Exit Codes:
  0  Success
  1  Runtime, network, collision, or validation error
  2  Invalid CLI arguments or boundary parse error
`;
}

export function formatJsonEnvelope<TData, TError>(payload: JsonEnvelope<TData, TError>): string {
  return `${JSON.stringify(payload)}\n`;
}

function stdoutOk(text: string, exitCode: ExitCode = 0): FormattedOutput {
  return { stream: "stdout", text, exitCode };
}

function jsonOutput<TData, TError>(
  payload: JsonEnvelope<TData, TError>,
  exitCode: ExitCode,
): FormattedOutput {
  return { stream: "stdout", text: formatJsonEnvelope(payload), exitCode };
}

export function renderSimpleTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  widths: readonly number[],
  theme: AnsiTheme,
): string {
  const headerLine = headers
    .map((h, i) => theme.bold(padVisible(h, widths[i] ?? 12)))
    .join("  ");
  const sepLine = theme.dim(widths.map((w) => "─".repeat(w)).join("  "));
  const bodyLines = rows.map((row) =>
    row.map((cell, i) => padVisible(cell, widths[i] ?? 12)).join("  "),
  );
  return [headerLine, sepLine, ...bodyLines].join("\n");
}

function formatInstalledLabel(plugin: InstalledPlugin): string {
  if (plugin.kind === "broken") return "broken";
  return plugin.activation.kind === "shadowed"
    ? `shadowed(${plugin.activation.shadowedBy})`
    : plugin.activation.kind;
}

function formatDiagnosticLine(diag: Diagnostic, theme: AnsiTheme): string {
  const level = diag.severity === "error" ? theme.red("ERROR") : theme.yellow("WARN ");
  const fix = diag.remediation !== undefined ? theme.green(` [fix: ${diag.remediation.label}]`) : "";
  return `${level} ${theme.cyan(diag.detail.kind)} — ${diag.message}${fix}\n      Hint: ${diag.hint}`;
}

function formatValidationHuman(report: ValidationReport, strict: boolean, theme: AnsiTheme): string {
  const lines: string[] = [];
  const passed = report.valid && (!strict || report.diagnostics.length === 0);
  lines.push(`${passed ? theme.green("PASS") : theme.red("FAIL")} validate: ${report.targetLabel}`);
  if (report.manifest !== null) {
    lines.push(
      `Plugin: ${report.manifest.name}${report.manifest.version ? ` v${report.manifest.version}` : ""}`,
    );
  }
  if (report.components !== null) {
    lines.push(`Components: ${formatComponentsCompact(report.components.counts)}`);
  }
  for (const diag of report.diagnostics) {
    lines.push(formatDiagnosticLine(diag, theme));
  }
  return `${lines.join("\n")}\n`;
}

function formatStatsHuman(snapshot: WorkspaceSnapshot, theme: AnsiTheme): string {
  const { stats } = snapshot;
  const c = stats.activeComponents;
  const lines: string[] = [
    theme.bold("Workspace Plugin Stats"),
    `Discoverable : ${stats.discoverableCount} (${snapshot.marketplaces.length} marketplaces)`,
    `Installed    : ${stats.installedCount} total (${stats.activeCount} active, ${stats.disabledCount} disabled, ${stats.shadowedCount} shadowed, ${stats.brokenCount} broken)`,
    `Components   : ${c.skills} skills, ${c.agents} agents, ${c.rules} rules, ${c.hooks} hooks, ${c.mcpServers} MCP servers`,
    `Desc Tokens  : ~${stats.estimatedDescriptionTokens}`,
    `Disk Usage   : ${formatBytes(stats.totalDiskBytes)}`,
    `Diagnostics  : ${stats.errorCount} error(s), ${stats.warningCount} warning(s)`,
  ];
  return `${lines.join("\n")}\n`;
}

export function formatParseError(error: ParseError, mode: OutputMode): FormattedOutput {
  if (mode === "json") {
    return jsonOutput({ ok: false, error }, 2);
  }
  return { stream: "stderr", text: `Error (${error.code}): ${error.message}\n`, exitCode: 2 };
}

export function formatCliError(
  code: string,
  message: string,
  mode: OutputMode,
  exitCode: ExitCode,
  detail?: unknown,
): FormattedOutput {
  if (mode === "json") {
    return jsonOutput({ ok: false, error: detail ?? { code, message } }, exitCode);
  }
  return { stream: "stderr", text: `Error: ${message}\n`, exitCode };
}

export function formatEngineFailure(error: EngineError, mode: OutputMode): FormattedOutput {
  if (mode === "json") {
    return jsonOutput({ ok: false, error }, 1);
  }
  return { stream: "stderr", text: `${formatEngineError(error)}\n`, exitCode: 1 };
}

export function formatHelpResult(version: string, mode: OutputMode): FormattedOutput {
  const help = getSimpleHelpText(version);
  return mode === "json" ? jsonOutput({ ok: true, data: { help } }, 0) : stdoutOk(help);
}

export function formatVersionResult(version: string, mode: OutputMode): FormattedOutput {
  return mode === "json" ? jsonOutput({ ok: true, data: { version } }, 0) : stdoutOk(`${version}\n`);
}

export function formatDiscoverResult(
  matches: readonly CatalogMatch[],
  ctx: FormatContext,
): FormattedOutput {
  if (ctx.mode === "json") {
    return jsonOutput({ ok: true, data: { total: matches.length, matches } }, 0);
  }
  if (matches.length === 0) {
    return stdoutOk("No matching plugins found.\n");
  }
  const rows = matches.map((m) => [
    m.entry.id,
    m.entry.displayName || m.entry.name,
    formatComponentsCompact(m.entry.componentCounts),
    m.entry.version ?? "-",
    m.installStatus.kind === "installed" ? m.installStatus.scopes.join(",") : "available",
  ]);
  return stdoutOk(
    `${renderSimpleTable(["ID", "Name", "Components", "Version", "Status"], rows, [28, 22, 16, 10, 14], ctx.theme)}\n`,
  );
}

export function formatInstallResult(
  res: EngineResult<InstallReport>,
  ctx: FormatContext,
): FormattedOutput {
  if (!res.ok) return formatEngineFailure(res.error, ctx.mode);
  if (ctx.mode === "json") return jsonOutput({ ok: true, data: res.report }, 0);
  const header = `${ctx.theme.green("✔")} ${res.report.outcome} ${res.report.pluginId} (${res.report.installPath})\n`;
  const warnings = res.report.warnings
    .map((warn) => `${formatDiagnosticLine(warn, ctx.theme)}\n`)
    .join("");
  return stdoutOk(`${header}${warnings}`);
}

export function formatUninstallResult(
  res: EngineResult<UninstallReport>,
  ctx: FormatContext,
): FormattedOutput {
  if (!res.ok) return formatEngineFailure(res.error, ctx.mode);
  if (ctx.mode === "json") return jsonOutput({ ok: true, data: res.report }, 0);
  return stdoutOk(`${ctx.theme.green("✔")} ${res.report.outcome}: ${res.report.pluginId}\n`);
}

export function formatSetEnabledResult(
  res: EngineResult<ToggleReport>,
  ctx: FormatContext,
): FormattedOutput {
  if (!res.ok) return formatEngineFailure(res.error, ctx.mode);
  if (ctx.mode === "json") return jsonOutput({ ok: true, data: res.report }, 0);
  const verb = res.report.enabled ? "enabled" : "disabled";
  return stdoutOk(`${ctx.theme.green("✔")} ${verb} ${res.report.pluginId} (${res.report.outcome})\n`);
}

export function formatListResult(
  plugins: readonly InstalledPlugin[],
  ctx: FormatContext,
): FormattedOutput {
  if (ctx.mode === "json") {
    return jsonOutput({ ok: true, data: { total: plugins.length, installed: plugins } }, 0);
  }
  if (plugins.length === 0) {
    return stdoutOk("No installed plugins found.\n");
  }
  const rows = plugins.map((p) => [
    p.id,
    p.kind === "valid" ? p.manifest.name : p.dirName,
    p.scope,
    p.kind === "valid" ? (p.manifest.version ?? "-") : "-",
    formatInstalledLabel(p),
    p.kind === "valid" ? formatComponentsCompact(p.components.counts) : "-",
  ]);
  return stdoutOk(
    `${renderSimpleTable(["ID", "Name", "Scope", "Version", "State", "Components"], rows, [22, 20, 8, 10, 16, 16], ctx.theme)}\n`,
  );
}

export function formatUpdateResult(
  res: EngineResult<UpdateReport>,
  ctx: FormatContext,
): FormattedOutput {
  if (!res.ok) return formatEngineFailure(res.error, ctx.mode);
  const failed = res.report.outcomes.filter((o) => o.status === "failed");
  if (ctx.mode === "json") {
    if (failed.length > 0) {
      return jsonOutput(
        {
          ok: false,
          error: {
            kind: "update-failed",
            message: `${failed.length} plugin update(s) failed.`,
            outcomes: res.report.outcomes,
          },
        },
        1,
      );
    }
    return jsonOutput({ ok: true, data: res.report }, 0);
  }
  const text = res.report.outcomes
    .map((o) => `${o.pluginId}: ${o.status}${o.reason ? ` (${o.reason})` : ""}\n`)
    .join("");
  return stdoutOk(text, failed.length > 0 ? 1 : 0);
}

export function formatValidateResult(
  report: ValidationReport,
  strict: boolean,
  ctx: FormatContext,
): FormattedOutput {
  const hasWarnings = report.diagnostics.some((d) => d.severity === "warning");
  const passed = report.valid && (!strict || !hasWarnings);
  const exitCode: ExitCode = passed ? 0 : 1;
  if (ctx.mode === "json") {
    return passed
      ? jsonOutput({ ok: true, data: report }, 0)
      : jsonOutput({ ok: false, error: { kind: "validation-failed", strict, report } }, 1);
  }
  return stdoutOk(formatValidationHuman(report, strict, ctx.theme), exitCode);
}

export function formatErrorsResult(
  diagnostics: readonly Diagnostic[],
  ctx: FormatContext,
): FormattedOutput {
  if (ctx.mode === "json") {
    return jsonOutput({ ok: true, data: { total: diagnostics.length, diagnostics } }, 0);
  }
  if (diagnostics.length === 0) {
    return stdoutOk("No diagnostics found.\n");
  }
  const text = diagnostics.map((diag) => `${formatDiagnosticLine(diag, ctx.theme)}\n`).join("");
  return stdoutOk(text);
}

export function formatStatsResult(
  snapshot: WorkspaceSnapshot,
  ctx: FormatContext,
): FormattedOutput {
  if (ctx.mode === "json") {
    return jsonOutput({ ok: true, data: snapshot.stats }, 0);
  }
  return stdoutOk(formatStatsHuman(snapshot, ctx.theme));
}

export function formatMarketplaceAddResult(
  res: EngineResult<MarketplaceSyncReport>,
  ctx: FormatContext,
): FormattedOutput {
  if (!res.ok) return formatEngineFailure(res.error, ctx.mode);
  const o = res.report.outcome;
  const failed = o.status === "failed";
  if (ctx.mode === "json") {
    return failed ? jsonOutput({ ok: false, error: o }, 1) : jsonOutput({ ok: true, data: res.report }, 0);
  }
  const text = failed
    ? `${ctx.theme.red("✖")} ${o.marketplaceId}: sync failed (${o.reason ?? "unknown"})\n`
    : `${ctx.theme.green("✔")} ${o.marketplaceId}: synced ${o.pluginCount} plugins (${o.format ?? "unknown"})\n`;
  return stdoutOk(text, failed ? 1 : 0);
}

export function formatMarketplaceListResult(
  marketplaces: readonly MarketplaceRecord[],
  ctx: FormatContext,
): FormattedOutput {
  if (ctx.mode === "json") {
    return jsonOutput({ ok: true, data: { total: marketplaces.length, marketplaces } }, 0);
  }
  if (marketplaces.length === 0) {
    return stdoutOk("No marketplaces registered.\n");
  }
  const rows = marketplaces.map((m) => [
    m.id,
    m.source.kind,
    formatMarketplaceSource(m.source),
    m.sync.kind === "synced" ? String(m.sync.pluginCount) : "-",
    m.sync.kind,
  ]);
  return stdoutOk(
    `${renderSimpleTable(["ID", "Kind", "Source", "Plugins", "Status"], rows, [22, 12, 34, 8, 13], ctx.theme)}\n`,
  );
}

export function formatMarketplaceUpdateResult(
  res: EngineResult<BulkSyncReport>,
  ctx: FormatContext,
): FormattedOutput {
  if (!res.ok) return formatEngineFailure(res.error, ctx.mode);
  const failed = res.report.outcomes.filter((o) => o.status === "failed");
  if (ctx.mode === "json") {
    if (failed.length > 0) {
      return jsonOutput(
        {
          ok: false,
          error: { kind: "marketplace-sync-failed", outcomes: res.report.outcomes },
        },
        1,
      );
    }
    return jsonOutput({ ok: true, data: res.report }, 0);
  }
  const text = res.report.outcomes
    .map(
      (o) =>
        `${o.marketplaceId}: ${o.status} (${o.pluginCount} plugins)${o.reason ? ` — ${o.reason}` : ""}\n`,
    )
    .join("");
  return stdoutOk(text, failed.length > 0 ? 1 : 0);
}

export function formatMarketplaceRemoveResult(
  res: EngineResult<RemoveMarketplaceReport>,
  ctx: FormatContext,
): FormattedOutput {
  if (!res.ok) return formatEngineFailure(res.error, ctx.mode);
  if (ctx.mode === "json") return jsonOutput({ ok: true, data: res.report }, 0);
  return stdoutOk(`${ctx.theme.green("✔")} removed marketplace ${res.report.id}\n`);
}
