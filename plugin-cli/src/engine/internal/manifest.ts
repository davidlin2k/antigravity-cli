import fs from "node:fs/promises";
import path from "node:path";
import {
  isNonEmpty,
  makeAbsolutePath,
  parsePluginName,
  parseRelativeSubpath,
} from "../../domain/types.ts";
import type {
  AbsolutePath,
  AgentSummary,
  ComponentCounts,
  ComponentInventory,
  HookSummary,
  ManifestEcosystem,
  McpServerSummary,
  NonEmpty,
  NormalizedPluginManifest,
  PluginName,
  RuleSummary,
  SkillSummary,
} from "../../domain/types.ts";
import { isRecord, isWithinCanonicalRoot } from "./fs-safety.ts";
import { parseJsoncBomSafe, parseYamlFrontmatter } from "./jsonc.ts";

interface FoundManifestFile {
  readonly path: AbsolutePath;
  readonly ecosystem: ManifestEcosystem;
  readonly relativePath: string;
}

interface ManifestExtras {
  readonly category: string | null;
  readonly tags: readonly string[];
  readonly inlineMcpServers: Record<string, unknown> | null;
  readonly hooksPath: string | null;
  readonly mcpPath: string | null;
}

type ManifestNormalizeResult =
  | {
      readonly ok: true;
      readonly manifest: NormalizedPluginManifest;
      readonly extras: ManifestExtras;
    }
  | {
      readonly ok: false;
      readonly fieldErrors: NonEmpty<string>;
    };

interface ParsedHooksSummary {
  readonly wrapped: boolean;
  readonly hooks: readonly HookSummary[];
  readonly totalCommands: number;
  readonly regexErrors: readonly string[];
}

const PLUGIN_MANIFEST_LOCATIONS: readonly {
  readonly subdir: string | null;
  readonly ecosystem: ManifestEcosystem;
}[] = [
  { subdir: null, ecosystem: "antigravity" },
  { subdir: ".antigravity-plugin", ecosystem: "antigravity" },
  { subdir: ".gemini-plugin", ecosystem: "antigravity" },
  { subdir: ".claude-plugin", ecosystem: "claude" },
  { subdir: ".cursor-plugin", ecosystem: "cursor" },
];

export async function findFileCaseInsensitive(
  dir: AbsolutePath,
  lowerFileName: string,
): Promise<AbsolutePath | null> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let fallbackMatch: string | null = null;
  for (const entry of entries) {
    if (entry.isDirectory()) {
      continue;
    }
    if (entry.name === lowerFileName) {
      return makeAbsolutePath(path.join(dir, entry.name));
    }
    if (fallbackMatch === null && entry.name.toLowerCase() === lowerFileName) {
      fallbackMatch = entry.name;
    }
  }
  return fallbackMatch !== null ? makeAbsolutePath(path.join(dir, fallbackMatch)) : null;
}

export async function findPluginManifestFile(
  pluginRoot: AbsolutePath,
): Promise<FoundManifestFile | null> {
  for (const loc of PLUGIN_MANIFEST_LOCATIONS) {
    const searchDir =
      loc.subdir === null ? pluginRoot : makeAbsolutePath(path.join(pluginRoot, loc.subdir));
    const found = await findFileCaseInsensitive(searchDir, "plugin.json");
    if (found !== null) {
      const fileName = path.basename(found);
      return {
        path: found,
        ecosystem: loc.ecosystem,
        relativePath: loc.subdir === null ? fileName : `${loc.subdir}/${fileName}`,
      };
    }
  }
  return null;
}

export function extractAuthorString(
  raw: unknown,
): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false; readonly error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return { ok: true, value: trimmed.length > 0 ? trimmed : undefined };
  }
  if (isRecord(raw) && typeof raw.name === "string") {
    const trimmed = raw.name.trim();
    return { ok: true, value: trimmed.length > 0 ? trimmed : undefined };
  }
  return { ok: false, error: "Field 'author' must be a string or an object with a string 'name'." };
}

export function extractRepositoryString(
  raw: unknown,
): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false; readonly error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return { ok: true, value: trimmed.length > 0 ? trimmed : undefined };
  }
  if (isRecord(raw) && typeof raw.url === "string") {
    const trimmed = raw.url.trim();
    return { ok: true, value: trimmed.length > 0 ? trimmed : undefined };
  }
  return { ok: false, error: "Field 'repository' must be a string or an object with a string 'url'." };
}

export function extractStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed.length > 0) {
        out.push(trimmed);
      }
    }
  }
  return out;
}

function readTrimmedStringField(
  rawObj: Record<string, unknown>,
  field: string,
  fieldErrors: string[],
): string | undefined {
  const value = rawObj[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    fieldErrors.push(`Field '${field}' must be a string.`);
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeAntigravityManifest(
  rawObj: unknown,
  fallbackDirName?: string,
): ManifestNormalizeResult {
  if (!isRecord(rawObj)) {
    return { ok: false, fieldErrors: ["Manifest root must be a JSON object."] };
  }

  const fieldErrors: string[] = [];

  let name: PluginName | null = null;
  if (rawObj.name !== undefined) {
    if (typeof rawObj.name !== "string") {
      fieldErrors.push("Field 'name' must be a string.");
    } else {
      const parsed = parsePluginName(rawObj.name);
      if (!parsed.ok) {
        fieldErrors.push(`Invalid 'name': ${parsed.error.message}`);
      } else {
        name = parsed.value;
      }
    }
  } else if (fallbackDirName !== undefined) {
    const parsed = parsePluginName(fallbackDirName);
    if (parsed.ok) {
      name = parsed.value;
    } else {
      fieldErrors.push("Missing required field 'name' and fallback directory name is invalid.");
    }
  } else {
    fieldErrors.push("Missing required field 'name'.");
  }

  const displayName = readTrimmedStringField(rawObj, "displayName", fieldErrors);

  let description: string | undefined;
  if (rawObj.description !== undefined && rawObj.description !== null) {
    if (typeof rawObj.description !== "string") {
      fieldErrors.push("Field 'description' must be a string.");
    } else {
      description = rawObj.description;
    }
  }

  const version = readTrimmedStringField(rawObj, "version", fieldErrors);

  const authorRes = extractAuthorString(rawObj.author);
  if (!authorRes.ok) {
    fieldErrors.push(authorRes.error);
  }

  const homepage = readTrimmedStringField(rawObj, "homepage", fieldErrors);

  const repoRes = extractRepositoryString(rawObj.repository);
  if (!repoRes.ok) {
    fieldErrors.push(repoRes.error);
  }

  const logo = readTrimmedStringField(rawObj, "logo", fieldErrors);

  let suggestedPrompts: readonly string[] | undefined;
  if (rawObj.suggestedPrompts !== undefined && rawObj.suggestedPrompts !== null) {
    if (!Array.isArray(rawObj.suggestedPrompts) || !rawObj.suggestedPrompts.every((p) => typeof p === "string")) {
      fieldErrors.push("Field 'suggestedPrompts' must be an array of strings.");
    } else {
      suggestedPrompts = rawObj.suggestedPrompts;
    }
  }

  let disabled: boolean | undefined;
  if (rawObj.disabled !== undefined && rawObj.disabled !== null) {
    if (typeof rawObj.disabled !== "boolean") {
      fieldErrors.push("Field 'disabled' must be a boolean.");
    } else {
      disabled = rawObj.disabled;
    }
  }

  if (isNonEmpty(fieldErrors) || name === null) {
    return {
      ok: false,
      fieldErrors: isNonEmpty(fieldErrors) ? fieldErrors : ["Missing required field 'name'."],
    };
  }

  const manifest: NormalizedPluginManifest = {
    name,
    ...(displayName !== undefined ? { displayName } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(authorRes.ok && authorRes.value !== undefined ? { author: authorRes.value } : {}),
    ...(homepage !== undefined ? { homepage } : {}),
    ...(repoRes.ok && repoRes.value !== undefined ? { repository: repoRes.value } : {}),
    ...(logo !== undefined ? { logo } : {}),
    ...(suggestedPrompts !== undefined ? { suggestedPrompts } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
  };

  const category =
    typeof rawObj.category === "string" && rawObj.category.trim().length > 0
      ? rawObj.category.trim()
      : null;
  const tagSet = new Set<string>([
    ...extractStringArray(rawObj.tags),
    ...extractStringArray(rawObj.keywords),
  ]);
  const inlineMcpServers = isRecord(rawObj.mcpServers) ? rawObj.mcpServers : null;
  const hooksPath = typeof rawObj.hooks === "string" && rawObj.hooks.trim().length > 0 ? rawObj.hooks.trim() : null;
  const mcpPath =
    typeof rawObj.mcpServers === "string" && rawObj.mcpServers.trim().length > 0
      ? rawObj.mcpServers.trim()
      : null;

  return {
    ok: true,
    manifest,
    extras: {
      category,
      tags: [...tagSet],
      inlineMcpServers,
      hooksPath,
      mcpPath,
    },
  };
}

export function extractHooksSummary(rawObj: Record<string, unknown>): ParsedHooksSummary {
  const wrapped = isRecord(rawObj.hooks);
  const eventMap: Record<string, unknown> = wrapped && isRecord(rawObj.hooks) ? rawObj.hooks : rawObj;

  const hooks: HookSummary[] = [];
  const regexErrors: string[] = [];
  let totalCommands = 0;

  for (const [event, value] of Object.entries(eventMap)) {
    if (!Array.isArray(value)) {
      continue;
    }
    let commandCount = 0;
    for (const item of value) {
      if (isRecord(item)) {
        if (typeof item.matcher === "string" && item.matcher.length > 0) {
          try {
            new RegExp(item.matcher);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            regexErrors.push(`Invalid regex matcher "${item.matcher}" on event "${event}": ${msg}`);
          }
        }
        if (Array.isArray(item.hooks)) {
          commandCount += item.hooks.length;
        } else {
          commandCount += 1;
        }
      } else {
        commandCount += 1;
      }
    }
    if (commandCount > 0) {
      hooks.push({ event, commandCount });
      totalCommands += commandCount;
    }
  }

  hooks.sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
  return { wrapped, hooks, totalCommands, regexErrors };
}

export function extractMcpSummary(rawObj: Record<string, unknown>): readonly McpServerSummary[] {
  const serversObj: Record<string, unknown> = isRecord(rawObj.mcpServers) ? rawObj.mcpServers : rawObj;
  const servers: McpServerSummary[] = [];
  for (const [name, cfg] of Object.entries(serversObj)) {
    if (!isRecord(cfg)) {
      continue;
    }
    let transport: "stdio" | "http" | "unknown" = "unknown";
    if (typeof cfg.command === "string") {
      transport = "stdio";
    } else if (typeof cfg.url === "string" || typeof cfg.serverUrl === "string") {
      transport = "http";
    }
    const eager = typeof cfg.eager === "boolean" ? cfg.eager : cfg.disabled !== true;
    servers.push({ name, transport, eager });
  }
  servers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return servers;
}

export function extractAgentsFromJson(rawValue: unknown): readonly AgentSummary[] {
  const agents: AgentSummary[] = [];
  if (Array.isArray(rawValue)) {
    for (const item of rawValue) {
      if (isRecord(item) && typeof item.name === "string" && item.name.trim().length > 0) {
        agents.push({
          name: item.name.trim(),
          fileName: "agents.json",
          description: typeof item.description === "string" ? item.description : "",
        });
      }
    }
  } else if (isRecord(rawValue)) {
    if (Array.isArray(rawValue.agents)) {
      return extractAgentsFromJson(rawValue.agents);
    }
    for (const [key, value] of Object.entries(rawValue)) {
      if (isRecord(value)) {
        const name = typeof value.name === "string" && value.name.trim().length > 0 ? value.name.trim() : key;
        agents.push({
          name,
          fileName: "agents.json",
          description: typeof value.description === "string" ? value.description : "",
        });
      }
    }
  }
  return agents;
}

async function isInsideCanonicalRoot(candidatePath: string, canonicalRoot: string): Promise<boolean> {
  try {
    const resolved = await fs.realpath(candidatePath);
    return isWithinCanonicalRoot(resolved, canonicalRoot);
  } catch {
    return false;
  }
}

async function collectRuleFiles(
  rulesRoot: AbsolutePath,
  canonicalPluginRoot: string,
  relPrefix: string,
  ancestorRealDirs: ReadonlySet<string>,
  out: RuleSummary[],
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(rulesRoot, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = makeAbsolutePath(path.join(rulesRoot, entry.name));
    let realTarget: string;
    let stat;
    try {
      realTarget = await fs.realpath(full);
      if (!isWithinCanonicalRoot(realTarget, canonicalPluginRoot)) {
        continue;
      }
      stat = await fs.stat(realTarget);
    } catch {
      continue;
    }
    const relStr = `${relPrefix}/${entry.name}`;
    if (stat.isDirectory()) {
      if (!ancestorRealDirs.has(realTarget)) {
        const nextAncestors = new Set(ancestorRealDirs);
        nextAncestors.add(realTarget);
        await collectRuleFiles(
          makeAbsolutePath(realTarget),
          canonicalPluginRoot,
          relStr,
          nextAncestors,
          out,
        );
      }
    } else if (stat.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const parsedRel = parseRelativeSubpath(relStr);
      if (parsedRel.ok) {
        out.push({
          name: path.basename(entry.name, path.extname(entry.name)),
          relativePath: parsedRel.value,
        });
      }
    }
  }
}

export async function previewPluginComponents(
  pluginDir: AbsolutePath,
): Promise<{ readonly counts: ComponentCounts; readonly inventory: ComponentInventory } | null> {
  let canonicalRoot: string;
  try {
    const stat = await fs.stat(pluginDir);
    if (!stat.isDirectory()) {
      return null;
    }
    canonicalRoot = await fs.realpath(pluginDir);
  } catch {
    return null;
  }

  const skills: SkillSummary[] = [];
  const skillsDir = makeAbsolutePath(path.join(pluginDir, "skills"));
  if (await isInsideCanonicalRoot(skillsDir, canonicalRoot)) {
    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const subDir = makeAbsolutePath(path.join(skillsDir, entry.name));
        if (!(await isInsideCanonicalRoot(subDir, canonicalRoot))) {
          continue;
        }
        const skillFile = await findFileCaseInsensitive(subDir, "skill.md");
        if (skillFile === null || !(await isInsideCanonicalRoot(skillFile, canonicalRoot))) {
          continue;
        }
        try {
          const text = await fs.readFile(skillFile, "utf8");
          const fm = parseYamlFrontmatter(text);
          const fmName = fm.fields.get("name")?.trim() ?? "";
          const fmDesc = fm.fields.get("description")?.trim() ?? "";
          const name = fmName.length > 0 ? fmName : entry.name;
          skills.push({
            name,
            folderName: entry.name,
            description: fmDesc,
            frontmatterNamePresent: fmName.length > 0,
            estimatedTokens: Math.ceil((name.length + fmDesc.length) / 4),
          });
        } catch {
        }
      }
    } catch {
    }
  }

  const agents: AgentSummary[] = [];
  const agentsDir = makeAbsolutePath(path.join(pluginDir, "agents"));
  if (await isInsideCanonicalRoot(agentsDir, canonicalRoot)) {
    try {
      const entries = await fs.readdir(agentsDir, { withFileTypes: true });
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (entry.isDirectory() || !entry.name.toLowerCase().endsWith(".md")) {
          continue;
        }
        const filePath = makeAbsolutePath(path.join(agentsDir, entry.name));
        if (!(await isInsideCanonicalRoot(filePath, canonicalRoot))) {
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

  const agentsJsonPath = makeAbsolutePath(path.join(pluginDir, "agents.json"));
  if (await isInsideCanonicalRoot(agentsJsonPath, canonicalRoot)) {
    try {
      const raw = await fs.readFile(agentsJsonPath);
      const parsed = parseJsoncBomSafe(raw, agentsJsonPath);
      if (parsed.ok) {
        agents.push(...extractAgentsFromJson(parsed.value));
      }
    } catch {
    }
  }

  const rules: RuleSummary[] = [];
  const rulesDir = makeAbsolutePath(path.join(pluginDir, "rules"));
  if (await isInsideCanonicalRoot(rulesDir, canonicalRoot)) {
    const realRulesDir = await fs.realpath(rulesDir).catch(() => null);
    if (realRulesDir !== null) {
      await collectRuleFiles(
        makeAbsolutePath(realRulesDir),
        canonicalRoot,
        "rules",
        new Set<string>([canonicalRoot, realRulesDir]),
        rules,
      );
    }
  }

  let hooks: readonly HookSummary[] = [];
  let hooksTotal = 0;
  for (const rel of ["hooks.json", "hooks/hooks.json"] as const) {
    const candidate = makeAbsolutePath(path.join(pluginDir, rel));
    if (!(await isInsideCanonicalRoot(candidate, canonicalRoot))) {
      continue;
    }
    try {
      const raw = await fs.readFile(candidate);
      const parsed = parseJsoncBomSafe(raw, candidate);
      if (parsed.ok && isRecord(parsed.value)) {
        const summary = extractHooksSummary(parsed.value);
        hooks = summary.hooks;
        hooksTotal = summary.totalCommands;
        break;
      }
    } catch {
    }
  }

  let mcpServers: readonly McpServerSummary[] = [];
  for (const rel of ["mcp_config.json", ".mcp.json"] as const) {
    const candidate = makeAbsolutePath(path.join(pluginDir, rel));
    if (!(await isInsideCanonicalRoot(candidate, canonicalRoot))) {
      continue;
    }
    try {
      const raw = await fs.readFile(candidate);
      const parsed = parseJsoncBomSafe(raw, candidate);
      if (parsed.ok && isRecord(parsed.value)) {
        mcpServers = extractMcpSummary(parsed.value);
        break;
      }
    } catch {
    }
  }

  const counts: ComponentCounts = {
    skills: skills.length,
    agents: agents.length,
    rules: rules.length,
    hooks: hooksTotal,
    mcpServers: mcpServers.length,
  };
  const inventory: ComponentInventory = {
    counts,
    skills,
    agents,
    rules,
    hooks,
    mcpServers,
  };
  return { counts, inventory };
}
