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
import { inspectPluginDirectory } from "./inspector.ts";
import {
  findPluginManifestFile,
  normalizeAntigravityManifest,
  parseJsoncBomSafe,
} from "./normalizer.ts";
import {
  BACKUP_PREFIX,
  STAGING_PREFIX,
  errorMessage,
  isRecord,
  writeJsonAtomic,
} from "./stores.ts";

export interface AdaptInstallInput {
  readonly sourceDir: AbsolutePath;
  readonly scopeRoot: AbsolutePath;
  readonly scope: InstallScope;
  readonly dirName: PluginDirName;
  readonly fallbackName?: string;
}

export type AdaptInstallResult =
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
  | { readonly ok: false; readonly kind: "bundle-invalid"; readonly diagnostics: NonEmpty<Diagnostic> }
  | { readonly ok: false; readonly kind: "io-failed"; readonly operation: string; readonly reason: string };

export type ToggleManifestResult =
  | { readonly ok: true; readonly outcome: "changed" | "unchanged" }
  | { readonly ok: false; readonly kind: "bundle-invalid"; readonly diagnostics: NonEmpty<Diagnostic> }
  | { readonly ok: false; readonly kind: "io-failed"; readonly operation: string; readonly reason: string };

const PLUGIN_ROOT_REPLACE_RE = /\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/g;

function isWithinRoot(resolved: string, canonicalRoot: string): boolean {
  return resolved === canonicalRoot || resolved.startsWith(`${canonicalRoot}${path.sep}`);
}

function expandPluginRootInValue(
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

async function copyDirectorySafely(input: {
  readonly currentSrc: AbsolutePath;
  readonly currentDest: AbsolutePath;
  readonly canonicalSourceRoot: string;
  readonly relPrefix: string;
  readonly visitedRealDirs: Set<string>;
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
        resolved = path.resolve(path.dirname(srcPath), rawLink);
      }
      if (!isWithinRoot(resolved, input.canonicalSourceRoot)) {
        return { ok: false, kind: "path-traversal", offendingPath: relPath };
      }
      if (targetStat === null) {
        continue;
      }
      if (targetStat.isDirectory()) {
        if (!input.visitedRealDirs.has(resolved)) {
          input.visitedRealDirs.add(resolved);
          const nested = await copyDirectorySafely({
            currentSrc: srcPath,
            currentDest: destPath,
            canonicalSourceRoot: input.canonicalSourceRoot,
            relPrefix: relPath,
            visitedRealDirs: input.visitedRealDirs,
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
      if (!isWithinRoot(realDir, input.canonicalSourceRoot)) {
        return { ok: false, kind: "path-traversal", offendingPath: relPath };
      }
      if (!input.visitedRealDirs.has(realDir)) {
        input.visitedRealDirs.add(realDir);
        const nested = await copyDirectorySafely({
          currentSrc: srcPath,
          currentDest: destPath,
          canonicalSourceRoot: input.canonicalSourceRoot,
          relPrefix: relPath,
          visitedRealDirs: input.visitedRealDirs,
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

async function fileExists(filePath: string): Promise<boolean> {
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

/**
 * Stages a source bundle into `<scopeRoot>/.agy-stage-<dirName>-<nonce>`, normalizes
 * `plugin.json`, promotes/unwraps `hooks.json` and `mcp_config.json` with `${CLAUDE_PLUGIN_ROOT}`
 * and `${PLUGIN_ROOT}` expanded to the FINAL install path, validates with `inspector.ts`,
 * and swaps atomically on the same filesystem.
 */
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
      currentSrc: sourceDir,
      currentDest: stageDir,
      canonicalSourceRoot,
      relPrefix: "",
      visitedRealDirs: new Set<string>([canonicalSourceRoot]),
    });
    if (!copyResult.ok) {
      await cleanupStage();
      return copyResult;
    }

    const foundManifest = await findPluginManifestFile(stageDir);
    if (foundManifest === null) {
      await cleanupStage();
      const missingPath = joinAbsolutePath(stageDir, makeRelativeSubpath("plugin.json"));
      return {
        ok: false,
        kind: "bundle-invalid",
        diagnostics: [
          {
            id: makeDiagnosticId("manifest-schema-invalid", pluginId, "missing"),
            severity: "error",
            subject: { kind: "installed", pluginId },
            detail: {
              kind: "manifest-schema-invalid",
              filePath: missingPath,
              fieldErrors: ["Missing plugin.json manifest in source bundle."],
            },
            message: `Bundle for "${pluginId}" is missing a plugin.json manifest.`,
            hint: "Ensure the plugin directory contains plugin.json (or .claude-plugin/plugin.json / .cursor-plugin/plugin.json).",
          },
        ],
      };
    }

    const manifestBytes = await fs.readFile(foundManifest.path);
    const parsedManifest = parseJsoncBomSafe(manifestBytes, foundManifest.path);
    if (!parsedManifest.ok) {
      await cleanupStage();
      return {
        ok: false,
        kind: "bundle-invalid",
        diagnostics: [
          {
            id: makeDiagnosticId("manifest-json-syntax", pluginId, "plugin-json"),
            severity: "error",
            subject: { kind: "installed", pluginId },
            detail: {
              kind: "manifest-json-syntax",
              filePath: foundManifest.path,
              line: parsedManifest.line,
              column: parsedManifest.column,
              hadUtf8Bom: parsedManifest.hadUtf8Bom,
              syntaxError: parsedManifest.syntaxError,
            },
            message: `Syntax error in ${foundManifest.relativePath}: ${parsedManifest.syntaxError}`,
            hint: "Fix the JSON syntax error in the plugin manifest before installing.",
          },
        ],
      };
    }

    const normalized = normalizeAntigravityManifest(
      parsedManifest.value,
      fallbackName ?? dirName,
    );
    if (!normalized.ok) {
      await cleanupStage();
      return {
        ok: false,
        kind: "bundle-invalid",
        diagnostics: [
          {
            id: makeDiagnosticId("manifest-schema-invalid", pluginId, "plugin-json"),
            severity: "error",
            subject: { kind: "installed", pluginId },
            detail: {
              kind: "manifest-schema-invalid",
              filePath: foundManifest.path,
              fieldErrors: normalized.fieldErrors,
            },
            message: `Invalid ${foundManifest.relativePath}: ${normalized.fieldErrors.join(" ")}`,
            hint: "Fix the manifest fields before installing.",
          },
        ],
      };
    }

    const rootManifestPath = joinAbsolutePath(stageDir, makeRelativeSubpath("plugin.json"));
    if (
      foundManifest.path !== rootManifestPath &&
      path.dirname(foundManifest.path) === stageDir &&
      path.basename(foundManifest.path).toLowerCase() === "plugin.json"
    ) {
      await fs.rm(foundManifest.path, { force: true });
    }
    await writeJsonAtomic(rootManifestPath, normalized.manifest, 0o644);

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
        return {
          ok: false,
          kind: "bundle-invalid",
          diagnostics: [
            {
              id: makeDiagnosticId("manifest-json-syntax", pluginId, "hooks-json"),
              severity: "error",
              subject: { kind: "installed", pluginId },
              detail: {
                kind: "manifest-json-syntax",
                filePath: hooksSourcePath,
                line: parsedHooks.line,
                column: parsedHooks.column,
                hadUtf8Bom: parsedHooks.hadUtf8Bom,
                syntaxError: parsedHooks.syntaxError,
              },
              message: `Syntax error in hooks configuration: ${parsedHooks.syntaxError}`,
              hint: "Fix the JSON syntax error in hooks.json.",
            },
          ],
        };
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
      const unwrapped = wasWrapped && isRecord(parsedHooks.value.hooks) ? parsedHooks.value.hooks : parsedHooks.value;
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
        return {
          ok: false,
          kind: "bundle-invalid",
          diagnostics: [
            {
              id: makeDiagnosticId("manifest-json-syntax", pluginId, "mcp-config"),
              severity: "error",
              subject: { kind: "installed", pluginId },
              detail: {
                kind: "manifest-json-syntax",
                filePath: mcpSourcePath,
                line: parsedMcp.line,
                column: parsedMcp.column,
                hadUtf8Bom: parsedMcp.hadUtf8Bom,
                syntaxError: parsedMcp.syntaxError,
              },
              message: `Syntax error in MCP configuration: ${parsedMcp.syntaxError}`,
              hint: "Fix the JSON syntax error in .mcp.json or mcp_config.json.",
            },
          ],
        };
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
        "mcpServers" in rawMcpValue
          ? rawMcpValue
          : { mcpServers: rawMcpValue };
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
      const reported = isNonEmpty(errors)
        ? errors
        : isNonEmpty(inspection.diagnostics)
          ? inspection.diagnostics
          : ([
              {
                id: makeDiagnosticId("manifest-schema-invalid", pluginId, "stage-failed"),
                severity: "error",
                subject: { kind: "installed", pluginId },
                detail: {
                  kind: "manifest-schema-invalid",
                  filePath: rootManifestPath,
                  fieldErrors: ["Staged bundle failed validation."],
                },
                message: `Staged bundle for "${pluginId}" failed validation.`,
                hint: "Inspect bundle files and retry.",
              },
            ] satisfies NonEmpty<Diagnostic>);
      return { ok: false, kind: "bundle-invalid", diagnostics: reported };
    }

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
      await cleanupStage();
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
  const found = await findPluginManifestFile(installPath);
  const rootManifestPath = joinAbsolutePath(installPath, makeRelativeSubpath("plugin.json"));
  if (found === null) {
    return {
      ok: false,
      kind: "bundle-invalid",
      diagnostics: [
        {
          id: makeDiagnosticId("manifest-schema-invalid", pluginId, "missing"),
          severity: "error",
          subject: { kind: "installed", pluginId },
          detail: {
            kind: "manifest-schema-invalid",
            filePath: rootManifestPath,
            fieldErrors: ["Missing plugin.json manifest."],
          },
          message: `Cannot toggle "${pluginId}": missing plugin.json.`,
          hint: "Reinstall or repair plugin.json.",
        },
      ],
    };
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
    return {
      ok: false,
      kind: "bundle-invalid",
      diagnostics: [
        {
          id: makeDiagnosticId("manifest-json-syntax", pluginId, "plugin-json"),
          severity: "error",
          subject: { kind: "installed", pluginId },
          detail: {
            kind: "manifest-json-syntax",
            filePath: found.path,
            line: parsed.line,
            column: parsed.column,
            hadUtf8Bom: parsed.hadUtf8Bom,
            syntaxError: parsed.syntaxError,
          },
          message: `Cannot toggle "${pluginId}": syntax error in plugin.json: ${parsed.syntaxError}`,
          hint: "Fix the JSON syntax error in plugin.json.",
        },
      ],
    };
  }

  const normalized = normalizeAntigravityManifest(parsed.value);
  if (!normalized.ok) {
    return {
      ok: false,
      kind: "bundle-invalid",
      diagnostics: [
        {
          id: makeDiagnosticId("manifest-schema-invalid", pluginId, "plugin-json"),
          severity: "error",
          subject: { kind: "installed", pluginId },
          detail: {
            kind: "manifest-schema-invalid",
            filePath: found.path,
            fieldErrors: normalized.fieldErrors,
          },
          message: `Cannot toggle "${pluginId}": invalid plugin.json.`,
          hint: "Fix the schema errors in plugin.json.",
        },
      ],
    };
  }

  const currentlyDisabled = normalized.manifest.disabled === true;
  const targetDisabled = !enabled;
  if (currentlyDisabled === targetDisabled && found.path === rootManifestPath && !parsed.hadUtf8Bom) {
    return { ok: true, outcome: "unchanged" };
  }

  const { disabled: _prevDisabled, ...withoutDisabled } = normalized.manifest;
  const updated: NormalizedPluginManifest = targetDisabled
    ? { ...withoutDisabled, disabled: true }
    : withoutDisabled;

  try {
    if (
      found.path !== rootManifestPath &&
      path.dirname(found.path) === installPath &&
      path.basename(found.path).toLowerCase() === "plugin.json"
    ) {
      await fs.rm(found.path, { force: true });
    }
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
