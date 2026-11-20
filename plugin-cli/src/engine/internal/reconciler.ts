import fs from "node:fs/promises";
import {
  EMPTY_COMPONENT_COUNTS,
  compareStrings,
  isAtLeastTwo,
  isNonEmpty,
  isPluginDirName,
  joinAbsolutePath,
  makeDiagnosticId,
  makeInstalledPluginId,
  makeIsoTimestamp,
} from "../../domain/types.ts";
import type {
  AbsolutePath,
  BrokenInstalledPlugin,
  CatalogEntry,
  CatalogEntryId,
  ComponentCounts,
  Diagnostic,
  DiagnosticId,
  InstallProvenance,
  InstallScope,
  InstalledPlugin,
  InstalledPluginId,
  MarketplaceId,
  MarketplaceRecord,
  MarketplaceStats,
  PluginActivation,
  PluginDirName,
  PluginFootprint,
  PluginName,
  ScopeStats,
  SnapshotRevision,
  ValidInstalledPlugin,
  VersionUpdate,
  WorkspacePaths,
  WorkspaceSnapshot,
  WorkspaceStats,
} from "../../domain/types.ts";
import { inspectPluginDirectory } from "./inspector.ts";
import type { PluginInspectionResult } from "./inspector.ts";
import {
  BACKUP_PREFIX,
  LOCK_PREFIX,
  STAGING_PREFIX,
  listStaleStagingPaths,
  loadAllReceipts,
  loadAllSyncCaches,
  loadKnownMarketplaces,
  scopeRootFor,
} from "./stores.ts";

interface ScannedValidCandidate {
  readonly id: InstalledPluginId;
  readonly scope: InstallScope;
  readonly dirName: PluginDirName;
  readonly installPath: AbsolutePath;
  readonly inspection: PluginInspectionResult & { readonly manifest: NonNullable<PluginInspectionResult["manifest"]> };
  readonly provenance: InstallProvenance;
  readonly diagnosticIds: DiagnosticId[];
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function isNewerVersion(candidate: string, current: string): boolean {
  if (candidate === current) {
    return false;
  }
  const candMatch = SEMVER_RE.exec(candidate.trim());
  const currMatch = SEMVER_RE.exec(current.trim());
  if (candMatch !== null && currMatch !== null) {
    const cMajor = Number(candMatch[1]);
    const cMinor = Number(candMatch[2]);
    const cPatch = Number(candMatch[3]);
    const kMajor = Number(currMatch[1]);
    const kMinor = Number(currMatch[2]);
    const kPatch = Number(currMatch[3]);
    if (cMajor !== kMajor) return cMajor > kMajor;
    if (cMinor !== kMinor) return cMinor > kMinor;
    if (cPatch !== kPatch) return cPatch > kPatch;
    const cPre = candMatch[4];
    const kPre = currMatch[4];
    if (cPre === undefined && kPre !== undefined) return true;
    if (cPre !== undefined && kPre === undefined) return false;
    if (cPre !== undefined && kPre !== undefined) {
      return cPre !== kPre && cPre > kPre;
    }
    return false;
  }
  return candidate.trim() !== current.trim();
}

function addComponentCounts(a: ComponentCounts, b: ComponentCounts): ComponentCounts {
  return {
    skills: a.skills + b.skills,
    agents: a.agents + b.agents,
    rules: a.rules + b.rules,
    hooks: a.hooks + b.hooks,
    mcpServers: a.mcpServers + b.mcpServers,
  };
}

function computeUpdateAvailable(
  candidate: ScannedValidCandidate,
  catalogById: ReadonlyMap<CatalogEntryId, CatalogEntry>,
  marketplacesById: ReadonlyMap<MarketplaceId, MarketplaceRecord>,
): VersionUpdate | null {
  if (candidate.provenance.kind !== "marketplace") {
    return null;
  }
  const entry = catalogById.get(candidate.provenance.entryId);
  if (entry === undefined) {
    return null;
  }
  const currentVersion =
    candidate.inspection.manifest.version ?? candidate.provenance.installedVersion;

  if (entry.version !== null) {
    if (currentVersion === null || isNewerVersion(entry.version, currentVersion)) {
      return {
        latestVersion: entry.version,
        sourceEntryId: entry.id,
      };
    }
    return null;
  }

  const mkt = marketplacesById.get(candidate.provenance.marketplaceId);
  if (
    mkt !== undefined &&
    mkt.sync.kind === "synced" &&
    mkt.sync.resolvedSha !== null &&
    candidate.provenance.installedSha !== null &&
    mkt.sync.resolvedSha !== candidate.provenance.installedSha
  ) {
    return {
      latestVersion: mkt.sync.resolvedSha.slice(0, 7),
      sourceEntryId: entry.id,
    };
  }
  return null;
}

export async function projectWorkspaceSnapshot(
  paths: WorkspacePaths,
  revision: SnapshotRevision,
): Promise<WorkspaceSnapshot> {
  const projectedAt = makeIsoTimestamp();
  const [knownMarketplaces, syncCaches, receipts] = await Promise.all([
    loadKnownMarketplaces(paths),
    loadAllSyncCaches(paths),
    loadAllReceipts(paths),
  ]);

  const marketplaces: MarketplaceRecord[] = [];
  const marketplacesById = new Map<MarketplaceId, MarketplaceRecord>();
  const catalog: CatalogEntry[] = [];
  const catalogById = new Map<CatalogEntryId, CatalogEntry>();
  const diagnostics: Diagnostic[] = [];
  const seenDiagnosticIds = new Set<DiagnosticId>();

  const pushDiagnostic = (diag: Diagnostic): void => {
    if (!seenDiagnosticIds.has(diag.id)) {
      seenDiagnosticIds.add(diag.id);
      diagnostics.push(diag);
    }
  };

  for (const known of knownMarketplaces) {
    const cache = syncCaches.get(known.id) ?? null;
    const record: MarketplaceRecord = {
      id: known.id,
      source: known.source,
      addedAt: known.addedAt,
      sync: cache?.sync ?? { kind: "never-synced" },
      localMirrorPath: cache?.localMirrorPath ?? null,
    };
    marketplaces.push(record);
    marketplacesById.set(record.id, record);

    if (cache !== null) {
      for (const entry of cache.entries) {
        if (!catalogById.has(entry.id)) {
          catalog.push(entry);
          catalogById.set(entry.id, entry);
        }
      }
      for (const diag of cache.diagnostics) {
        pushDiagnostic(diag);
      }
    }

    if (record.sync.kind === "sync-failed") {
      const failId = makeDiagnosticId("marketplace-sync-failed", record.id);
      if (!seenDiagnosticIds.has(failId)) {
        pushDiagnostic({
          id: failId,
          severity: "error",
          subject: { kind: "marketplace", marketplaceId: record.id },
          detail: {
            kind: "marketplace-sync-failed",
            marketplaceId: record.id,
            reason: record.sync.reason,
          },
          message: `Marketplace "${record.id}" sync failed: ${record.sync.reason}`,
          hint: "Check remote availability and retry marketplace sync.",
          remediation: {
            kind: "retry-marketplace-sync",
            marketplaceId: record.id,
            label: `Retry sync for ${record.id}`,
          },
        });
      }
    }
  }

  const staleStagingPaths: AbsolutePath[] = [];
  const validCandidates: ScannedValidCandidate[] = [];
  const brokenPlugins: BrokenInstalledPlugin[] = [];
  const seenInstalledIds = new Set<InstalledPluginId>();

  const scopes: readonly InstallScope[] = ["project", "user"];
  for (const scope of scopes) {
    const scopeRoot = scopeRootFor(paths, scope);

    const staleArtifacts = await listStaleStagingPaths(scopeRoot, scope);
    for (const artifact of staleArtifacts) {
      staleStagingPaths.push(artifact.path);
      pushDiagnostic({
        id: makeDiagnosticId("stale-staging-artifact", scope, artifact.name),
        severity: "warning",
        subject: { kind: "path", path: artifact.path },
        detail: {
          kind: "stale-staging-artifact",
          artifactPath: artifact.path,
          scope,
          artifactKind: artifact.artifactKind,
        },
        message: `Stale ${artifact.artifactKind} artifact "${artifact.name}" left in ${scope} plugins directory.`,
        hint: "Run remediation to recover any missing backup and remove stale staging artifacts.",
        remediation: {
          kind: "clean-stale-staging",
          path: artifact.path,
          label: `Clean stale ${artifact.artifactKind} artifact`,
        },
      });
    }

    let entries;
    try {
      entries = await fs.readdir(scopeRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => compareStrings(a.name, b.name));

    for (const entry of entries) {
      if (
        entry.name.startsWith(STAGING_PREFIX) ||
        entry.name.startsWith(BACKUP_PREFIX) ||
        entry.name.startsWith(LOCK_PREFIX) ||
        entry.name.startsWith(".")
      ) {
        continue;
      }
      if (!isPluginDirName(entry.name)) {
        continue;
      }

      const installPath = joinAbsolutePath(scopeRoot, entry.name);
      const isDir = entry.isDirectory()
        ? true
        : entry.isSymbolicLink()
          ? await fs
              .stat(installPath)
              .then((s) => s.isDirectory())
              .catch(() => false)
          : false;
      if (!isDir) {
        continue;
      }

      const pluginId = makeInstalledPluginId(scope, entry.name);
      seenInstalledIds.add(pluginId);

      const receipt = receipts.get(pluginId);
      const provenance: InstallProvenance =
        receipt !== undefined ? receipt.provenance : { kind: "unmanaged" };

      const inspection = await inspectPluginDirectory({
        pluginRoot: installPath,
        subject: { kind: "installed", pluginId },
        pluginIdForRemediation: pluginId,
      });

      const pluginDiagIds: DiagnosticId[] = [];
      for (const diag of inspection.diagnostics) {
        pushDiagnostic(diag);
        pluginDiagIds.push(diag.id);
      }

      if (inspection.valid && inspection.manifest !== null) {
        validCandidates.push({
          id: pluginId,
          scope,
          dirName: entry.name,
          installPath,
          inspection: {
            ...inspection,
            manifest: inspection.manifest,
          },
          provenance,
          diagnosticIds: pluginDiagIds,
        });
      } else {
        if (!isNonEmpty(pluginDiagIds)) {
          const fallbackDiag: Diagnostic = {
            id: makeDiagnosticId("manifest-schema-invalid", pluginId, "broken"),
            severity: "error",
            subject: { kind: "installed", pluginId },
            detail: {
              kind: "manifest-schema-invalid",
              filePath: installPath,
              fieldErrors: ["Plugin directory failed validation."],
            },
            message: `Plugin "${pluginId}" is broken and cannot be loaded.`,
            hint: "Inspect or remove the broken plugin directory.",
            remediation: {
              kind: "remove-plugin",
              pluginId,
              label: `Remove broken plugin ${pluginId}`,
            },
          };
          pushDiagnostic(fallbackDiag);
          pluginDiagIds.push(fallbackDiag.id);
        }
        if (isNonEmpty(pluginDiagIds)) {
          brokenPlugins.push({
            kind: "broken",
            id: pluginId,
            scope,
            dirName: entry.name,
            installPath,
            provenance,
            diskBytes: inspection.diskBytes,
            diagnosticIds: pluginDiagIds,
          });
        }
      }
    }
  }

  for (const [pluginId, receipt] of receipts.entries()) {
    if (!seenInstalledIds.has(pluginId)) {
      const expectedPath = joinAbsolutePath(scopeRootFor(paths, receipt.scope), receipt.dirName);
      pushDiagnostic({
        id: makeDiagnosticId("orphaned-receipt", pluginId),
        severity: "warning",
        subject: { kind: "installed", pluginId },
        detail: {
          kind: "orphaned-receipt",
          pluginId,
          expectedPath,
        },
        message: `Receipt for "${pluginId}" points to missing directory "${expectedPath}".`,
        hint: "Uninstall or remediate to clean up the orphaned receipt.",
        remediation: {
          kind: "remove-plugin",
          pluginId,
          label: `Clean orphaned receipt for ${pluginId}`,
        },
      });
    }
  }

  const enabledByName = new Map<PluginName, ScannedValidCandidate[]>();
  for (const candidate of validCandidates) {
    if (candidate.inspection.manifest.disabled === true) {
      continue;
    }
    const group = enabledByName.get(candidate.inspection.manifest.name) ?? [];
    group.push(candidate);
    enabledByName.set(candidate.inspection.manifest.name, group);
  }

  const activationById = new Map<InstalledPluginId, PluginActivation>();
  for (const candidate of validCandidates) {
    if (candidate.inspection.manifest.disabled === true) {
      activationById.set(candidate.id, { kind: "disabled" });
    }
  }

  for (const [pluginName, group] of enabledByName.entries()) {
    group.sort((a, b) => {
      if (a.scope !== b.scope) {
        return a.scope === "project" ? -1 : 1;
      }
      return compareStrings(a.dirName, b.dirName);
    });

    const winner = group[0];
    if (winner === undefined) {
      continue;
    }
    activationById.set(winner.id, { kind: "active" });

    if (group.length >= 2) {
      const participantIds = group.map((item) => item.id);
      if (isAtLeastTwo(participantIds)) {
        for (let i = 1; i < group.length; i += 1) {
          const loser = group[i];
          if (loser === undefined) {
            continue;
          }
          activationById.set(loser.id, { kind: "shadowed", shadowedBy: winner.id });
          const diag: Diagnostic = {
            id: makeDiagnosticId("name-collision", pluginName, loser.id),
            severity: "error",
            subject: { kind: "installed", pluginId: loser.id },
            detail: {
              kind: "name-collision",
              collidingName: pluginName,
              winnerId: winner.id,
              participants: participantIds,
            },
            message: `Plugin name "${pluginName}" collides across ${participantIds.join(", ")}; "${winner.id}" wins and "${loser.id}" is shadowed.`,
            hint: `Disable "${loser.id}" to resolve the global plugin name collision.`,
            remediation: {
              kind: "disable-plugin",
              pluginId: loser.id,
              label: `Disable shadowed plugin ${loser.id}`,
            },
          };
          pushDiagnostic(diag);
          loser.diagnosticIds.push(diag.id);
        }
      }
    }
  }

  const installed: InstalledPlugin[] = [];
  for (const candidate of validCandidates) {
    const activation = activationById.get(candidate.id) ?? { kind: "active" };
    const updateAvailable = computeUpdateAvailable(candidate, catalogById, marketplacesById);
    const plugin: ValidInstalledPlugin = {
      kind: "valid",
      id: candidate.id,
      scope: candidate.scope,
      dirName: candidate.dirName,
      installPath: candidate.installPath,
      manifest: candidate.inspection.manifest,
      activation,
      provenance: candidate.provenance,
      components: candidate.inspection.components,
      diskBytes: candidate.inspection.diskBytes,
      estimatedDescriptionTokens: candidate.inspection.estimatedDescriptionTokens,
      updateAvailable,
      diagnosticIds: candidate.diagnosticIds,
    };
    installed.push(plugin);
  }
  for (const broken of brokenPlugins) {
    installed.push(broken);
  }

  installed.sort((a, b) => compareStrings(a.id, b.id));
  marketplaces.sort((a, b) => compareStrings(a.id, b.id));
  staleStagingPaths.sort(compareStrings);
  diagnostics.sort((a, b) => {
    if (a.severity !== b.severity) {
      return a.severity === "error" ? -1 : 1;
    }
    return compareStrings(a.id, b.id);
  });

  const installedById = new Map<InstalledPluginId, InstalledPlugin>();
  const installedIdsByPluginNameMutable = new Map<PluginName, InstalledPluginId[]>();
  const diagnosticsById = new Map<DiagnosticId, Diagnostic>();

  for (const diag of diagnostics) {
    diagnosticsById.set(diag.id, diag);
  }

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
    installedById.set(plugin.id, plugin);
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

    const nameList = installedIdsByPluginNameMutable.get(plugin.manifest.name) ?? [];
    nameList.push(plugin.id);
    installedIdsByPluginNameMutable.set(plugin.manifest.name, nameList);

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

  for (const list of installedIdsByPluginNameMutable.values()) {
    list.sort((a, b) => {
      const aProj = a.startsWith("project:");
      const bProj = b.startsWith("project:");
      if (aProj !== bProj) {
        return aProj ? -1 : 1;
      }
      return compareStrings(a, b);
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

  const stats: WorkspaceStats = {
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

  return {
    revision,
    projectedAt,
    paths,
    catalog,
    installed,
    marketplaces,
    diagnostics,
    staleStagingPaths,
    stats,
    catalogById,
    installedById,
    marketplacesById,
    diagnosticsById,
    installedIdsByPluginName: installedIdsByPluginNameMutable,
  };
}
