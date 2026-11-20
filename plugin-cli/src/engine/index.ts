import fs from "node:fs/promises";
import path from "node:path";
import { deriveMarketplaceId, formatMarketplaceSource } from "../domain/query.ts";
import {
  isAtLeastTwo,
  isCatalogEntryId,
  isMarketplaceId,
  joinAbsolutePath,
  makeAbsolutePath,
  makeDiagnosticId,
  makeHttpUrl,
  makeInstalledPluginId,
  makeIsoTimestamp,
  makePluginName,
  makeSnapshotRevision,
  nextSnapshotRevision,
  slugifyPluginDirName,
  splitInstalledPluginId,
} from "../domain/types.ts";
import type {
  AbsolutePath,
  CatalogEntry,
  CatalogEntryId,
  Diagnostic,
  EngineError,
  EngineResult,
  InstallScope,
  InstalledPlugin,
  InstalledPluginId,
  InstalledPluginSelector,
  MarketplaceId,
  MarketplaceSource,
  PluginDirName,
  PluginInstallSource,
  PluginName,
  WorkspaceSnapshot,
} from "../domain/types.ts";
import type {
  AddMarketplaceInput,
  BulkSyncReport,
  InstallPluginInput,
  InstallReport,
  MarketplaceSyncOutcome,
  MarketplaceSyncReport,
  PluginEngine,
  PluginEngineConfig,
  PluginUpdateOutcome,
  RemediateInput,
  RemediateReport,
  RemoveMarketplaceInput,
  RemoveMarketplaceReport,
  SetPluginEnabledInput,
  SyncMarketplacesInput,
  ToggleReport,
  UninstallPluginInput,
  UninstallReport,
  UpdatePluginsInput,
  UpdateReport,
  ValidateTargetInput,
  ValidationReport,
} from "./contract.ts";
import {
  adaptAndInstallBundle,
  readaptInstalledPlugin,
  toggleManifestDisabledAtomic,
} from "./internal/adapter.ts";
import {
  DEFAULT_NETWORK_TIMEOUT_MS,
  materializeInstallSource,
  resolveMarketplaceSource,
  syncSingleMarketplace,
} from "./internal/fetcher.ts";
import { inspectPluginDirectory } from "./internal/inspector.ts";
import {
  findPluginManifestFile,
  normalizeAntigravityManifest,
  parseJsoncBomSafe,
} from "./internal/normalizer.ts";
import { projectWorkspaceSnapshot } from "./internal/reconciler.ts";
import {
  BACKUP_PREFIX,
  LockBusyError,
  STAGING_PREFIX,
  deleteReceipt,
  deleteSyncCache,
  deriveWorkspacePaths,
  errorMessage,
  isWithinCanonicalRoot,
  loadAllReceipts,
  loadAllSyncCaches,
  loadKnownMarketplaces,
  marketplaceMirrorPath,
  recoverAndCleanStagingArtifacts,
  registryLockPath,
  saveKnownMarketplaces,
  saveReceipt,
  scopeRootFor,
  targetLockPath,
  withTargetLock,
  writeDerivedCaches,
} from "./internal/stores.ts";
import type { KnownMarketplaceEntry, ManagedProvenance, PersistedReceipt } from "./internal/stores.ts";

export * from "./contract.ts";

function installSourcesEqual(a: PluginInstallSource, b: PluginInstallSource): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case "marketplace-root":
      return b.kind === "marketplace-root" && a.marketplaceId === b.marketplaceId;
    case "marketplace-subdir":
      return (
        b.kind === "marketplace-subdir" &&
        a.marketplaceId === b.marketplaceId &&
        a.subdir === b.subdir
      );
    case "git-subdir":
      return (
        b.kind === "git-subdir" &&
        a.repoUrl === b.repoUrl &&
        a.subdir === b.subdir &&
        a.ref === b.ref
      );
    case "git-repo":
      return b.kind === "git-repo" && a.repoUrl === b.repoUrl && a.ref === b.ref;
    case "archive-url":
      return b.kind === "archive-url" && a.url === b.url;
    case "local-dir":
      return b.kind === "local-dir" && a.path === b.path;
    default: {
      const _exhaustive: never = a;
      return _exhaustive;
    }
  }
}

function marketplaceSourceToPluginInstallSource(
  source: MarketplaceSource,
): PluginInstallSource | null {
  switch (source.kind) {
    case "github": {
      const repoUrl = makeHttpUrl(`https://github.com/${source.owner}/${source.repo}.git`);
      if (source.subdir !== undefined) {
        return {
          kind: "git-subdir",
          repoUrl,
          subdir: source.subdir,
          ...(source.ref !== undefined ? { ref: source.ref } : {}),
        };
      }
      return {
        kind: "git-repo",
        repoUrl,
        ...(source.ref !== undefined ? { ref: source.ref } : {}),
      };
    }
    case "ssh":
    case "https-git":
      if (source.subdir !== undefined) {
        return {
          kind: "git-subdir",
          repoUrl: source.url,
          subdir: source.subdir,
          ...(source.ref !== undefined ? { ref: source.ref } : {}),
        };
      }
      return {
        kind: "git-repo",
        repoUrl: source.url,
        ...(source.ref !== undefined ? { ref: source.ref } : {}),
      };
    case "local-folder":
      return { kind: "local-dir", path: source.path };
    case "https-json":
    case "local-json":
      return null;
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

function defaultDirNameFromSource(source: MarketplaceSource): PluginDirName {
  switch (source.kind) {
    case "github":
      return slugifyPluginDirName(
        source.subdir !== undefined ? path.basename(source.subdir) : source.repo,
      );
    case "ssh":
    case "https-git": {
      if (source.subdir !== undefined) {
        return slugifyPluginDirName(path.basename(source.subdir));
      }
      const clean = source.url.replace(/\/+$/, "").replace(/\.git$/i, "");
      const last = clean.split(/[/:]/).filter((s) => s.length > 0).at(-1) ?? "plugin";
      return slugifyPluginDirName(last);
    }
    case "local-folder": {
      const base = path.basename(source.path).replace(/\.git$/i, "");
      return slugifyPluginDirName(base);
    }
    case "https-json":
    case "local-json":
      return slugifyPluginDirName("plugin");
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

function selectorLabel(selector: InstalledPluginSelector): string {
  if (selector.kind === "id") {
    return selector.id;
  }
  return selector.scope !== undefined ? `${selector.scope}:${selector.name}` : selector.name;
}

type SelectorResolution =
  | { readonly ok: true; readonly plugin: InstalledPlugin }
  | { readonly ok: false; readonly error: EngineError };

function resolveInstalledSelector(
  snapshot: WorkspaceSnapshot,
  selector: InstalledPluginSelector,
): SelectorResolution {
  if (selector.kind === "id") {
    const found = snapshot.installedById.get(selector.id);
    if (found === undefined) {
      return { ok: false, error: { kind: "plugin-not-found", selector: selector.id } };
    }
    return { ok: true, plugin: found };
  }

  const matches: InstalledPlugin[] = [];
  for (const plugin of snapshot.installed) {
    if (selector.scope !== undefined && plugin.scope !== selector.scope) {
      continue;
    }
    if (
      (plugin.kind === "valid" && plugin.manifest.name === selector.name) ||
      String(plugin.dirName) === String(selector.name)
    ) {
      matches.push(plugin);
    }
  }

  if (matches.length === 0) {
    return { ok: false, error: { kind: "plugin-not-found", selector: selectorLabel(selector) } };
  }
  if (matches.length === 1 && matches[0] !== undefined) {
    return { ok: true, plugin: matches[0] };
  }
  const matchIds = matches.map((m) => m.id);
  if (isAtLeastTwo(matchIds)) {
    return {
      ok: false,
      error: {
        kind: "ambiguous-plugin-selector",
        name: selector.name,
        matches: matchIds,
      },
    };
  }
  return { ok: false, error: { kind: "plugin-not-found", selector: selectorLabel(selector) } };
}

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

async function peekCandidatePluginName(
  sourceDir: AbsolutePath,
  fallbackDirName: string,
): Promise<PluginName | null> {
  try {
    const canonicalRoot = await fs.realpath(sourceDir);
    const found = await findPluginManifestFile(sourceDir);
    if (found === null) {
      return null;
    }
    const realManifest = await fs.realpath(found.path);
    if (realManifest !== canonicalRoot && !realManifest.startsWith(`${canonicalRoot}${path.sep}`)) {
      return null;
    }
    const bytes = await fs.readFile(found.path);
    const parsed = parseJsoncBomSafe(bytes, found.path);
    if (!parsed.ok) {
      return null;
    }
    const norm = normalizeAntigravityManifest(parsed.value, fallbackDirName);
    return norm.ok ? norm.manifest.name : null;
  } catch {
    return null;
  }
}

function lookupCatalogEntryForPair(
  snapshot: WorkspaceSnapshot,
  left: string,
  right: string,
): CatalogEntry | null {
  const mktLower = left.toLowerCase();
  if (!isMarketplaceId(mktLower)) {
    return null;
  }
  const exactCandidate = `${mktLower}/${right}`;
  if (isCatalogEntryId(exactCandidate)) {
    const direct = snapshot.catalogById.get(exactCandidate);
    if (direct !== undefined) {
      return direct;
    }
  }
  const slugCandidate = `${mktLower}/${slugifyPluginDirName(right)}`;
  if (isCatalogEntryId(slugCandidate)) {
    const bySlug = snapshot.catalogById.get(slugCandidate);
    if (bySlug !== undefined) {
      return bySlug;
    }
  }
  const rightLower = right.toLowerCase();
  for (const entry of snapshot.catalog) {
    if (
      entry.marketplaceId === mktLower &&
      (entry.name.toLowerCase() === rightLower || entry.slug.toLowerCase() === rightLower)
    ) {
      return entry;
    }
  }
  return null;
}

function isSameInstalledPlugin(
  existing: InstalledPlugin,
  incoming: {
    readonly provenanceKind: "marketplace" | "direct";
    readonly entryId?: CatalogEntryId;
    readonly installSource: PluginInstallSource;
    readonly candidatePluginName: PluginName | null;
  },
): boolean {
  if (existing.provenance.kind === "marketplace" && incoming.provenanceKind === "marketplace") {
    return existing.provenance.entryId === incoming.entryId;
  }
  if (existing.provenance.kind === "direct" && incoming.provenanceKind === "direct") {
    return installSourcesEqual(existing.provenance.installSource, incoming.installSource);
  }
  if (existing.provenance.kind === "unmanaged") {
    return (
      existing.kind === "valid" &&
      incoming.candidatePluginName !== null &&
      existing.manifest.name === incoming.candidatePluginName
    );
  }
  return false;
}

/**
 * Creates a `PluginEngine` bound to explicit home, config, and workspace directories.
 * Never opens `<configDir>/config.json` for write; all manager metadata stays under
 * `<configDir>/plugin-manager/`.
 */
export function createPluginEngine(config: PluginEngineConfig): PluginEngine {
  const paths = deriveWorkspacePaths(config);
  const timeoutMs = config.networkTimeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS;
  let revision = makeSnapshotRevision(0);

  const nextRev = () => {
    revision = nextSnapshotRevision(revision);
    return revision;
  };

  const projectFresh = async (): Promise<WorkspaceSnapshot> => {
    return projectWorkspaceSnapshot(paths, nextRev());
  };

  const commitSnapshot = async (): Promise<WorkspaceSnapshot> => {
    const snap = await projectFresh();
    await writeDerivedCaches(paths, snap);
    return snap;
  };

  const fail = async <T>(error: EngineError, writeDerived = false): Promise<EngineResult<T>> => {
    const snap = writeDerived ? await commitSnapshot() : await projectFresh();
    return { ok: false, error, snapshot: snap };
  };

  const mapLockOrIoError = async <T>(
    err: unknown,
    operation: string,
  ): Promise<EngineResult<T>> => {
    if (err instanceof LockBusyError) {
      return fail({ kind: "lock-busy", target: err.target });
    }
    return fail({ kind: "io-failed", operation, reason: errorMessage(err) });
  };

  const engine: PluginEngine = {
    async snapshot(): Promise<WorkspaceSnapshot> {
      return projectFresh();
    },

    async install(input: InstallPluginInput): Promise<EngineResult<InstallReport>> {
      const before = await projectFresh();

      let installSource: PluginInstallSource;
      let defaultDirName: PluginDirName;
      let provenanceKind: "marketplace" | "direct";
      let marketplaceId: MarketplaceId | undefined;
      let entryId: CatalogEntryId | undefined;
      let fallbackName: string | undefined;
      let catalogVersion: string | null = null;

      const { target } = input;
      switch (target.kind) {
        case "catalog-entry": {
          const entry = before.catalogById.get(target.entryId);
          if (entry === undefined) {
            return fail({ kind: "catalog-entry-not-found", target: target.entryId });
          }
          installSource = entry.installSource;
          defaultDirName = entry.slug;
          provenanceKind = "marketplace";
          marketplaceId = entry.marketplaceId;
          entryId = entry.id;
          fallbackName = entry.name;
          catalogVersion = entry.version;
          break;
        }
        case "catalog-name": {
          const nameLower = target.name.toLowerCase();
          const exactMatches: CatalogEntry[] = [];
          const ciMatches: CatalogEntry[] = [];
          for (const entry of before.catalog) {
            if (target.marketplaceId !== undefined && entry.marketplaceId !== target.marketplaceId) {
              continue;
            }
            if (entry.name === target.name || String(entry.slug) === String(target.name)) {
              exactMatches.push(entry);
            } else if (
              entry.name.toLowerCase() === nameLower ||
              entry.slug.toLowerCase() === nameLower
            ) {
              ciMatches.push(entry);
            }
          }
          const matches = exactMatches.length > 0 ? exactMatches : ciMatches;
          if (matches.length === 0) {
            const label =
              target.marketplaceId !== undefined
                ? `${target.name}@${target.marketplaceId}`
                : target.name;
            return fail({ kind: "catalog-entry-not-found", target: label });
          }
          if (matches.length > 1) {
            const candidateIds = matches.map((m) => m.id);
            if (isAtLeastTwo(candidateIds)) {
              return fail({
                kind: "ambiguous-catalog-target",
                name: target.name,
                candidates: candidateIds,
              });
            }
          }
          const matched = matches[0];
          if (matched === undefined) {
            return fail({ kind: "catalog-entry-not-found", target: target.name });
          }
          installSource = matched.installSource;
          defaultDirName = matched.slug;
          provenanceKind = "marketplace";
          marketplaceId = matched.marketplaceId;
          entryId = matched.id;
          fallbackName = matched.name;
          catalogVersion = matched.version;
          break;
        }
        case "catalog-or-github": {
          const catalogEntry = lookupCatalogEntryForPair(before, target.left, target.right);
          if (catalogEntry !== null) {
            installSource = catalogEntry.installSource;
            defaultDirName = catalogEntry.slug;
            provenanceKind = "marketplace";
            marketplaceId = catalogEntry.marketplaceId;
            entryId = catalogEntry.id;
            fallbackName = catalogEntry.name;
            catalogVersion = catalogEntry.version;
          } else {
            const directSrc = marketplaceSourceToPluginInstallSource(target.githubSource);
            if (directSrc === null) {
              return fail({
                kind: "catalog-entry-not-found",
                target: `${target.left}/${target.right}`,
              });
            }
            installSource = directSrc;
            defaultDirName = defaultDirNameFromSource(target.githubSource);
            provenanceKind = "direct";
            fallbackName = defaultDirName;
          }
          break;
        }
        case "direct-source": {
          const resolved = await resolveMarketplaceSource(target.source, timeoutMs);
          if (!resolved.ok) {
            return fail({
              kind: "io-failed",
              operation: "resolve-direct-source",
              reason: resolved.reason,
            });
          }
          const directSrc = marketplaceSourceToPluginInstallSource(resolved.source);
          if (directSrc === null) {
            return fail({
              kind: "catalog-entry-not-found",
              target: formatMarketplaceSource(resolved.source),
            });
          }
          installSource = directSrc;
          defaultDirName = defaultDirNameFromSource(resolved.source);
          provenanceKind = "direct";
          fallbackName = defaultDirName;
          break;
        }
        default: {
          const _exhaustive: never = target;
          return _exhaustive;
        }
      }

      const [knownMarketplaces, syncCaches] = await Promise.all([
        loadKnownMarketplaces(paths),
        loadAllSyncCaches(paths),
      ]);

      const materialized = await materializeInstallSource({
        installSource,
        paths,
        marketplaces: knownMarketplaces,
        syncCaches,
        timeoutMs,
      });
      if (!materialized.ok) {
        if (materialized.kind === "path-traversal") {
          return fail({ kind: "path-traversal", offendingPath: materialized.offendingPath });
        }
        return fail({
          kind: "io-failed",
          operation: materialized.operation,
          reason: materialized.reason,
        });
      }

      const { bundle } = materialized;
      try {
        const candidatePluginName = await peekCandidatePluginName(
          bundle.sourceDir,
          fallbackName ?? defaultDirName,
        );
        const dirName: PluginDirName =
          input.dirName ??
          (candidatePluginName !== null ? slugifyPluginDirName(candidatePluginName, defaultDirName) : defaultDirName);
        const targetPluginId = makeInstalledPluginId(input.scope, dirName);
        const scopeRoot = scopeRootFor(paths, input.scope);

        const existingAtSlot = before.installedById.get(targetPluginId);
        if (existingAtSlot !== undefined) {
          const samePlugin = isSameInstalledPlugin(existingAtSlot, {
            provenanceKind,
            entryId,
            installSource,
            candidatePluginName,
          });
          if (!samePlugin && input.allowNameCollision !== true) {
            const existingName =
              existingAtSlot.kind === "valid"
                ? existingAtSlot.manifest.name
                : makePluginName(existingAtSlot.dirName);
            return fail({
              kind: "name-collision",
              pluginName: existingName,
              existingId: targetPluginId,
              targetScope: input.scope,
            });
          }
        }

        if (candidatePluginName !== null && input.allowNameCollision !== true) {
          const sameNameIds = before.installedIdsByPluginName.get(candidatePluginName) ?? [];
          for (const otherId of sameNameIds) {
            if (otherId === targetPluginId) {
              continue;
            }
            const other = before.installedById.get(otherId);
            if (other !== undefined && other.kind === "valid" && other.manifest.disabled !== true) {
              return fail({
                kind: "name-collision",
                pluginName: candidatePluginName,
                existingId: otherId,
                targetScope: input.scope,
              });
            }
          }
        }

        const adapted = await withTargetLock(targetLockPath(scopeRoot, dirName), async () => {
          await recoverAndCleanStagingArtifacts(scopeRoot, input.scope, dirName);
          const result = await adaptAndInstallBundle({
            sourceDir: bundle.sourceDir,
            scopeRoot,
            scope: input.scope,
            dirName,
            fallbackName: fallbackName ?? dirName,
            ...(catalogVersion !== null ? { fallbackVersion: catalogVersion } : {}),
          });
          if (!result.ok) {
            return result;
          }

          const installedAt = makeIsoTimestamp();
          const installedVersion = result.manifest.version ?? catalogVersion ?? null;
          const provenance: ManagedProvenance =
            provenanceKind === "marketplace" &&
            marketplaceId !== undefined &&
            entryId !== undefined
              ? {
                  kind: "marketplace",
                  marketplaceId,
                  entryId,
                  installSource,
                  installedVersion,
                  installedSha: bundle.resolvedSha,
                  installedAt,
                }
              : {
                  kind: "direct",
                  installSource,
                  installedVersion,
                  installedSha: bundle.resolvedSha,
                  installedAt,
                };

          const receipt: PersistedReceipt = {
            schemaVersion: 1,
            id: targetPluginId,
            scope: input.scope,
            dirName,
            provenance,
          };
          await saveReceipt(paths, receipt);
          return result;
        });

        if (!adapted.ok) {
          switch (adapted.kind) {
            case "path-traversal":
              return fail({ kind: "path-traversal", offendingPath: adapted.offendingPath });
            case "bundle-invalid":
              return fail({ kind: "bundle-invalid", diagnostics: adapted.diagnostics });
            case "io-failed":
              return fail({
                kind: "io-failed",
                operation: adapted.operation,
                reason: adapted.reason,
              });
            default: {
              const _exhaustive: never = adapted;
              return _exhaustive;
            }
          }
        }

        const after = await commitSnapshot();
        return {
          ok: true,
          report: {
            pluginId: targetPluginId,
            pluginName: adapted.manifest.name,
            scope: input.scope,
            installPath: adapted.installPath,
            outcome: existingAtSlot !== undefined ? "updated" : "installed",
            adaptedHooks: adapted.adaptedHooks,
            adaptedMcp: adapted.adaptedMcp,
            warnings: adapted.warnings,
          },
          snapshot: after,
        };
      } catch (err) {
        return mapLockOrIoError(err, "install");
      } finally {
        await bundle.cleanup();
      }
    },

    async uninstall(input: UninstallPluginInput): Promise<EngineResult<UninstallReport>> {
      const before = await projectFresh();
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
        return fail(resolved.error);
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

        const after = await commitSnapshot();
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
        return mapLockOrIoError(err, "uninstall");
      }
    },

    async setEnabled(input: SetPluginEnabledInput): Promise<EngineResult<ToggleReport>> {
      const before = await projectFresh();
      const resolved = resolveInstalledSelector(before, input.selector);
      if (!resolved.ok) {
        return fail(resolved.error);
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
          switch (toggled.kind) {
            case "path-traversal":
              return fail({ kind: "path-traversal", offendingPath: toggled.offendingPath });
            case "bundle-invalid":
              return fail({ kind: "bundle-invalid", diagnostics: toggled.diagnostics });
            case "io-failed":
              return fail({
                kind: "io-failed",
                operation: toggled.operation,
                reason: toggled.reason,
              });
            default: {
              const _exhaustive: never = toggled;
              return _exhaustive;
            }
          }
        }

        const after = await commitSnapshot();
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
        return mapLockOrIoError(err, "set-enabled");
      }
    },

    async update(input: UpdatePluginsInput): Promise<EngineResult<UpdateReport>> {
      const before = await projectFresh();

      let targets: readonly InstalledPlugin[];
      if (input.kind === "single") {
        const resolved = resolveInstalledSelector(before, input.selector);
        if (!resolved.ok) {
          return fail(resolved.error);
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

      const after = await commitSnapshot();
      return {
        ok: true,
        report: { outcomes },
        snapshot: after,
      };
    },

    async addMarketplace(input: AddMarketplaceInput): Promise<EngineResult<MarketplaceSyncReport>> {
      const id = input.id ?? deriveMarketplaceId(input.source);

      try {
        const registration = await withTargetLock(registryLockPath(paths), async () => {
          const existing = await loadKnownMarketplaces(paths);
          if (existing.some((entry) => entry.id === id)) {
            return { ok: false as const, error: { kind: "marketplace-exists" as const, id } };
          }

          const resolved = await resolveMarketplaceSource(input.source, timeoutMs);
          if (!resolved.ok) {
            return {
              ok: false as const,
              error: {
                kind: "marketplace-sync-failed" as const,
                id,
                reason: resolved.reason,
              },
            };
          }

          const entry: KnownMarketplaceEntry = {
            id,
            source: resolved.source,
            addedAt: makeIsoTimestamp(),
          };
          await saveKnownMarketplaces(paths, [...existing, entry]);
          return { ok: true as const, entry };
        });

        if (!registration.ok) {
          return fail(registration.error);
        }

        const outcome = await syncSingleMarketplace(paths, registration.entry, timeoutMs);
        const after = await commitSnapshot();
        if (outcome.status === "failed") {
          return {
            ok: false,
            error: {
              kind: "marketplace-sync-failed",
              id,
              reason: outcome.reason ?? "Marketplace sync failed.",
            },
            snapshot: after,
          };
        }
        return {
          ok: true,
          report: { outcome },
          snapshot: after,
        };
      } catch (err) {
        return mapLockOrIoError(err, "add-marketplace");
      }
    },

    async syncMarketplaces(input: SyncMarketplacesInput): Promise<EngineResult<BulkSyncReport>> {
      const known = await loadKnownMarketplaces(paths);

      if (input.kind === "single") {
        const entry = known.find((m) => m.id === input.id);
        if (entry === undefined) {
          return fail({ kind: "marketplace-not-found", id: input.id });
        }
        const outcome = await syncSingleMarketplace(paths, entry, timeoutMs);
        const after = await commitSnapshot();
        if (outcome.status === "failed") {
          return {
            ok: false,
            error: {
              kind: "marketplace-sync-failed",
              id: entry.id,
              reason: outcome.reason ?? "Marketplace sync failed.",
            },
            snapshot: after,
          };
        }
        return {
          ok: true,
          report: { outcomes: [outcome] },
          snapshot: after,
        };
      }

      const outcomes: MarketplaceSyncOutcome[] = await Promise.all(
        known.map((entry) => syncSingleMarketplace(paths, entry, timeoutMs)),
      );
      const after = await commitSnapshot();
      return {
        ok: true,
        report: { outcomes },
        snapshot: after,
      };
    },

    async removeMarketplace(
      input: RemoveMarketplaceInput,
    ): Promise<EngineResult<RemoveMarketplaceReport>> {
      try {
        const removed = await withTargetLock(registryLockPath(paths), async () => {
          const existing = await loadKnownMarketplaces(paths);
          const found = existing.find((m) => m.id === input.id);
          if (found === undefined) {
            return { ok: false as const };
          }
          const next = existing.filter((m) => m.id !== input.id);
          await saveKnownMarketplaces(paths, next);
          return { ok: true as const };
        });

        if (!removed.ok) {
          return fail({ kind: "marketplace-not-found", id: input.id });
        }

        await deleteSyncCache(paths, input.id);

        const mirrorDir = marketplaceMirrorPath(paths, input.id);
        const mirrorExists = await fs
          .lstat(mirrorDir)
          .then(() => true)
          .catch(() => false);
        if (mirrorExists) {
          await fs.rm(mirrorDir, { recursive: true, force: true });
        }

        const after = await commitSnapshot();
        return {
          ok: true,
          report: {
            id: input.id,
            removedMirror: mirrorExists,
          },
          snapshot: after,
        };
      } catch (err) {
        return mapLockOrIoError(err, "remove-marketplace");
      }
    },

    async validate(input: ValidateTargetInput): Promise<ValidationReport> {
      switch (input.kind) {
        case "workspace": {
          const snap = await projectFresh();
          return {
            valid: snap.stats.errorCount === 0,
            targetLabel: "workspace",
            manifest: null,
            components: null,
            diagnostics: snap.diagnostics,
          };
        }

        case "installed": {
          const snap = await projectFresh();
          const resolved = resolveInstalledSelector(snap, input.selector);
          const label = selectorLabel(input.selector);
          if (!resolved.ok) {
            const diag: Diagnostic = {
              id: makeDiagnosticId("validate-not-found", label),
              severity: "error",
              subject: { kind: "path", path: paths.workspaceDir },
              detail: {
                kind: "manifest-schema-invalid",
                filePath: paths.workspaceDir,
                fieldErrors: [`Installed plugin "${label}" not found.`],
              },
              message: `Installed plugin "${label}" could not be found.`,
              hint: "Run list to see installed plugins and scopes.",
            };
            return {
              valid: false,
              targetLabel: label,
              manifest: null,
              components: null,
              diagnostics: [diag],
            };
          }

          const plugin = resolved.plugin;
          const inspection = await inspectPluginDirectory({
            pluginRoot: plugin.installPath,
            subject: { kind: "installed", pluginId: plugin.id },
            pluginIdForRemediation: plugin.id,
          });
          const mergedDiagnostics: Diagnostic[] = [...inspection.diagnostics];
          const seenIds = new Set(mergedDiagnostics.map((d) => d.id));
          for (const diagId of plugin.diagnosticIds) {
            const wsDiag = snap.diagnosticsById.get(diagId);
            if (wsDiag !== undefined && !seenIds.has(wsDiag.id)) {
              seenIds.add(wsDiag.id);
              mergedDiagnostics.push(wsDiag);
            }
          }
          return {
            valid: mergedDiagnostics.every((d) => d.severity !== "error") && inspection.manifest !== null,
            targetLabel: plugin.id,
            manifest: inspection.manifest,
            components: inspection.components,
            diagnostics: mergedDiagnostics,
          };
        }

        case "source": {
          const label = formatMarketplaceSource(input.source);
          const resolvedSource = await resolveMarketplaceSource(input.source, timeoutMs);
          if (!resolvedSource.ok) {
            return {
              valid: false,
              targetLabel: label,
              manifest: null,
              components: null,
              diagnostics: [
                {
                  id: makeDiagnosticId("validate-source-failed", label),
                  severity: "error",
                  subject: { kind: "path", path: paths.workspaceDir },
                  detail: {
                    kind: "manifest-schema-invalid",
                    filePath: paths.workspaceDir,
                    fieldErrors: [resolvedSource.reason],
                  },
                  message: resolvedSource.reason,
                  hint: "Verify the source path or remote URL is reachable.",
                },
              ],
            };
          }

          const installSource = marketplaceSourceToPluginInstallSource(resolvedSource.source);
          if (installSource === null) {
            return {
              valid: false,
              targetLabel: label,
              manifest: null,
              components: null,
              diagnostics: [
                {
                  id: makeDiagnosticId("validate-source-unsupported", label),
                  severity: "error",
                  subject: { kind: "path", path: paths.workspaceDir },
                  detail: {
                    kind: "manifest-schema-invalid",
                    filePath: paths.workspaceDir,
                    fieldErrors: ["JSON catalog files cannot be validated as a single plugin bundle."],
                  },
                  message: `"${label}" is a catalog JSON file rather than a plugin bundle directory.`,
                  hint: "Pass a plugin directory or git repository URL to validate.",
                },
              ],
            };
          }

          const materialized = await materializeInstallSource({
            installSource,
            paths,
            marketplaces: [],
            syncCaches: new Map(),
            timeoutMs,
          });
          if (!materialized.ok) {
            const reason =
              materialized.kind === "path-traversal"
                ? `Path traversal rejected: ${materialized.offendingPath}`
                : materialized.reason;
            return {
              valid: false,
              targetLabel: label,
              manifest: null,
              components: null,
              diagnostics: [
                {
                  id: makeDiagnosticId("validate-materialize-failed", label),
                  severity: "error",
                  subject: { kind: "path", path: paths.workspaceDir },
                  detail:
                    materialized.kind === "path-traversal"
                      ? {
                          kind: "path-traversal-rejected",
                          offendingPath: materialized.offendingPath,
                          resolvedOutsideRoot: materialized.offendingPath,
                        }
                      : {
                          kind: "manifest-schema-invalid",
                          filePath: paths.workspaceDir,
                          fieldErrors: [reason],
                        },
                  message: reason,
                  hint: "Verify the plugin source exists and is readable.",
                },
              ],
            };
          }

          try {
            const inspection = await inspectPluginDirectory({
              pluginRoot: materialized.bundle.sourceDir,
              subject: { kind: "path", path: materialized.bundle.sourceDir },
            });
            return {
              valid: inspection.valid,
              targetLabel: label,
              manifest: inspection.manifest,
              components: inspection.components,
              diagnostics: inspection.diagnostics,
            };
          } finally {
            await materialized.bundle.cleanup();
          }
        }

        default: {
          const _exhaustive: never = input;
          return _exhaustive;
        }
      }
    },

    async remediate(input: RemediateInput): Promise<EngineResult<RemediateReport>> {
      const { plan } = input;

      switch (plan.kind) {
        case "readapt-bundle": {
          const { scope, dirName } = splitInstalledPluginId(plan.pluginId);
          const scopeRoot = scopeRootFor(paths, scope);
          const installedPath = joinAbsolutePath(scopeRoot, dirName);
          const exists = await fs
            .stat(installedPath)
            .then((s) => s.isDirectory())
            .catch(() => false);
          if (!exists) {
            return fail({
              kind: "remediation-failed",
              planKind: "readapt-bundle",
              reason: `Plugin directory "${installedPath}" does not exist.`,
            });
          }

          try {
            const result = await withTargetLock(
              targetLockPath(scopeRoot, dirName),
              async () => {
                await recoverAndCleanStagingArtifacts(scopeRoot, scope, dirName);
                return readaptInstalledPlugin({ scopeRoot, scope, dirName });
              },
            );
            if (!result.ok) {
              const reason =
                result.kind === "path-traversal"
                  ? `Path traversal rejected: ${result.offendingPath}`
                  : result.kind === "bundle-invalid"
                    ? result.diagnostics[0].message
                    : result.reason;
              return fail({
                kind: "remediation-failed",
                planKind: "readapt-bundle",
                reason,
              });
            }
            const after = await commitSnapshot();
            return {
              ok: true,
              report: {
                kind: "readapted-bundle",
                pluginId: plan.pluginId,
                adaptedHooks: result.adaptedHooks,
                adaptedMcp: result.adaptedMcp,
                expandedPluginRoot: result.expandedPluginRoot,
              },
              snapshot: after,
            };
          } catch (err) {
            return mapLockOrIoError(err, "remediate-readapt");
          }
        }

        case "disable-plugin": {
          const res = await engine.setEnabled({
            selector: { kind: "id", id: plan.pluginId },
            enabled: false,
          });
          if (!res.ok) {
            return {
              ok: false,
              error: {
                kind: "remediation-failed",
                planKind: "disable-plugin",
                reason: `Failed to disable ${plan.pluginId} (${res.error.kind}).`,
              },
              snapshot: res.snapshot,
            };
          }
          return {
            ok: true,
            report: {
              kind: "disabled-plugin",
              pluginId: plan.pluginId,
              outcome: res.report.outcome,
            },
            snapshot: res.snapshot,
          };
        }

        case "remove-plugin": {
          const res = await engine.uninstall({
            selector: { kind: "id", id: plan.pluginId },
          });
          if (!res.ok) {
            return {
              ok: false,
              error: {
                kind: "remediation-failed",
                planKind: "remove-plugin",
                reason: `Failed to remove ${plan.pluginId} (${res.error.kind}).`,
              },
              snapshot: res.snapshot,
            };
          }
          return {
            ok: true,
            report: {
              kind: "removed-plugin",
              pluginId: plan.pluginId,
              removedPath: res.report.removedPath,
            },
            snapshot: res.snapshot,
          };
        }

        case "clean-stale-staging": {
          const removedPaths: AbsolutePath[] = [];
          try {
            if (plan.path !== undefined) {
              const parent = makeAbsolutePath(path.dirname(plan.path));
              const base = path.basename(plan.path);
              const validPrefix =
                base.startsWith(STAGING_PREFIX) || base.startsWith(BACKUP_PREFIX);
              if (!validPrefix) {
                return fail({
                  kind: "remediation-failed",
                  planKind: "clean-stale-staging",
                  reason: `Refusing to clean non-staging path "${plan.path}".`,
                });
              }
              let scope: InstallScope | null = null;
              if (parent === paths.userPluginsDir) {
                scope = "user";
              } else if (parent === paths.projectPluginsDir) {
                scope = "project";
              }
              if (scope === null) {
                return fail({
                  kind: "remediation-failed",
                  planKind: "clean-stale-staging",
                  reason: `Path "${plan.path}" is not inside a managed plugins root.`,
                });
              }
              const cleaned = await recoverAndCleanStagingArtifacts(
                parent,
                scope,
                undefined,
                plan.path,
              );
              removedPaths.push(...cleaned);
            } else {
              const [userCleaned, projectCleaned] = await Promise.all([
                recoverAndCleanStagingArtifacts(paths.userPluginsDir, "user"),
                recoverAndCleanStagingArtifacts(paths.projectPluginsDir, "project"),
              ]);
              removedPaths.push(...projectCleaned, ...userCleaned);
            }
          } catch (err) {
            return fail({
              kind: "remediation-failed",
              planKind: "clean-stale-staging",
              reason: errorMessage(err),
            });
          }

          const after = await commitSnapshot();
          return {
            ok: true,
            report: {
              kind: "cleaned-stale-staging",
              removedPaths,
            },
            snapshot: after,
          };
        }

        case "retry-marketplace-sync": {
          const res = await engine.syncMarketplaces({
            kind: "single",
            id: plan.marketplaceId,
          });
          if (!res.ok) {
            return {
              ok: false,
              error: {
                kind: "remediation-failed",
                planKind: "retry-marketplace-sync",
                reason:
                  res.error.kind === "marketplace-sync-failed"
                    ? res.error.reason
                    : `Retry failed (${res.error.kind}).`,
              },
              snapshot: res.snapshot,
            };
          }
          const outcome = res.report.outcomes[0];
          if (outcome === undefined) {
            return fail({
              kind: "remediation-failed",
              planKind: "retry-marketplace-sync",
              reason: "Sync produced no outcome.",
            });
          }
          return {
            ok: true,
            report: {
              kind: "retried-marketplace-sync",
              outcome,
            },
            snapshot: res.snapshot,
          };
        }

        default: {
          const _exhaustive: never = plan;
          return _exhaustive;
        }
      }
    },
  };

  return engine;
}
