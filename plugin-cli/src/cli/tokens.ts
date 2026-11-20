import path from "node:path";
import { parseMarketplaceInput } from "../domain/query.ts";
import {
  makeAbsolutePath,
  parseAbsolutePath,
  parseErr,
  parseInstalledPluginId,
  parseOk,
  parsePluginName,
  splitInstalledPluginId,
} from "../domain/types.ts";
import type {
  AbsolutePath,
  DiagnosticSeverity,
  InstalledPluginSelector,
  InstallScope,
  ParseResult,
} from "../domain/types.ts";
import type { PluginEngineConfig, ValidateTargetInput } from "../engine/contract.ts";

export interface ParsedTokenStream {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

export interface EngineConfigRawInput {
  readonly configDirRaw?: string;
  readonly workspaceRaw?: string;
  readonly cwd: string;
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export const EMPTY_FLAGS: ReadonlySet<string> = new Set();

function expandTilde(rawPath: string, homeDir: string): string {
  if (rawPath === "~") return homeDir;
  if (rawPath.startsWith("~/")) return path.join(homeDir, rawPath.slice(2));
  return rawPath;
}

function resolveUserPath(
  rawPath: string,
  baseDir: string,
  homeDir: string,
): ParseResult<AbsolutePath> {
  if (rawPath.trim().length === 0) {
    return parseErr("empty-input", rawPath, "Path cannot be empty.");
  }
  if (rawPath.includes("\0")) {
    return parseErr("invalid-path", rawPath, "Path cannot contain NUL bytes.");
  }
  const expanded = expandTilde(rawPath.trim(), homeDir);
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(baseDir, expanded);
  return parseAbsolutePath(resolved);
}

export function resolveEngineConfig(
  input: EngineConfigRawInput,
): ParseResult<PluginEngineConfig> {
  const homeRes = resolveUserPath(input.homeDir, "/", "/");
  if (!homeRes.ok) return homeRes;
  const cwdRes = resolveUserPath(input.cwd, homeRes.value, homeRes.value);
  if (!cwdRes.ok) return cwdRes;
  const workspaceRes =
    input.workspaceRaw !== undefined
      ? resolveUserPath(input.workspaceRaw, cwdRes.value, homeRes.value)
      : parseOk(cwdRes.value);
  if (!workspaceRes.ok) return workspaceRes;
  const envConfigDir = input.env.AGY_CONFIG_DIR;
  const rawConfigDir =
    input.configDirRaw ??
    (envConfigDir !== undefined && envConfigDir.trim().length > 0
      ? envConfigDir
      : path.join(homeRes.value, ".gemini", "config"));
  const configDirRes = resolveUserPath(rawConfigDir, cwdRes.value, homeRes.value);
  if (!configDirRes.ok) return configDirRes;

  return parseOk({
    homeDir: homeRes.value,
    configDir: configDirRes.value,
    workspaceDir: workspaceRes.value,
  });
}

export function resolveFallbackConfig(cwd: string, homeDir: string): PluginEngineConfig {
  const safePath = (raw: string): AbsolutePath => {
    const parsed = parseAbsolutePath(path.resolve(raw));
    return parsed.ok ? parsed.value : makeAbsolutePath("/");
  };
  const resolvedHome = safePath(homeDir);
  return {
    homeDir: resolvedHome,
    configDir: safePath(path.join(resolvedHome, ".gemini", "config")),
    workspaceDir: safePath(cwd),
  };
}

export function parseCommandTokens(
  tokens: readonly string[],
  valueFlags: ReadonlySet<string>,
  booleanFlags: ReadonlySet<string>,
): ParseResult<ParsedTokenStream> {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  let stopFlags = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (stopFlags) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      stopFlags = true;
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    const eqIdx = token.indexOf("=");
    if (eqIdx !== -1) {
      const flagName = token.slice(0, eqIdx);
      const flagValue = token.slice(eqIdx + 1);
      if (!valueFlags.has(flagName)) {
        return parseErr("invalid-cli-args", token, `Unknown or non-value flag: ${flagName}`);
      }
      flags.set(flagName, flagValue);
      continue;
    }

    if (booleanFlags.has(token)) {
      flags.set(token, true);
      continue;
    }
    if (valueFlags.has(token)) {
      const value = tokens[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return parseErr("invalid-cli-args", token, `Missing value for flag ${token}.`);
      }
      flags.set(token, value);
      i += 1;
      continue;
    }

    return parseErr("invalid-cli-args", token, `Unknown flag: ${token}`);
  }

  return parseOk({ positionals, flags });
}

export function getStringFlag(
  flags: ReadonlyMap<string, string | true>,
  name: string,
): string | undefined {
  const val = flags.get(name);
  return typeof val === "string" ? val : undefined;
}

export function parseOptionalFlag<T>(
  flags: ReadonlyMap<string, string | true>,
  name: string,
  parser: (raw: string) => ParseResult<T>,
): ParseResult<T | undefined> {
  const raw = getStringFlag(flags, name);
  return raw === undefined ? parseOk(undefined) : parser(raw);
}

export function parseInstalledSelector(
  raw: string,
  scopeOpt?: InstallScope,
): ParseResult<InstalledPluginSelector> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return parseErr("empty-input", raw, "Plugin selector cannot be empty.");
  }
  if (trimmed.includes(":")) {
    const parsedId = parseInstalledPluginId(trimmed);
    if (!parsedId.ok) return parsedId;
    if (scopeOpt !== undefined && splitInstalledPluginId(parsedId.value).scope !== scopeOpt) {
      return parseErr(
        "invalid-cli-args",
        raw,
        `Selector "${parsedId.value}" conflicts with --scope ${scopeOpt}.`,
      );
    }
    return parseOk({ kind: "id", id: parsedId.value });
  }
  const parsedName = parsePluginName(trimmed);
  if (!parsedName.ok) return parsedName;
  return parseOk(
    scopeOpt !== undefined
      ? { kind: "name", name: parsedName.value, scope: scopeOpt }
      : { kind: "name", name: parsedName.value },
  );
}

function isSourceLikeValidateTarget(raw: string): boolean {
  const trimmed = raw.trim();
  return (
    trimmed === "." ||
    trimmed === ".." ||
    trimmed === "~" ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("file://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("https://") ||
    trimmed.startsWith("ssh://") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes(":") ||
    trimmed.includes("@")
  );
}

export function parseValidateTarget(
  raw: string,
  scopeOpt: InstallScope | undefined,
  cwd: AbsolutePath,
  homeDir: AbsolutePath,
): ParseResult<ValidateTargetInput> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return parseErr("empty-input", raw, "Validate target cannot be empty.");
  }
  const parsedId = parseInstalledPluginId(trimmed);
  if (parsedId.ok) {
    if (scopeOpt !== undefined && splitInstalledPluginId(parsedId.value).scope !== scopeOpt) {
      return parseErr(
        "invalid-cli-args",
        raw,
        `Selector "${parsedId.value}" conflicts with --scope ${scopeOpt}.`,
      );
    }
    return parseOk({ kind: "installed", selector: { kind: "id", id: parsedId.value } });
  }
  if (isSourceLikeValidateTarget(trimmed)) {
    if (scopeOpt !== undefined) {
      return parseErr(
        "invalid-cli-args",
        raw,
        "--scope cannot be combined with a source path or URL in validate.",
      );
    }
    const parsedSource = parseMarketplaceInput({ raw: trimmed, cwd, homeDir });
    if (!parsedSource.ok) return parsedSource;
    return parseOk({ kind: "source", source: parsedSource.value });
  }
  const parsedName = parsePluginName(trimmed);
  if (!parsedName.ok) return parsedName;
  return parseOk({
    kind: "installed",
    selector:
      scopeOpt !== undefined
        ? { kind: "name", name: parsedName.value, scope: scopeOpt }
        : { kind: "name", name: parsedName.value },
  });
}

export function parseInstalledStateFilter(
  raw: string,
): ParseResult<"active" | "disabled" | "shadowed" | "broken"> {
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "active" ||
    normalized === "disabled" ||
    normalized === "shadowed" ||
    normalized === "broken"
  ) {
    return parseOk(normalized);
  }
  return parseErr(
    "invalid-cli-args",
    raw,
    `Expected --state to be active|disabled|shadowed|broken, got "${raw}".`,
  );
}

export function parseDiagnosticSeverityFlag(raw: string): ParseResult<DiagnosticSeverity> {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "error" || normalized === "warning") {
    return parseOk(normalized);
  }
  return parseErr(
    "invalid-cli-args",
    raw,
    `Expected --severity to be error|warning, got "${raw}".`,
  );
}
