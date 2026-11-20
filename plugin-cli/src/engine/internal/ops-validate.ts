import fs from "node:fs/promises";
import path from "node:path";
import { formatMarketplaceSource } from "../../domain/query.ts";
import {
  joinAbsolutePath,
  makeAbsolutePath,
  makeDiagnosticId,
  splitInstalledPluginId,
} from "../../domain/types.ts";
import type {
  AbsolutePath,
  Diagnostic,
  DiagnosticDetail,
  EngineResult,
  InstallScope,
  WorkspacePaths,
} from "../../domain/types.ts";
import type {
  RemediateInput,
  RemediateReport,
  ValidateTargetInput,
  ValidationReport,
} from "../contract.ts";
import { readaptInstalledPlugin } from "./adapter.ts";
import {
  marketplaceSourceToPluginInstallSource,
  resolveInstalledSelector,
  selectorLabel,
} from "./engine-context.ts";
import type { EngineRuntime } from "./engine-context.ts";
import { resolveMarketplaceSource } from "./fetcher.ts";
import {
  BACKUP_PREFIX,
  STAGING_PREFIX,
  errorMessage,
  recoverAndCleanStagingArtifacts,
  targetLockPath,
  withTargetLock,
} from "./fs-safety.ts";
import { inspectPluginDirectory } from "./inspector.ts";
import { materializeInstallSource } from "./materialize.ts";
import { opSetEnabled, opUninstall } from "./ops-lifecycle.ts";
import { opSyncMarketplaces } from "./ops-marketplace.ts";
import { scopeRootFor } from "./stores.ts";

function validationErrorReport(input: {
  readonly paths: WorkspacePaths;
  readonly targetLabel: string;
  readonly idKind: string;
  readonly detail: DiagnosticDetail;
  readonly message: string;
  readonly hint: string;
}): ValidationReport {
  return {
    valid: false,
    targetLabel: input.targetLabel,
    manifest: null,
    components: null,
    diagnostics: [
      {
        id: makeDiagnosticId(input.idKind, input.targetLabel),
        severity: "error",
        subject: { kind: "path", path: input.paths.workspaceDir },
        detail: input.detail,
        message: input.message,
        hint: input.hint,
      },
    ],
  };
}

export async function opValidate(
  ctx: EngineRuntime,
  input: ValidateTargetInput,
): Promise<ValidationReport> {
  const { paths, timeoutMs } = ctx;

  switch (input.kind) {
    case "workspace": {
      const snap = await ctx.projectSnapshot();
      return {
        valid: snap.stats.errorCount === 0,
        targetLabel: "workspace",
        manifest: null,
        components: null,
        diagnostics: snap.diagnostics,
      };
    }

    case "installed": {
      const snap = await ctx.projectSnapshot();
      const resolved = resolveInstalledSelector(snap, input.selector);
      const label = selectorLabel(input.selector);
      if (!resolved.ok) {
        return validationErrorReport({
          paths,
          targetLabel: label,
          idKind: "validate-not-found",
          detail: {
            kind: "manifest-schema-invalid",
            filePath: paths.workspaceDir,
            fieldErrors: [`Installed plugin "${label}" not found.`],
          },
          message: `Installed plugin "${label}" could not be found.`,
          hint: "Run list to see installed plugins and scopes.",
        });
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
        valid:
          mergedDiagnostics.every((d) => d.severity !== "error") && inspection.manifest !== null,
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
        return validationErrorReport({
          paths,
          targetLabel: label,
          idKind: "validate-source-failed",
          detail: {
            kind: "manifest-schema-invalid",
            filePath: paths.workspaceDir,
            fieldErrors: [resolvedSource.reason],
          },
          message: resolvedSource.reason,
          hint: "Verify the source path or remote URL is reachable.",
        });
      }

      const installSource = marketplaceSourceToPluginInstallSource(resolvedSource.source);
      if (installSource === null) {
        return validationErrorReport({
          paths,
          targetLabel: label,
          idKind: "validate-source-unsupported",
          detail: {
            kind: "manifest-schema-invalid",
            filePath: paths.workspaceDir,
            fieldErrors: ["JSON catalog files cannot be validated as a single plugin bundle."],
          },
          message: `"${label}" is a catalog JSON file rather than a plugin bundle directory.`,
          hint: "Pass a plugin directory or git repository URL to validate.",
        });
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
        return validationErrorReport({
          paths,
          targetLabel: label,
          idKind: "validate-materialize-failed",
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
        });
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
}

export async function opRemediate(
  ctx: EngineRuntime,
  input: RemediateInput,
): Promise<EngineResult<RemediateReport>> {
  const { paths } = ctx;
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
        return ctx.fail({
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
          return ctx.fail({
            kind: "remediation-failed",
            planKind: "readapt-bundle",
            reason,
          });
        }
        const after = await ctx.commitMutation();
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
        return ctx.mapLockOrIoError(err, "remediate-readapt");
      }
    }

    case "disable-plugin": {
      const res = await opSetEnabled(ctx, {
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
      const res = await opUninstall(ctx, {
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
            return ctx.fail({
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
            return ctx.fail({
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
        return ctx.fail({
          kind: "remediation-failed",
          planKind: "clean-stale-staging",
          reason: errorMessage(err),
        });
      }

      const after = await ctx.commitMutation();
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
      const res = await opSyncMarketplaces(ctx, {
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
        return ctx.fail({
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
}
