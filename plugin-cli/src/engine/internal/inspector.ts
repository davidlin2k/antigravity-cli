import fs from "node:fs/promises";
import path from "node:path";
import {
  EMPTY_COMPONENT_INVENTORY,
  joinAbsolutePath,
  makeAbsolutePath,
  makeDiagnosticId,
  makeRelativeSubpath,
} from "../../domain/types.ts";
import type {
  AbsolutePath,
  ComponentCounts,
  ComponentInventory,
  Diagnostic,
  DiagnosticSubject,
  InstalledPluginId,
  ManifestEcosystem,
  NormalizedPluginManifest,
  RemediationPlan,
} from "../../domain/types.ts";
import {
  errorMessage,
  isWithinCanonicalRoot,
  resolvePossiblyDanglingTarget,
} from "./fs-safety.ts";
import {
  inspectAgents,
  inspectHooks,
  inspectMcp,
  inspectRules,
  inspectSkills,
  isSafeExistingFile,
} from "./inspector-components.ts";
import type { ComponentScanContext } from "./inspector-components.ts";
import { parseJsoncBomSafe } from "./jsonc.ts";
import {
  findPluginManifestFile,
  normalizeAntigravityManifest,
} from "./manifest.ts";

interface InspectPluginOptions {
  readonly pluginRoot: AbsolutePath;
  readonly subject: DiagnosticSubject;
  readonly pluginIdForRemediation?: InstalledPluginId;
  readonly allowMissingNameFallback?: string;
}

export interface PluginInspectionResult {
  readonly valid: boolean;
  readonly manifest: NormalizedPluginManifest | null;
  readonly manifestPath: AbsolutePath | null;
  readonly manifestEcosystem: ManifestEcosystem | null;
  readonly hadUtf8Bom: boolean;
  readonly components: ComponentInventory;
  readonly diskBytes: number;
  readonly estimatedDescriptionTokens: number;
  readonly diagnostics: readonly Diagnostic[];
}

function subjectKey(subject: DiagnosticSubject): string {
  switch (subject.kind) {
    case "installed":
      return subject.pluginId;
    case "marketplace":
      return subject.marketplaceId;
    case "path":
      return subject.path;
    default: {
      const _exhaustive: never = subject;
      return _exhaustive;
    }
  }
}

function removeRemediation(
  pluginId: InstalledPluginId | undefined,
  label: string,
): { readonly remediation?: RemediationPlan } {
  if (pluginId === undefined) {
    return {};
  }
  return {
    remediation: {
      kind: "remove-plugin",
      pluginId,
      label,
    },
  };
}

interface WalkStats {
  diskBytes: number;
  readonly unsafePaths: Set<string>;
  readonly countedRealFiles: Set<string>;
}

async function walkAndCheckContainment(input: {
  readonly currentDir: AbsolutePath;
  readonly canonicalRoot: string;
  readonly relPrefix: string;
  readonly ancestorRealDirs: ReadonlySet<string>;
  readonly stats: WalkStats;
  readonly subject: DiagnosticSubject;
  readonly pluginIdForRemediation: InstalledPluginId | undefined;
  readonly diagnostics: Diagnostic[];
}): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(input.currentDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    const entryAbs = makeAbsolutePath(path.join(input.currentDir, entry.name));
    const relPath = input.relPrefix.length > 0 ? `${input.relPrefix}/${entry.name}` : entry.name;

    let lstat;
    try {
      lstat = await fs.lstat(entryAbs);
    } catch {
      continue;
    }

    if (lstat.isSymbolicLink()) {
      let resolvedTarget: string;
      let targetStat: Awaited<ReturnType<typeof fs.stat>> | null = null;
      try {
        resolvedTarget = await fs.realpath(entryAbs);
        targetStat = await fs.stat(entryAbs);
      } catch {
        try {
          const linkRaw = await fs.readlink(entryAbs);
          resolvedTarget = await resolvePossiblyDanglingTarget(input.currentDir, linkRaw);
        } catch {
          resolvedTarget = entryAbs;
        }
      }

      if (!isWithinCanonicalRoot(resolvedTarget, input.canonicalRoot)) {
        input.stats.unsafePaths.add(entryAbs);
        input.diagnostics.push({
          id: makeDiagnosticId("path-traversal-rejected", subjectKey(input.subject), relPath),
          severity: "error",
          subject: input.subject,
          detail: {
            kind: "path-traversal-rejected",
            offendingPath: relPath,
            resolvedOutsideRoot: resolvedTarget,
          },
          message: `Symlink "${relPath}" resolves outside the plugin root (${resolvedTarget}).`,
          hint: "Remove the unsafe symlink or uninstall this plugin.",
          ...removeRemediation(input.pluginIdForRemediation, "Remove unsafe plugin"),
        });
        continue;
      }

      if (targetStat !== null) {
        if (targetStat.isDirectory()) {
          if (!input.ancestorRealDirs.has(resolvedTarget)) {
            const nextAncestors = new Set(input.ancestorRealDirs);
            nextAncestors.add(resolvedTarget);
            await walkAndCheckContainment({
              ...input,
              currentDir: makeAbsolutePath(resolvedTarget),
              relPrefix: relPath,
              ancestorRealDirs: nextAncestors,
            });
          }
        } else if (targetStat.isFile()) {
          if (!input.stats.countedRealFiles.has(resolvedTarget)) {
            input.stats.countedRealFiles.add(resolvedTarget);
            input.stats.diskBytes += targetStat.size;
          }
        }
      }
      continue;
    }

    if (lstat.isDirectory()) {
      let realDir: string;
      try {
        realDir = await fs.realpath(entryAbs);
      } catch {
        continue;
      }
      if (!isWithinCanonicalRoot(realDir, input.canonicalRoot)) {
        input.stats.unsafePaths.add(entryAbs);
        input.diagnostics.push({
          id: makeDiagnosticId("path-traversal-rejected", subjectKey(input.subject), relPath),
          severity: "error",
          subject: input.subject,
          detail: {
            kind: "path-traversal-rejected",
            offendingPath: relPath,
            resolvedOutsideRoot: realDir,
          },
          message: `Directory "${relPath}" resolves outside the plugin root (${realDir}).`,
          hint: "Remove the escaping directory or uninstall this plugin.",
          ...removeRemediation(input.pluginIdForRemediation, "Remove unsafe plugin"),
        });
        continue;
      }
      if (!input.ancestorRealDirs.has(realDir)) {
        const nextAncestors = new Set(input.ancestorRealDirs);
        nextAncestors.add(realDir);
        await walkAndCheckContainment({
          ...input,
          currentDir: makeAbsolutePath(realDir),
          relPrefix: relPath,
          ancestorRealDirs: nextAncestors,
        });
      }
    } else if (lstat.isFile()) {
      if (!input.stats.countedRealFiles.has(entryAbs)) {
        input.stats.countedRealFiles.add(entryAbs);
        input.stats.diskBytes += lstat.size;
      }
    }
  }
}

interface ManifestInspectionResult {
  readonly manifest: NormalizedPluginManifest | null;
  readonly manifestPath: AbsolutePath | null;
  readonly manifestEcosystem: ManifestEcosystem | null;
  readonly hadUtf8Bom: boolean;
}

async function inspectManifest(
  ctx: ComponentScanContext,
  allowMissingNameFallback: string | undefined,
): Promise<ManifestInspectionResult> {
  let manifest: NormalizedPluginManifest | null = null;
  let manifestPath: AbsolutePath | null = null;
  let manifestEcosystem: ManifestEcosystem | null = null;
  let hadUtf8Bom = false;

  const foundManifest = await findPluginManifestFile(ctx.pluginRoot);
  if (foundManifest === null) {
    const expectedPath = joinAbsolutePath(ctx.pluginRoot, makeRelativeSubpath("plugin.json"));
    ctx.diagnostics.push({
      id: makeDiagnosticId("manifest-schema-invalid", ctx.subKey, "missing"),
      severity: "error",
      subject: ctx.subject,
      detail: {
        kind: "manifest-schema-invalid",
        filePath: expectedPath,
        fieldErrors: ["Missing plugin.json manifest."],
      },
      message: `No plugin.json manifest found in "${ctx.pluginRoot}".`,
      hint: "Add a valid root plugin.json with at least a string 'name' field.",
    });
    return { manifest, manifestPath, manifestEcosystem, hadUtf8Bom };
  }

  if (await isSafeExistingFile(foundManifest.path, ctx.canonicalRoot)) {
    manifestPath = foundManifest.path;
    manifestEcosystem = foundManifest.ecosystem;
    try {
      const rawBytes = await fs.readFile(foundManifest.path);
      const parsed = parseJsoncBomSafe(rawBytes, foundManifest.path);
      hadUtf8Bom = parsed.hadUtf8Bom;
      if (!parsed.ok) {
        ctx.diagnostics.push({
          id: makeDiagnosticId("manifest-json-syntax", ctx.subKey, "plugin-json"),
          severity: "error",
          subject: ctx.subject,
          detail: {
            kind: "manifest-json-syntax",
            filePath: foundManifest.path,
            line: parsed.line,
            column: parsed.column,
            hadUtf8Bom: parsed.hadUtf8Bom,
            syntaxError: parsed.syntaxError,
          },
          message: `Syntax error in ${foundManifest.relativePath}${parsed.line !== null ? ` at line ${parsed.line}, column ${parsed.column ?? 1}` : ""}: ${parsed.syntaxError}`,
          hint: "Fix the JSON syntax error in plugin.json.",
        });
      } else {
        const normalized = normalizeAntigravityManifest(parsed.value, allowMissingNameFallback);
        if (!normalized.ok) {
          ctx.diagnostics.push({
            id: makeDiagnosticId("manifest-schema-invalid", ctx.subKey, "plugin-json"),
            severity: "error",
            subject: ctx.subject,
            detail: {
              kind: "manifest-schema-invalid",
              filePath: foundManifest.path,
              fieldErrors: normalized.fieldErrors,
            },
            message: `Invalid ${foundManifest.relativePath}: ${normalized.fieldErrors.join(" ")}`,
            hint: "Fix the schema errors in plugin.json.",
          });
        } else {
          manifest = normalized.manifest;
        }
      }
    } catch (err) {
      ctx.diagnostics.push({
        id: makeDiagnosticId("manifest-schema-invalid", ctx.subKey, "read-error"),
        severity: "error",
        subject: ctx.subject,
        detail: {
          kind: "manifest-schema-invalid",
          filePath: foundManifest.path,
          fieldErrors: [`Failed to read manifest: ${errorMessage(err)}`],
        },
        message: `Failed to read ${foundManifest.relativePath}: ${errorMessage(err)}`,
        hint: "Ensure plugin.json is readable.",
      });
    }
  }

  return { manifest, manifestPath, manifestEcosystem, hadUtf8Bom };
}

function emptyFailureResult(diagnostics: readonly Diagnostic[]): PluginInspectionResult {
  return {
    valid: false,
    manifest: null,
    manifestPath: null,
    manifestEcosystem: null,
    hadUtf8Bom: false,
    components: EMPTY_COMPONENT_INVENTORY,
    diskBytes: 0,
    estimatedDescriptionTokens: 0,
    diagnostics,
  };
}

export async function inspectPluginDirectory(
  options: InspectPluginOptions,
): Promise<PluginInspectionResult> {
  const { pluginRoot, subject, pluginIdForRemediation, allowMissingNameFallback } = options;
  const subKey = subjectKey(subject);
  const diagnostics: Diagnostic[] = [];

  let canonicalRoot: string;
  try {
    const rootStat = await fs.stat(pluginRoot);
    if (!rootStat.isDirectory()) {
      diagnostics.push({
        id: makeDiagnosticId("manifest-schema-invalid", subKey, "not-dir"),
        severity: "error",
        subject,
        detail: {
          kind: "manifest-schema-invalid",
          filePath: pluginRoot,
          fieldErrors: ["Plugin path is not a directory."],
        },
        message: `Plugin path "${pluginRoot}" is not a directory.`,
        hint: "Provide a valid plugin directory containing plugin.json.",
      });
      return emptyFailureResult(diagnostics);
    }
    canonicalRoot = await fs.realpath(pluginRoot);
  } catch (err) {
    diagnostics.push({
      id: makeDiagnosticId("manifest-schema-invalid", subKey, "unreadable"),
      severity: "error",
      subject,
      detail: {
        kind: "manifest-schema-invalid",
        filePath: pluginRoot,
        fieldErrors: [`Plugin directory could not be accessed: ${errorMessage(err)}`],
      },
      message: `Plugin directory "${pluginRoot}" could not be accessed.`,
      hint: "Verify the plugin directory exists and is readable.",
    });
    return emptyFailureResult(diagnostics);
  }

  const walkStats: WalkStats = {
    diskBytes: 0,
    unsafePaths: new Set(),
    countedRealFiles: new Set(),
  };
  await walkAndCheckContainment({
    currentDir: makeAbsolutePath(canonicalRoot),
    canonicalRoot,
    relPrefix: "",
    ancestorRealDirs: new Set<string>([canonicalRoot]),
    stats: walkStats,
    subject,
    pluginIdForRemediation,
    diagnostics,
  });

  const scanCtx: ComponentScanContext = {
    pluginRoot,
    canonicalRoot,
    subject,
    subKey,
    pluginIdForRemediation,
    diagnostics,
  };

  const { manifest, manifestPath, manifestEcosystem, hadUtf8Bom } = await inspectManifest(
    scanCtx,
    allowMissingNameFallback,
  );
  const skills = await inspectSkills(scanCtx);
  const agents = await inspectAgents(scanCtx);
  const rules = await inspectRules(scanCtx);
  const { hooks, totalCommands: hooksTotal } = await inspectHooks(scanCtx);
  const mcpServers = await inspectMcp(scanCtx);

  let descriptionChars = 0;
  for (const skill of skills) {
    descriptionChars += skill.name.length + skill.description.length;
  }
  for (const agent of agents) {
    descriptionChars += agent.name.length + agent.description.length;
  }
  if (manifest?.description !== undefined) {
    descriptionChars += manifest.description.length;
  }
  const estimatedDescriptionTokens =
    descriptionChars > 0 ? Math.ceil(descriptionChars / 4) : 0;

  const counts: ComponentCounts = {
    skills: skills.length,
    agents: agents.length,
    rules: rules.length,
    hooks: hooksTotal,
    mcpServers: mcpServers.length,
  };
  const components: ComponentInventory =
    counts.skills === 0 &&
    counts.agents === 0 &&
    counts.rules === 0 &&
    counts.hooks === 0 &&
    counts.mcpServers === 0
      ? EMPTY_COMPONENT_INVENTORY
      : {
          counts,
          skills,
          agents,
          rules,
          hooks,
          mcpServers,
        };

  const valid = manifest !== null && diagnostics.every((d) => d.severity !== "error");

  return {
    valid,
    manifest,
    manifestPath,
    manifestEcosystem,
    hadUtf8Bom,
    components,
    diskBytes: walkStats.diskBytes,
    estimatedDescriptionTokens,
    diagnostics,
  };
}
