import fs from "node:fs/promises";
import path from "node:path";
import { makeAbsolutePath } from "../../domain/types.ts";
import type { AbsolutePath } from "../../domain/types.ts";
import {
  errorMessage,
  isRecord,
  isWithinCanonicalRoot,
  resolvePossiblyDanglingTarget,
} from "./fs-safety.ts";

const PLUGIN_ROOT_REPLACE_RE = /\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/g;

export function expandPluginRootInValue(
  value: unknown,
  finalInstallPath: AbsolutePath,
): { readonly value: unknown; readonly expanded: boolean } {
  if (typeof value === "string") {
    PLUGIN_ROOT_REPLACE_RE.lastIndex = 0;
    if (!PLUGIN_ROOT_REPLACE_RE.test(value)) {
      return { value, expanded: false };
    }
    PLUGIN_ROOT_REPLACE_RE.lastIndex = 0;
    return {
      value: value.replace(PLUGIN_ROOT_REPLACE_RE, finalInstallPath),
      expanded: true,
    };
  }
  if (Array.isArray(value)) {
    let expanded = false;
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i += 1) {
      const item = expandPluginRootInValue(value[i], finalInstallPath);
      out[i] = item.value;
      if (item.expanded) {
        expanded = true;
      }
    }
    return { value: out, expanded };
  }
  if (isRecord(value)) {
    let expanded = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const child = expandPluginRootInValue(v, finalInstallPath);
      out[k] = child.value;
      if (child.expanded) {
        expanded = true;
      }
    }
    return { value: out, expanded };
  }
  return { value, expanded: false };
}

export async function copyDirectorySafely(input: {
  readonly currentSrc: AbsolutePath;
  readonly currentDest: AbsolutePath;
  readonly canonicalSourceRoot: string;
  readonly relPrefix: string;
  readonly ancestorRealDirs: ReadonlySet<string>;
}): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: "path-traversal"; readonly offendingPath: string }
> {
  await fs.mkdir(input.currentDest, { recursive: true });
  const entries = await fs.readdir(input.currentSrc, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".git" && input.relPrefix === "") {
      continue;
    }
    if (entry.name === ".." || entry.name === "." || entry.name.includes("\0")) {
      return { ok: false, kind: "path-traversal", offendingPath: entry.name };
    }
    const relPath = input.relPrefix.length > 0 ? `${input.relPrefix}/${entry.name}` : entry.name;
    const srcPath = makeAbsolutePath(path.join(input.currentSrc, entry.name));
    const destPath = makeAbsolutePath(path.join(input.currentDest, entry.name));

    const lstat = await fs.lstat(srcPath);
    if (lstat.isSymbolicLink()) {
      let resolved: string;
      let targetStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
      try {
        resolved = await fs.realpath(srcPath);
        targetStat = await fs.stat(srcPath);
      } catch {
        const rawLink = await fs.readlink(srcPath);
        resolved = await resolvePossiblyDanglingTarget(input.currentSrc, rawLink);
      }
      if (!isWithinCanonicalRoot(resolved, input.canonicalSourceRoot)) {
        return { ok: false, kind: "path-traversal", offendingPath: relPath };
      }
      if (targetStat === null) {
        continue;
      }
      if (targetStat.isDirectory()) {
        if (!input.ancestorRealDirs.has(resolved)) {
          const nextAncestors = new Set(input.ancestorRealDirs);
          nextAncestors.add(resolved);
          const nested = await copyDirectorySafely({
            currentSrc: makeAbsolutePath(resolved),
            currentDest: destPath,
            canonicalSourceRoot: input.canonicalSourceRoot,
            relPrefix: relPath,
            ancestorRealDirs: nextAncestors,
          });
          if (!nested.ok) {
            return nested;
          }
        }
      } else if (targetStat.isFile()) {
        await fs.copyFile(resolved, destPath);
        const execBits = targetStat.mode & 0o111;
        if (execBits !== 0) {
          await fs.chmod(destPath, 0o644 | execBits).catch(() => {});
        }
      }
      continue;
    }

    if (lstat.isDirectory()) {
      const realDir = await fs.realpath(srcPath);
      if (!isWithinCanonicalRoot(realDir, input.canonicalSourceRoot)) {
        return { ok: false, kind: "path-traversal", offendingPath: relPath };
      }
      if (!input.ancestorRealDirs.has(realDir)) {
        const nextAncestors = new Set(input.ancestorRealDirs);
        nextAncestors.add(realDir);
        const nested = await copyDirectorySafely({
          currentSrc: makeAbsolutePath(realDir),
          currentDest: destPath,
          canonicalSourceRoot: input.canonicalSourceRoot,
          relPrefix: relPath,
          ancestorRealDirs: nextAncestors,
        });
        if (!nested.ok) {
          return nested;
        }
      }
    } else if (lstat.isFile()) {
      await fs.copyFile(srcPath, destPath);
      const execBits = lstat.mode & 0o111;
      if (execBits !== 0) {
        await fs.chmod(destPath, 0o644 | execBits).catch(() => {});
      }
    }
  }

  return { ok: true };
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function entryExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function atomicSwapStagingDir(input: {
  readonly stageDir: AbsolutePath;
  readonly finalInstallPath: AbsolutePath;
  readonly backupDir: AbsolutePath;
}): Promise<
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly kind: "io-failed";
      readonly operation: string;
      readonly reason: string;
    }
> {
  const { stageDir, finalInstallPath, backupDir } = input;
  const hadExisting = await entryExists(finalInstallPath);
  let movedToBackup = false;
  try {
    if (hadExisting) {
      await fs.rename(finalInstallPath, backupDir);
      movedToBackup = true;
    }
    await fs.rename(stageDir, finalInstallPath);
  } catch (swapErr) {
    if (movedToBackup) {
      await fs.rename(backupDir, finalInstallPath).catch(() => {});
    }
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    return {
      ok: false,
      kind: "io-failed",
      operation: "atomic-swap",
      reason: errorMessage(swapErr),
    };
  }
  if (movedToBackup) {
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => {});
  }
  return { ok: true };
}

export async function removeCaseVariantRootManifest(
  foundPath: AbsolutePath,
  rootManifestPath: AbsolutePath,
  rootDir: AbsolutePath,
): Promise<void> {
  if (
    foundPath !== rootManifestPath &&
    path.dirname(foundPath) === rootDir &&
    path.basename(foundPath).toLowerCase() === "plugin.json"
  ) {
    await fs.rm(foundPath, { force: true });
  }
}
