import fs from "node:fs/promises";
import {
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
  Diagnostic,
  DiagnosticId,
  InstallProvenance,
  InstallScope,
  InstalledPlugin,
  InstalledPluginId,
  MarketplaceId,
  MarketplaceRecord,
  PluginActivation,
  PluginDirName,
  PluginName,
  SnapshotRevision,
  ValidInstalledPlugin,
  VersionUpdate,
  WorkspacePaths,
  WorkspaceSnapshot,
} from "../../domain/types.ts";
import {
  BACKUP_PREFIX,
  LOCK_PREFIX,
  STAGING_PREFIX,
  listStaleStagingPaths,
} from "./fs-safety.ts";
import { inspectPluginDirectory } from "./inspector.ts";
import type { PluginInspectionResult } from "./inspector.ts";
import { computeWorkspaceStats } from "./stats.ts";
import {
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
  readonly inspection: PluginInspectionResult & {
    readonly manifest: NonNullable<PluginInspectionResult["manifest"]>;
  };
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

function resolveNameCollisions(
  validCandidates: readonly ScannedValidCandidate[],
  pushDiagnostic: (diag: Diagnostic) => void,
): ReadonlyMap<InstalledPluginId, PluginActivation> {
  const enabledByName = new Map<PluginName, ScannedValidCandidate[]>();
  const activationById = new Map<InstalledPluginId, PluginActivation>();

  for (const candidate of validCandidates) {
    if (candidate.inspection.manifest.disabled === true) {
      activationById.set(candidate.id, { kind: "disabled" });
      continue;
    }
    const group = enabledByName.get(candidate.inspection.manifest.name) ?? [];
    group.push(candidate);
    enabledByName.set(candidate.inspection.manifest.name, group);
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

  return activationById;
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

  const activationById = resolveNameCollisions(validCandidates, pushDiagnostic);

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
  const installedIdsByPluginName = new Map<PluginName, InstalledPluginId[]>();
  const diagnosticsById = new Map<DiagnosticId, Diagnostic>();

  for (const diag of diagnostics) {
    diagnosticsById.set(diag.id, diag);
  }
  for (const plugin of installed) {
    installedById.set(plugin.id, plugin);
    if (plugin.kind === "valid") {
      const nameList = installedIdsByPluginName.get(plugin.manifest.name) ?? [];
      nameList.push(plugin.id);
      installedIdsByPluginName.set(plugin.manifest.name, nameList);
    }
  }
  for (const list of installedIdsByPluginName.values()) {
    list.sort((a, b) => {
      const aProj = a.startsWith("project:");
      const bProj = b.startsWith("project:");
      if (aProj !== bProj) {
        return aProj ? -1 : 1;
      }
      return compareStrings(a, b);
    });
  }

  const stats = computeWorkspaceStats({
    paths,
    catalog,
    installed,
    marketplaces,
    diagnostics,
  });

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
    installedIdsByPluginName,
  };
}
