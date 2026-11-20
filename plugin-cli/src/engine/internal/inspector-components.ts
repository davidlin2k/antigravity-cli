import fs from "node:fs/promises";
import path from "node:path";
import {
  isNonEmpty,
  makeAbsolutePath,
  makeDiagnosticId,
  makeRelativeSubpath,
  parseRelativeSubpath,
} from "../../domain/types.ts";
import type {
  AbsolutePath,
  AgentSummary,
  Diagnostic,
  DiagnosticSubject,
  HookSummary,
  InstalledPluginId,
  McpServerSummary,
  NonEmpty,
  RemediationPlan,
  RuleSummary,
  SkillSummary,
} from "../../domain/types.ts";
import { isRecord, isWithinCanonicalRoot } from "./fs-safety.ts";
import { parseJsoncBomSafe, parseYamlFrontmatter } from "./jsonc.ts";
import {
  extractAgentsFromJson,
  extractHooksSummary,
  extractMcpSummary,
  findFileCaseInsensitive,
} from "./manifest.ts";

export interface ComponentScanContext {
  readonly pluginRoot: AbsolutePath;
  readonly canonicalRoot: string;
  readonly subject: DiagnosticSubject;
  readonly subKey: string;
  readonly pluginIdForRemediation: InstalledPluginId | undefined;
  readonly diagnostics: Diagnostic[];
}

const PLUGIN_ROOT_VAR_RE = /\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/g;

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

function findUnexpandedPluginRootVarsInValue(value: unknown): NonEmpty<string> | null {
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

function pushJsonSyntaxDiagnostic(
  ctx: ComponentScanContext,
  idSuffix: string,
  filePath: AbsolutePath,
  fileLabel: string,
  parsed: {
    readonly line: number | null;
    readonly column: number | null;
    readonly hadUtf8Bom: boolean;
    readonly syntaxError: string;
  },
): void {
  ctx.diagnostics.push({
    id: makeDiagnosticId("manifest-json-syntax", ctx.subKey, idSuffix),
    severity: "error",
    subject: ctx.subject,
    detail: {
      kind: "manifest-json-syntax",
      filePath,
      line: parsed.line,
      column: parsed.column,
      hadUtf8Bom: parsed.hadUtf8Bom,
      syntaxError: parsed.syntaxError,
    },
    message: `Syntax error in ${fileLabel}: ${parsed.syntaxError}`,
    hint: `Fix the JSON syntax error in ${fileLabel}.`,
  });
}

function pushUnexpandedRootDiagnostic(
  ctx: ComponentScanContext,
  idSuffix: string,
  filePath: AbsolutePath,
  fileLabel: string,
  variables: NonEmpty<string>,
  hint: string,
  remediationLabel: string,
): void {
  ctx.diagnostics.push({
    id: makeDiagnosticId("unexpanded-plugin-root", ctx.subKey, idSuffix),
    severity: "warning",
    subject: ctx.subject,
    detail: {
      kind: "unexpanded-plugin-root",
      filePath,
      variables,
    },
    message: `${fileLabel} contains unexpanded root placeholders: ${variables.join(", ")}.`,
    hint,
    ...readaptRemediation(ctx.pluginIdForRemediation, remediationLabel),
  });
}

async function checkNestedUnexpandedVars(
  ctx: ComponentScanContext,
  filePath: AbsolutePath,
  idSuffix: string,
  fileLabel: string,
): Promise<void> {
  try {
    const nestedBytes = await fs.readFile(filePath);
    const parsedNested = parseJsoncBomSafe(nestedBytes, filePath);
    const unexpanded = parsedNested.ok
      ? findUnexpandedPluginRootVarsInValue(parsedNested.value)
      : null;
    if (unexpanded !== null) {
      pushUnexpandedRootDiagnostic(
        ctx,
        idSuffix,
        filePath,
        fileLabel,
        unexpanded,
        "Re-adapt the plugin bundle to expand plugin root variables.",
        "Re-adapt bundle",
      );
    }
  } catch {
  }
}

async function safeResolvedStat(
  targetPath: AbsolutePath,
  canonicalRoot: string,
): Promise<Awaited<ReturnType<typeof fs.stat>> | null> {
  try {
    const resolved = await fs.realpath(targetPath);
    if (!isWithinCanonicalRoot(resolved, canonicalRoot)) {
      return null;
    }
    return await fs.stat(resolved);
  } catch {
    return null;
  }
}

export async function isSafeExistingFile(
  filePath: AbsolutePath,
  canonicalRoot: string,
): Promise<boolean> {
  return (await safeResolvedStat(filePath, canonicalRoot))?.isFile() ?? false;
}

async function isSafeExistingDir(
  dirPath: AbsolutePath,
  canonicalRoot: string,
): Promise<boolean> {
  return (await safeResolvedStat(dirPath, canonicalRoot))?.isDirectory() ?? false;
}

async function readDirSorted(dir: AbsolutePath) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return entries;
  } catch {
    return null;
  }
}

async function scanRulesDir(
  dir: AbsolutePath,
  canonicalRoot: string,
  relPrefix: string,
  ancestorRealDirs: ReadonlySet<string>,
  out: RuleSummary[],
): Promise<void> {
  const entries = await readDirSorted(dir);
  if (entries === null) {
    return;
  }
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

export async function inspectSkills(ctx: ComponentScanContext): Promise<SkillSummary[]> {
  const skills: SkillSummary[] = [];
  const skillsDir = makeAbsolutePath(path.join(ctx.pluginRoot, "skills"));
  if (!(await isSafeExistingDir(skillsDir, ctx.canonicalRoot))) {
    return skills;
  }
  const skillEntries = await readDirSorted(skillsDir);
  if (skillEntries === null) {
    return skills;
  }
  for (const entry of skillEntries) {
    const subDir = makeAbsolutePath(path.join(skillsDir, entry.name));
    if (!(await isSafeExistingDir(subDir, ctx.canonicalRoot))) {
      continue;
    }
    const skillFile = await findFileCaseInsensitive(subDir, "skill.md");
    if (skillFile === null || !(await isSafeExistingFile(skillFile, ctx.canonicalRoot))) {
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
        ctx.diagnostics.push({
          id: makeDiagnosticId("skill-frontmatter-missing", ctx.subKey, entry.name),
          severity: "warning",
          subject: ctx.subject,
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
  return skills;
}

export async function inspectAgents(ctx: ComponentScanContext): Promise<AgentSummary[]> {
  const agents: AgentSummary[] = [];
  const agentsDir = makeAbsolutePath(path.join(ctx.pluginRoot, "agents"));
  if (await isSafeExistingDir(agentsDir, ctx.canonicalRoot)) {
    const agentEntries = await readDirSorted(agentsDir);
    for (const entry of agentEntries ?? []) {
      if (!entry.name.toLowerCase().endsWith(".md")) {
        continue;
      }
      const filePath = makeAbsolutePath(path.join(agentsDir, entry.name));
      if (!(await isSafeExistingFile(filePath, ctx.canonicalRoot))) {
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
  }

  const agentsJsonPath = makeAbsolutePath(path.join(ctx.pluginRoot, "agents.json"));
  if (await isSafeExistingFile(agentsJsonPath, ctx.canonicalRoot)) {
    try {
      const rawBytes = await fs.readFile(agentsJsonPath);
      const parsed = parseJsoncBomSafe(rawBytes, agentsJsonPath);
      if (!parsed.ok) {
        pushJsonSyntaxDiagnostic(ctx, "agents-json", agentsJsonPath, "agents.json", parsed);
      } else {
        agents.push(...extractAgentsFromJson(parsed.value));
      }
    } catch {
    }
  }

  return agents;
}

export async function inspectRules(ctx: ComponentScanContext): Promise<RuleSummary[]> {
  const rules: RuleSummary[] = [];
  const rulesDir = makeAbsolutePath(path.join(ctx.pluginRoot, "rules"));
  if (await isSafeExistingDir(rulesDir, ctx.canonicalRoot)) {
    const realRulesDir = await fs.realpath(rulesDir).catch(() => null);
    if (realRulesDir !== null) {
      await scanRulesDir(
        makeAbsolutePath(realRulesDir),
        ctx.canonicalRoot,
        "rules",
        new Set<string>([ctx.canonicalRoot, realRulesDir]),
        rules,
      );
    }
  }
  for (const rootRule of ["AGENTS.md", "GEMINI.md"] as const) {
    const rootRulePath = makeAbsolutePath(path.join(ctx.pluginRoot, rootRule));
    if (await isSafeExistingFile(rootRulePath, ctx.canonicalRoot)) {
      rules.push({
        name: path.basename(rootRule, ".md"),
        relativePath: makeRelativeSubpath(rootRule),
      });
    }
  }
  return rules;
}

export async function inspectHooks(
  ctx: ComponentScanContext,
): Promise<{ readonly hooks: readonly HookSummary[]; readonly totalCommands: number }> {
  let hooks: readonly HookSummary[] = [];
  let totalCommands = 0;
  const rootHooksPath = makeAbsolutePath(path.join(ctx.pluginRoot, "hooks.json"));
  const nestedHooksPath = makeAbsolutePath(path.join(ctx.pluginRoot, "hooks", "hooks.json"));
  const hasRootHooks = await isSafeExistingFile(rootHooksPath, ctx.canonicalRoot);
  const hasNestedHooks = await isSafeExistingFile(nestedHooksPath, ctx.canonicalRoot);

  if (hasRootHooks) {
    try {
      const rawBytes = await fs.readFile(rootHooksPath);
      const parsed = parseJsoncBomSafe(rawBytes, rootHooksPath);
      if (!parsed.ok) {
        pushJsonSyntaxDiagnostic(ctx, "hooks-json", rootHooksPath, "hooks.json", parsed);
      } else if (!isRecord(parsed.value)) {
        ctx.diagnostics.push({
          id: makeDiagnosticId("hooks-invalid", ctx.subKey, "non-object"),
          severity: "error",
          subject: ctx.subject,
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
          ctx.diagnostics.push({
            id: makeDiagnosticId("hooks-invalid", ctx.subKey, "wrapped"),
            severity: "warning",
            subject: ctx.subject,
            detail: {
              kind: "hooks-invalid",
              filePath: rootHooksPath,
              reason: 'Top-level "hooks" wrapper must be unwrapped for Antigravity.',
            },
            message:
              'Root hooks.json uses a top-level "hooks" wrapper that Antigravity ignores.',
            hint: "Re-adapt the plugin bundle to unwrap hooks.json into top-level hook events.",
            ...readaptRemediation(ctx.pluginIdForRemediation, "Re-adapt hooks.json"),
          });
        }
        for (let i = 0; i < summary.regexErrors.length; i += 1) {
          const reason = summary.regexErrors[i] ?? "Invalid regex matcher.";
          ctx.diagnostics.push({
            id: makeDiagnosticId("hooks-invalid", ctx.subKey, `regex-${i}`),
            severity: "error",
            subject: ctx.subject,
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
          pushUnexpandedRootDiagnostic(
            ctx,
            "hooks-json",
            rootHooksPath,
            "hooks.json",
            unexpanded,
            "Re-adapt the plugin bundle to expand plugin root variables to the installed path.",
            "Expand plugin root in hooks.json",
          );
        }
        hooks = summary.hooks;
        totalCommands = summary.totalCommands;
      }
    } catch {
    }
  } else if (hasNestedHooks) {
    ctx.diagnostics.push({
      id: makeDiagnosticId("unadapted-hooks-path", ctx.subKey),
      severity: "warning",
      subject: ctx.subject,
      detail: {
        kind: "unadapted-hooks-path",
        sourcePath: nestedHooksPath,
        expectedPath: rootHooksPath,
      },
      message: "Found unadapted hooks/hooks.json; Antigravity only loads root hooks.json.",
      hint: "Re-adapt the plugin bundle to promote and unwrap hooks/hooks.json into root hooks.json.",
      ...readaptRemediation(ctx.pluginIdForRemediation, "Re-adapt hooks/hooks.json"),
    });
    await checkNestedUnexpandedVars(ctx, nestedHooksPath, "nested-hooks", "hooks/hooks.json");
  }

  return { hooks, totalCommands };
}

export async function inspectMcp(
  ctx: ComponentScanContext,
): Promise<readonly McpServerSummary[]> {
  let mcpServers: readonly McpServerSummary[] = [];
  const rootMcpPath = makeAbsolutePath(path.join(ctx.pluginRoot, "mcp_config.json"));
  const nestedMcpPath = makeAbsolutePath(path.join(ctx.pluginRoot, ".mcp.json"));
  const hasRootMcp = await isSafeExistingFile(rootMcpPath, ctx.canonicalRoot);
  const hasNestedMcp = await isSafeExistingFile(nestedMcpPath, ctx.canonicalRoot);

  if (hasRootMcp) {
    try {
      const rawBytes = await fs.readFile(rootMcpPath);
      const parsed = parseJsoncBomSafe(rawBytes, rootMcpPath);
      if (!parsed.ok) {
        pushJsonSyntaxDiagnostic(ctx, "mcp-config", rootMcpPath, "mcp_config.json", parsed);
      } else if (!isRecord(parsed.value)) {
        ctx.diagnostics.push({
          id: makeDiagnosticId("mcp-config-invalid", ctx.subKey, "non-object"),
          severity: "error",
          subject: ctx.subject,
          detail: {
            kind: "mcp-config-invalid",
            filePath: rootMcpPath,
            reason: "mcp_config.json must contain a JSON object.",
          },
          message: "Root mcp_config.json must contain a JSON object.",
          hint: "Provide an object with an mcpServers map in mcp_config.json.",
        });
      } else if ("mcpServers" in parsed.value && !isRecord(parsed.value.mcpServers)) {
        ctx.diagnostics.push({
          id: makeDiagnosticId("mcp-config-invalid", ctx.subKey, "mcp-servers-type"),
          severity: "error",
          subject: ctx.subject,
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
          pushUnexpandedRootDiagnostic(
            ctx,
            "mcp-config",
            rootMcpPath,
            "mcp_config.json",
            unexpanded,
            "Re-adapt the plugin bundle to expand plugin root variables to the installed path.",
            "Expand plugin root in mcp_config.json",
          );
        }
        mcpServers = extractMcpSummary(parsed.value);
      }
    } catch {
    }
  } else if (hasNestedMcp) {
    ctx.diagnostics.push({
      id: makeDiagnosticId("unadapted-mcp-path", ctx.subKey),
      severity: "warning",
      subject: ctx.subject,
      detail: {
        kind: "unadapted-mcp-path",
        sourcePath: nestedMcpPath,
        expectedPath: rootMcpPath,
      },
      message: "Found unadapted .mcp.json; Antigravity loads root mcp_config.json.",
      hint: "Re-adapt the plugin bundle to convert .mcp.json into root mcp_config.json.",
      ...readaptRemediation(ctx.pluginIdForRemediation, "Re-adapt .mcp.json"),
    });
    await checkNestedUnexpandedVars(ctx, nestedMcpPath, "dot-mcp", ".mcp.json");
  }

  return mcpServers;
}
