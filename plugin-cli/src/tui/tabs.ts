import {
  formatBytes,
  formatComponentsCompact,
  formatMarketplaceSource,
  queryCatalog,
  queryDiagnostics,
  queryInstalled,
  queryMarketplaces,
} from "../domain/query.ts";
import type { CatalogMatch } from "../domain/query.ts";
import type {
  Diagnostic,
  InstalledPlugin,
  MarketplaceRecord,
} from "../domain/types.ts";
import { EMPTY_TEXT_INPUT } from "./state.ts";
import type {
  DiscoverFilterMode,
  ErrorSeverityFilter,
  InstalledScopeFilter,
  StatsBreakdownMode,
  TabId,
  TuiState,
} from "./state.ts";
import { defineTab } from "./tab-registry.ts";
import type { CellTone, StyledCell, SummaryCard, TabDescriptor } from "./tab-registry.ts";

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatShortTimestamp(iso: string): string {
  return iso.slice(0, 10);
}

function formatDiagnosticSubject(subject: Diagnostic["subject"]): string {
  switch (subject.kind) {
    case "installed":
      return subject.pluginId;
    case "marketplace":
      return subject.marketplaceId;
    case "path":
      return subject.path;
    default: {
      const _exhaustive: never = subject;
      return _exhaustive;
    }
  }
}

function discoverModeLabel(mode: DiscoverFilterMode): string {
  switch (mode) {
    case "all":
      return "All";
    case "available":
      return "Available";
    case "installed":
      return "Installed";
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

function installedScopeLabel(scope: InstalledScopeFilter): string {
  switch (scope) {
    case "all":
      return "All Scopes";
    case "user":
      return "User";
    case "project":
      return "Project";
    default: {
      const _exhaustive: never = scope;
      return _exhaustive;
    }
  }
}

function errorSeverityLabel(level: ErrorSeverityFilter): string {
  switch (level) {
    case "all":
      return "All";
    case "error":
      return "Errors";
    case "warning":
      return "Warnings";
    default: {
      const _exhaustive: never = level;
      return _exhaustive;
    }
  }
}

function statsModeLabel(mode: StatsBreakdownMode): string {
  switch (mode) {
    case "by-plugin":
      return "By Plugin";
    case "by-marketplace":
      return "By Marketplace";
    case "by-scope":
      return "By Scope";
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

function discoverInstallFilterArg(
  mode: DiscoverFilterMode,
): "all" | "installed" | "not-installed" {
  switch (mode) {
    case "all":
      return "all";
    case "available":
      return "not-installed";
    case "installed":
      return "installed";
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

function installedStateCell(plugin: InstalledPlugin): StyledCell {
  if (plugin.kind === "broken") {
    return { text: "broken", tone: "error" };
  }
  switch (plugin.activation.kind) {
    case "active":
      return { text: "active", tone: "success" };
    case "disabled":
      return { text: "disabled", tone: "muted" };
    case "shadowed":
      return { text: "shadowed", tone: "warning" };
    default: {
      const _exhaustive: never = plugin.activation;
      return _exhaustive;
    }
  }
}

function installedSourceLabel(plugin: InstalledPlugin): string {
  switch (plugin.provenance.kind) {
    case "marketplace":
      return plugin.provenance.marketplaceId;
    case "direct":
      return plugin.provenance.installSource.kind;
    case "unmanaged":
      return "unmanaged";
    default: {
      const _exhaustive: never = plugin.provenance;
      return _exhaustive;
    }
  }
}

function marketplaceSyncStatusCell(record: MarketplaceRecord): StyledCell {
  switch (record.sync.kind) {
    case "synced":
      return { text: "synced", tone: "success" };
    case "never-synced":
      return { text: "pending", tone: "warning" };
    case "sync-failed":
      return { text: "failed", tone: "error" };
    default: {
      const _exhaustive: never = record.sync;
      return _exhaustive;
    }
  }
}

interface StatsRow {
  readonly key: string;
  readonly entity: string;
  readonly components: string;
  readonly estTokens: string;
  readonly disk: string;
  readonly tone: CellTone;
}

function buildStatsRows(state: TuiState): readonly StatsRow[] {
  const { snapshot, statsMode } = state;

  switch (statsMode) {
    case "by-plugin": {
      const rows: StatsRow[] = [];
      const sorted = [...snapshot.installed].sort((a, b) => {
        const tokA = a.kind === "valid" ? a.estimatedDescriptionTokens : 0;
        const tokB = b.kind === "valid" ? b.estimatedDescriptionTokens : 0;
        if (tokB !== tokA) {
          return tokB - tokA;
        }
        return b.diskBytes - a.diskBytes;
      });
      for (const plugin of sorted) {
        const name = plugin.kind === "valid" ? plugin.manifest.name : plugin.dirName;
        const tokens = plugin.kind === "valid" ? plugin.estimatedDescriptionTokens : 0;
        const components =
          plugin.kind === "valid" ? formatComponentsCompact(plugin.components.counts) : "broken";
        const tone: CellTone =
          plugin.kind === "broken"
            ? "error"
            : plugin.activation.kind === "shadowed"
              ? "warning"
              : plugin.activation.kind === "disabled"
                ? "muted"
                : tokens > 4000
                  ? "warning"
                  : "default";
        rows.push({
          key: `plugin:${plugin.id}`,
          entity: `${name} (${plugin.scope})`,
          components,
          estTokens: formatNumber(tokens),
          disk: formatBytes(plugin.diskBytes),
          tone,
        });
      }
      return rows;
    }
    case "by-marketplace": {
      return snapshot.stats.byMarketplace.map((mkt) => {
        let tokens = 0;
        let diskBytes = 0;
        for (const plugin of snapshot.installed) {
          if (
            plugin.provenance.kind === "marketplace" &&
            plugin.provenance.marketplaceId === mkt.marketplaceId
          ) {
            diskBytes += plugin.diskBytes;
            if (plugin.kind === "valid") {
              tokens += plugin.estimatedDescriptionTokens;
            }
          }
        }
        const tone: CellTone =
          mkt.syncStatus === "sync-failed"
            ? "error"
            : mkt.syncStatus === "never-synced"
              ? "warning"
              : "success";
        return {
          key: `mkt:${mkt.marketplaceId}`,
          entity: mkt.marketplaceId,
          components: `${formatNumber(mkt.catalogCount)} avail · ${formatNumber(mkt.installedFromCount)} inst`,
          estTokens: tokens > 0 ? formatNumber(tokens) : "-",
          disk: diskBytes > 0 ? formatBytes(diskBytes) : "-",
          tone,
        };
      });
    }
    case "by-scope": {
      const scopes = [snapshot.stats.byScope.user, snapshot.stats.byScope.project] as const;
      return scopes.map((scopeStats) => {
        let tokens = 0;
        for (const plugin of snapshot.installed) {
          if (plugin.scope === scopeStats.scope && plugin.kind === "valid") {
            tokens += plugin.estimatedDescriptionTokens;
          }
        }
        return {
          key: `scope:${scopeStats.scope}`,
          entity: `${scopeStats.scope} (${scopeStats.activeCount}/${scopeStats.installedCount} active)`,
          components: formatComponentsCompact(scopeStats.componentTotals),
          estTokens: formatNumber(tokens),
          disk: formatBytes(scopeStats.diskBytes),
          tone: scopeStats.brokenCount > 0 ? "warning" : "default",
        };
      });
    }
    default: {
      const _exhaustive: never = statsMode;
      return _exhaustive;
    }
  }
}

const discoverTab = defineTab<"discover", CatalogMatch>({
  id: "discover",
  number: 1,
  label: "Discover",
  searchable: true,
  badge: () => null,
  selectRows: (state) =>
    queryCatalog(state.snapshot, {
      text: state.searchByTab.discover.value,
      installFilter: discoverInstallFilterArg(state.discoverFilter),
    }),
  rowKey: (row) => row.entry.id,
  modeBadge: (state, rows) => ({
    text: `Filter [f]: ${discoverModeLabel(state.discoverFilter)} (${formatNumber(rows.length)})`,
    tone: "accent",
  }),
  emptyMessage: (state) => {
    if (state.snapshot.marketplaces.length === 0) {
      return "No marketplaces added yet. Press 'a' to add one (e.g. cursor/plugins).";
    }
    if (state.searchByTab.discover.value.trim().length > 0) {
      return `No catalog plugins matching "${state.searchByTab.discover.value.trim()}".`;
    }
    return "No plugins match the active filter.";
  },
  columns: [
    {
      id: "name",
      header: "Name",
      width: { kind: "flex", min: 16, weight: 3 },
      cell: (row) => ({
        text: row.entry.displayName || row.entry.name,
        tone: row.installStatus.kind === "installed" ? "accent" : "default",
      }),
    },
    {
      id: "marketplace",
      header: "Marketplace",
      width: { kind: "flex", min: 14, weight: 2 },
      cell: (row) => ({ text: row.entry.marketplaceId, tone: "muted" }),
    },
    {
      id: "components",
      header: "Components",
      width: { kind: "fixed", chars: 16 },
      cell: (row) => ({
        text: formatComponentsCompact(row.entry.componentCounts),
        tone: row.entry.componentCounts === null ? "muted" : "default",
      }),
    },
    {
      id: "version",
      header: "Version",
      width: { kind: "fixed", chars: 9 },
      cell: (row) => ({ text: row.entry.version ?? "-", tone: "muted" }),
    },
    {
      id: "status",
      header: "Status",
      width: { kind: "fixed", chars: 13 },
      cell: (row) => {
        if (row.installStatus.kind === "not-installed") {
          return { text: "available", tone: "muted" };
        }
        const scopes = row.installStatus.scopes.join(",");
        const suffix = row.installStatus.hasUpdate ? " ↑" : "";
        return {
          text: `${scopes}${suffix}`,
          tone: row.installStatus.hasUpdate ? "warning" : "success",
        };
      },
    },
  ],
  actions: [
    {
      scope: "row",
      id: "open-discover-detail",
      key: "enter",
      hintKeys: "Enter",
      hintLabel: "open",
      run: (row, state) => ({
        kind: "open-overlay",
        overlay: {
          kind: "discover-detail",
          entryId: row.entry.id,
          targetScope: state.defaultInstallScope,
          focusedButton: "primary",
        },
      }),
    },
    {
      scope: "row",
      id: "quick-install",
      key: { kind: "char", ch: "i" },
      hintKeys: "i",
      hintLabel: "install",
      run: (row, state) => ({
        kind: "mutate",
        mutation: {
          kind: "install",
          input: {
            target: { kind: "catalog-entry", entryId: row.entry.id },
            scope: state.defaultInstallScope,
          },
          label: `Installing ${row.entry.name} (${state.defaultInstallScope})`,
        },
      }),
    },
    {
      scope: "tab",
      id: "cycle-discover-filter",
      key: { kind: "char", ch: "f" },
      hintKeys: "f",
      hintLabel: "filter",
      run: () => ({ kind: "cycle-discover-filter" }),
    },
    {
      scope: "tab",
      id: "add-marketplace-from-discover",
      key: { kind: "char", ch: "a" },
      hintKeys: "a",
      hintLabel: "add mkt",
      run: () => ({
        kind: "open-overlay",
        overlay: {
          kind: "add-marketplace",
          sourceInput: EMPTY_TEXT_INPUT,
          idInput: EMPTY_TEXT_INPUT,
          focusedField: "source",
          preview: { kind: "empty" },
        },
      }),
    },
  ],
});

const installedTab = defineTab<"installed", InstalledPlugin>({
  id: "installed",
  number: 2,
  label: "Installed",
  searchable: true,
  badge: (snapshot) => String(snapshot.installed.length),
  selectRows: (state) =>
    queryInstalled(state.snapshot, {
      text: state.searchByTab.installed.value,
      scope: state.installedScopeFilter === "all" ? undefined : state.installedScopeFilter,
    }),
  rowKey: (row) => row.id,
  modeBadge: (state) => ({
    text: `Scope [f]: ${installedScopeLabel(state.installedScopeFilter)}`,
    tone: "accent",
  }),
  emptyMessage: (state) => {
    if (state.snapshot.installed.length === 0) {
      return "No plugins installed yet. Switch to Discover (1) to install plugins.";
    }
    return "No installed plugins match the current search or scope filter.";
  },
  columns: [
    {
      id: "name",
      header: "Name",
      width: { kind: "flex", min: 15, weight: 3 },
      cell: (row) => ({
        text: row.kind === "valid" ? row.manifest.name : row.dirName,
        tone: row.kind === "broken" ? "error" : "default",
      }),
    },
    {
      id: "scope",
      header: "Scope",
      width: { kind: "fixed", chars: 8 },
      cell: (row) => ({ text: row.scope, tone: "muted" }),
    },
    {
      id: "version",
      header: "Version",
      width: { kind: "fixed", chars: 9 },
      cell: (row) => {
        if (row.kind === "broken") {
          return { text: "-", tone: "muted" };
        }
        const ver = row.manifest.version ?? "-";
        return {
          text: row.updateAvailable !== null ? `${ver} ↑` : ver,
          tone: row.updateAvailable !== null ? "warning" : "muted",
        };
      },
    },
    {
      id: "state",
      header: "State",
      width: { kind: "fixed", chars: 9 },
      cell: (row) => installedStateCell(row),
    },
    {
      id: "components",
      header: "S/A/R/H/M",
      width: { kind: "fixed", chars: 16 },
      cell: (row) => ({
        text: row.kind === "valid" ? formatComponentsCompact(row.components.counts) : "-",
        tone: row.kind === "valid" ? "default" : "muted",
      }),
    },
    {
      id: "source",
      header: "Source",
      width: { kind: "flex", min: 12, weight: 2 },
      cell: (row) => ({ text: installedSourceLabel(row), tone: "muted" }),
    },
  ],
  actions: [
    {
      scope: "row",
      id: "inspect-installed",
      key: "enter",
      hintKeys: "Enter",
      hintLabel: "inspect",
      run: (row) => ({
        kind: "open-overlay",
        overlay: {
          kind: "installed-detail",
          pluginId: row.id,
          focusedAction: row.kind === "valid" ? "toggle" : "uninstall",
        },
      }),
    },
    {
      scope: "row",
      id: "toggle-installed",
      key: "space",
      hintKeys: "Space",
      hintLabel: "enable/disable",
      when: (row) => row.kind === "valid",
      run: (row) => {
        if (row.kind !== "valid") {
          return null;
        }
        const enable = row.activation.kind === "disabled";
        return {
          kind: "mutate",
          mutation: {
            kind: "set-enabled",
            input: { selector: { kind: "id", id: row.id }, enabled: enable },
            label: `${enable ? "Enabling" : "Disabling"} ${row.manifest.name}`,
          },
        };
      },
    },
    {
      scope: "row",
      id: "update-installed",
      key: { kind: "char", ch: "u" },
      hintKeys: "u",
      hintLabel: "update",
      when: (row) => row.provenance.kind !== "unmanaged",
      run: (row) => ({
        kind: "mutate",
        mutation: {
          kind: "update",
          input: { kind: "single", selector: { kind: "id", id: row.id } },
          label: `Updating ${row.id}`,
        },
      }),
    },
    {
      scope: "tab",
      id: "update-all-installed",
      key: { kind: "char", ch: "U" },
      hintKeys: "U",
      hintLabel: "update all",
      when: (state) => state.snapshot.installed.length > 0,
      run: (state) => ({
        kind: "mutate",
        mutation: {
          kind: "update",
          input:
            state.installedScopeFilter === "all"
              ? { kind: "all" }
              : { kind: "all", scope: state.installedScopeFilter },
          label: "Updating managed plugins",
        },
      }),
    },
    {
      scope: "row",
      id: "uninstall-installed",
      key: { kind: "char", ch: "x" },
      hintKeys: "x",
      hintLabel: "uninstall",
      run: (row) => {
        const name = row.kind === "valid" ? row.manifest.name : row.dirName;
        return {
          kind: "open-overlay",
          overlay: {
            kind: "confirm",
            title: "Uninstall plugin",
            message: `Remove "${name}" (${row.id}) from ${row.installPath}?`,
            confirmLabel: "Uninstall",
            mutation: {
              kind: "uninstall",
              input: { selector: { kind: "id", id: row.id } },
              label: `Uninstalling ${row.id}`,
            },
            returnOverlay: { kind: "none" },
            focusedChoice: "cancel",
          },
        };
      },
    },
    {
      scope: "tab",
      id: "cycle-installed-scope",
      key: { kind: "char", ch: "f" },
      hintKeys: "f",
      hintLabel: "scope",
      run: () => ({ kind: "cycle-installed-scope" }),
    },
  ],
});

const marketplacesTab = defineTab<"marketplaces", MarketplaceRecord>({
  id: "marketplaces",
  number: 3,
  label: "Marketplaces",
  searchable: true,
  badge: (snapshot) => String(snapshot.marketplaces.length),
  selectRows: (state) =>
    queryMarketplaces(state.snapshot, state.searchByTab.marketplaces.value),
  rowKey: (row) => row.id,
  modeBadge: (state) => ({
    text: `${formatNumber(state.snapshot.marketplaces.length)} configured`,
    tone: "muted",
  }),
  emptyMessage: (state) =>
    state.searchByTab.marketplaces.value.trim().length > 0
      ? `No marketplaces matching "${state.searchByTab.marketplaces.value.trim()}".`
      : "No marketplaces registered. Press 'a' to add GitHub, SSH, HTTPS, or local sources.",
  columns: [
    {
      id: "name",
      header: "Name",
      width: { kind: "flex", min: 14, weight: 2 },
      cell: (row) => ({ text: row.id, tone: "accent" }),
    },
    {
      id: "kind",
      header: "Kind",
      width: { kind: "fixed", chars: 12 },
      cell: (row) => ({ text: row.source.kind, tone: "muted" }),
    },
    {
      id: "source",
      header: "Source",
      width: { kind: "flex", min: 18, weight: 4 },
      cell: (row) => ({ text: formatMarketplaceSource(row.source), tone: "default" }),
    },
    {
      id: "plugins",
      header: "Plugins",
      width: { kind: "fixed", chars: 8 },
      align: "right",
      cell: (row) => ({
        text: row.sync.kind === "synced" ? formatNumber(row.sync.pluginCount) : "-",
        tone: "default",
      }),
    },
    {
      id: "synced",
      header: "Synced",
      width: { kind: "fixed", chars: 11 },
      cell: (row) => {
        if (row.sync.kind === "synced") {
          return { text: formatShortTimestamp(row.sync.syncedAt), tone: "muted" };
        }
        if (row.sync.kind === "sync-failed" && row.sync.lastGoodSyncAt !== null) {
          return { text: formatShortTimestamp(row.sync.lastGoodSyncAt), tone: "muted" };
        }
        return { text: "never", tone: "muted" };
      },
    },
    {
      id: "status",
      header: "Status",
      width: { kind: "fixed", chars: 8 },
      cell: (row) => marketplaceSyncStatusCell(row),
    },
  ],
  actions: [
    {
      scope: "tab",
      id: "add-marketplace",
      key: { kind: "char", ch: "a" },
      hintKeys: "a",
      hintLabel: "add",
      run: () => ({
        kind: "open-overlay",
        overlay: {
          kind: "add-marketplace",
          sourceInput: EMPTY_TEXT_INPUT,
          idInput: EMPTY_TEXT_INPUT,
          focusedField: "source",
          preview: { kind: "empty" },
        },
      }),
    },
    {
      scope: "row",
      id: "open-marketplace-detail",
      key: "enter",
      hintKeys: "Enter",
      hintLabel: "details",
      run: (row) => ({
        kind: "open-overlay",
        overlay: {
          kind: "marketplace-detail",
          marketplaceId: row.id,
          focusedAction: "update",
        },
      }),
    },
    {
      scope: "row",
      id: "update-marketplace",
      key: { kind: "char", ch: "u" },
      hintKeys: "u",
      hintLabel: "update",
      run: (row) => ({
        kind: "mutate",
        mutation: {
          kind: "sync-marketplaces",
          input: { kind: "single", id: row.id },
          label: `Syncing marketplace ${row.id}`,
        },
      }),
    },
    {
      scope: "tab",
      id: "update-all-marketplaces",
      key: { kind: "char", ch: "U" },
      hintKeys: "U",
      hintLabel: "update all",
      when: (state) => state.snapshot.marketplaces.length > 0,
      run: () => ({
        kind: "mutate",
        mutation: {
          kind: "sync-marketplaces",
          input: { kind: "all" },
          label: "Syncing all marketplaces",
        },
      }),
    },
    {
      scope: "row",
      id: "remove-marketplace",
      key: { kind: "char", ch: "d" },
      hintKeys: "d",
      hintLabel: "remove",
      run: (row) => ({
        kind: "open-overlay",
        overlay: {
          kind: "confirm",
          title: "Remove marketplace",
          message: `Remove marketplace "${row.id}" and its local mirror? Installed plugins remain untouched.`,
          confirmLabel: "Remove",
          mutation: {
            kind: "remove-marketplace",
            input: { id: row.id },
            label: `Removing marketplace ${row.id}`,
          },
          returnOverlay: { kind: "none" },
          focusedChoice: "cancel",
        },
      }),
    },
  ],
});

const errorsTab = defineTab<"errors", Diagnostic>({
  id: "errors",
  number: 4,
  label: "Errors",
  searchable: true,
  badge: (snapshot) =>
    snapshot.diagnostics.length > 0 ? String(snapshot.diagnostics.length) : null,
  selectRows: (state) =>
    queryDiagnostics(state.snapshot, {
      text: state.searchByTab.errors.value,
      severity: state.errorSeverityFilter === "all" ? undefined : state.errorSeverityFilter,
    }),
  rowKey: (row) => row.id,
  modeBadge: (state) => ({
    text: `Level [m]: ${errorSeverityLabel(state.errorSeverityFilter)}`,
    tone: "accent",
  }),
  emptyMessage: (state) =>
    state.snapshot.diagnostics.length === 0
      ? "No plugin errors or warnings detected."
      : "No diagnostics match the active filter.",
  columns: [
    {
      id: "level",
      header: "Level",
      width: { kind: "fixed", chars: 7 },
      cell: (row) =>
        row.severity === "error"
          ? { text: "ERROR", tone: "error" }
          : { text: "WARN", tone: "warning" },
    },
    {
      id: "code",
      header: "Code",
      width: { kind: "fixed", chars: 24 },
      cell: (row) => ({ text: row.detail.kind, tone: "accent" }),
    },
    {
      id: "target",
      header: "Target",
      width: { kind: "flex", min: 16, weight: 2 },
      cell: (row) => ({ text: formatDiagnosticSubject(row.subject), tone: "muted" }),
    },
    {
      id: "summary",
      header: "Summary",
      width: { kind: "flex", min: 22, weight: 4 },
      cell: (row) => ({
        text:
          row.remediation !== undefined
            ? `${row.message} [f: ${row.remediation.label}]`
            : row.message,
        tone: "default",
      }),
    },
  ],
  actions: [
    {
      scope: "row",
      id: "open-diagnostic-detail",
      key: "enter",
      hintKeys: "Enter",
      hintLabel: "details",
      run: (row) => ({
        kind: "open-overlay",
        overlay: {
          kind: "diagnostic-detail",
          diagnosticId: row.id,
          focusedAction: row.remediation !== undefined ? "fix" : "close",
        },
      }),
    },
    {
      scope: "row",
      id: "fix-diagnostic",
      key: { kind: "char", ch: "f" },
      hintKeys: "f",
      hintLabel: "fix",
      when: (row) => row.remediation !== undefined,
      run: (row) => {
        if (row.remediation === undefined) {
          return null;
        }
        return {
          kind: "mutate",
          mutation: {
            kind: "remediate",
            input: { plan: row.remediation },
            label: row.remediation.label,
          },
        };
      },
    },
    {
      scope: "tab",
      id: "cycle-error-severity",
      key: { kind: "char", ch: "m" },
      hintKeys: "m",
      hintLabel: "level",
      run: () => ({ kind: "cycle-error-severity" }),
    },
    {
      scope: "tab",
      id: "recheck-diagnostics",
      key: { kind: "char", ch: "r" },
      hintKeys: "r",
      hintLabel: "re-check",
      run: () => ({ kind: "rescan" }),
    },
  ],
});

const statsTab = defineTab<"stats", StatsRow>({
  id: "stats",
  number: 5,
  label: "Stats",
  searchable: false,
  badge: () => null,
  selectRows: (state) => buildStatsRows(state),
  rowKey: (row) => row.key,
  modeBadge: (state) => ({
    text: `View [m]: ${statsModeLabel(state.statsMode)}`,
    tone: "accent",
  }),
  summaryCards: (state): readonly SummaryCard[] => {
    const { stats, marketplaces } = state.snapshot;
    const c = stats.activeComponents;
    const totalComponents = c.skills + c.agents + c.rules + c.hooks + c.mcpServers;
    return [
      {
        label: "Discoverable",
        value: formatNumber(stats.discoverableCount),
        subtext: `${formatNumber(marketplaces.length)} mkts`,
        tone: "accent",
      },
      {
        label: "Installed",
        value: `${formatNumber(stats.activeCount)}/${formatNumber(stats.installedCount)}`,
        subtext: "active/total",
        tone: stats.brokenCount > 0 || stats.shadowedCount > 0 ? "warning" : "success",
      },
      {
        label: "Components",
        value: formatNumber(totalComponents),
        subtext: `${c.skills}S ${c.agents}A ${c.rules}R ${c.hooks}H ${c.mcpServers}M`,
        tone: "default",
      },
      {
        label: "Desc Tokens",
        value: `~${formatNumber(stats.estimatedDescriptionTokens)}`,
        subtext: "session load",
        tone: stats.estimatedDescriptionTokens > 15000 ? "warning" : "accent",
      },
      {
        label: "Disk",
        value: formatBytes(stats.totalDiskBytes),
        subtext: `${stats.errorCount} err ${stats.warningCount} warn`,
        tone: stats.errorCount > 0 ? "error" : "default",
      },
    ];
  },
  emptyMessage: (state) =>
    state.statsMode === "by-marketplace"
      ? "No marketplaces configured yet."
      : "No installed plugins yet.",
  columns: [
    {
      id: "entity",
      header: "Entity",
      width: { kind: "flex", min: 20, weight: 3 },
      cell: (row) => ({ text: row.entity, tone: row.tone }),
    },
    {
      id: "components",
      header: "Components / Items",
      width: { kind: "flex", min: 18, weight: 3 },
      cell: (row) => ({ text: row.components, tone: "default" }),
    },
    {
      id: "tokens",
      header: "Est. Tokens",
      width: { kind: "fixed", chars: 12 },
      align: "right",
      cell: (row) => ({ text: row.estTokens, tone: "warning" }),
    },
    {
      id: "disk",
      header: "Disk",
      width: { kind: "fixed", chars: 10 },
      align: "right",
      cell: (row) => ({ text: row.disk, tone: "muted" }),
    },
  ],
  actions: [
    {
      scope: "tab",
      id: "cycle-stats-mode",
      key: { kind: "char", ch: "m" },
      hintKeys: "m",
      hintLabel: "breakdown",
      run: () => ({ kind: "cycle-stats-mode" }),
    },
    {
      scope: "tab",
      id: "refresh-stats",
      key: { kind: "char", ch: "r" },
      hintKeys: "r",
      hintLabel: "refresh",
      run: () => ({ kind: "rescan" }),
    },
  ],
});

export const TAB_REGISTRY = {
  discover: discoverTab,
  installed: installedTab,
  marketplaces: marketplacesTab,
  errors: errorsTab,
  stats: statsTab,
} as const satisfies { readonly [K in TabId]: TabDescriptor<K> };
