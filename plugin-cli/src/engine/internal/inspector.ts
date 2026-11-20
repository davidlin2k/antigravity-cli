import fs from "node:fs/promises";
import path from "node:path";
import {
  EMPTY_COMPONENT_COUNTS,
  EMPTY_COMPONENT_INVENTORY,
  isNonEmpty,
  joinAbsolutePath,
  makeAbsolutePath,
  makeDiagnosticId,
  makeRelativeSubpath,
  parseRelativeSubpath,
} from "../../domain/types.ts";
import type {
  AbsolutePath,
  AgentSummary,
  ComponentCounts,
  ComponentInventory,
  Diagnostic,
  DiagnosticSubject,
  HookSummary,
  InstalledPluginId,
  ManifestEcosystem,
  McpServerSummary,
  NonEmpty,
  NormalizedPluginManifest,
  RemediationPlan,
  RuleSummary,
  SkillSummary,
} from "../../domain/types.ts";
import {
  extractAgentsFromJson,
  extractHooksSummary,
  extractMcpSummary,
  findFileCaseInsensitive,
  findPluginManifestFile,
  normalizeAntigravityManifest,
  parseJsoncBomSafe,
  parseYamlFrontmatter,
} from "./normalizer.ts";
import {
  errorMessage,
  isRecord,
  isWithinCanonicalRoot,
  resolvePossiblyDanglingTarget,
} from "./stores.ts";

export interface InspectPluginOptions {
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

const PLUGIN_ROOT_VAR_RE = /\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/g;

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

function collectUnexpandedPluginRootVars(value: unknown, found: Set<string>): void {
  if (typeof value === "string") {
    PLUGIN_ROOT_VAR_RE.lastIndex = 0;
    let match = PLUGIN_ROOT_VAR_RE.exec(value);
    while (match !== null) {
      if (match[0] !== undefined) {
        found.add(match[0]);
      }
      match = PLUGIN_ROOT_VAR_RE.exec(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectUnexpandedPluginRootVars(item, found);
    }
    return;
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) {
      collectUnexpandedPluginRootVars(child, found);
    }
  }
}

export function findUnexpandedPluginRootVarsInValue(value: unknown): NonEmpty<string> | null {
  const found = new Set<string>();
  collectUnexpandedPluginRootVars(value, found);
  const list = [...found];
  return isNonEmpty(list) ? list : null;
}

function readaptRemediation(
  pluginId: InstalledPluginId | undefined,
  label: string,
): { readonly remediation?: RemediationPlan } {
  if (pluginId === undefined) {
    return {};
  }
  return {
    remediation: {
      kind: "readapt-bundle",
      pluginId,
      label,
    },
  };
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

async function isSafeExistingFile(filePath: AbsolutePath, canonicalRoot: string): Promise<boolean> {
  try {
    const resolved = await fs.realpath(filePath);
    if (!isWithinCanonicalRoot(resolved, canonicalRoot)) {
      return false;
    }
    const stat = await fs.stat(resolved);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function isSafeExistingDir(dirPath: AbsolutePath, canonicalRoot: string): Promise<boolean> {
  try {
    const resolved = await fs.realpath(dirPath);
    if (!isWithinCanonicalRoot(resolved, canonicalRoot)) {
      return false;
    }
    const stat = await fs.stat(resolved);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function scanRulesDir(
  dir: AbsolutePath,
  canonicalRoot: string,
  relPrefix: string,
  ancestorRealDirs: ReadonlySet<string>,
  out: RuleSummary[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const abs = makeAbsolutePath(path.join(dir, entry.name));
    const rel = `${relPrefix}/${entry.name}`;
    if (await isSafeExistingDir(abs, canonicalRoot)) {
      const realSub = await fs.realpath(abs).catch(() => null);
      if (realSub !== null && !ancestorRealDirs.has(realSub)) {
        const nextAncestors = new Set(ancestorRealDirs);
        nextAncestors.add(realSub);
        await scanRulesDir(makeAbsolutePath(realSub), canonicalRoot, rel, nextAncestors, out);
      }
    } else if (
      entry.name.toLowerCase().endsWith(".md") &&
      (await isSafeExistingFile(abs, canonicalRoot))
    ) {
      const parsedRel = parseRelativeSubpath(rel);
      if (parsedRel.ok) {
        out.push({
          name: path.basename(entry.name, path.extname(entry.name)),
          relativePath: parsedRel.value,
        });
      }
    }
  }
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

  let manifest: NormalizedPluginManifest | null = null;
  let manifestPath: AbsolutePath | null = null;
  let manifestEcosystem: ManifestEcosystem | null = null;
  let hadUtf8Bom = false;

  const foundManifest = await findPluginManifestFile(pluginRoot);
  if (foundManifest === null) {
    const expectedPath = joinAbsolutePath(pluginRoot, makeRelativeSubpath("plugin.json"));
    diagnostics.push({
      id: makeDiagnosticId("manifest-schema-invalid", subKey, "missing"),
      severity: "error",
      subject,
      detail: {
        kind: "manifest-schema-invalid",
        filePath: expectedPath,
        fieldErrors: ["Missing plugin.json manifest."],
      },
      message: `No plugin.json manifest found in "${pluginRoot}".`,
      hint: "Add a valid root plugin.json with at least a string 'name' field.",
    });
  } else if (await isSafeExistingFile(foundManifest.path, canonicalRoot)) {
    manifestPath = foundManifest.path;
    manifestEcosystem = foundManifest.ecosystem;
    try {
      const rawBytes = await fs.readFile(foundManifest.path);
      const parsed = parseJsoncBomSafe(rawBytes, foundManifest.path);
      hadUtf8Bom = parsed.hadUtf8Bom;
      if (!parsed.ok) {
        diagnostics.push({
          id: makeDiagnosticId("manifest-json-syntax", subKey, "plugin-json"),
          severity: "error",
          subject,
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
          diagnostics.push({
            id: makeDiagnosticId("manifest-schema-invalid", subKey, "plugin-json"),
            severity: "error",
            subject,
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
      diagnostics.push({
        id: makeDiagnosticId("manifest-schema-invalid", subKey, "read-error"),
        severity: "error",
        subject,
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

  const skills: SkillSummary[] = [];
  const skillsDir = makeAbsolutePath(path.join(pluginRoot, "skills"));
  if (await isSafeExistingDir(skillsDir, canonicalRoot)) {
    try {
      const skillEntries = await fs.readdir(skillsDir, { withFileTypes: true });
      skillEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of skillEntries) {
        const subDir = makeAbsolutePath(path.join(skillsDir, entry.name));
        if (!(await isSafeExistingDir(subDir, canonicalRoot))) {
          continue;
        }
        const skillFile = await findFileCaseInsensitive(subDir, "skill.md");
        if (skillFile === null || !(await isSafeExistingFile(skillFile, canonicalRoot))) {
          continue;
        }
        try {
          const text = await fs.readFile(skillFile, "utf8");
          const fm = parseYamlFrontmatter(text);
          const fmName = fm.fields.get("name")?.trim() ?? "";
          const fmDesc = fm.fields.get("description")?.trim() ?? "";
          const missingFields: ("frontmatter" | "name" | "description")[] = [];
          if (!fm.present) {
            missingFields.push("frontmatter");
          } else {
            if (fmName.length === 0) {
              missingFields.push("name");
            }
            if (fmDesc.length === 0) {
              missingFields.push("description");
            }
          }
          if (isNonEmpty(missingFields)) {
            diagnostics.push({
              id: makeDiagnosticId("skill-frontmatter-missing", subKey, entry.name),
              severity: "warning",
              subject,
              detail: {
                kind: "skill-frontmatter-missing",
                skillFilePath: skillFile,
                folderName: entry.name,
                missingFields,
              },
              message: `Skill "${entry.name}" SKILL.md is missing ${missingFields.join(", ")}.`,
              hint: `Add YAML frontmatter with name and description to skills/${entry.name}/SKILL.md (falling back to folder name "${entry.name}").`,
            });
          }
          const resolvedName = fmName.length > 0 ? fmName : entry.name;
          skills.push({
            name: resolvedName,
            folderName: entry.name,
            description: fmDesc,
            frontmatterNamePresent: fmName.length > 0,
            estimatedTokens: Math.ceil((resolvedName.length + fmDesc.length) / 4),
          });
        } catch {
        }
      }
    } catch {
    }
  }

  const agents: AgentSummary[] = [];
  const agentsDir = makeAbsolutePath(path.join(pluginRoot, "agents"));
  if (await isSafeExistingDir(agentsDir, canonicalRoot)) {
    try {
      const agentEntries = await fs.readdir(agentsDir, { withFileTypes: true });
      agentEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of agentEntries) {
        if (!entry.name.toLowerCase().endsWith(".md")) {
          continue;
        }
        const filePath = makeAbsolutePath(path.join(agentsDir, entry.name));
        if (!(await isSafeExistingFile(filePath, canonicalRoot))) {
          continue;
        }
        try {
          const text = await fs.readFile(filePath, "utf8");
          const fm = parseYamlFrontmatter(text);
          const stem = entry.name.slice(0, -3);
          const fmName = fm.fields.get("name")?.trim() ?? "";
          const fmDesc = fm.fields.get("description")?.trim() ?? "";
          agents.push({
            name: fmName.length > 0 ? fmName : stem,
            fileName: entry.name,
            description: fmDesc,
          });
        } catch {
        }
      }
    } catch {
    }
  }

  const agentsJsonPath = makeAbsolutePath(path.join(pluginRoot, "agents.json"));
  if (await isSafeExistingFile(agentsJsonPath, canonicalRoot)) {
    try {
      const rawBytes = await fs.readFile(agentsJsonPath);
      const parsed = parseJsoncBomSafe(rawBytes, agentsJsonPath);
      if (!parsed.ok) {
        diagnostics.push({
          id: makeDiagnosticId("manifest-json-syntax", subKey, "agents-json"),
          severity: "error",
          subject,
          detail: {
            kind: "manifest-json-syntax",
            filePath: agentsJsonPath,
            line: parsed.line,
            column: parsed.column,
            hadUtf8Bom: parsed.hadUtf8Bom,
            syntaxError: parsed.syntaxError,
          },
          message: `Syntax error in agents.json: ${parsed.syntaxError}`,
          hint: "Fix the JSON syntax error in agents.json.",
        });
      } else {
        agents.push(...extractAgentsFromJson(parsed.value));
      }
    } catch {
    }
  }

  const rules: RuleSummary[] = [];
  const rulesDir = makeAbsolutePath(path.join(pluginRoot, "rules"));
  if (await isSafeExistingDir(rulesDir, canonicalRoot)) {
    const realRulesDir = await fs.realpath(rulesDir).catch(() => null);
    if (realRulesDir !== null) {
      await scanRulesDir(
        makeAbsolutePath(realRulesDir),
        canonicalRoot,
        "rules",
        new Set<string>([canonicalRoot, realRulesDir]),
        rules,
      );
    }
  }
  for (const rootRule of ["AGENTS.md", "GEMINI.md"] as const) {
    const rootRulePath = makeAbsolutePath(path.join(pluginRoot, rootRule));
    if (await isSafeExistingFile(rootRulePath, canonicalRoot)) {
      rules.push({
        name: path.basename(rootRule, ".md"),
        relativePath: makeRelativeSubpath(rootRule),
      });
    }
  }

  let hooks: readonly HookSummary[] = [];
  let hooksTotal = 0;
  const rootHooksPath = makeAbsolutePath(path.join(pluginRoot, "hooks.json"));
  const nestedHooksPath = makeAbsolutePath(path.join(pluginRoot, "hooks", "hooks.json"));
  const hasRootHooks = await isSafeExistingFile(rootHooksPath, canonicalRoot);
  const hasNestedHooks = await isSafeExistingFile(nestedHooksPath, canonicalRoot);

  if (hasRootHooks) {
    try {
      const rawBytes = await fs.readFile(rootHooksPath);
      const parsed = parseJsoncBomSafe(rawBytes, rootHooksPath);
      if (!parsed.ok) {
        diagnostics.push({
          id: makeDiagnosticId("manifest-json-syntax", subKey, "hooks-json"),
          severity: "error",
          subject,
          detail: {
            kind: "manifest-json-syntax",
            filePath: rootHooksPath,
            line: parsed.line,
            column: parsed.column,
            hadUtf8Bom: parsed.hadUtf8Bom,
            syntaxError: parsed.syntaxError,
          },
          message: `Syntax error in hooks.json: ${parsed.syntaxError}`,
          hint: "Fix the JSON syntax error in hooks.json.",
        });
      } else if (!isRecord(parsed.value)) {
        diagnostics.push({
          id: makeDiagnosticId("hooks-invalid", subKey, "non-object"),
          severity: "error",
          subject,
          detail: {
            kind: "hooks-invalid",
            filePath: rootHooksPath,
            reason: "hooks.json must contain a JSON object.",
          },
          message: "Root hooks.json must contain a JSON object.",
          hint: "Replace hooks.json with a valid hook event object.",
        });
      } else {
        const summary = extractHooksSummary(parsed.value);
        if (summary.wrapped) {
          diagnostics.push({
            id: makeDiagnosticId("hooks-invalid", subKey, "wrapped"),
            severity: "warning",
            subject,
            detail: {
              kind: "hooks-invalid",
              filePath: rootHooksPath,
              reason: 'Top-level "hooks" wrapper must be unwrapped for Antigravity.',
            },
            message: 'Root hooks.json uses a top-level "hooks" wrapper that Antigravity ignores.',
            hint: "Re-adapt the plugin bundle to unwrap hooks.json into top-level hook events.",
            ...readaptRemediation(pluginIdForRemediation, "Re-adapt hooks.json"),
          });
        }
        for (let i = 0; i < summary.regexErrors.length; i += 1) {
          const reason = summary.regexErrors[i] ?? "Invalid regex matcher.";
          diagnostics.push({
            id: makeDiagnosticId("hooks-invalid", subKey, `regex-${i}`),
            severity: "error",
            subject,
            detail: {
              kind: "hooks-invalid",
              filePath: rootHooksPath,
              reason,
            },
            message: reason,
            hint: "Fix the invalid regular expression in hooks.json matcher.",
          });
        }
        const unexpanded = findUnexpandedPluginRootVarsInValue(parsed.value);
        if (unexpanded !== null) {
          diagnostics.push({
            id: makeDiagnosticId("unexpanded-plugin-root", subKey, "hooks-json"),
            severity: "warning",
            subject,
            detail: {
              kind: "unexpanded-plugin-root",
              filePath: rootHooksPath,
              variables: unexpanded,
            },
            message: `hooks.json contains unexpanded root placeholders: ${unexpanded.join(", ")}.`,
            hint: "Re-adapt the plugin bundle to expand plugin root variables to the installed path.",
            ...readaptRemediation(pluginIdForRemediation, "Expand plugin root in hooks.json"),
          });
        }
        hooks = summary.hooks;
        hooksTotal = summary.totalCommands;
      }
    } catch {
    }
  } else if (hasNestedHooks) {
    diagnostics.push({
      id: makeDiagnosticId("unadapted-hooks-path", subKey),
      severity: "warning",
      subject,
      detail: {
        kind: "unadapted-hooks-path",
        sourcePath: nestedHooksPath,
        expectedPath: rootHooksPath,
      },
      message: "Found unadapted hooks/hooks.json; Antigravity only loads root hooks.json.",
      hint: "Re-adapt the plugin bundle to promote and unwrap hooks/hooks.json into root hooks.json.",
      ...readaptRemediation(pluginIdForRemediation, "Re-adapt hooks/hooks.json"),
    });
    try {
      const nestedBytes = await fs.readFile(nestedHooksPath);
      const parsedNested = parseJsoncBomSafe(nestedBytes, nestedHooksPath);
      const unexpanded = parsedNested.ok
        ? findUnexpandedPluginRootVarsInValue(parsedNested.value)
        : null;
      if (unexpanded !== null) {
        diagnostics.push({
          id: makeDiagnosticId("unexpanded-plugin-root", subKey, "nested-hooks"),
          severity: "warning",
          subject,
          detail: {
            kind: "unexpanded-plugin-root",
            filePath: nestedHooksPath,
            variables: unexpanded,
          },
          message: `hooks/hooks.json contains unexpanded root placeholders: ${unexpanded.join(", ")}.`,
          hint: "Re-adapt the plugin bundle to expand plugin root variables.",
          ...readaptRemediation(pluginIdForRemediation, "Re-adapt bundle"),
        });
      }
    } catch {
    }
  }

  let mcpServers: readonly McpServerSummary[] = [];
  const rootMcpPath = makeAbsolutePath(path.join(pluginRoot, "mcp_config.json"));
  const nestedMcpPath = makeAbsolutePath(path.join(pluginRoot, ".mcp.json"));
  const hasRootMcp = await isSafeExistingFile(rootMcpPath, canonicalRoot);
  const hasNestedMcp = await isSafeExistingFile(nestedMcpPath, canonicalRoot);

  if (hasRootMcp) {
    try {
      const rawBytes = await fs.readFile(rootMcpPath);
      const parsed = parseJsoncBomSafe(rawBytes, rootMcpPath);
      if (!parsed.ok) {
        diagnostics.push({
          id: makeDiagnosticId("manifest-json-syntax", subKey, "mcp-config"),
          severity: "error",
          subject,
          detail: {
            kind: "manifest-json-syntax",
            filePath: rootMcpPath,
            line: parsed.line,
            column: parsed.column,
            hadUtf8Bom: parsed.hadUtf8Bom,
            syntaxError: parsed.syntaxError,
          },
          message: `Syntax error in mcp_config.json: ${parsed.syntaxError}`,
          hint: "Fix the JSON syntax error in mcp_config.json.",
        });
      } else if (!isRecord(parsed.value)) {
        diagnostics.push({
          id: makeDiagnosticId("mcp-config-invalid", subKey, "non-object"),
          severity: "error",
          subject,
          detail: {
            kind: "mcp-config-invalid",
            filePath: rootMcpPath,
            reason: "mcp_config.json must contain a JSON object.",
          },
          message: "Root mcp_config.json must contain a JSON object.",
          hint: "Provide an object with an mcpServers map in mcp_config.json.",
        });
      } else if ("mcpServers" in parsed.value && !isRecord(parsed.value.mcpServers)) {
        diagnostics.push({
          id: makeDiagnosticId("mcp-config-invalid", subKey, "mcp-servers-type"),
          severity: "error",
          subject,
          detail: {
            kind: "mcp-config-invalid",
            filePath: rootMcpPath,
            reason: 'Field "mcpServers" in mcp_config.json must be a JSON object.',
          },
          message: 'Field "mcpServers" in mcp_config.json must be a JSON object.',
          hint: "Ensure mcpServers maps server names to configuration objects.",
        });
      } else {
        const unexpanded = findUnexpandedPluginRootVarsInValue(parsed.value);
        if (unexpanded !== null) {
          diagnostics.push({
            id: makeDiagnosticId("unexpanded-plugin-root", subKey, "mcp-config"),
            severity: "warning",
            subject,
            detail: {
              kind: "unexpanded-plugin-root",
              filePath: rootMcpPath,
              variables: unexpanded,
            },
            message: `mcp_config.json contains unexpanded root placeholders: ${unexpanded.join(", ")}.`,
            hint: "Re-adapt the plugin bundle to expand plugin root variables to the installed path.",
            ...readaptRemediation(pluginIdForRemediation, "Expand plugin root in mcp_config.json"),
          });
        }
        mcpServers = extractMcpSummary(parsed.value);
      }
    } catch {
    }
  } else if (hasNestedMcp) {
    diagnostics.push({
      id: makeDiagnosticId("unadapted-mcp-path", subKey),
      severity: "warning",
      subject,
      detail: {
        kind: "unadapted-mcp-path",
        sourcePath: nestedMcpPath,
        expectedPath: rootMcpPath,
      },
      message: "Found unadapted .mcp.json; Antigravity loads root mcp_config.json.",
      hint: "Re-adapt the plugin bundle to convert .mcp.json into root mcp_config.json.",
      ...readaptRemediation(pluginIdForRemediation, "Re-adapt .mcp.json"),
    });
    try {
      const nestedBytes = await fs.readFile(nestedMcpPath);
      const parsedNested = parseJsoncBomSafe(nestedBytes, nestedMcpPath);
      const unexpanded = parsedNested.ok
        ? findUnexpandedPluginRootVarsInValue(parsedNested.value)
        : null;
      if (unexpanded !== null) {
        diagnostics.push({
          id: makeDiagnosticId("unexpanded-plugin-root", subKey, "dot-mcp"),
          severity: "warning",
          subject,
          detail: {
            kind: "unexpanded-plugin-root",
            filePath: nestedMcpPath,
            variables: unexpanded,
          },
          message: `.mcp.json contains unexpanded root placeholders: ${unexpanded.join(", ")}.`,
          hint: "Re-adapt the plugin bundle to expand plugin root variables.",
          ...readaptRemediation(pluginIdForRemediation, "Re-adapt bundle"),
        });
      }
    } catch {
    }
  }

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

export { EMPTY_COMPONENT_COUNTS };
