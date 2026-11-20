import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  isNonEmpty,
  joinAbsolutePath,
  makeAbsolutePath,
  makeDiagnosticId,
  makeInstalledPluginId,
  makeRelativeSubpath,
  parseRelativeSubpath,
} from "../../domain/types.ts";
import type {
  AbsolutePath,
  Diagnostic,
  InstallScope,
  InstalledPluginId,
  NonEmpty,
  NormalizedPluginManifest,
  PluginDirName,
} from "../../domain/types.ts";
import {
  atomicSwapStagingDir,
  copyDirectorySafely,
  expandPluginRootInValue,
  fileExists,
  removeCaseVariantRootManifest,
} from "./adapter-copy.ts";
import {
  BACKUP_PREFIX,
  STAGING_PREFIX,
  checkContainedPath,
  errorMessage,
  isRecord,
  writeJsonAtomic,
} from "./fs-safety.ts";
import { inspectPluginDirectory } from "./inspector.ts";
import { parseJsoncBomSafe } from "./jsonc.ts";
import {
  findPluginManifestFile,
  normalizeAntigravityManifest,
} from "./manifest.ts";

interface AdaptInstallInput {
  readonly sourceDir: AbsolutePath;
  readonly scopeRoot: AbsolutePath;
  readonly scope: InstallScope;
  readonly dirName: PluginDirName;
  readonly fallbackName?: string;
  readonly fallbackVersion?: string;
  readonly disabled?: boolean;
}

type BundleInvalidError = {
  readonly ok: false;
  readonly kind: "bundle-invalid";
  readonly diagnostics: NonEmpty<Diagnostic>;
};

type AdaptInstallResult =
  | {
      readonly ok: true;
      readonly installPath: AbsolutePath;
      readonly manifest: NormalizedPluginManifest;
      readonly adaptedHooks: boolean;
      readonly adaptedMcp: boolean;
      readonly expandedPluginRoot: boolean;
      readonly warnings: readonly Diagnostic[];
    }
  | { readonly ok: false; readonly kind: "path-traversal"; readonly offendingPath: string }
  | BundleInvalidError
  | {
      readonly ok: false;
      readonly kind: "io-failed";
      readonly operation: string;
      readonly reason: string;
    };

type ToggleManifestResult =
  | { readonly ok: true; readonly outcome: "changed" | "unchanged" }
  | { readonly ok: false; readonly kind: "path-traversal"; readonly offendingPath: string }
  | BundleInvalidError
  | {
      readonly ok: false;
      readonly kind: "io-failed";
      readonly operation: string;
      readonly reason: string;
    };

function bundleSyntaxError(
  pluginId: InstalledPluginId,
  idSuffix: string,
  filePath: AbsolutePath,
  parsed: {
    readonly line: number | null;
    readonly column: number | null;
    readonly hadUtf8Bom: boolean;
    readonly syntaxError: string;
  },
  message: string,
  hint: string,
): BundleInvalidError {
  return {
    ok: false,
    kind: "bundle-invalid",
    diagnostics: [
      {
        id: makeDiagnosticId("manifest-json-syntax", pluginId, idSuffix),
        severity: "error",
        subject: { kind: "installed", pluginId },
        detail: {
          kind: "manifest-json-syntax",
          filePath,
          line: parsed.line,
          column: parsed.column,
          hadUtf8Bom: parsed.hadUtf8Bom,
          syntaxError: parsed.syntaxError,
        },
        message,
        hint,
      },
    ],
  };
}

function bundleSchemaError(
  pluginId: InstalledPluginId,
  idSuffix: string,
  filePath: AbsolutePath,
  fieldErrors: NonEmpty<string>,
  message: string,
  hint: string,
): BundleInvalidError {
  return {
    ok: false,
    kind: "bundle-invalid",
    diagnostics: [
      {
        id: makeDiagnosticId("manifest-schema-invalid", pluginId, idSuffix),
        severity: "error",
        subject: { kind: "installed", pluginId },
        detail: {
          kind: "manifest-schema-invalid",
          filePath,
          fieldErrors,
        },
        message,
        hint,
      },
    ],
  };
}

export async function adaptAndInstallBundle(
  input: AdaptInstallInput,
): Promise<AdaptInstallResult> {
  const { sourceDir, scopeRoot, scope, dirName, fallbackName } = input;
  const pluginId: InstalledPluginId = makeInstalledPluginId(scope, dirName);
  const finalInstallPath = joinAbsolutePath(scopeRoot, dirName);
  const nonce = crypto.randomBytes(6).toString("hex");
  const stageDir = makeAbsolutePath(path.join(scopeRoot, `${STAGING_PREFIX}${dirName}-${nonce}`));
  const backupDir = makeAbsolutePath(path.join(scopeRoot, `${BACKUP_PREFIX}${dirName}-${nonce}`));

  const cleanupStage = async (): Promise<void> => {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    await fs.mkdir(scopeRoot, { recursive: true });
    const canonicalSourceRoot = await fs.realpath(sourceDir);

    const copyResult = await copyDirectorySafely({
      currentSrc: makeAbsolutePath(canonicalSourceRoot),
      currentDest: stageDir,
      canonicalSourceRoot,
      relPrefix: "",
      ancestorRealDirs: new Set<string>([canonicalSourceRoot]),
    });
    if (!copyResult.ok) {
      await cleanupStage();
      return copyResult;
    }

    const foundManifest = await findPluginManifestFile(stageDir);
    if (foundManifest === null) {
      await cleanupStage();
      const missingPath = joinAbsolutePath(stageDir, makeRelativeSubpath("plugin.json"));
      return bundleSchemaError(
        pluginId,
        "missing",
        missingPath,
        ["Missing plugin.json manifest in source bundle."],
        `Bundle for "${pluginId}" is missing a plugin.json manifest.`,
        "Ensure the plugin directory contains plugin.json (or .claude-plugin/plugin.json / .cursor-plugin/plugin.json).",
      );
    }

    const manifestBytes = await fs.readFile(foundManifest.path);
    const parsedManifest = parseJsoncBomSafe(manifestBytes, foundManifest.path);
    if (!parsedManifest.ok) {
      await cleanupStage();
      return bundleSyntaxError(
        pluginId,
        "plugin-json",
        foundManifest.path,
        parsedManifest,
        `Syntax error in ${foundManifest.relativePath}: ${parsedManifest.syntaxError}`,
        "Fix the JSON syntax error in the plugin manifest before installing.",
      );
    }

    const normalized = normalizeAntigravityManifest(
      parsedManifest.value,
      fallbackName ?? dirName,
    );
    if (!normalized.ok) {
      await cleanupStage();
      return bundleSchemaError(
        pluginId,
        "plugin-json",
        foundManifest.path,
        normalized.fieldErrors,
        `Invalid ${foundManifest.relativePath}: ${normalized.fieldErrors.join(" ")}`,
        "Fix the manifest fields before installing.",
      );
    }

    const effectiveVersion =
      normalized.manifest.version ??
      (input.fallbackVersion !== undefined && input.fallbackVersion.trim().length > 0
        ? input.fallbackVersion.trim()
        : undefined);
    const finalManifest: NormalizedPluginManifest = {
      ...normalized.manifest,
      ...(effectiveVersion !== undefined ? { version: effectiveVersion } : {}),
      ...(input.disabled === true ? { disabled: true } : {}),
    };

    const rootManifestPath = joinAbsolutePath(stageDir, makeRelativeSubpath("plugin.json"));
    await removeCaseVariantRootManifest(foundManifest.path, rootManifestPath, stageDir);
    await writeJsonAtomic(rootManifestPath, finalManifest, 0o644);

    let adaptedHooks = false;
    let adaptedMcp = false;
    let expandedPluginRoot = false;

    const rootHooksPath = joinAbsolutePath(stageDir, makeRelativeSubpath("hooks.json"));
    const nestedHooksPath = joinAbsolutePath(stageDir, makeRelativeSubpath("hooks/hooks.json"));
    let hooksSourcePath: AbsolutePath | null = null;
    let hooksPromotedFromNested = false;

    if (await fileExists(rootHooksPath)) {
      hooksSourcePath = rootHooksPath;
    } else if (await fileExists(nestedHooksPath)) {
      hooksSourcePath = nestedHooksPath;
      hooksPromotedFromNested = true;
    } else if (normalized.extras.hooksPath !== null) {
      const parsedRel = parseRelativeSubpath(normalized.extras.hooksPath);
      if (!parsedRel.ok) {
        await cleanupStage();
        return {
          ok: false,
          kind: "path-traversal",
          offendingPath: normalized.extras.hooksPath,
        };
      }
      const customPath = joinAbsolutePath(stageDir, parsedRel.value);
      if (await fileExists(customPath)) {
        hooksSourcePath = customPath;
        hooksPromotedFromNested = customPath !== rootHooksPath;
      }
    }

    if (hooksSourcePath !== null) {
      const hooksBytes = await fs.readFile(hooksSourcePath);
      const parsedHooks = parseJsoncBomSafe(hooksBytes, hooksSourcePath);
      if (!parsedHooks.ok) {
        await cleanupStage();
        return bundleSyntaxError(
          pluginId,
          "hooks-json",
          hooksSourcePath,
          parsedHooks,
          `Syntax error in hooks configuration: ${parsedHooks.syntaxError}`,
          "Fix the JSON syntax error in hooks.json.",
        );
      }
      if (!isRecord(parsedHooks.value)) {
        await cleanupStage();
        return {
          ok: false,
          kind: "bundle-invalid",
          diagnostics: [
            {
              id: makeDiagnosticId("hooks-invalid", pluginId, "non-object"),
              severity: "error",
              subject: { kind: "installed", pluginId },
              detail: {
                kind: "hooks-invalid",
                filePath: hooksSourcePath,
                reason: "hooks configuration must be a JSON object.",
              },
              message: "Hooks configuration must be a JSON object.",
              hint: "Provide a JSON object mapping hook event names to arrays.",
            },
          ],
        };
      }

      const wasWrapped = isRecord(parsedHooks.value.hooks);
      const unwrapped =
        wasWrapped && isRecord(parsedHooks.value.hooks)
          ? parsedHooks.value.hooks
          : parsedHooks.value;
      const expanded = expandPluginRootInValue(unwrapped, finalInstallPath);
      if (expanded.expanded) {
        expandedPluginRoot = true;
      }
      if (hooksPromotedFromNested || wasWrapped || parsedHooks.hadUtf8Bom || expanded.expanded) {
        adaptedHooks = true;
      }
      await writeJsonAtomic(rootHooksPath, expanded.value, 0o644);
      if (hooksPromotedFromNested && hooksSourcePath === nestedHooksPath) {
        await fs.rm(nestedHooksPath, { force: true }).catch(() => {});
      }
    }

    const rootMcpPath = joinAbsolutePath(stageDir, makeRelativeSubpath("mcp_config.json"));
    const dotMcpPath = joinAbsolutePath(stageDir, makeRelativeSubpath(".mcp.json"));
    let mcpSourcePath: AbsolutePath | null = null;
    let mcpPromoted = false;
    let rawMcpValue: unknown = null;
    let mcpHadBom = false;

    if (await fileExists(rootMcpPath)) {
      mcpSourcePath = rootMcpPath;
    } else if (await fileExists(dotMcpPath)) {
      mcpSourcePath = dotMcpPath;
      mcpPromoted = true;
    } else if (normalized.extras.mcpPath !== null) {
      const parsedRel = parseRelativeSubpath(normalized.extras.mcpPath);
      if (!parsedRel.ok) {
        await cleanupStage();
        return {
          ok: false,
          kind: "path-traversal",
          offendingPath: normalized.extras.mcpPath,
        };
      }
      const customMcpPath = joinAbsolutePath(stageDir, parsedRel.value);
      if (await fileExists(customMcpPath)) {
        mcpSourcePath = customMcpPath;
        mcpPromoted = customMcpPath !== rootMcpPath;
      }
    } else if (normalized.extras.inlineMcpServers !== null) {
      rawMcpValue = { mcpServers: normalized.extras.inlineMcpServers };
      mcpPromoted = true;
    }

    if (mcpSourcePath !== null) {
      const mcpBytes = await fs.readFile(mcpSourcePath);
      const parsedMcp = parseJsoncBomSafe(mcpBytes, mcpSourcePath);
      if (!parsedMcp.ok) {
        await cleanupStage();
        return bundleSyntaxError(
          pluginId,
          "mcp-config",
          mcpSourcePath,
          parsedMcp,
          `Syntax error in MCP configuration: ${parsedMcp.syntaxError}`,
          "Fix the JSON syntax error in .mcp.json or mcp_config.json.",
        );
      }
      mcpHadBom = parsedMcp.hadUtf8Bom;
      rawMcpValue = parsedMcp.value;
    }

    if (rawMcpValue !== null) {
      if (!isRecord(rawMcpValue)) {
        await cleanupStage();
        return {
          ok: false,
          kind: "bundle-invalid",
          diagnostics: [
            {
              id: makeDiagnosticId("mcp-config-invalid", pluginId, "non-object"),
              severity: "error",
              subject: { kind: "installed", pluginId },
              detail: {
                kind: "mcp-config-invalid",
                filePath: mcpSourcePath ?? rootMcpPath,
                reason: "MCP configuration must be a JSON object.",
              },
              message: "MCP configuration must be a JSON object.",
              hint: "Provide an object with an mcpServers map.",
            },
          ],
        };
      }
      const normalizedMcpObj =
        "mcpServers" in rawMcpValue ? rawMcpValue : { mcpServers: rawMcpValue };
      const expanded = expandPluginRootInValue(normalizedMcpObj, finalInstallPath);
      if (expanded.expanded) {
        expandedPluginRoot = true;
      }
      if (mcpPromoted || mcpHadBom || expanded.expanded) {
        adaptedMcp = true;
      }
      await writeJsonAtomic(rootMcpPath, expanded.value, 0o644);
      if (mcpPromoted && mcpSourcePath === dotMcpPath) {
        await fs.rm(dotMcpPath, { force: true }).catch(() => {});
      }
    }

    const inspection = await inspectPluginDirectory({
      pluginRoot: stageDir,
      subject: { kind: "installed", pluginId },
      pluginIdForRemediation: pluginId,
    });
    if (!inspection.valid || inspection.manifest === null) {
      await cleanupStage();
      const errors = inspection.diagnostics.filter((d) => d.severity === "error");
      if (isNonEmpty(errors)) {
        return { ok: false, kind: "bundle-invalid", diagnostics: errors };
      }
      if (isNonEmpty(inspection.diagnostics)) {
        return { ok: false, kind: "bundle-invalid", diagnostics: inspection.diagnostics };
      }
      return bundleSchemaError(
        pluginId,
        "stage-failed",
        rootManifestPath,
        ["Staged bundle failed validation."],
        `Staged bundle for "${pluginId}" failed validation.`,
        "Inspect bundle files and retry.",
      );
    }

    const swapResult = await atomicSwapStagingDir({
      stageDir,
      finalInstallPath,
      backupDir,
    });
    if (!swapResult.ok) {
      return swapResult;
    }

    const warnings = inspection.diagnostics.filter((d) => d.severity === "warning");
    return {
      ok: true,
      installPath: finalInstallPath,
      manifest: inspection.manifest,
      adaptedHooks,
      adaptedMcp,
      expandedPluginRoot,
      warnings,
    };
  } catch (err) {
    await cleanupStage();
    return {
      ok: false,
      kind: "io-failed",
      operation: "adapt-install",
      reason: errorMessage(err),
    };
  }
}

export async function readaptInstalledPlugin(input: {
  readonly scopeRoot: AbsolutePath;
  readonly scope: InstallScope;
  readonly dirName: PluginDirName;
}): Promise<AdaptInstallResult> {
  const installedPath = joinAbsolutePath(input.scopeRoot, input.dirName);
  return adaptAndInstallBundle({
    sourceDir: installedPath,
    scopeRoot: input.scopeRoot,
    scope: input.scope,
    dirName: input.dirName,
    fallbackName: input.dirName,
  });
}

export async function toggleManifestDisabledAtomic(
  installPath: AbsolutePath,
  pluginId: InstalledPluginId,
  enabled: boolean,
): Promise<ToggleManifestResult> {
  let canonicalInstallRoot: string;
  try {
    canonicalInstallRoot = await fs.realpath(installPath);
  } catch (err) {
    return {
      ok: false,
      kind: "io-failed",
      operation: "resolve-install-path",
      reason: errorMessage(err),
    };
  }

  const rootManifestPath = joinAbsolutePath(installPath, makeRelativeSubpath("plugin.json"));
  const rootCheck = await checkContainedPath(rootManifestPath, canonicalInstallRoot);
  if (rootCheck.kind === "escaped") {
    return { ok: false, kind: "path-traversal", offendingPath: "plugin.json" };
  }

  const found = await findPluginManifestFile(installPath);
  if (found === null) {
    return bundleSchemaError(
      pluginId,
      "missing",
      rootManifestPath,
      ["Missing plugin.json manifest."],
      `Cannot toggle "${pluginId}": missing plugin.json.`,
      "Reinstall or repair plugin.json.",
    );
  }

  const manifestCheck = await checkContainedPath(found.path, canonicalInstallRoot);
  if (manifestCheck.kind === "escaped") {
    return { ok: false, kind: "path-traversal", offendingPath: found.relativePath };
  }

  let rawBytes: Uint8Array;
  try {
    rawBytes = await fs.readFile(found.path);
  } catch (err) {
    return {
      ok: false,
      kind: "io-failed",
      operation: "read-manifest",
      reason: errorMessage(err),
    };
  }

  const parsed = parseJsoncBomSafe(rawBytes, found.path);
  if (!parsed.ok) {
    return bundleSyntaxError(
      pluginId,
      "plugin-json",
      found.path,
      parsed,
      `Cannot toggle "${pluginId}": syntax error in plugin.json: ${parsed.syntaxError}`,
      "Fix the JSON syntax error in plugin.json.",
    );
  }

  const normalized = normalizeAntigravityManifest(parsed.value);
  if (!normalized.ok || !isRecord(parsed.value)) {
    return bundleSchemaError(
      pluginId,
      "plugin-json",
      found.path,
      normalized.ok ? ["Manifest root must be a JSON object."] : normalized.fieldErrors,
      `Cannot toggle "${pluginId}": invalid plugin.json.`,
      "Fix the schema errors in plugin.json.",
    );
  }

  const currentlyDisabled = normalized.manifest.disabled === true;
  const targetDisabled = !enabled;
  if (
    currentlyDisabled === targetDisabled &&
    found.path === rootManifestPath &&
    !parsed.hadUtf8Bom
  ) {
    return { ok: true, outcome: "unchanged" };
  }

  const updated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.value)) {
    if (key === "disabled") {
      continue;
    }
    updated[key] = value;
  }
  if (targetDisabled) {
    updated.disabled = true;
  }

  try {
    await removeCaseVariantRootManifest(found.path, rootManifestPath, installPath);
    await writeJsonAtomic(rootManifestPath, updated, 0o644);
    return { ok: true, outcome: "changed" };
  } catch (err) {
    return {
      ok: false,
      kind: "io-failed",
      operation: "write-manifest",
      reason: errorMessage(err),
    };
  }
}
