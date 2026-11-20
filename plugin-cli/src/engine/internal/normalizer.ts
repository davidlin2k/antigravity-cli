import fs from "node:fs/promises";
import path from "node:path";
import {
  EMPTY_COMPONENT_COUNTS,
  EMPTY_COMPONENT_INVENTORY,
  isAbsolutePath,
  isHttpUrl,
  isNonEmpty,
  isPluginDirName,
  isSshGitUrl,
  joinAbsolutePath,
  makeAbsolutePath,
  makeCatalogEntryId,
  makeDiagnosticId,
  makeHttpUrl,
  makePluginDirName,
  makeRelativeSubpath,
  parseHttpUrl,
  parsePluginName,
  parseRelativeSubpath,
  parseSshGitUrl,
  slugifyPluginDirName,
} from "../../domain/types.ts";
import type {
  AbsolutePath,
  AgentSummary,
  CatalogEntry,
  ComponentCounts,
  ComponentInventory,
  Diagnostic,
  HookSummary,
  ManifestEcosystem,
  MarketplaceId,
  McpServerSummary,
  NonEmpty,
  NormalizedPluginManifest,
  PluginDirName,
  PluginInstallSource,
  PluginName,
  RelativeSubpath,
  RemoteGitUrl,
  RuleSummary,
  SkillSummary,
} from "../../domain/types.ts";
import { checkContainedPath, isRecord, isWithinCanonicalRoot } from "./stores.ts";

export type JsoncParseResult =
  | { readonly ok: true; readonly value: unknown; readonly hadUtf8Bom: boolean }
  | {
      readonly ok: false;
      readonly hadUtf8Bom: boolean;
      readonly line: number | null;
      readonly column: number | null;
      readonly syntaxError: string;
    };

export interface FoundManifestFile {
  readonly path: AbsolutePath;
  readonly ecosystem: ManifestEcosystem;
  readonly relativePath: string;
}

export interface ManifestExtras {
  readonly category: string | null;
  readonly tags: readonly string[];
  readonly inlineMcpServers: Record<string, unknown> | null;
  readonly hooksPath: string | null;
  readonly mcpPath: string | null;
}

export type ManifestNormalizeResult =
  | {
      readonly ok: true;
      readonly manifest: NormalizedPluginManifest;
      readonly extras: ManifestExtras;
    }
  | {
      readonly ok: false;
      readonly fieldErrors: NonEmpty<string>;
    };

export interface ParsedFrontmatter {
  readonly present: boolean;
  readonly fields: ReadonlyMap<string, string>;
}

export interface ParsedHooksSummary {
  readonly wrapped: boolean;
  readonly hooks: readonly HookSummary[];
  readonly totalCommands: number;
  readonly regexErrors: readonly string[];
}

export interface CatalogNormalizationResult {
  readonly ok: boolean;
  readonly format: ManifestEcosystem | null;
  readonly entries: readonly CatalogEntry[];
  readonly diagnostics: readonly Diagnostic[];
}

const ARCHIVE_EXT_RE = /\.(?:tar\.gz|tgz|zip)$/i;
const GITHUB_REPO_PAIR_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;

function isCurrentDirPath(raw: string): boolean {
  const slashed = raw.trim().replaceAll("\\", "/");
  if (slashed.length === 0 || slashed.startsWith("/")) {
    return false;
  }
  const segments = slashed.split("/");
  return segments.some((seg) => seg === ".") && segments.every((seg) => seg === "" || seg === ".");
}

function lineColAtOffset(text: string, offset: number): { readonly line: number; readonly column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let column = 1;
  for (let i = 0; i < clamped; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function stripJsoncCommentsAndTrailingCommas(
  text: string,
):
  | { readonly ok: true; readonly cleaned: string }
  | { readonly ok: false; readonly line: number; readonly column: number; readonly error: string } {
  const chars = Array.from(text);
  const len = chars.length;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < len; i += 1) {
    const ch = chars[i];
    const next = i + 1 < len ? chars[i + 1] : "";

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "/" && next === "/") {
      chars[i] = " ";
      chars[i + 1] = " ";
      i += 2;
      while (i < len && chars[i] !== "\n" && chars[i] !== "\r") {
        chars[i] = " ";
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      const startOffset = i;
      chars[i] = " ";
      chars[i + 1] = " ";
      i += 2;
      let closed = false;
      while (i < len) {
        if (chars[i] === "*" && i + 1 < len && chars[i + 1] === "/") {
          chars[i] = " ";
          chars[i + 1] = " ";
          i += 1;
          closed = true;
          break;
        }
        if (chars[i] !== "\n" && chars[i] !== "\r") {
          chars[i] = " ";
        }
        i += 1;
      }
      if (!closed) {
        const pos = lineColAtOffset(text, startOffset);
        return {
          ok: false,
          line: pos.line,
          column: pos.column,
          error: "Unterminated block comment in JSONC.",
        };
      }
    }
  }

  inString = false;
  escaped = false;
  for (let i = 0; i < len; i += 1) {
    const ch = chars[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < len && (chars[j] === " " || chars[j] === "\t" || chars[j] === "\n" || chars[j] === "\r")) {
        j += 1;
      }
      if (j < len && (chars[j] === "}" || chars[j] === "]")) {
        chars[i] = " ";
      }
    }
  }

  return { ok: true, cleaned: chars.join("") };
}

function locateJsonSyntaxError(text: string): number {
  let pos = 0;
  const len = text.length;

  const skipWs = (): void => {
    while (pos < len) {
      const code = text.charCodeAt(pos);
      if (code === 32 || code === 9 || code === 10 || code === 13) {
        pos += 1;
      } else {
        break;
      }
    }
  };

  const parseString = (): boolean => {
    if (text.charCodeAt(pos) !== 34) {
      return false;
    }
    pos += 1;
    while (pos < len) {
      const code = text.charCodeAt(pos);
      if (code === 34) {
        pos += 1;
        return true;
      }
      if (code === 92) {
        pos += 1;
        if (pos >= len) {
          return false;
        }
        const esc = text.charAt(pos);
        if (esc === "u") {
          if (!/^[0-9a-fA-F]{4}/.test(text.slice(pos + 1, pos + 5))) {
            return false;
          }
          pos += 5;
        } else if ('"\\/bfnrt'.includes(esc)) {
          pos += 1;
        } else {
          return false;
        }
        continue;
      }
      if (code < 0x20) {
        return false;
      }
      pos += 1;
    }
    return false;
  };

  const parseNumber = (): boolean => {
    const start = pos;
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(start));
    if (!match || match[0].length === 0) {
      return false;
    }
    pos += match[0].length;
    return true;
  };

  const parseValue = (): boolean => {
    skipWs();
    if (pos >= len) {
      return false;
    }
    const ch = text.charAt(pos);
    if (ch === "{") {
      pos += 1;
      skipWs();
      if (text.charAt(pos) === "}") {
        pos += 1;
        return true;
      }
      while (pos < len) {
        skipWs();
        if (!parseString()) {
          return false;
        }
        skipWs();
        if (text.charAt(pos) !== ":") {
          return false;
        }
        pos += 1;
        if (!parseValue()) {
          return false;
        }
        skipWs();
        if (text.charAt(pos) === ",") {
          pos += 1;
          continue;
        }
        if (text.charAt(pos) === "}") {
          pos += 1;
          return true;
        }
        return false;
      }
      return false;
    }
    if (ch === "[") {
      pos += 1;
      skipWs();
      if (text.charAt(pos) === "]") {
        pos += 1;
        return true;
      }
      while (pos < len) {
        if (!parseValue()) {
          return false;
        }
        skipWs();
        if (text.charAt(pos) === ",") {
          pos += 1;
          continue;
        }
        if (text.charAt(pos) === "]") {
          pos += 1;
          return true;
        }
        return false;
      }
      return false;
    }
    if (ch === '"') {
      return parseString();
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      return parseNumber();
    }
    if (text.startsWith("true", pos)) {
      pos += 4;
      return true;
    }
    if (text.startsWith("false", pos)) {
      pos += 5;
      return true;
    }
    if (text.startsWith("null", pos)) {
      pos += 4;
      return true;
    }
    return false;
  };

  if (!parseValue()) {
    return pos;
  }
  skipWs();
  return pos;
}

function extractJsonErrorPosition(
  message: string,
  cleaned: string,
): { readonly line: number | null; readonly column: number | null } {
  const lineColMatch = /\(line\s+(\d+)\s+column\s+(\d+)\)/i.exec(message);
  if (lineColMatch?.[1] !== undefined && lineColMatch[2] !== undefined) {
    return { line: Number(lineColMatch[1]), column: Number(lineColMatch[2]) };
  }
  const posMatch = /position\s+(\d+)/i.exec(message);
  if (posMatch?.[1] !== undefined) {
    return lineColAtOffset(cleaned, Number(posMatch[1]));
  }
  return lineColAtOffset(cleaned, locateJsonSyntaxError(cleaned));
}

export function parseJsoncBomSafe(
  rawBytes: Uint8Array | string,
  _filePath?: AbsolutePath,
): JsoncParseResult {
  let hadUtf8Bom = false;
  let text: string;

  if (typeof rawBytes === "string") {
    if (rawBytes.startsWith("\uFEFF")) {
      hadUtf8Bom = true;
      text = rawBytes.slice(1);
    } else {
      text = rawBytes;
    }
  } else {
    if (
      rawBytes.length >= 3 &&
      rawBytes[0] === 0xef &&
      rawBytes[1] === 0xbb &&
      rawBytes[2] === 0xbf
    ) {
      hadUtf8Bom = true;
      text = Buffer.from(rawBytes.subarray(3)).toString("utf8");
    } else {
      text = Buffer.from(rawBytes).toString("utf8");
    }
  }

  const stripped = stripJsoncCommentsAndTrailingCommas(text);
  if (!stripped.ok) {
    return {
      ok: false,
      hadUtf8Bom,
      line: stripped.line,
      column: stripped.column,
      syntaxError: stripped.error,
    };
  }

  try {
    const value: unknown = JSON.parse(stripped.cleaned);
    return { ok: true, value, hadUtf8Bom };
  } catch (err) {
    const syntaxError = err instanceof Error ? err.message : String(err);
    const pos = extractJsonErrorPosition(syntaxError, stripped.cleaned);
    return {
      ok: false,
      hadUtf8Bom,
      line: pos.line,
      column: pos.column,
      syntaxError,
    };
  }
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : trimmed.slice(1, -1);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

export function parseYamlFrontmatter(rawText: string): ParsedFrontmatter {
  const text = rawText.startsWith("\uFEFF") ? rawText.slice(1) : rawText;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { present: false, fields: new Map() };
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i]?.trim();
    if (trimmed === "---" || trimmed === "...") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return { present: false, fields: new Map() };
  }

  const fields = new Map<string, string>();
  let i = 1;
  while (i < endIdx) {
    const line = lines[i] ?? "";
    const match = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      i += 1;
      continue;
    }
    const key = (match[1] ?? "").toLowerCase();
    const rest = (match[2] ?? "").trim();

    if (rest === "|" || rest === "|-" || rest === ">" || rest === ">-") {
      const folded = rest.startsWith(">");
      const blockLines: string[] = [];
      let j = i + 1;
      while (j < endIdx) {
        const nextLine = lines[j] ?? "";
        if (nextLine.trim().length === 0) {
          blockLines.push("");
          j += 1;
          continue;
        }
        if (!/^\s+/.test(nextLine)) {
          break;
        }
        blockLines.push(nextLine.trim());
        j += 1;
      }
      const joined = folded ? blockLines.join(" ").replace(/\s+/g, " ").trim() : blockLines.join("\n").trim();
      fields.set(key, joined);
      i = j;
      continue;
    }

    fields.set(key, unquoteYamlScalar(rest));
    i += 1;
  }

  return { present: true, fields };
}

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

function extractAuthorString(raw: unknown): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false; readonly error: string } {
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

function extractRepositoryString(raw: unknown): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false; readonly error: string } {
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

function extractStringArray(raw: unknown): string[] {
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

  let displayName: string | undefined;
  if (rawObj.displayName !== undefined && rawObj.displayName !== null) {
    if (typeof rawObj.displayName !== "string") {
      fieldErrors.push("Field 'displayName' must be a string.");
    } else if (rawObj.displayName.trim().length > 0) {
      displayName = rawObj.displayName.trim();
    }
  }

  let description: string | undefined;
  if (rawObj.description !== undefined && rawObj.description !== null) {
    if (typeof rawObj.description !== "string") {
      fieldErrors.push("Field 'description' must be a string.");
    } else {
      description = rawObj.description;
    }
  }

  let version: string | undefined;
  if (rawObj.version !== undefined && rawObj.version !== null) {
    if (typeof rawObj.version !== "string") {
      fieldErrors.push("Field 'version' must be a string.");
    } else if (rawObj.version.trim().length > 0) {
      version = rawObj.version.trim();
    }
  }

  const authorRes = extractAuthorString(rawObj.author);
  if (!authorRes.ok) {
    fieldErrors.push(authorRes.error);
  }

  let homepage: string | undefined;
  if (rawObj.homepage !== undefined && rawObj.homepage !== null) {
    if (typeof rawObj.homepage !== "string") {
      fieldErrors.push("Field 'homepage' must be a string.");
    } else if (rawObj.homepage.trim().length > 0) {
      homepage = rawObj.homepage.trim();
    }
  }

  const repoRes = extractRepositoryString(rawObj.repository);
  if (!repoRes.ok) {
    fieldErrors.push(repoRes.error);
  }

  let logo: string | undefined;
  if (rawObj.logo !== undefined && rawObj.logo !== null) {
    if (typeof rawObj.logo !== "string") {
      fieldErrors.push("Field 'logo' must be a string.");
    } else if (rawObj.logo.trim().length > 0) {
      logo = rawObj.logo.trim();
    }
  }

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

function allocateUniqueSlug(baseRaw: string, usedSlugs: Set<string>): PluginDirName {
  const base = slugifyPluginDirName(baseRaw, "plugin");
  if (!usedSlugs.has(base)) {
    usedSlugs.add(base);
    return base;
  }
  let counter = 2;
  while (counter < 100_000) {
    const suffix = `-${counter}`;
    const trimmedBase = base.slice(0, Math.max(1, 128 - suffix.length)).replace(/[-.]+$/, "");
    const candidate = `${trimmedBase.length > 0 ? trimmedBase : "plugin"}${suffix}`;
    if (isPluginDirName(candidate) && !usedSlugs.has(candidate)) {
      usedSlugs.add(candidate);
      return candidate;
    }
    counter += 1;
  }
  const fallback = makePluginDirName(`plugin-${usedSlugs.size + 1}`);
  usedSlugs.add(fallback);
  return fallback;
}

function parseRemoteGitUrl(raw: string): RemoteGitUrl | null {
  const trimmed = raw.trim();
  const http = parseHttpUrl(trimmed);
  if (http.ok) {
    return http.value;
  }
  const ssh = parseSshGitUrl(trimmed);
  if (ssh.ok) {
    return ssh.value;
  }
  return null;
}

function normalizeDirectoryCacheListings(
  marketplaceId: MarketplaceId,
  listings: readonly unknown[],
): readonly CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const usedSlugs = new Set<string>();

  for (const item of listings) {
    if (!isRecord(item)) {
      continue;
    }
    const rawName =
      typeof item.name === "string" && item.name.trim().length > 0
        ? item.name.trim()
        : typeof item.id === "string" && item.id.trim().length > 0
          ? item.id.trim()
          : null;
    if (rawName === null) {
      continue;
    }

    const sourceObj = isRecord(item.source) ? item.source : null;
    const repoObj = sourceObj !== null && isRecord(sourceObj.repository) ? sourceObj.repository : null;
    const rawRepoUrl = repoObj !== null && typeof repoObj.url === "string" ? repoObj.url.trim() : null;
    if (rawRepoUrl === null) {
      continue;
    }
    const repoUrl = parseRemoteGitUrl(rawRepoUrl);
    if (repoUrl === null) {
      continue;
    }

    const reviewedCommit =
      repoObj !== null &&
      typeof repoObj.reviewed_commit === "string" &&
      repoObj.reviewed_commit.trim().length > 0
        ? repoObj.reviewed_commit.trim()
        : undefined;

    let installSource: PluginInstallSource;
    if (repoObj !== null && typeof repoObj.path === "string" && repoObj.path.trim().length > 0) {
      const parsedSubpath = parseRelativeSubpath(repoObj.path);
      if (!parsedSubpath.ok) {
        continue;
      }
      installSource = {
        kind: "git-subdir",
        repoUrl,
        subdir: parsedSubpath.value,
        ...(reviewedCommit !== undefined ? { sha: reviewedCommit } : {}),
      };
    } else {
      installSource = {
        kind: "git-repo",
        repoUrl,
        ...(reviewedCommit !== undefined ? { sha: reviewedCommit } : {}),
      };
    }

    const slug = allocateUniqueSlug(rawName, usedSlugs);
    const verifiedName = parsePluginName(rawName);
    const safeName = verifiedName.ok ? verifiedName : parsePluginName(slug);
    if (!safeName.ok) {
      continue;
    }

    const releaseObj = isRecord(item.release) ? item.release : null;
    const version =
      releaseObj !== null && typeof releaseObj.version === "string" && releaseObj.version.trim().length > 0
        ? releaseObj.version.trim()
        : typeof item.version === "string" && item.version.trim().length > 0
          ? item.version.trim()
          : null;

    const publisherObj = isRecord(item.publisher) ? item.publisher : null;
    const author =
      publisherObj !== null && typeof publisherObj.name === "string" && publisherObj.name.trim().length > 0
        ? publisherObj.name.trim()
        : typeof item.publisher === "string" && item.publisher.trim().length > 0
          ? item.publisher.trim()
          : (() => {
              const auth = extractAuthorString(item.author);
              return auth.ok ? (auth.value ?? null) : null;
            })();

    const linksObj = isRecord(item.links) ? item.links : null;
    const homepage =
      linksObj !== null && typeof linksObj.homepage === "string" && linksObj.homepage.trim().length > 0
        ? linksObj.homepage.trim()
        : linksObj !== null && typeof linksObj.documentation === "string" && linksObj.documentation.trim().length > 0
          ? linksObj.documentation.trim()
          : typeof item.homepage === "string" && item.homepage.trim().length > 0
            ? item.homepage.trim()
            : null;

    const description =
      typeof item.summary === "string"
        ? item.summary
        : typeof item.description === "string"
          ? item.description
          : "";

    const category =
      typeof item.category === "string" && item.category.trim().length > 0
        ? item.category.trim()
        : null;
    const tags = [
      ...new Set([...extractStringArray(item.tags), ...extractStringArray(item.keywords)]),
    ];

    entries.push({
      id: makeCatalogEntryId(marketplaceId, slug),
      marketplaceId,
      slug,
      name: safeName.value,
      displayName: rawName,
      description,
      version,
      author,
      category,
      tags,
      homepage,
      repository: repoUrl,
      sourceFormat: "claude",
      installSource,
      componentCounts: null,
      componentsPreview: null,
    });
  }

  return entries;
}

type ResolvePluginSourceResult =
  | { readonly ok: true; readonly source: PluginInstallSource }
  | { readonly ok: false; readonly kind: "skip" }
  | { readonly ok: false; readonly kind: "invalid"; readonly reason: string }
  | {
      readonly ok: false;
      readonly kind: "path-traversal";
      readonly offendingPath: string;
      readonly resolvedOutsideRoot: string;
      readonly reason: string;
    };

async function resolveRelativeSubdirWithPrefix(input: {
  readonly subpath: RelativeSubpath;
  readonly pluginRootPrefix: RelativeSubpath | null;
  readonly rootDir: AbsolutePath | undefined;
  readonly canonicalRootDir: string | null;
}): Promise<RelativeSubpath> {
  const { subpath, pluginRootPrefix, rootDir, canonicalRootDir } = input;
  if (
    pluginRootPrefix === null ||
    subpath === pluginRootPrefix ||
    subpath.startsWith(`${pluginRootPrefix}/`)
  ) {
    return subpath;
  }
  const combined = parseRelativeSubpath(`${pluginRootPrefix}/${subpath}`);
  if (!combined.ok) {
    return subpath;
  }
  if (rootDir === undefined) {
    return combined.value;
  }
  const directPath = joinAbsolutePath(rootDir, subpath);
  const prefixedPath = joinAbsolutePath(rootDir, combined.value);
  if (canonicalRootDir !== null) {
    const directCheck = await checkContainedPath(directPath, canonicalRootDir);
    if (directCheck.kind === "escaped") {
      return subpath;
    }
    const directExists =
      directCheck.kind === "contained" &&
      (await fs
        .stat(directCheck.realPath)
        .then((s) => s.isDirectory())
        .catch(() => false));
    if (directExists) {
      return subpath;
    }
    const prefixedCheck = await checkContainedPath(prefixedPath, canonicalRootDir);
    const prefixedExists =
      prefixedCheck.kind === "contained" &&
      (await fs
        .stat(prefixedCheck.realPath)
        .then((s) => s.isDirectory())
        .catch(() => false));
    return prefixedExists ? combined.value : subpath;
  }
  const directExists = await fs
    .stat(directPath)
    .then((s) => s.isDirectory())
    .catch(() => false);
  const prefixedExists = await fs
    .stat(prefixedPath)
    .then((s) => s.isDirectory())
    .catch(() => false);
  return !directExists && prefixedExists ? combined.value : subpath;
}

async function resolveMarketplacePluginSource(input: {
  readonly rawSource: unknown;
  readonly marketplaceId: MarketplaceId;
  readonly pluginRootPrefix: RelativeSubpath | null;
  readonly rootDir: AbsolutePath | undefined;
  readonly canonicalRootDir: string | null;
}): Promise<ResolvePluginSourceResult> {
  const { rawSource, marketplaceId, pluginRootPrefix, rootDir, canonicalRootDir } = input;

  if (typeof rawSource === "string") {
    const trimmed = rawSource.trim();
    if (trimmed.length === 0) {
      return { ok: false, kind: "invalid", reason: "Plugin source string cannot be empty." };
    }
    if (isHttpUrl(trimmed)) {
      if (ARCHIVE_EXT_RE.test(trimmed)) {
        return { ok: true, source: { kind: "archive-url", url: trimmed } };
      }
      return { ok: true, source: { kind: "git-repo", repoUrl: trimmed } };
    }
    if (isSshGitUrl(trimmed)) {
      return { ok: true, source: { kind: "git-repo", repoUrl: trimmed } };
    }
    if (isCurrentDirPath(trimmed)) {
      return { ok: true, source: { kind: "marketplace-root", marketplaceId } };
    }

    const parsedSubpath = parseRelativeSubpath(trimmed);
    if (!parsedSubpath.ok) {
      return { ok: false, kind: "invalid", reason: parsedSubpath.error.message };
    }

    const finalSubpath = await resolveRelativeSubdirWithPrefix({
      subpath: parsedSubpath.value,
      pluginRootPrefix,
      rootDir,
      canonicalRootDir,
    });

    return {
      ok: true,
      source: {
        kind: "marketplace-subdir",
        marketplaceId,
        subdir: finalSubpath,
      },
    };
  }

  if (!isRecord(rawSource) || typeof rawSource.source !== "string") {
    return { ok: false, kind: "invalid", reason: "Plugin entry is missing a valid 'source' field." };
  }

  const ref = typeof rawSource.ref === "string" && rawSource.ref.trim().length > 0 ? rawSource.ref.trim() : undefined;
  const sha = typeof rawSource.sha === "string" && rawSource.sha.trim().length > 0 ? rawSource.sha.trim() : undefined;

  switch (rawSource.source) {
    case "git-subdir": {
      if (typeof rawSource.url !== "string" || typeof rawSource.path !== "string") {
        return { ok: false, kind: "invalid", reason: "git-subdir source requires 'url' and 'path'." };
      }
      const repoUrl = parseRemoteGitUrl(rawSource.url);
      if (repoUrl === null) {
        return { ok: false, kind: "invalid", reason: `Invalid git-subdir URL: "${rawSource.url}".` };
      }
      const parsedPath = parseRelativeSubpath(rawSource.path);
      if (!parsedPath.ok) {
        return { ok: false, kind: "invalid", reason: parsedPath.error.message };
      }
      return {
        ok: true,
        source: {
          kind: "git-subdir",
          repoUrl,
          subdir: parsedPath.value,
          ...(ref !== undefined ? { ref } : {}),
          ...(sha !== undefined ? { sha } : {}),
        },
      };
    }
    case "url": {
      if (typeof rawSource.url !== "string") {
        return { ok: false, kind: "invalid", reason: "url source requires 'url'." };
      }
      const repoUrl = parseRemoteGitUrl(rawSource.url);
      if (repoUrl === null) {
        return { ok: false, kind: "invalid", reason: `Invalid source URL: "${rawSource.url}".` };
      }
      if (typeof rawSource.path === "string" && rawSource.path.trim().length > 0) {
        const parsedPath = parseRelativeSubpath(rawSource.path);
        if (!parsedPath.ok) {
          return { ok: false, kind: "invalid", reason: parsedPath.error.message };
        }
        return {
          ok: true,
          source: {
            kind: "git-subdir",
            repoUrl,
            subdir: parsedPath.value,
            ...(ref !== undefined ? { ref } : {}),
            ...(sha !== undefined ? { sha } : {}),
          },
        };
      }
      if (isHttpUrl(repoUrl) && ARCHIVE_EXT_RE.test(repoUrl)) {
        const sha256 =
          typeof rawSource.sha256 === "string" && rawSource.sha256.trim().length > 0
            ? rawSource.sha256.trim()
            : undefined;
        return {
          ok: true,
          source: {
            kind: "archive-url",
            url: repoUrl,
            ...(sha256 !== undefined ? { sha256 } : {}),
          },
        };
      }
      return {
        ok: true,
        source: {
          kind: "git-repo",
          repoUrl,
          ...(ref !== undefined ? { ref } : {}),
          ...(sha !== undefined ? { sha } : {}),
        },
      };
    }
    case "github": {
      if (typeof rawSource.repo !== "string" || !GITHUB_REPO_PAIR_RE.test(rawSource.repo.trim())) {
        return { ok: false, kind: "invalid", reason: `Invalid GitHub repo specifier: "${String(rawSource.repo)}".` };
      }
      const repoUrl = makeHttpUrl(`https://github.com/${rawSource.repo.trim()}.git`);
      if (typeof rawSource.path === "string" && rawSource.path.trim().length > 0) {
        const parsedPath = parseRelativeSubpath(rawSource.path);
        if (!parsedPath.ok) {
          return { ok: false, kind: "invalid", reason: parsedPath.error.message };
        }
        return {
          ok: true,
          source: {
            kind: "git-subdir",
            repoUrl,
            subdir: parsedPath.value,
            ...(ref !== undefined ? { ref } : {}),
            ...(sha !== undefined ? { sha } : {}),
          },
        };
      }
      return {
        ok: true,
        source: {
          kind: "git-repo",
          repoUrl,
          ...(ref !== undefined ? { ref } : {}),
          ...(sha !== undefined ? { sha } : {}),
        },
      };
    }
    case "directory":
    case "local": {
      if (typeof rawSource.path !== "string") {
        return { ok: false, kind: "invalid", reason: "Local directory source requires 'path'." };
      }
      const trimmedPath = rawSource.path.trim();
      if (trimmedPath.length === 0) {
        return { ok: false, kind: "invalid", reason: "Local directory source path cannot be empty." };
      }
      if (
        path.isAbsolute(trimmedPath) ||
        trimmedPath.startsWith("/") ||
        trimmedPath.startsWith("\\") ||
        WINDOWS_DRIVE_RE.test(trimmedPath)
      ) {
        return {
          ok: false,
          kind: "path-traversal",
          offendingPath: trimmedPath,
          resolvedOutsideRoot: trimmedPath,
          reason: `Absolute path "${trimmedPath}" is not allowed in marketplace manifests.`,
        };
      }
      if (isCurrentDirPath(trimmedPath)) {
        return { ok: true, source: { kind: "marketplace-root", marketplaceId } };
      }
      const rel = parseRelativeSubpath(trimmedPath);
      if (!rel.ok) {
        if (rel.error.code === "path-traversal") {
          return {
            ok: false,
            kind: "path-traversal",
            offendingPath: trimmedPath,
            resolvedOutsideRoot: trimmedPath,
            reason: rel.error.message,
          };
        }
        return { ok: false, kind: "invalid", reason: rel.error.message };
      }
      const finalSubpath = await resolveRelativeSubdirWithPrefix({
        subpath: rel.value,
        pluginRootPrefix,
        rootDir,
        canonicalRootDir,
      });
      return {
        ok: true,
        source: {
          kind: "marketplace-subdir",
          marketplaceId,
          subdir: finalSubpath,
        },
      };
    }
    case "command":
      return { ok: false, kind: "skip" };
    default:
      return { ok: false, kind: "invalid", reason: `Unsupported plugin source kind "${rawSource.source}".` };
  }
}

export async function normalizeJsonCatalog(
  marketplaceId: MarketplaceId,
  filePath: AbsolutePath,
  rawBytes: Uint8Array | string,
  options?: {
    readonly rootDir?: AbsolutePath;
    readonly defaultEcosystem?: ManifestEcosystem;
  },
): Promise<CatalogNormalizationResult> {
  const parsed = parseJsoncBomSafe(rawBytes, filePath);
  if (!parsed.ok) {
    return {
      ok: false,
      format: null,
      entries: [],
      diagnostics: [
        {
          id: makeDiagnosticId("marketplace-json-syntax", marketplaceId),
          severity: "error",
          subject: { kind: "marketplace", marketplaceId },
          detail: {
            kind: "manifest-json-syntax",
            filePath,
            line: parsed.line,
            column: parsed.column,
            hadUtf8Bom: parsed.hadUtf8Bom,
            syntaxError: parsed.syntaxError,
          },
          message: `Failed to parse marketplace catalog JSON for "${marketplaceId}": ${parsed.syntaxError}`,
          hint: "Fix the JSON syntax error in the marketplace catalog file and re-sync.",
        },
      ],
    };
  }

  const root = parsed.value;
  if (isRecord(root) && Array.isArray(root.listings)) {
    const entries = normalizeDirectoryCacheListings(marketplaceId, root.listings);
    return {
      ok: true,
      format: "claude",
      entries,
      diagnostics: [],
    };
  }

  const pluginList = Array.isArray(root)
    ? root
    : isRecord(root) && Array.isArray(root.plugins)
      ? root.plugins
      : null;

  if (pluginList === null) {
    return {
      ok: false,
      format: null,
      entries: [],
      diagnostics: [
        {
          id: makeDiagnosticId("marketplace-manifest-invalid", marketplaceId),
          severity: "error",
          subject: { kind: "marketplace", marketplaceId },
          detail: {
            kind: "marketplace-manifest-invalid",
            marketplaceId,
            filePath,
            reason: 'Expected a JSON object with a "plugins" or "listings" array.',
          },
          message: `Marketplace "${marketplaceId}" manifest is missing a "plugins" or "listings" array.`,
          hint: "Provide a valid Antigravity, Claude, or Cursor marketplace.json.",
        },
      ],
    };
  }

  let ecosystem: ManifestEcosystem = options?.defaultEcosystem ?? "antigravity";
  if (isRecord(root) && typeof root.$schema === "string" && root.$schema.toLowerCase().includes("claude")) {
    ecosystem = "claude";
  }

  let pluginRootPrefix: RelativeSubpath | null = null;
  const rawPluginRoot =
    isRecord(root) && isRecord(root.metadata) && typeof root.metadata.pluginRoot === "string"
      ? root.metadata.pluginRoot
      : isRecord(root) && typeof root.pluginRoot === "string"
        ? root.pluginRoot
        : null;
  if (rawPluginRoot !== null) {
    const parsedRoot = parseRelativeSubpath(rawPluginRoot);
    if (parsedRoot.ok) {
      pluginRootPrefix = parsedRoot.value;
    }
  }

  const rootDir = options?.rootDir;
  let canonicalRootDir: string | null = null;
  if (rootDir !== undefined) {
    try {
      canonicalRootDir = await fs.realpath(rootDir);
    } catch {
      canonicalRootDir = null;
    }
  }

  const entries: CatalogEntry[] = [];
  const diagnostics: Diagnostic[] = [];
  const usedSlugs = new Set<string>();

  for (let i = 0; i < pluginList.length; i += 1) {
    const item = pluginList[i];
    if (!isRecord(item)) {
      continue;
    }

    const rawName = typeof item.name === "string" ? item.name.trim() : "";
    if (rawName.length === 0) {
      diagnostics.push({
        id: makeDiagnosticId("marketplace-manifest-invalid", marketplaceId, `entry-${i}`),
        severity: "warning",
        subject: { kind: "marketplace", marketplaceId },
        detail: {
          kind: "marketplace-manifest-invalid",
          marketplaceId,
          filePath,
          reason: `Plugin entry at index ${i} is missing a string "name".`,
        },
        message: `Skipped unnamed plugin entry at index ${i} in marketplace "${marketplaceId}".`,
        hint: "Add a non-empty string name to each plugin entry.",
      });
      continue;
    }

    const resolvedSource = await resolveMarketplacePluginSource({
      rawSource: item.source,
      marketplaceId,
      pluginRootPrefix,
      rootDir,
      canonicalRootDir,
    });
    if (!resolvedSource.ok) {
      switch (resolvedSource.kind) {
        case "skip":
          break;
        case "path-traversal":
          diagnostics.push({
            id: makeDiagnosticId("path-traversal-rejected", marketplaceId, rawName),
            severity: "error",
            subject: { kind: "marketplace", marketplaceId },
            detail: {
              kind: "path-traversal-rejected",
              offendingPath: resolvedSource.offendingPath,
              resolvedOutsideRoot: resolvedSource.resolvedOutsideRoot,
            },
            message: `Rejected plugin "${rawName}" in marketplace "${marketplaceId}": ${resolvedSource.reason}`,
            hint: "Plugin sources inside marketplace manifests must be relative paths contained inside the marketplace root or valid remote URLs.",
          });
          break;
        case "invalid":
          diagnostics.push({
            id: makeDiagnosticId("marketplace-manifest-invalid", marketplaceId, rawName),
            severity: "warning",
            subject: { kind: "marketplace", marketplaceId },
            detail: {
              kind: "marketplace-manifest-invalid",
              marketplaceId,
              filePath,
              reason: `Plugin "${rawName}": ${resolvedSource.reason}`,
            },
            message: `Skipped plugin "${rawName}" in marketplace "${marketplaceId}": ${resolvedSource.reason}`,
            hint: "Ensure plugin source paths are valid relative subpaths without '..' or valid remote URLs.",
          });
          break;
        default: {
          const _exhaustive: never = resolvedSource;
          return _exhaustive;
        }
      }
      continue;
    }

    const slug = allocateUniqueSlug(rawName, usedSlugs);
    const parsedName = parsePluginName(rawName);
    const safeName = parsedName.ok ? parsedName : parsePluginName(slug);
    if (!safeName.ok) {
      continue;
    }

    let displayName =
      typeof item.displayName === "string" && item.displayName.trim().length > 0
        ? item.displayName.trim()
        : rawName;
    let description = typeof item.description === "string" ? item.description : "";
    let version =
      typeof item.version === "string" && item.version.trim().length > 0
        ? item.version.trim()
        : null;
    const authorRes = extractAuthorString(item.author);
    let author = authorRes.ok ? (authorRes.value ?? null) : null;
    let category =
      typeof item.category === "string" && item.category.trim().length > 0
        ? item.category.trim()
        : null;
    const tagSet = new Set<string>([
      ...extractStringArray(item.tags),
      ...extractStringArray(item.keywords),
    ]);
    let homepage =
      typeof item.homepage === "string" && item.homepage.trim().length > 0
        ? item.homepage.trim()
        : null;
    const repoRes = extractRepositoryString(item.repository);
    let repository = repoRes.ok ? (repoRes.value ?? null) : null;

    let componentCounts: ComponentCounts | null = null;
    let componentsPreview: ComponentInventory | null = null;

    if (
      rootDir !== undefined &&
      canonicalRootDir !== null &&
      (resolvedSource.source.kind === "marketplace-subdir" ||
        resolvedSource.source.kind === "marketplace-root")
    ) {
      const localPluginDir =
        resolvedSource.source.kind === "marketplace-root"
          ? rootDir
          : joinAbsolutePath(rootDir, resolvedSource.source.subdir);
      const dirOffendingLabel =
        resolvedSource.source.kind === "marketplace-root" ? "." : resolvedSource.source.subdir;
      const dirCheck = await checkContainedPath(localPluginDir, canonicalRootDir);
      if (dirCheck.kind === "escaped") {
        diagnostics.push({
          id: makeDiagnosticId("path-traversal-rejected", marketplaceId, rawName),
          severity: "error",
          subject: { kind: "marketplace", marketplaceId },
          detail: {
            kind: "path-traversal-rejected",
            offendingPath: dirOffendingLabel,
            resolvedOutsideRoot: dirCheck.resolvedOutsideRoot,
          },
          message: `Rejected plugin "${rawName}" in marketplace "${marketplaceId}": "${dirOffendingLabel}" resolves outside marketplace root (${dirCheck.resolvedOutsideRoot}).`,
          hint: "Remove the escaping symlink from the marketplace repository.",
        });
        continue;
      }
      if (dirCheck.kind === "contained") {
        const canonicalPluginDir = dirCheck.realPath;
        const pluginManifest = await findPluginManifestFile(localPluginDir);
        if (pluginManifest !== null) {
          const manifestCheck = await checkContainedPath(pluginManifest.path, canonicalPluginDir);
          if (manifestCheck.kind === "escaped") {
            const manifestOffending =
              resolvedSource.source.kind === "marketplace-root"
                ? pluginManifest.relativePath
                : `${resolvedSource.source.subdir}/${pluginManifest.relativePath}`;
            diagnostics.push({
              id: makeDiagnosticId("path-traversal-rejected", marketplaceId, rawName),
              severity: "error",
              subject: { kind: "marketplace", marketplaceId },
              detail: {
                kind: "path-traversal-rejected",
                offendingPath: manifestOffending,
                resolvedOutsideRoot: manifestCheck.resolvedOutsideRoot,
              },
              message: `Rejected plugin "${rawName}" in marketplace "${marketplaceId}": manifest "${manifestOffending}" resolves outside plugin root (${manifestCheck.resolvedOutsideRoot}).`,
              hint: "Remove the escaping symlink from the plugin manifest.",
            });
            continue;
          }
          if (manifestCheck.kind === "contained") {
            try {
              const manifestBytes = await fs.readFile(pluginManifest.path);
              const manifestParsed = parseJsoncBomSafe(manifestBytes, pluginManifest.path);
              if (manifestParsed.ok) {
                const norm = normalizeAntigravityManifest(manifestParsed.value, slug);
                if (norm.ok) {
                  if (version === null && norm.manifest.version !== undefined) {
                    version = norm.manifest.version;
                  }
                  if (description.length === 0 && norm.manifest.description !== undefined) {
                    description = norm.manifest.description;
                  }
                  if (displayName === rawName && norm.manifest.displayName !== undefined) {
                    displayName = norm.manifest.displayName;
                  }
                  if (author === null && norm.manifest.author !== undefined) {
                    author = norm.manifest.author;
                  }
                  if (homepage === null && norm.manifest.homepage !== undefined) {
                    homepage = norm.manifest.homepage;
                  }
                  if (repository === null && norm.manifest.repository !== undefined) {
                    repository = norm.manifest.repository;
                  }
                  if (category === null && norm.extras.category !== null) {
                    category = norm.extras.category;
                  }
                  for (const tag of norm.extras.tags) {
                    tagSet.add(tag);
                  }
                }
              }
            } catch {
            }
          }
        }
        const preview = await previewPluginComponents(localPluginDir);
        if (preview !== null) {
          componentCounts = preview.counts;
          componentsPreview = preview.inventory;
        }
      }
    }

    if (
      repository === null &&
      (resolvedSource.source.kind === "git-repo" || resolvedSource.source.kind === "git-subdir")
    ) {
      repository = resolvedSource.source.repoUrl;
    }

    entries.push({
      id: makeCatalogEntryId(marketplaceId, slug),
      marketplaceId,
      slug,
      name: safeName.value,
      displayName,
      description,
      version,
      author,
      category,
      tags: [...tagSet],
      homepage,
      repository,
      sourceFormat: ecosystem,
      installSource: resolvedSource.source,
      componentCounts,
      componentsPreview,
    });
  }

  return {
    ok: true,
    format: ecosystem,
    entries,
    diagnostics,
  };
}

const NATIVE_MARKETPLACE_CANDIDATES: readonly {
  readonly relativePath: string;
  readonly ecosystem: ManifestEcosystem;
}[] = [
  { relativePath: ".antigravity-plugin/marketplace.json", ecosystem: "antigravity" },
  { relativePath: ".gemini-plugin/marketplace.json", ecosystem: "antigravity" },
  { relativePath: "marketplace.json", ecosystem: "antigravity" },
];

const EXTERNAL_MARKETPLACE_CANDIDATES: readonly {
  readonly relativePath: string;
  readonly ecosystem: ManifestEcosystem;
}[] = [
  { relativePath: ".claude-plugin/marketplace.json", ecosystem: "claude" },
  { relativePath: ".cursor-plugin/marketplace.json", ecosystem: "cursor" },
];

function buildMarketplacePathTraversalResult(
  marketplaceId: MarketplaceId,
  offendingPath: string,
  resolvedOutsideRoot: string,
): CatalogNormalizationResult {
  return {
    ok: false,
    format: null,
    entries: [],
    diagnostics: [
      {
        id: makeDiagnosticId("path-traversal-rejected", marketplaceId, offendingPath),
        severity: "error",
        subject: { kind: "marketplace", marketplaceId },
        detail: {
          kind: "path-traversal-rejected",
          offendingPath,
          resolvedOutsideRoot,
        },
        message: `Marketplace "${marketplaceId}" manifest "${offendingPath}" resolves outside marketplace root (${resolvedOutsideRoot}).`,
        hint: "Remove the escaping symlink from the marketplace repository.",
      },
    ],
  };
}

export async function normalizeMarketplaceRoot(
  marketplaceId: MarketplaceId,
  rootDir: AbsolutePath,
): Promise<CatalogNormalizationResult> {
  let canonicalRootDir: string;
  try {
    canonicalRootDir = await fs.realpath(rootDir);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      format: null,
      entries: [],
      diagnostics: [
        {
          id: makeDiagnosticId("marketplace-manifest-invalid", marketplaceId),
          severity: "error",
          subject: { kind: "marketplace", marketplaceId },
          detail: {
            kind: "marketplace-manifest-invalid",
            marketplaceId,
            filePath: rootDir,
            reason,
          },
          message: `Failed to access marketplace directory "${rootDir}": ${reason}`,
          hint: "Ensure the marketplace directory exists and is readable.",
        },
      ],
    };
  }

  for (const candidate of NATIVE_MARKETPLACE_CANDIDATES) {
    const candidatePath = joinAbsolutePath(rootDir, makeRelativeSubpath(candidate.relativePath));
    const check = await checkContainedPath(candidatePath, canonicalRootDir);
    if (check.kind === "missing") {
      continue;
    }
    if (check.kind === "escaped") {
      return buildMarketplacePathTraversalResult(
        marketplaceId,
        candidate.relativePath,
        check.resolvedOutsideRoot,
      );
    }
    let rawBytes: Uint8Array;
    try {
      rawBytes = await fs.readFile(candidatePath);
    } catch {
      continue;
    }
    return normalizeJsonCatalog(marketplaceId, candidatePath, rawBytes, {
      rootDir,
      defaultEcosystem: candidate.ecosystem,
    });
  }

  // Dual-ecosystem repos (like cursor/plugins) may ship a small .claude-plugin shim alongside a full .cursor-plugin catalog; pick the richer valid catalog.
  let bestExternal: CatalogNormalizationResult | null = null;
  for (const candidate of EXTERNAL_MARKETPLACE_CANDIDATES) {
    const candidatePath = joinAbsolutePath(rootDir, makeRelativeSubpath(candidate.relativePath));
    const check = await checkContainedPath(candidatePath, canonicalRootDir);
    if (check.kind === "missing") {
      continue;
    }
    if (check.kind === "escaped") {
      return buildMarketplacePathTraversalResult(
        marketplaceId,
        candidate.relativePath,
        check.resolvedOutsideRoot,
      );
    }
    let rawBytes: Uint8Array;
    try {
      rawBytes = await fs.readFile(candidatePath);
    } catch {
      continue;
    }
    const result = await normalizeJsonCatalog(marketplaceId, candidatePath, rawBytes, {
      rootDir,
      defaultEcosystem: candidate.ecosystem,
    });
    if (bestExternal === null) {
      bestExternal = result;
    } else if (result.ok && (!bestExternal.ok || result.entries.length > bestExternal.entries.length)) {
      bestExternal = result;
    }
  }
  if (bestExternal !== null) {
    return bestExternal;
  }

  const singleManifest = await findPluginManifestFile(rootDir);
  if (singleManifest !== null) {
    const manifestCheck = await checkContainedPath(singleManifest.path, canonicalRootDir);
    if (manifestCheck.kind === "escaped") {
      return buildMarketplacePathTraversalResult(
        marketplaceId,
        singleManifest.relativePath,
        manifestCheck.resolvedOutsideRoot,
      );
    }
    if (manifestCheck.kind === "contained") {
      let rawBytes: Uint8Array;
      try {
        rawBytes = await fs.readFile(singleManifest.path);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          format: null,
          entries: [],
          diagnostics: [
            {
              id: makeDiagnosticId("marketplace-manifest-invalid", marketplaceId),
              severity: "error",
              subject: { kind: "marketplace", marketplaceId },
              detail: {
                kind: "marketplace-manifest-invalid",
                marketplaceId,
                filePath: singleManifest.path,
                reason,
              },
              message: `Failed to read plugin manifest for "${marketplaceId}": ${reason}`,
              hint: "Ensure the plugin manifest file is readable.",
            },
          ],
        };
      }

      const parsed = parseJsoncBomSafe(rawBytes, singleManifest.path);
      if (!parsed.ok) {
        return {
          ok: false,
          format: null,
          entries: [],
          diagnostics: [
            {
              id: makeDiagnosticId("marketplace-json-syntax", marketplaceId),
              severity: "error",
              subject: { kind: "marketplace", marketplaceId },
              detail: {
                kind: "manifest-json-syntax",
                filePath: singleManifest.path,
                line: parsed.line,
                column: parsed.column,
                hadUtf8Bom: parsed.hadUtf8Bom,
                syntaxError: parsed.syntaxError,
              },
              message: `Failed to parse plugin.json for single-plugin marketplace "${marketplaceId}": ${parsed.syntaxError}`,
              hint: "Fix the JSON syntax error in plugin.json.",
            },
          ],
        };
      }

      const fallbackName = path.basename(rootDir);
      const normalized = normalizeAntigravityManifest(parsed.value, fallbackName);
      if (!normalized.ok) {
        return {
          ok: false,
          format: null,
          entries: [],
          diagnostics: [
            {
              id: makeDiagnosticId("marketplace-manifest-invalid", marketplaceId),
              severity: "error",
              subject: { kind: "marketplace", marketplaceId },
              detail: {
                kind: "marketplace-manifest-invalid",
                marketplaceId,
                filePath: singleManifest.path,
                reason: normalized.fieldErrors.join(" "),
              },
              message: `Invalid plugin.json for "${marketplaceId}": ${normalized.fieldErrors.join(" ")}`,
              hint: "Fix the manifest schema errors in plugin.json.",
            },
          ],
        };
      }

      const slug = slugifyPluginDirName(normalized.manifest.name, fallbackName);
      const preview = await previewPluginComponents(rootDir);
      const entry: CatalogEntry = {
        id: makeCatalogEntryId(marketplaceId, slug),
        marketplaceId,
        slug,
        name: normalized.manifest.name,
        displayName: normalized.manifest.displayName ?? normalized.manifest.name,
        description: normalized.manifest.description ?? "",
        version: normalized.manifest.version ?? null,
        author: normalized.manifest.author ?? null,
        category: normalized.extras.category,
        tags: normalized.extras.tags,
        homepage: normalized.manifest.homepage ?? null,
        repository: normalized.manifest.repository ?? null,
        sourceFormat: "single-plugin",
        installSource: { kind: "marketplace-root", marketplaceId },
        componentCounts: preview?.counts ?? EMPTY_COMPONENT_COUNTS,
        componentsPreview: preview?.inventory ?? EMPTY_COMPONENT_INVENTORY,
      };

      return {
        ok: true,
        format: "single-plugin",
        entries: [entry],
        diagnostics: [],
      };
    }
  }

  return {
    ok: false,
    format: null,
    entries: [],
    diagnostics: [
      {
        id: makeDiagnosticId("marketplace-manifest-invalid", marketplaceId),
        severity: "error",
        subject: { kind: "marketplace", marketplaceId },
        detail: {
          kind: "marketplace-manifest-invalid",
          marketplaceId,
          filePath: rootDir,
          reason: "No marketplace.json or plugin.json manifest found in directory.",
        },
        message: `Marketplace "${marketplaceId}" does not contain a marketplace.json or plugin.json manifest.`,
        hint: "Add .antigravity-plugin/marketplace.json, .claude-plugin/marketplace.json, .cursor-plugin/marketplace.json, or a plugin.json.",
      },
    ],
  };
}

export function isValidAbsolute(value: string): value is AbsolutePath {
  return isAbsolutePath(value);
}
