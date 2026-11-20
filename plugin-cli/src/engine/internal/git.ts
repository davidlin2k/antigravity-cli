import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { joinAbsolutePath, makeAbsolutePath } from "../../domain/types.ts";
import type { AbsolutePath, RelativeSubpath } from "../../domain/types.ts";
import { errorMessage, isRecord } from "./fs-safety.ts";

const execFileAsync = promisify(execFile);

export const DEFAULT_NETWORK_TIMEOUT_MS = 30_000;

interface GitRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly message: string;
}

interface MaterializedBundle {
  readonly sourceDir: AbsolutePath;
  readonly resolvedSha: string | null;
  readonly cleanup: () => Promise<void>;
}

export type MaterializeResult =
  | { readonly ok: true; readonly bundle: MaterializedBundle }
  | { readonly ok: false; readonly kind: "path-traversal"; readonly offendingPath: string }
  | {
      readonly ok: false;
      readonly kind: "io-failed";
      readonly operation: string;
      readonly reason: string;
    };

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

export async function isInsideCanonicalDir(
  candidate: string,
  canonicalBase: string,
): Promise<boolean> {
  try {
    const resolved = await fs.realpath(candidate);
    return resolved === canonicalBase || resolved.startsWith(`${canonicalBase}${path.sep}`);
  } catch {
    return false;
  }
}

export async function cloneOrUpdateGitMirror(input: {
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

export async function cloneGitIntoTempDir(input: {
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
