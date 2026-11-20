import fs from "node:fs/promises";
import path from "node:path";
import {
  joinAbsolutePath,
  makeDiagnosticId,
  makeIsoTimestamp,
} from "../../domain/types.ts";
import type {
  AbsolutePath,
  CatalogEntry,
  Diagnostic,
  ManifestEcosystem,
  MarketplaceId,
  MarketplaceSource,
  ParsedMarketplaceInput,
  WorkspacePaths,
} from "../../domain/types.ts";
import type { MarketplaceSyncOutcome } from "../contract.ts";
import {
  normalizeJsonCatalog,
  normalizeMarketplaceRoot,
} from "./catalog.ts";
import { errorMessage, isRecord } from "./fs-safety.ts";
import {
  DEFAULT_NETWORK_TIMEOUT_MS,
  cloneOrUpdateGitMirror,
  isBareGitRepo,
  isInsideCanonicalDir,
  runGit,
} from "./git.ts";
import { parseJsoncBomSafe } from "./jsonc.ts";
import {
  loadSyncCache,
  marketplaceMirrorPath,
  saveSyncCache,
  syncCachePath,
} from "./stores.ts";
import type { KnownMarketplaceEntry, PersistedSyncCache } from "./stores.ts";

export async function resolveMarketplaceSource(
  input: ParsedMarketplaceInput,
  timeoutMs: number = DEFAULT_NETWORK_TIMEOUT_MS,
): Promise<
  | { readonly ok: true; readonly source: MarketplaceSource }
  | { readonly ok: false; readonly reason: string }
> {
  if (input.kind !== "https-auto") {
    return { ok: true, source: input };
  }

  const gitProbe = await runGit(["ls-remote", "--", input.url], {
    timeoutMs: Math.min(timeoutMs, 15_000),
  });
  // Require actual git OID ref lines so catch-all HTTP endpoints returning 200 JSON aren't mistaken for git remotes.
  if (gitProbe.ok && /^[0-9a-f]{40,64}\t/m.test(gitProbe.stdout)) {
    return {
      ok: true,
      source: {
        kind: "https-git",
        url: input.url,
        ...(input.ref !== undefined ? { ref: input.ref } : {}),
        ...(input.subdir !== undefined ? { subdir: input.subdir } : {}),
      },
    };
  }

  try {
    const response = await fetch(input.url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: `URL "${input.url}" is neither a reachable git remote nor an accessible JSON catalog (HTTP ${response.status}).`,
      };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const parsed = parseJsoncBomSafe(bytes);
    if (!parsed.ok || (!isRecord(parsed.value) && !Array.isArray(parsed.value))) {
      return {
        ok: false,
        reason: `URL "${input.url}" did not respond as a git remote or a valid JSON catalog.`,
      };
    }
    return {
      ok: true,
      source: {
        kind: "https-json",
        url: input.url,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to probe "${input.url}": ${errorMessage(err)}`,
    };
  }
}

function buildSyncFailedDiagnostic(
  marketplaceId: MarketplaceId,
  reason: string,
): Diagnostic {
  return {
    id: makeDiagnosticId("marketplace-sync-failed", marketplaceId),
    severity: "error",
    subject: { kind: "marketplace", marketplaceId },
    detail: {
      kind: "marketplace-sync-failed",
      marketplaceId,
      reason,
    },
    message: `Marketplace "${marketplaceId}" sync failed: ${reason}`,
    hint: "Verify network access, git credentials, or local path availability and retry sync.",
    remediation: {
      kind: "retry-marketplace-sync",
      marketplaceId,
      label: `Retry sync for ${marketplaceId}`,
    },
  };
}

async function persistSyncFailure(input: {
  readonly paths: WorkspacePaths;
  readonly marketplaceId: MarketplaceId;
  readonly previous: PersistedSyncCache | null;
  readonly reason: string;
  readonly extraDiagnostics?: readonly Diagnostic[];
}): Promise<MarketplaceSyncOutcome> {
  const { paths, marketplaceId, previous, reason, extraDiagnostics } = input;
  const attemptedAt = makeIsoTimestamp();
  const lastGoodSyncAt =
    previous === null
      ? null
      : previous.sync.kind === "synced"
        ? previous.sync.syncedAt
        : previous.sync.kind === "sync-failed"
          ? previous.sync.lastGoodSyncAt
          : null;

  const preservedEntries = previous?.entries ?? [];
  const diagnostics: Diagnostic[] = [buildSyncFailedDiagnostic(marketplaceId, reason)];
  if (extraDiagnostics !== undefined) {
    const seen = new Set(diagnostics.map((d) => d.id));
    for (const diag of extraDiagnostics) {
      if (!seen.has(diag.id)) {
        seen.add(diag.id);
        diagnostics.push(diag);
      }
    }
  }
  const nextCache: PersistedSyncCache = {
    schemaVersion: 1,
    marketplaceId,
    sync: {
      kind: "sync-failed",
      attemptedAt,
      lastGoodSyncAt,
      reason,
    },
    localMirrorPath: previous?.localMirrorPath ?? null,
    sourceMtimeMs: previous?.sourceMtimeMs ?? null,
    entries: preservedEntries,
    diagnostics,
  };

  await saveSyncCache(paths, nextCache);
  return {
    marketplaceId,
    status: "failed",
    pluginCount: preservedEntries.length,
    format: null,
    reason,
  };
}

async function persistSyncSuccess(input: {
  readonly paths: WorkspacePaths;
  readonly marketplaceId: MarketplaceId;
  readonly format: ManifestEcosystem;
  readonly entries: readonly CatalogEntry[];
  readonly diagnostics: readonly Diagnostic[];
  readonly resolvedRef: string | null;
  readonly resolvedSha: string | null;
  readonly localMirrorPath: AbsolutePath | null;
  readonly sourceMtimeMs: number | null;
}): Promise<MarketplaceSyncOutcome> {
  const cache: PersistedSyncCache = {
    schemaVersion: 1,
    marketplaceId: input.marketplaceId,
    sync: {
      kind: "synced",
      syncedAt: makeIsoTimestamp(),
      resolvedRef: input.resolvedRef,
      resolvedSha: input.resolvedSha,
      format: input.format,
      pluginCount: input.entries.length,
    },
    localMirrorPath: input.localMirrorPath,
    sourceMtimeMs: input.sourceMtimeMs,
    entries: input.entries,
    diagnostics: input.diagnostics,
  };
  await saveSyncCache(input.paths, cache);
  return {
    marketplaceId: input.marketplaceId,
    status: "synced",
    pluginCount: input.entries.length,
    format: input.format,
  };
}

export async function syncSingleMarketplace(
  paths: WorkspacePaths,
  entry: KnownMarketplaceEntry,
  timeoutMs: number = DEFAULT_NETWORK_TIMEOUT_MS,
): Promise<MarketplaceSyncOutcome> {
  const previous = await loadSyncCache(paths, entry.id);
  const { source } = entry;

  try {
    switch (source.kind) {
      case "github":
      case "ssh":
      case "https-git": {
        const remoteUrl =
          source.kind === "github"
            ? `https://github.com/${source.owner}/${source.repo}.git`
            : source.url;
        const mirrorDir = marketplaceMirrorPath(paths, entry.id);
        const synced = await cloneOrUpdateGitMirror({
          remoteUrl,
          mirrorDir,
          ref: source.ref,
          isLocalRepo: false,
          timeoutMs,
        });
        if (!synced.ok) {
          return persistSyncFailure({
            paths,
            marketplaceId: entry.id,
            previous,
            reason: synced.reason,
          });
        }
        let effectiveRoot = mirrorDir;
        if (source.subdir !== undefined) {
          effectiveRoot = joinAbsolutePath(mirrorDir, source.subdir);
          const canonicalMirror = await fs.realpath(mirrorDir);
          if (!(await isInsideCanonicalDir(effectiveRoot, canonicalMirror))) {
            return persistSyncFailure({
              paths,
              marketplaceId: entry.id,
              previous,
              reason: `Subdir "${source.subdir}" resolves outside marketplace mirror.`,
            });
          }
        }
        const normalized = await normalizeMarketplaceRoot(entry.id, effectiveRoot);
        if (!normalized.ok || normalized.format === null) {
          const reason =
            normalized.diagnostics[0]?.message ?? "Invalid marketplace manifest.";
          return persistSyncFailure({
            paths,
            marketplaceId: entry.id,
            previous,
            reason,
            extraDiagnostics: normalized.diagnostics,
          });
        }
        return persistSyncSuccess({
          paths,
          marketplaceId: entry.id,
          format: normalized.format,
          entries: normalized.entries,
          diagnostics: normalized.diagnostics,
          resolvedRef: synced.resolvedRef,
          resolvedSha: synced.resolvedSha,
          localMirrorPath: mirrorDir,
          sourceMtimeMs: null,
        });
      }

      case "local-folder": {
        let dirStat;
        try {
          dirStat = await fs.stat(source.path);
        } catch (err) {
          return persistSyncFailure({
            paths,
            marketplaceId: entry.id,
            previous,
            reason: `Local marketplace path "${source.path}" is inaccessible: ${errorMessage(err)}`,
          });
        }
        if (!dirStat.isDirectory()) {
          return persistSyncFailure({
            paths,
            marketplaceId: entry.id,
            previous,
            reason: `Local marketplace path "${source.path}" is not a directory.`,
          });
        }

        if (await isBareGitRepo(source.path)) {
          const mirrorDir = marketplaceMirrorPath(paths, entry.id);
          const synced = await cloneOrUpdateGitMirror({
            remoteUrl: source.path,
            mirrorDir,
            isLocalRepo: true,
            timeoutMs,
          });
          if (!synced.ok) {
            return persistSyncFailure({
              paths,
              marketplaceId: entry.id,
              previous,
              reason: synced.reason,
            });
          }
          const normalized = await normalizeMarketplaceRoot(entry.id, mirrorDir);
          if (!normalized.ok || normalized.format === null) {
            const reason =
              normalized.diagnostics[0]?.message ?? "Invalid marketplace manifest in git repo.";
            return persistSyncFailure({
              paths,
              marketplaceId: entry.id,
              previous,
              reason,
              extraDiagnostics: normalized.diagnostics,
            });
          }
          return persistSyncSuccess({
            paths,
            marketplaceId: entry.id,
            format: normalized.format,
            entries: normalized.entries,
            diagnostics: normalized.diagnostics,
            resolvedRef: synced.resolvedRef,
            resolvedSha: synced.resolvedSha,
            localMirrorPath: mirrorDir,
            sourceMtimeMs: dirStat.mtimeMs,
          });
        }

        let resolvedSha: string | null = null;
        let resolvedRef: string | null = null;
        const hasDotGit = await fs
          .lstat(path.join(source.path, ".git"))
          .then(() => true)
          .catch(() => false);
        if (hasDotGit) {
          const shaRes = await runGit(["rev-parse", "HEAD"], {
            cwd: source.path,
            timeoutMs: 5_000,
          });
          if (shaRes.ok) {
            resolvedSha = shaRes.stdout.trim() || null;
          }
          const refRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd: source.path,
            timeoutMs: 5_000,
          });
          if (refRes.ok && refRes.stdout.trim() !== "HEAD") {
            resolvedRef = refRes.stdout.trim() || null;
          }
        }

        const normalized = await normalizeMarketplaceRoot(entry.id, source.path);
        if (!normalized.ok || normalized.format === null) {
          const reason =
            normalized.diagnostics[0]?.message ?? "Invalid local folder marketplace.";
          return persistSyncFailure({
            paths,
            marketplaceId: entry.id,
            previous,
            reason,
            extraDiagnostics: normalized.diagnostics,
          });
        }

        return persistSyncSuccess({
          paths,
          marketplaceId: entry.id,
          format: normalized.format,
          entries: normalized.entries,
          diagnostics: normalized.diagnostics,
          resolvedRef,
          resolvedSha,
          localMirrorPath: null,
          sourceMtimeMs: dirStat.mtimeMs,
        });
      }

      case "local-json": {
        let stat;
        let bytes: Uint8Array;
        try {
          stat = await fs.stat(source.path);
          bytes = await fs.readFile(source.path);
        } catch (err) {
          return persistSyncFailure({
            paths,
            marketplaceId: entry.id,
            previous,
            reason: `Failed to read local JSON catalog "${source.path}": ${errorMessage(err)}`,
          });
        }
        const normalized = await normalizeJsonCatalog(entry.id, source.path, bytes);
        if (!normalized.ok || normalized.format === null) {
          const reason =
            normalized.diagnostics[0]?.message ?? "Invalid local JSON catalog.";
          return persistSyncFailure({
            paths,
            marketplaceId: entry.id,
            previous,
            reason,
            extraDiagnostics: normalized.diagnostics,
          });
        }
        return persistSyncSuccess({
          paths,
          marketplaceId: entry.id,
          format: normalized.format,
          entries: normalized.entries,
          diagnostics: normalized.diagnostics,
          resolvedRef: null,
          resolvedSha: null,
          localMirrorPath: null,
          sourceMtimeMs: stat.mtimeMs,
        });
      }

      case "https-json": {
        let bytes: Uint8Array;
        try {
          const response = await fetch(source.url, {
            signal: AbortSignal.timeout(timeoutMs),
            headers: { Accept: "application/json" },
          });
          if (!response.ok) {
            return persistSyncFailure({
              paths,
              marketplaceId: entry.id,
              previous,
              reason: `HTTP ${response.status} fetching "${source.url}".`,
            });
          }
          bytes = new Uint8Array(await response.arrayBuffer());
        } catch (err) {
          return persistSyncFailure({
            paths,
            marketplaceId: entry.id,
            previous,
            reason: `Network error fetching "${source.url}": ${errorMessage(err)}`,
          });
        }
        const normalized = await normalizeJsonCatalog(
          entry.id,
          syncCachePath(paths, entry.id),
          bytes,
        );
        if (!normalized.ok || normalized.format === null) {
          const reason =
            normalized.diagnostics[0]?.message ?? "Invalid remote JSON catalog.";
          return persistSyncFailure({
            paths,
            marketplaceId: entry.id,
            previous,
            reason,
            extraDiagnostics: normalized.diagnostics,
          });
        }
        return persistSyncSuccess({
          paths,
          marketplaceId: entry.id,
          format: normalized.format,
          entries: normalized.entries,
          diagnostics: normalized.diagnostics,
          resolvedRef: null,
          resolvedSha: null,
          localMirrorPath: null,
          sourceMtimeMs: null,
        });
      }

      default: {
        const _exhaustive: never = source;
        return _exhaustive;
      }
    }
  } catch (err) {
    return persistSyncFailure({
      paths,
      marketplaceId: entry.id,
      previous,
      reason: errorMessage(err),
    });
  }
}
