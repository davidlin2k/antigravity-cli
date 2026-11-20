import fs from "node:fs/promises";
import {
  joinAbsolutePath,
  makeIsoTimestamp,
  splitInstalledPluginId,
} from "../../domain/types.ts";
import type {
  AbsolutePath,
  CatalogEntry,
  CatalogEntryId,
  EngineResult,
  InstalledPlugin,
  InstalledPluginId,
  MarketplaceId,
} from "../../domain/types.ts";
import type {
  PluginUpdateOutcome,
  SetPluginEnabledInput,
  ToggleReport,
  UninstallPluginInput,
  UninstallReport,
  UpdatePluginsInput,
  UpdateReport,
} from "../contract.ts";
import {
  adaptAndInstallBundle,
  toggleManifestDisabledAtomic,
} from "./adapter.ts";
import { resolveInstalledSelector, toEngineError } from "./engine-context.ts";
import type { EngineRuntime } from "./engine-context.ts";
import { syncSingleMarketplace } from "./fetcher.ts";
import {
  errorMessage,
  isWithinCanonicalRoot,
  recoverAndCleanStagingArtifacts,
  targetLockPath,
  withTargetLock,
} from "./fs-safety.ts";
import { parseJsoncBomSafe } from "./jsonc.ts";
import {
  findPluginManifestFile,
  normalizeAntigravityManifest,
} from "./manifest.ts";
import { materializeInstallSource } from "./materialize.ts";
import {
  deleteReceipt,
  loadAllReceipts,
  loadAllSyncCaches,
  loadKnownMarketplaces,
  saveReceipt,
  scopeRootFor,
} from "./stores.ts";
import type { ManagedProvenance } from "./stores.ts";

async function isInstalledPluginCurrentlyDisabled(
  installPath: AbsolutePath,
  fallback: boolean,
): Promise<boolean> {
  try {
    const canonicalRoot = await fs.realpath(installPath);
    const found = await findPluginManifestFile(installPath);
    if (found === null) {
      return fallback;
    }
    const realManifest = await fs.realpath(found.path);
    if (!isWithinCanonicalRoot(realManifest, canonicalRoot)) {
      return fallback;
    }
    const bytes = await fs.readFile(found.path);
    const parsed = parseJsoncBomSafe(bytes, found.path);
    if (!parsed.ok) {
      return fallback;
    }
    const norm = normalizeAntigravityManifest(parsed.value);
    return norm.ok ? norm.manifest.disabled === true : fallback;
  } catch {
    return fallback;
  }
}

export async function opUninstall(
  ctx: EngineRuntime,
  input: UninstallPluginInput,
): Promise<EngineResult<UninstallReport>> {
  const { paths } = ctx;
  const before = await ctx.projectSnapshot();
  const receipts = await loadAllReceipts(paths);

  let targetId: InstalledPluginId;
  let installPath: AbsolutePath;
  let onDisk = true;

  const resolved = resolveInstalledSelector(before, input.selector);
  if (resolved.ok) {
    targetId = resolved.plugin.id;
    installPath = resolved.plugin.installPath;
  } else if (input.selector.kind === "id" && receipts.has(input.selector.id)) {
    targetId = input.selector.id;
    const { scope, dirName } = splitInstalledPluginId(targetId);
    installPath = joinAbsolutePath(scopeRootFor(paths, scope), dirName);
    onDisk = false;
  } else {
    return ctx.fail(resolved.error);
  }

  const { scope, dirName } = splitInstalledPluginId(targetId);
  const scopeRoot = scopeRootFor(paths, scope);

  try {
    const outcome: UninstallReport["outcome"] = await withTargetLock(
      targetLockPath(scopeRoot, dirName),
      async () => {
        await recoverAndCleanStagingArtifacts(scopeRoot, scope, dirName);
        const existsNow = await fs
          .lstat(installPath)
          .then(() => true)
          .catch(() => false);
        if (existsNow) {
          await fs.rm(installPath, { recursive: true, force: true });
        }
        await deleteReceipt(paths, scope, dirName);
        return existsNow || onDisk ? "removed" : "cleaned-orphan-receipt";
      },
    );

    const after = await ctx.commitMutation();
    return {
      ok: true,
      report: {
        pluginId: targetId,
        removedPath: installPath,
        outcome,
      },
      snapshot: after,
    };
  } catch (err) {
    return ctx.mapLockOrIoError(err, "uninstall");
  }
}

export async function opSetEnabled(
  ctx: EngineRuntime,
  input: SetPluginEnabledInput,
): Promise<EngineResult<ToggleReport>> {
  const { paths } = ctx;
  const before = await ctx.projectSnapshot();
  const resolved = resolveInstalledSelector(before, input.selector);
  if (!resolved.ok) {
    return ctx.fail(resolved.error);
  }

  const plugin = resolved.plugin;
  const scopeRoot = scopeRootFor(paths, plugin.scope);

  try {
    const toggled = await withTargetLock(
      targetLockPath(scopeRoot, plugin.dirName),
      async () => {
        await recoverAndCleanStagingArtifacts(scopeRoot, plugin.scope, plugin.dirName);
        return toggleManifestDisabledAtomic(plugin.installPath, plugin.id, input.enabled);
      },
    );

    if (!toggled.ok) {
      return ctx.fail(toEngineError(toggled));
    }

    const after = await ctx.commitMutation();
    return {
      ok: true,
      report: {
        pluginId: plugin.id,
        enabled: input.enabled,
        outcome: toggled.outcome,
      },
      snapshot: after,
    };
  } catch (err) {
    return ctx.mapLockOrIoError(err, "set-enabled");
  }
}

export async function opUpdate(
  ctx: EngineRuntime,
  input: UpdatePluginsInput,
): Promise<EngineResult<UpdateReport>> {
  const { paths, timeoutMs } = ctx;
  const before = await ctx.projectSnapshot();

  let targets: readonly InstalledPlugin[];
  if (input.kind === "single") {
    const resolved = resolveInstalledSelector(before, input.selector);
    if (!resolved.ok) {
      return ctx.fail(resolved.error);
    }
    targets = [resolved.plugin];
  } else {
    targets = before.installed.filter(
      (plugin) => input.scope === undefined || plugin.scope === input.scope,
    );
  }

  const knownMarketplaces = await loadKnownMarketplaces(paths);
  const referencedMarketplaces = new Set<MarketplaceId>();
  for (const plugin of targets) {
    if (plugin.provenance.kind === "marketplace") {
      referencedMarketplaces.add(plugin.provenance.marketplaceId);
    }
  }

  const marketsToSync = knownMarketplaces.filter((m) => referencedMarketplaces.has(m.id));
  if (marketsToSync.length > 0) {
    await Promise.all(
      marketsToSync.map((entry) => syncSingleMarketplace(paths, entry, timeoutMs)),
    );
  }

  const syncCaches = await loadAllSyncCaches(paths);
  const freshCatalogById = new Map<CatalogEntryId, CatalogEntry>();
  for (const cache of syncCaches.values()) {
    for (const entry of cache.entries) {
      freshCatalogById.set(entry.id, entry);
    }
  }

  const outcomes: PluginUpdateOutcome[] = [];

  for (const plugin of targets) {
    const fromVersion =
      plugin.kind === "valid"
        ? (plugin.manifest.version ??
          (plugin.provenance.kind !== "unmanaged" ? plugin.provenance.installedVersion : null))
        : plugin.provenance.kind !== "unmanaged"
          ? plugin.provenance.installedVersion
          : null;

    if (plugin.provenance.kind === "unmanaged") {
      outcomes.push({
        pluginId: plugin.id,
        status: "skipped-unmanaged",
        fromVersion,
        toVersion: fromVersion,
        reason: "Plugin was not installed with manager provenance.",
      });
      continue;
    }

    const catalogEntry =
      plugin.provenance.kind === "marketplace"
        ? freshCatalogById.get(plugin.provenance.entryId)
        : undefined;
    const installSource = catalogEntry?.installSource ?? plugin.provenance.installSource;
    const prevSha = plugin.provenance.installedSha;

    const materialized = await materializeInstallSource({
      installSource,
      paths,
      marketplaces: knownMarketplaces,
      syncCaches,
      timeoutMs,
    });

    if (!materialized.ok) {
      outcomes.push({
        pluginId: plugin.id,
        status: "failed",
        fromVersion,
        toVersion: fromVersion,
        reason:
          materialized.kind === "path-traversal"
            ? `Path traversal rejected: ${materialized.offendingPath}`
            : materialized.reason,
      });
      continue;
    }

    const { bundle } = materialized;
    try {
      const scopeRoot = scopeRootFor(paths, plugin.scope);
      if (
        prevSha !== null &&
        bundle.resolvedSha !== null &&
        prevSha === bundle.resolvedSha &&
        (catalogEntry?.version === undefined ||
          catalogEntry.version === null ||
          catalogEntry.version === fromVersion)
      ) {
        outcomes.push({
          pluginId: plugin.id,
          status: "unchanged",
          fromVersion,
          toVersion: fromVersion,
        });
        continue;
      }

      const adapted = await withTargetLock(
        targetLockPath(scopeRoot, plugin.dirName),
        async () => {
          await recoverAndCleanStagingArtifacts(scopeRoot, plugin.scope, plugin.dirName);
          const preserveDisabled = await isInstalledPluginCurrentlyDisabled(
            plugin.installPath,
            plugin.kind === "valid" && plugin.manifest.disabled === true,
          );
          const fallbackVersion =
            catalogEntry?.version !== undefined && catalogEntry.version !== null
              ? catalogEntry.version
              : undefined;
          const result = await adaptAndInstallBundle({
            sourceDir: bundle.sourceDir,
            scopeRoot,
            scope: plugin.scope,
            dirName: plugin.dirName,
            fallbackName: plugin.dirName,
            ...(fallbackVersion !== undefined ? { fallbackVersion } : {}),
            ...(preserveDisabled ? { disabled: true } : {}),
          });
          if (!result.ok) {
            return result;
          }
          const nextVersion = result.manifest.version ?? catalogEntry?.version ?? null;
          const nextProvenance: ManagedProvenance =
            plugin.provenance.kind === "marketplace"
              ? {
                  kind: "marketplace",
                  marketplaceId: plugin.provenance.marketplaceId,
                  entryId: plugin.provenance.entryId,
                  installSource,
                  installedVersion: nextVersion,
                  installedSha: bundle.resolvedSha,
                  installedAt: makeIsoTimestamp(),
                }
              : {
                  kind: "direct",
                  installSource,
                  installedVersion: nextVersion,
                  installedSha: bundle.resolvedSha,
                  installedAt: makeIsoTimestamp(),
                };

          await saveReceipt(paths, {
            schemaVersion: 1,
            id: plugin.id,
            scope: plugin.scope,
            dirName: plugin.dirName,
            provenance: nextProvenance,
          });
          return result;
        },
      );

      if (!adapted.ok) {
        outcomes.push({
          pluginId: plugin.id,
          status: "failed",
          fromVersion,
          toVersion: fromVersion,
          reason:
            adapted.kind === "path-traversal"
              ? `Path traversal rejected: ${adapted.offendingPath}`
              : adapted.kind === "bundle-invalid"
                ? adapted.diagnostics[0].message
                : adapted.reason,
        });
        continue;
      }

      const toVersion = adapted.manifest.version ?? catalogEntry?.version ?? null;
      const changed =
        toVersion !== fromVersion ||
        (bundle.resolvedSha !== null && bundle.resolvedSha !== prevSha) ||
        adapted.adaptedHooks ||
        adapted.adaptedMcp;

      outcomes.push({
        pluginId: plugin.id,
        status: changed ? "updated" : "unchanged",
        fromVersion,
        toVersion,
      });
    } catch (err) {
      outcomes.push({
        pluginId: plugin.id,
        status: "failed",
        fromVersion,
        toVersion: fromVersion,
        reason: errorMessage(err),
      });
    } finally {
      await bundle.cleanup();
    }
  }

  const after = await ctx.commitMutation();
  return {
    ok: true,
    report: { outcomes },
    snapshot: after,
  };
}
