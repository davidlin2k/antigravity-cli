import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  isPluginDirName,
  joinAbsolutePath,
  makeAbsolutePath,
} from "../../domain/types.ts";
import type {
  AbsolutePath,
  InstallScope,
  PluginDirName,
} from "../../domain/types.ts";

export const STAGING_PREFIX = ".agy-stage-";
export const BACKUP_PREFIX = ".agy-backup-";
export const LOCK_PREFIX = ".agy-lock-";

const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRIES = 6;
const DEFAULT_LOCK_RETRY_DELAY_MS = 40;

export class LockBusyError extends Error {
  readonly target: string;

  constructor(target: string) {
    super(`Lock is held by another active process: ${target}`);
    this.name = "LockBusyError";
    this.target = target;
  }
}

interface StaleStagingArtifact {
  readonly path: AbsolutePath;
  readonly name: string;
  readonly scope: InstallScope;
  readonly artifactKind: "staging" | "backup";
  readonly targetDirName: PluginDirName | null;
}

type ContainedPathCheck =
  | { readonly kind: "missing" }
  | { readonly kind: "contained"; readonly realPath: string }
  | { readonly kind: "escaped"; readonly resolvedOutsideRoot: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWithinCanonicalRoot(resolvedPath: string, canonicalRoot: string): boolean {
  return resolvedPath === canonicalRoot || resolvedPath.startsWith(`${canonicalRoot}${path.sep}`);
}

export async function resolvePossiblyDanglingTarget(
  canonicalStartDir: string,
  rawTarget: string,
  maxHops = 40,
): Promise<string> {
  const resolveStep = async (startDir: string, target: string, hops: number): Promise<string> => {
    let cur = path.isAbsolute(target) ? path.parse(target).root : startDir;
    const remainder = path.isAbsolute(target) ? target.slice(cur.length) : target;
    const segments = remainder.split(/[\\/]+/);

    for (const seg of segments) {
      if (seg.length === 0 || seg === ".") {
        continue;
      }
      if (seg === "..") {
        cur = path.dirname(cur);
        continue;
      }
      const next = path.join(cur, seg);
      try {
        cur = await fs.realpath(next);
      } catch {
        if (hops < maxHops) {
          try {
            const nestedLink = await fs.readlink(next);
            cur = await resolveStep(cur, nestedLink, hops + 1);
            continue;
          } catch {
          }
        }
        cur = next;
      }
    }
    return cur;
  };

  return resolveStep(canonicalStartDir, rawTarget, 0);
}

export async function checkContainedPath(
  candidatePath: AbsolutePath,
  canonicalRoot: string,
): Promise<ContainedPathCheck> {
  let lstat;
  try {
    lstat = await fs.lstat(candidatePath);
  } catch {
    return { kind: "missing" };
  }
  try {
    const realPath = await fs.realpath(candidatePath);
    if (!isWithinCanonicalRoot(realPath, canonicalRoot)) {
      return { kind: "escaped", resolvedOutsideRoot: realPath };
    }
    return { kind: "contained", realPath };
  } catch {
    if (lstat.isSymbolicLink()) {
      const linkRaw = await fs.readlink(candidatePath).catch(() => "");
      const parentReal = await fs
        .realpath(path.dirname(candidatePath))
        .catch(() => path.dirname(candidatePath));
      const resolved = await resolvePossiblyDanglingTarget(parentReal, linkRaw);
      if (!isWithinCanonicalRoot(resolved, canonicalRoot)) {
        return { kind: "escaped", resolvedOutsideRoot: resolved };
      }
    }
    return { kind: "missing" };
  }
}

function getErrnoCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function targetLockPath(scopeRoot: AbsolutePath, dirName: PluginDirName): AbsolutePath {
  return makeAbsolutePath(path.join(scopeRoot, `${LOCK_PREFIX}${dirName}`));
}

async function writeFileAtomic(
  filePath: AbsolutePath,
  content: string | Uint8Array,
  mode = 0o644,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const nonce = crypto.randomBytes(6).toString("hex");
  const tmpPath = path.join(dir, `.agy-tmp-${process.pid}-${nonce}`);
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tmpPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
    if (typeof content === "string") {
      await handle.writeFile(content, "utf8");
    } else {
      await handle.writeFile(content);
    }
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    if (handle !== null) {
      await handle.close().catch(() => {});
    }
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

export async function writeJsonAtomic(
  filePath: AbsolutePath,
  data: unknown,
  mode = 0o600,
): Promise<void> {
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  await writeFileAtomic(filePath, serialized, mode);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return getErrnoCode(err) === "EPERM";
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function isLockStale(lockFilePath: AbsolutePath, staleMs: number): Promise<boolean> {
  let stat;
  try {
    stat = await fs.stat(lockFilePath);
  } catch (err) {
    return getErrnoCode(err) === "ENOENT";
  }
  const ageByMtime = Date.now() - stat.mtimeMs;
  if (ageByMtime > staleMs) {
    return true;
  }
  try {
    const raw = await fs.readFile(lockFilePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      const pid = typeof parsed.pid === "number" ? parsed.pid : null;
      const createdAt = typeof parsed.createdAt === "number" ? parsed.createdAt : null;
      if (pid !== null && !isPidAlive(pid)) {
        return true;
      }
      if (createdAt !== null && Date.now() - createdAt > staleMs) {
        return true;
      }
      return false;
    }
    return true;
  } catch (err) {
    return getErrnoCode(err) === "ENOENT" || err instanceof SyntaxError;
  }
}

export async function withTargetLock<T>(
  lockFilePath: AbsolutePath,
  fn: () => Promise<T>,
  options?: {
    readonly staleMs?: number;
    readonly retries?: number;
    readonly retryDelayMs?: number;
  },
): Promise<T> {
  const staleMs = options?.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const retries = options?.retries ?? DEFAULT_LOCK_RETRIES;
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;

  await fs.mkdir(path.dirname(lockFilePath), { recursive: true });

  const tmpLockPath = `${lockFilePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  let acquired = false;
  try {
    const payload = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
    const handle = await fs.open(
      tmpLockPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        await fs.link(tmpLockPath, lockFilePath);
        acquired = true;
        break;
      } catch (err) {
        if (getErrnoCode(err) !== "EEXIST") {
          throw err;
        }
        const stale = await isLockStale(lockFilePath, staleMs);
        if (stale) {
          await fs.rm(lockFilePath, { force: true }).catch(() => {});
          continue;
        }
        if (attempt < retries) {
          await sleep(retryDelayMs * (attempt + 1));
        }
      }
    }
  } finally {
    await fs.rm(tmpLockPath, { force: true }).catch(() => {});
  }

  if (!acquired) {
    throw new LockBusyError(lockFilePath);
  }

  try {
    return await fn();
  } finally {
    await fs.rm(lockFilePath, { force: true }).catch(() => {});
  }
}

function extractTargetDirName(artifactName: string, prefix: string): PluginDirName | null {
  const rest = artifactName.slice(prefix.length);
  if (rest.length === 0) {
    return null;
  }
  const lastDash = rest.lastIndexOf("-");
  if (lastDash > 0 && /^[0-9a-f]{8,}$/i.test(rest.slice(lastDash + 1))) {
    const candidate = rest.slice(0, lastDash);
    if (isPluginDirName(candidate)) {
      return candidate;
    }
  }
  return isPluginDirName(rest) ? rest : null;
}

async function isLockHeldByLiveProcess(lockFilePath: AbsolutePath): Promise<boolean> {
  return !(await isLockStale(lockFilePath, DEFAULT_LOCK_STALE_MS));
}

export async function listStaleStagingPaths(
  scopeRoot: AbsolutePath,
  scope: InstallScope,
): Promise<readonly StaleStagingArtifact[]> {
  let names: string[];
  try {
    names = await fs.readdir(scopeRoot);
  } catch {
    return [];
  }
  const artifacts: StaleStagingArtifact[] = [];
  for (const name of names) {
    if (name.startsWith(STAGING_PREFIX)) {
      artifacts.push({
        path: makeAbsolutePath(path.join(scopeRoot, name)),
        name,
        scope,
        artifactKind: "staging",
        targetDirName: extractTargetDirName(name, STAGING_PREFIX),
      });
    } else if (name.startsWith(BACKUP_PREFIX)) {
      artifacts.push({
        path: makeAbsolutePath(path.join(scopeRoot, name)),
        name,
        scope,
        artifactKind: "backup",
        targetDirName: extractTargetDirName(name, BACKUP_PREFIX),
      });
    }
  }
  artifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return artifacts;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function recoverAndCleanStagingArtifacts(
  scopeRoot: AbsolutePath,
  scope: InstallScope,
  dirNameFilter?: PluginDirName,
  onlyPath?: AbsolutePath,
): Promise<readonly AbsolutePath[]> {
  const artifacts = await listStaleStagingPaths(scopeRoot, scope);
  const removedPaths: AbsolutePath[] = [];

  for (const artifact of artifacts) {
    if (onlyPath !== undefined && artifact.path !== onlyPath) {
      continue;
    }
    if (dirNameFilter !== undefined) {
      if (artifact.targetDirName !== dirNameFilter) {
        continue;
      }
    } else if (artifact.targetDirName !== null) {
      const lockFile = targetLockPath(scopeRoot, artifact.targetDirName);
      if (await isLockHeldByLiveProcess(lockFile)) {
        continue;
      }
    }
    if (artifact.artifactKind === "backup" && artifact.targetDirName !== null) {
      const targetPath = joinAbsolutePath(scopeRoot, artifact.targetDirName);
      if (!(await pathExists(targetPath))) {
        try {
          await fs.rename(artifact.path, targetPath);
          removedPaths.push(artifact.path);
          continue;
        } catch {
          if (!(await pathExists(targetPath))) {
            continue;
          }
        }
      }
    }
    await fs.rm(artifact.path, { recursive: true, force: true });
    removedPaths.push(artifact.path);
  }

  return removedPaths;
}
