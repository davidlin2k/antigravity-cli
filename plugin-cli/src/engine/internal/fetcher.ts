import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  joinAbsolutePath,
  makeAbsolutePath,
  makeDiagnosticId,
  makeIsoTimestamp,
} from "../../domain/types.ts";
import type {
  AbsolutePath,
  Diagnostic,
  ManifestEcosystem,
  MarketplaceId,
  MarketplaceSource,
  ParsedMarketplaceInput,
  PluginInstallSource,
  RelativeSubpath,
  WorkspacePaths,
} from "../../domain/types.ts";
import type { MarketplaceSyncOutcome } from "../contract.ts";
import {
  normalizeJsonCatalog,
  normalizeMarketplaceRoot,
  parseJsoncBomSafe,
} from "./normalizer.ts";
import {
  errorMessage,
  isRecord,
  loadSyncCache,
  marketplaceMirrorPath,
  saveSyncCache,
  syncCachePath,
} from "./stores.ts";
import type { KnownMarketplaceEntry, PersistedSyncCache } from "./stores.ts";

const execFileAsync = promisify(execFile);

export const DEFAULT_NETWORK_TIMEOUT_MS = 30_000;

export interface GitRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly message: string;
}

export async function runGit(
  args: readonly string[],
  options?: {
    readonly cwd?: AbsolutePath | string;
    readonly timeoutMs?: number;
  },
): Promise<GitRunResult> {
  const timeout = options?.timeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS;
  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], {
      cwd: options?.cwd,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
        GCM_INTERACTIVE: "never",
      },
    });
    return { ok: true, stdout, stderr, message: "" };
  } catch (err) {
    const stderr =
      isRecord(err) && typeof err.stderr === "string" ? err.stderr.trim() : "";
    const stdout =
      isRecord(err) && typeof err.stdout === "string" ? err.stdout.trim() : "";
    const msg = stderr.length > 0 ? stderr : errorMessage(err);
    return { ok: false, stdout, stderr, message: msg };
  }
}

export async function isBareGitRepo(dirPath: AbsolutePath): Promise<boolean> {
  try {
    const headStat = await fs.stat(path.join(dirPath, "HEAD"));
    const objectsStat = await fs.stat(path.join(dirPath, "objects"));
    if (!headStat.isFile() || !objectsStat.isDirectory()) {
      return false;
    }
    const dotGitExists = await fs
      .lstat(path.join(dirPath, ".git"))
      .then(() => true)
      .catch(() => false);
    if (dotGitExists) {
      return false;
    }
    const check = await runGit(["-C", dirPath, "rev-parse", "--is-bare-repository"], {
      timeoutMs: 5_000,
    });
    return check.ok && check.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Resolves an `https-auto` marketplace input once at `addMarketplace` into either
 * `https-git` (when `git ls-remote` succeeds) or `https-json` (when HTTP returns JSON).
 */
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

async function isInsideCanonicalDir(candidate: string, canonicalBase: string): Promise<boolean> {
  try {
    const resolved = await fs.realpath(candidate);
    return resolved === canonicalBase || resolved.startsWith(`${canonicalBase}${path.sep}`);
  } catch {
    return false;
  }
}

async function cloneOrUpdateGitMirror(input: {
  readonly remoteUrl: string;
  readonly mirrorDir: AbsolutePath;
  readonly ref?: string;
  readonly isLocalRepo: boolean;
  readonly timeoutMs: number;
}): Promise<
  | { readonly ok: true; readonly resolvedRef: string | null; readonly resolvedSha: string | null }
  | { readonly ok: false; readonly reason: string }
> {
  const { remoteUrl, mirrorDir, ref, isLocalRepo, timeoutMs } = input;
  const dotGitDir = path.join(mirrorDir, ".git");
  const mirrorExists = await fs
    .stat(dotGitDir)
    .then((s) => s.isDirectory())
    .catch(() => false);

  if (!mirrorExists) {
    await fs.rm(mirrorDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.dirname(mirrorDir), { recursive: true });

    const cloneArgs: string[] = ["clone"];
    if (!isLocalRepo) {
      cloneArgs.push("--depth", "1");
    }
    if (ref !== undefined) {
      cloneArgs.push("--branch", ref);
    }
    cloneArgs.push("--", remoteUrl, mirrorDir);

    let cloned = await runGit(cloneArgs, { timeoutMs });
    if (!cloned.ok && ref !== undefined) {
      // Fallback when `ref` is a commit SHA or tag unsupported by `--branch`.
      await fs.rm(mirrorDir, { recursive: true, force: true }).catch(() => {});
      cloned = await runGit(["clone", "--", remoteUrl, mirrorDir], { timeoutMs });
      if (cloned.ok) {
        const co = await runGit(["checkout", "--force", ref], { cwd: mirrorDir, timeoutMs });
        if (!co.ok) {
          return { ok: false, reason: `git checkout ${ref} failed: ${co.message}` };
        }
      }
    }
    if (!cloned.ok) {
      return { ok: false, reason: `git clone failed: ${cloned.message}` };
    }
  } else {
    const fetchTarget = ref ?? "HEAD";
    const fetchArgs = isLocalRepo
      ? ["fetch", "origin", fetchTarget]
      : ["fetch", "--depth", "1", "origin", fetchTarget];
    let fetched = await runGit(fetchArgs, { cwd: mirrorDir, timeoutMs });
    if (!fetched.ok && !isLocalRepo) {
      fetched = await runGit(["fetch", "origin", fetchTarget], { cwd: mirrorDir, timeoutMs });
    }
    if (!fetched.ok) {
      fetched = await runGit(["fetch", "--prune", "origin"], { cwd: mirrorDir, timeoutMs });
      if (!fetched.ok) {
        return { ok: false, reason: `git fetch failed: ${fetched.message}` };
      }
      if (ref !== undefined) {
        const co = await runGit(["checkout", "--force", ref], { cwd: mirrorDir, timeoutMs });
        if (!co.ok) {
          return { ok: false, reason: `git checkout ${ref} failed: ${co.message}` };
        }
      }
    } else {
      const reset = await runGit(["reset", "--hard", "FETCH_HEAD"], { cwd: mirrorDir, timeoutMs });
      if (!reset.ok) {
        return { ok: false, reason: `git reset failed: ${reset.message}` };
      }
    }
    await runGit(["clean", "-fd"], { cwd: mirrorDir, timeoutMs });
  }

  const shaRes = await runGit(["rev-parse", "HEAD"], { cwd: mirrorDir, timeoutMs: 5_000 });
  const resolvedSha = shaRes.ok ? shaRes.stdout.trim() || null : null;

  let resolvedRef: string | null = ref ?? null;
  if (resolvedRef === null) {
    const sym = await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: mirrorDir,
      timeoutMs: 5_000,
    });
    if (sym.ok) {
      const raw = sym.stdout.trim();
      resolvedRef = raw.startsWith("origin/") ? raw.slice("origin/".length) : raw || null;
    } else {
      const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: mirrorDir,
        timeoutMs: 5_000,
      });
      if (branch.ok && branch.stdout.trim() !== "HEAD") {
        resolvedRef = branch.stdout.trim() || null;
      }
    }
  }

  return { ok: true, resolvedRef, resolvedSha };
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
}): Promise<MarketplaceSyncOutcome> {
  const { paths, marketplaceId, previous, reason } = input;
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
    diagnostics: [buildSyncFailedDiagnostic(marketplaceId, reason)],
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

/**
 * Syncs one marketplace into its isolated `cache/sync/<marketplaceId>.json` file.
 * Preserves last known good catalog entries if the sync fails.
 */
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
          });
        }
        const cache: PersistedSyncCache = {
          schemaVersion: 1,
          marketplaceId: entry.id,
          sync: {
            kind: "synced",
            syncedAt: makeIsoTimestamp(),
            resolvedRef: synced.resolvedRef,
            resolvedSha: synced.resolvedSha,
            format: normalized.format,
            pluginCount: normalized.entries.length,
          },
          localMirrorPath: mirrorDir,
          sourceMtimeMs: null,
          entries: normalized.entries,
          diagnostics: normalized.diagnostics,
        };
        await saveSyncCache(paths, cache);
        return {
          marketplaceId: entry.id,
          status: "synced",
          pluginCount: normalized.entries.length,
          format: normalized.format,
        };
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
            });
          }
          const cache: PersistedSyncCache = {
            schemaVersion: 1,
            marketplaceId: entry.id,
            sync: {
              kind: "synced",
              syncedAt: makeIsoTimestamp(),
              resolvedRef: synced.resolvedRef,
              resolvedSha: synced.resolvedSha,
              format: normalized.format,
              pluginCount: normalized.entries.length,
            },
            localMirrorPath: mirrorDir,
            sourceMtimeMs: dirStat.mtimeMs,
            entries: normalized.entries,
            diagnostics: normalized.diagnostics,
          };
          await saveSyncCache(paths, cache);
          return {
            marketplaceId: entry.id,
            status: "synced",
            pluginCount: normalized.entries.length,
            format: normalized.format,
          };
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
          });
        }

        const cache: PersistedSyncCache = {
          schemaVersion: 1,
          marketplaceId: entry.id,
          sync: {
            kind: "synced",
            syncedAt: makeIsoTimestamp(),
            resolvedRef,
            resolvedSha,
            format: normalized.format,
            pluginCount: normalized.entries.length,
          },
          localMirrorPath: null,
          sourceMtimeMs: dirStat.mtimeMs,
          entries: normalized.entries,
          diagnostics: normalized.diagnostics,
        };
        await saveSyncCache(paths, cache);
        return {
          marketplaceId: entry.id,
          status: "synced",
          pluginCount: normalized.entries.length,
          format: normalized.format,
        };
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
          });
        }
        const cache: PersistedSyncCache = {
          schemaVersion: 1,
          marketplaceId: entry.id,
          sync: {
            kind: "synced",
            syncedAt: makeIsoTimestamp(),
            resolvedRef: null,
            resolvedSha: null,
            format: normalized.format,
            pluginCount: normalized.entries.length,
          },
          localMirrorPath: null,
          sourceMtimeMs: stat.mtimeMs,
          entries: normalized.entries,
          diagnostics: normalized.diagnostics,
        };
        await saveSyncCache(paths, cache);
        return {
          marketplaceId: entry.id,
          status: "synced",
          pluginCount: normalized.entries.length,
          format: normalized.format,
        };
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
          });
        }
        const cache: PersistedSyncCache = {
          schemaVersion: 1,
          marketplaceId: entry.id,
          sync: {
            kind: "synced",
            syncedAt: makeIsoTimestamp(),
            resolvedRef: null,
            resolvedSha: null,
            format: normalized.format,
            pluginCount: normalized.entries.length,
          },
          localMirrorPath: null,
          sourceMtimeMs: null,
          entries: normalized.entries,
          diagnostics: normalized.diagnostics,
        };
        await saveSyncCache(paths, cache);
        return {
          marketplaceId: entry.id,
          status: "synced",
          pluginCount: normalized.entries.length,
          format: normalized.format,
        };
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

export interface MaterializedBundle {
  readonly sourceDir: AbsolutePath;
  readonly resolvedSha: string | null;
  readonly cleanup: () => Promise<void>;
}

export type MaterializeResult =
  | { readonly ok: true; readonly bundle: MaterializedBundle }
  | { readonly ok: false; readonly kind: "path-traversal"; readonly offendingPath: string }
  | { readonly ok: false; readonly kind: "io-failed"; readonly operation: string; readonly reason: string };

async function cloneGitIntoTempDir(input: {
  readonly repoUrl: string;
  readonly ref?: string;
  readonly sha?: string;
  readonly subdir?: RelativeSubpath;
  readonly isLocalRepo?: boolean;
  readonly timeoutMs: number;
}): Promise<MaterializeResult> {
  const tmpDir = makeAbsolutePath(await fs.mkdtemp(path.join(os.tmpdir(), "agy-plugin-fetch-")));
  const cleanup = async (): Promise<void> => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const cloneArgs: string[] = ["clone"];
    if (!input.isLocalRepo && input.sha === undefined) {
      cloneArgs.push("--depth", "1");
    }
    if (input.ref !== undefined && input.sha === undefined) {
      cloneArgs.push("--branch", input.ref);
    }
    cloneArgs.push("--", input.repoUrl, tmpDir);

    let cloned = await runGit(cloneArgs, { timeoutMs: input.timeoutMs });
    if (!cloned.ok && input.ref !== undefined && input.sha === undefined) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(tmpDir, { recursive: true });
      cloned = await runGit(["clone", "--", input.repoUrl, tmpDir], {
        timeoutMs: input.timeoutMs,
      });
      if (cloned.ok) {
        const co = await runGit(["checkout", "--force", input.ref], {
          cwd: tmpDir,
          timeoutMs: input.timeoutMs,
        });
        if (!co.ok) {
          await cleanup();
          return {
            ok: false,
            kind: "io-failed",
            operation: "git-checkout",
            reason: co.message,
          };
        }
      }
    }
    if (!cloned.ok) {
      await cleanup();
      return {
        ok: false,
        kind: "io-failed",
        operation: "git-clone",
        reason: cloned.message,
      };
    }

    if (input.sha !== undefined) {
      const co = await runGit(["checkout", "--force", input.sha], {
        cwd: tmpDir,
        timeoutMs: input.timeoutMs,
      });
      if (!co.ok) {
        await cleanup();
        return {
          ok: false,
          kind: "io-failed",
          operation: "git-checkout",
          reason: `Could not check out commit ${input.sha}: ${co.message}`,
        };
      }
    }

    const shaRes = await runGit(["rev-parse", "HEAD"], { cwd: tmpDir, timeoutMs: 5_000 });
    const resolvedSha = shaRes.ok ? shaRes.stdout.trim() || null : null;

    let sourceDir = tmpDir;
    if (input.subdir !== undefined) {
      sourceDir = joinAbsolutePath(tmpDir, input.subdir);
      const canonicalTmp = await fs.realpath(tmpDir);
      if (!(await isInsideCanonicalDir(sourceDir, canonicalTmp))) {
        await cleanup();
        return { ok: false, kind: "path-traversal", offendingPath: input.subdir };
      }
      const stat = await fs.stat(sourceDir).catch(() => null);
      if (stat === null || !stat.isDirectory()) {
        await cleanup();
        return {
          ok: false,
          kind: "io-failed",
          operation: "materialize-subdir",
          reason: `Subdirectory "${input.subdir}" does not exist in "${input.repoUrl}".`,
        };
      }
    }

    return {
      ok: true,
      bundle: { sourceDir, resolvedSha, cleanup },
    };
  } catch (err) {
    await cleanup();
    return {
      ok: false,
      kind: "io-failed",
      operation: "materialize-git",
      reason: errorMessage(err),
    };
  }
}

export async function materializeInstallSource(input: {
  readonly installSource: PluginInstallSource;
  readonly paths: WorkspacePaths;
  readonly marketplaces: readonly KnownMarketplaceEntry[];
  readonly syncCaches: ReadonlyMap<MarketplaceId, PersistedSyncCache>;
  readonly timeoutMs?: number;
}): Promise<MaterializeResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS;
  const { installSource } = input;

  switch (installSource.kind) {
    case "marketplace-subdir": {
      const mkt = input.marketplaces.find((m) => m.id === installSource.marketplaceId);
      const cache = input.syncCaches.get(installSource.marketplaceId) ?? null;

      let baseDir: AbsolutePath | null = cache?.localMirrorPath ?? null;
      if (baseDir === null && mkt?.source.kind === "local-folder") {
        baseDir = mkt.source.path;
      }
      if (baseDir === null) {
        return {
          ok: false,
          kind: "io-failed",
          operation: "materialize-marketplace-subdir",
          reason: `Marketplace "${installSource.marketplaceId}" has no local mirror or folder on disk. Run marketplace update first.`,
        };
      }

      let effectiveBase = baseDir;
      if (
        mkt !== undefined &&
        (mkt.source.kind === "github" ||
          mkt.source.kind === "ssh" ||
          mkt.source.kind === "https-git") &&
        mkt.source.subdir !== undefined
      ) {
        effectiveBase = joinAbsolutePath(baseDir, mkt.source.subdir);
      }

      const sourceDir = joinAbsolutePath(effectiveBase, installSource.subdir);
      let canonicalBase: string;
      try {
        canonicalBase = await fs.realpath(effectiveBase);
      } catch (err) {
        return {
          ok: false,
          kind: "io-failed",
          operation: "materialize-marketplace-subdir",
          reason: errorMessage(err),
        };
      }
      if (!(await isInsideCanonicalDir(sourceDir, canonicalBase))) {
        return { ok: false, kind: "path-traversal", offendingPath: installSource.subdir };
      }
      const stat = await fs.stat(sourceDir).catch(() => null);
      if (stat === null || !stat.isDirectory()) {
        return {
          ok: false,
          kind: "io-failed",
          operation: "materialize-marketplace-subdir",
          reason: `Plugin directory "${installSource.subdir}" not found in marketplace "${installSource.marketplaceId}".`,
        };
      }
      const resolvedSha =
        cache !== null && cache.sync.kind === "synced" ? cache.sync.resolvedSha : null;
      return {
        ok: true,
        bundle: {
          sourceDir,
          resolvedSha,
          cleanup: async () => {},
        },
      };
    }

    case "local-dir": {
      const stat = await fs.stat(installSource.path).catch(() => null);
      if (stat === null || !stat.isDirectory()) {
        return {
          ok: false,
          kind: "io-failed",
          operation: "materialize-local-dir",
          reason: `Local plugin directory "${installSource.path}" does not exist.`,
        };
      }
      if (await isBareGitRepo(installSource.path)) {
        return cloneGitIntoTempDir({
          repoUrl: installSource.path,
          isLocalRepo: true,
          timeoutMs,
        });
      }
      return {
        ok: true,
        bundle: {
          sourceDir: installSource.path,
          resolvedSha: null,
          cleanup: async () => {},
        },
      };
    }

    case "git-repo":
      return cloneGitIntoTempDir({
        repoUrl: installSource.repoUrl,
        ref: installSource.ref,
        sha: installSource.sha,
        timeoutMs,
      });

    case "git-subdir":
      return cloneGitIntoTempDir({
        repoUrl: installSource.repoUrl,
        ref: installSource.ref,
        sha: installSource.sha,
        subdir: installSource.subdir,
        timeoutMs,
      });

    case "archive-url": {
      const tmpDir = makeAbsolutePath(
        await fs.mkdtemp(path.join(os.tmpdir(), "agy-plugin-archive-")),
      );
      const cleanup = async (): Promise<void> => {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      };
      try {
        const res = await fetch(installSource.url, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          await cleanup();
          return {
            ok: false,
            kind: "io-failed",
            operation: "fetch-archive",
            reason: `HTTP ${res.status} downloading "${installSource.url}".`,
          };
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (installSource.sha256 !== undefined) {
          const digest = crypto.createHash("sha256").update(bytes).digest("hex");
          if (digest !== installSource.sha256.toLowerCase()) {
            await cleanup();
            return {
              ok: false,
              kind: "io-failed",
              operation: "verify-archive",
              reason: `Archive SHA-256 mismatch: expected ${installSource.sha256}, got ${digest}.`,
            };
          }
        }
        const archivePath = path.join(tmpDir, "bundle.tar.gz");
        const extractDir = makeAbsolutePath(path.join(tmpDir, "extracted"));
        await fs.writeFile(archivePath, bytes);
        await fs.mkdir(extractDir, { recursive: true });
        await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDir], {
          timeout: timeoutMs,
        });
        const entries = await fs.readdir(extractDir, { withFileTypes: true });
        let sourceDir = extractDir;
        if (entries.length === 1 && entries[0]?.isDirectory()) {
          sourceDir = makeAbsolutePath(path.join(extractDir, entries[0].name));
        }
        return {
          ok: true,
          bundle: { sourceDir, resolvedSha: null, cleanup },
        };
      } catch (err) {
        await cleanup();
        return {
          ok: false,
          kind: "io-failed",
          operation: "extract-archive",
          reason: errorMessage(err),
        };
      }
    }

    default: {
      const _exhaustive: never = installSource;
      return _exhaustive;
    }
  }
}

export type { ManifestEcosystem };
