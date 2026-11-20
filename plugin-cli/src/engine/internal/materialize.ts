import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { joinAbsolutePath, makeAbsolutePath } from "../../domain/types.ts";
import type {
  AbsolutePath,
  MarketplaceId,
  PluginInstallSource,
  WorkspacePaths,
} from "../../domain/types.ts";
import { errorMessage } from "./fs-safety.ts";
import {
  DEFAULT_NETWORK_TIMEOUT_MS,
  cloneGitIntoTempDir,
  isBareGitRepo,
  isInsideCanonicalDir,
} from "./git.ts";
import type { MaterializeResult } from "./git.ts";
import type { KnownMarketplaceEntry, PersistedSyncCache } from "./stores.ts";

const execFileAsync = promisify(execFile);

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
    case "marketplace-root":
    case "marketplace-subdir": {
      const opName =
        installSource.kind === "marketplace-root"
          ? "materialize-marketplace-root"
          : "materialize-marketplace-subdir";
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
          operation: opName,
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
        let canonicalMirror: string;
        try {
          canonicalMirror = await fs.realpath(baseDir);
        } catch (err) {
          return {
            ok: false,
            kind: "io-failed",
            operation: opName,
            reason: errorMessage(err),
          };
        }
        if (!(await isInsideCanonicalDir(effectiveBase, canonicalMirror))) {
          return { ok: false, kind: "path-traversal", offendingPath: mkt.source.subdir };
        }
      }

      const sourceDir =
        installSource.kind === "marketplace-root"
          ? effectiveBase
          : joinAbsolutePath(effectiveBase, installSource.subdir);
      if (installSource.kind === "marketplace-subdir") {
        let canonicalBase: string;
        try {
          canonicalBase = await fs.realpath(effectiveBase);
        } catch (err) {
          return {
            ok: false,
            kind: "io-failed",
            operation: opName,
            reason: errorMessage(err),
          };
        }
        if (!(await isInsideCanonicalDir(sourceDir, canonicalBase))) {
          return { ok: false, kind: "path-traversal", offendingPath: installSource.subdir };
        }
      }

      const stat = await fs.stat(sourceDir).catch(() => null);
      if (stat === null || !stat.isDirectory()) {
        return {
          ok: false,
          kind: "io-failed",
          operation: opName,
          reason:
            installSource.kind === "marketplace-root"
              ? `Marketplace root directory not found for "${installSource.marketplaceId}".`
              : `Plugin directory "${installSource.subdir}" not found in marketplace "${installSource.marketplaceId}".`,
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
