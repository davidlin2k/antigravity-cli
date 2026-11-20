import {
  isAtLeastTwo,
  makeHttpUrl,
  makeSnapshotRevision,
  nextSnapshotRevision,
} from "../../domain/types.ts";
import type {
  Diagnostic,
  EngineError,
  EngineResult,
  InstalledPlugin,
  InstalledPluginSelector,
  MarketplaceSource,
  NonEmpty,
  PluginInstallSource,
  WorkspacePaths,
  WorkspaceSnapshot,
} from "../../domain/types.ts";
import type { PluginEngineConfig } from "../contract.ts";
import { LockBusyError, errorMessage } from "./fs-safety.ts";
import { DEFAULT_NETWORK_TIMEOUT_MS } from "./git.ts";
import { projectWorkspaceSnapshot } from "./reconciler.ts";
import { deriveWorkspacePaths, writeDerivedCaches } from "./stores.ts";

export interface EngineRuntime {
  readonly paths: WorkspacePaths;
  readonly timeoutMs: number;
  projectSnapshot(): Promise<WorkspaceSnapshot>;
  commitMutation(): Promise<WorkspaceSnapshot>;
  fail<T>(error: EngineError, writeDerived?: boolean): Promise<EngineResult<T>>;
  mapLockOrIoError<T>(err: unknown, operation: string): Promise<EngineResult<T>>;
}

export function createEngineRuntime(config: PluginEngineConfig): EngineRuntime {
  const paths = deriveWorkspacePaths(config);
  const timeoutMs = config.networkTimeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS;
  let revision = makeSnapshotRevision(0);

  const projectSnapshot = async (): Promise<WorkspaceSnapshot> => {
    revision = nextSnapshotRevision(revision);
    return projectWorkspaceSnapshot(paths, revision);
  };

  const commitMutation = async (): Promise<WorkspaceSnapshot> => {
    const snap = await projectSnapshot();
    await writeDerivedCaches(paths, snap);
    return snap;
  };

  const fail = async <T>(error: EngineError, writeDerived = false): Promise<EngineResult<T>> => {
    const snap = writeDerived ? await commitMutation() : await projectSnapshot();
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

  return {
    paths,
    timeoutMs,
    projectSnapshot,
    commitMutation,
    fail,
    mapLockOrIoError,
  };
}

export function marketplaceSourceToPluginInstallSource(
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

export function selectorLabel(selector: InstalledPluginSelector): string {
  if (selector.kind === "id") {
    return selector.id;
  }
  return selector.scope !== undefined ? `${selector.scope}:${selector.name}` : selector.name;
}

type SelectorResolution =
  | { readonly ok: true; readonly plugin: InstalledPlugin }
  | { readonly ok: false; readonly error: EngineError };

export function resolveInstalledSelector(
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

type BundleOperationFailure =
  | { readonly kind: "path-traversal"; readonly offendingPath: string }
  | { readonly kind: "bundle-invalid"; readonly diagnostics: NonEmpty<Diagnostic> }
  | { readonly kind: "io-failed"; readonly operation: string; readonly reason: string };

export function toEngineError(failure: BundleOperationFailure): EngineError {
  switch (failure.kind) {
    case "path-traversal":
      return { kind: "path-traversal", offendingPath: failure.offendingPath };
    case "bundle-invalid":
      return { kind: "bundle-invalid", diagnostics: failure.diagnostics };
    case "io-failed":
      return {
        kind: "io-failed",
        operation: failure.operation,
        reason: failure.reason,
      };
    default: {
      const _exhaustive: never = failure;
      return _exhaustive;
    }
  }
}
