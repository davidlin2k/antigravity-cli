import { EMPTY_COMPONENT_COUNTS, compareStrings } from "../../domain/types.ts";
import type {
  CatalogEntry,
  ComponentCounts,
  Diagnostic,
  InstallScope,
  InstalledPlugin,
  MarketplaceId,
  MarketplaceRecord,
  MarketplaceStats,
  PluginFootprint,
  ScopeStats,
  WorkspacePaths,
  WorkspaceStats,
} from "../../domain/types.ts";

function addComponentCounts(a: ComponentCounts, b: ComponentCounts): ComponentCounts {
  return {
    skills: a.skills + b.skills,
    agents: a.agents + b.agents,
    rules: a.rules + b.rules,
    hooks: a.hooks + b.hooks,
    mcpServers: a.mcpServers + b.mcpServers,
  };
}

export function computeWorkspaceStats(input: {
  readonly paths: WorkspacePaths;
  readonly catalog: readonly CatalogEntry[];
  readonly installed: readonly InstalledPlugin[];
  readonly marketplaces: readonly MarketplaceRecord[];
  readonly diagnostics: readonly Diagnostic[];
}): WorkspaceStats {
  const { paths, catalog, installed, marketplaces, diagnostics } = input;

  let activeCount = 0;
  let disabledCount = 0;
  let shadowedCount = 0;
  let brokenCount = 0;
  let activeComponents: ComponentCounts = EMPTY_COMPONENT_COUNTS;
  let installedComponents: ComponentCounts = EMPTY_COMPONENT_COUNTS;
  let estimatedDescriptionTokens = 0;
  let totalDiskBytes = 0;

  const scopeAccum: Record<
    InstallScope,
    {
      installedCount: number;
      activeCount: number;
      disabledCount: number;
      brokenCount: number;
      diskBytes: number;
      componentTotals: ComponentCounts;
    }
  > = {
    user: {
      installedCount: 0,
      activeCount: 0,
      disabledCount: 0,
      brokenCount: 0,
      diskBytes: 0,
      componentTotals: EMPTY_COMPONENT_COUNTS,
    },
    project: {
      installedCount: 0,
      activeCount: 0,
      disabledCount: 0,
      brokenCount: 0,
      diskBytes: 0,
      componentTotals: EMPTY_COMPONENT_COUNTS,
    },
  };

  const installedFromMarketplace = new Map<MarketplaceId, number>();
  const footprints: PluginFootprint[] = [];

  for (const plugin of installed) {
    totalDiskBytes += plugin.diskBytes;
    const scopeBucket = scopeAccum[plugin.scope];
    scopeBucket.installedCount += 1;
    scopeBucket.diskBytes += plugin.diskBytes;

    if (plugin.provenance.kind === "marketplace") {
      installedFromMarketplace.set(
        plugin.provenance.marketplaceId,
        (installedFromMarketplace.get(plugin.provenance.marketplaceId) ?? 0) + 1,
      );
    }

    if (plugin.kind === "broken") {
      brokenCount += 1;
      scopeBucket.brokenCount += 1;
      continue;
    }

    installedComponents = addComponentCounts(installedComponents, plugin.components.counts);
    scopeBucket.componentTotals = addComponentCounts(
      scopeBucket.componentTotals,
      plugin.components.counts,
    );

    switch (plugin.activation.kind) {
      case "active":
        activeCount += 1;
        scopeBucket.activeCount += 1;
        activeComponents = addComponentCounts(activeComponents, plugin.components.counts);
        estimatedDescriptionTokens += plugin.estimatedDescriptionTokens;
        break;
      case "disabled":
        disabledCount += 1;
        scopeBucket.disabledCount += 1;
        break;
      case "shadowed":
        shadowedCount += 1;
        break;
      default: {
        const _exhaustive: never = plugin.activation;
        return _exhaustive;
      }
    }

    footprints.push({
      pluginId: plugin.id,
      pluginName: plugin.manifest.name,
      scope: plugin.scope,
      estimatedDescriptionTokens: plugin.estimatedDescriptionTokens,
      diskBytes: plugin.diskBytes,
      skillCount: plugin.components.counts.skills,
    });
  }

  footprints.sort((a, b) => {
    if (b.estimatedDescriptionTokens !== a.estimatedDescriptionTokens) {
      return b.estimatedDescriptionTokens - a.estimatedDescriptionTokens;
    }
    if (b.diskBytes !== a.diskBytes) {
      return b.diskBytes - a.diskBytes;
    }
    return compareStrings(a.pluginId, b.pluginId);
  });

  const catalogCountByMarketplace = new Map<MarketplaceId, number>();
  for (const entry of catalog) {
    catalogCountByMarketplace.set(
      entry.marketplaceId,
      (catalogCountByMarketplace.get(entry.marketplaceId) ?? 0) + 1,
    );
  }

  const byMarketplace: MarketplaceStats[] = marketplaces.map((record) => ({
    marketplaceId: record.id,
    catalogCount: catalogCountByMarketplace.get(record.id) ?? 0,
    installedFromCount: installedFromMarketplace.get(record.id) ?? 0,
    syncStatus: record.sync.kind,
  }));

  const byScope: Readonly<Record<InstallScope, ScopeStats>> = {
    user: {
      scope: "user",
      pluginsRoot: paths.userPluginsDir,
      ...scopeAccum.user,
    },
    project: {
      scope: "project",
      pluginsRoot: paths.projectPluginsDir,
      ...scopeAccum.project,
    },
  };

  let errorCount = 0;
  let warningCount = 0;
  for (const diag of diagnostics) {
    if (diag.severity === "error") {
      errorCount += 1;
    } else {
      warningCount += 1;
    }
  }

  return {
    discoverableCount: catalog.length,
    installedCount: installed.length,
    activeCount,
    disabledCount,
    shadowedCount,
    brokenCount,
    errorCount,
    warningCount,
    activeComponents,
    installedComponents,
    estimatedDescriptionTokens,
    totalDiskBytes,
    byScope,
    byMarketplace,
    topTokenConsumers: footprints,
  };
}
