import fs from "node:fs/promises";
import path from "node:path";
import { formatMarketplaceSource } from "../../domain/query.ts";
import {
  isAtLeastTwo,
  isCatalogEntryId,
  isMarketplaceId,
  makeInstalledPluginId,
  makeIsoTimestamp,
  makePluginName,
  slugifyPluginDirName,
} from "../../domain/types.ts";
import type {
  AbsolutePath,
  CatalogEntry,
  CatalogEntryId,
  EngineError,
  EngineResult,
  InstallTarget,
  InstalledPlugin,
  MarketplaceId,
  MarketplaceSource,
  PluginDirName,
  PluginInstallSource,
  PluginName,
  WorkspaceSnapshot,
} from "../../domain/types.ts";
import type { InstallPluginInput, InstallReport } from "../contract.ts";
import { adaptAndInstallBundle } from "./adapter.ts";
import {
  marketplaceSourceToPluginInstallSource,
  toEngineError,
} from "./engine-context.ts";
import type { EngineRuntime } from "./engine-context.ts";
import { resolveMarketplaceSource } from "./fetcher.ts";
import {
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
  loadAllSyncCaches,
  loadKnownMarketplaces,
  saveReceipt,
  scopeRootFor,
} from "./stores.ts";
import type { ManagedProvenance, PersistedReceipt } from "./stores.ts";

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

interface ResolvedInstallTarget {
  readonly installSource: PluginInstallSource;
  readonly defaultDirName: PluginDirName;
  readonly provenanceKind: "marketplace" | "direct";
  readonly marketplaceId?: MarketplaceId;
  readonly entryId?: CatalogEntryId;
  readonly fallbackName?: string;
  readonly catalogVersion: string | null;
}

function resolvedFromCatalogEntry(entry: CatalogEntry): ResolvedInstallTarget {
  return {
    installSource: entry.installSource,
    defaultDirName: entry.slug,
    provenanceKind: "marketplace",
    marketplaceId: entry.marketplaceId,
    entryId: entry.id,
    fallbackName: entry.name,
    catalogVersion: entry.version,
  };
}

async function resolveInstallTarget(
  before: WorkspaceSnapshot,
  target: InstallTarget,
  timeoutMs: number,
): Promise<
  | { readonly ok: true; readonly resolved: ResolvedInstallTarget }
  | { readonly ok: false; readonly error: EngineError }
> {
  switch (target.kind) {
    case "catalog-entry": {
      const entry = before.catalogById.get(target.entryId);
      if (entry === undefined) {
        return { ok: false, error: { kind: "catalog-entry-not-found", target: target.entryId } };
      }
      return { ok: true, resolved: resolvedFromCatalogEntry(entry) };
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
        return { ok: false, error: { kind: "catalog-entry-not-found", target: label } };
      }
      if (matches.length > 1) {
        const candidateIds = matches.map((m) => m.id);
        if (isAtLeastTwo(candidateIds)) {
          return {
            ok: false,
            error: {
              kind: "ambiguous-catalog-target",
              name: target.name,
              candidates: candidateIds,
            },
          };
        }
      }
      const matched = matches[0];
      if (matched === undefined) {
        return { ok: false, error: { kind: "catalog-entry-not-found", target: target.name } };
      }
      return { ok: true, resolved: resolvedFromCatalogEntry(matched) };
    }
    case "catalog-or-github": {
      const catalogEntry = lookupCatalogEntryForPair(before, target.left, target.right);
      if (catalogEntry !== null) {
        return { ok: true, resolved: resolvedFromCatalogEntry(catalogEntry) };
      }
      const directSrc = marketplaceSourceToPluginInstallSource(target.githubSource);
      if (directSrc === null) {
        return {
          ok: false,
          error: {
            kind: "catalog-entry-not-found",
            target: `${target.left}/${target.right}`,
          },
        };
      }
      const defaultDirName = defaultDirNameFromSource(target.githubSource);
      return {
        ok: true,
        resolved: {
          installSource: directSrc,
          defaultDirName,
          provenanceKind: "direct",
          fallbackName: defaultDirName,
          catalogVersion: null,
        },
      };
    }
    case "direct-source": {
      const resolved = await resolveMarketplaceSource(target.source, timeoutMs);
      if (!resolved.ok) {
        return {
          ok: false,
          error: {
            kind: "io-failed",
            operation: "resolve-direct-source",
            reason: resolved.reason,
          },
        };
      }
      const directSrc = marketplaceSourceToPluginInstallSource(resolved.source);
      if (directSrc === null) {
        return {
          ok: false,
          error: {
            kind: "catalog-entry-not-found",
            target: formatMarketplaceSource(resolved.source),
          },
        };
      }
      const defaultDirName = defaultDirNameFromSource(resolved.source);
      return {
        ok: true,
        resolved: {
          installSource: directSrc,
          defaultDirName,
          provenanceKind: "direct",
          fallbackName: defaultDirName,
          catalogVersion: null,
        },
      };
    }
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

export async function opInstall(
  ctx: EngineRuntime,
  input: InstallPluginInput,
): Promise<EngineResult<InstallReport>> {
  const { paths, timeoutMs } = ctx;
  const before = await ctx.projectSnapshot();

  const resolvedTarget = await resolveInstallTarget(before, input.target, timeoutMs);
  if (!resolvedTarget.ok) {
    return ctx.fail(resolvedTarget.error);
  }
  const {
    installSource,
    defaultDirName,
    provenanceKind,
    marketplaceId,
    entryId,
    fallbackName,
    catalogVersion,
  } = resolvedTarget.resolved;

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
      return ctx.fail({ kind: "path-traversal", offendingPath: materialized.offendingPath });
    }
    return ctx.fail({
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
      (candidatePluginName !== null
        ? slugifyPluginDirName(candidatePluginName, defaultDirName)
        : defaultDirName);
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
        return ctx.fail({
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
          return ctx.fail({
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
      return ctx.fail(toEngineError(adapted));
    }

    const after = await ctx.commitMutation();
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
    return ctx.mapLockOrIoError(err, "install");
  } finally {
    await bundle.cleanup();
  }
}
