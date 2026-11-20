import { formatBytes, formatComponentsCompact } from "../domain/query.ts";
import type { StatsBreakdownMode, TuiState } from "./state.ts";
import { defineTab } from "./tab-registry.ts";
import type { CellTone, SummaryCard } from "./tab-registry.ts";

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
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

export interface StatsRow {
  readonly key: string;
  readonly entity: string;
  readonly components: string;
  readonly estTokens: string;
  readonly disk: string;
  readonly tone: CellTone;
}

export function buildStatsRows(state: TuiState): readonly StatsRow[] {
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

export const statsTab = defineTab<"stats", StatsRow>({
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
