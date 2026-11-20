import fs from "node:fs";
import path from "node:path";
import {
  formatBytes,
  formatComponentsCompact,
  formatMarketplaceSource,
  parseInstallTarget,
  parseMarketplaceInput,
  queryCatalog,
  queryDiagnostics,
  queryInstalled,
  queryMarketplaces,
} from "../domain/query.ts";
import {
  makeAbsolutePath,
  parseAbsolutePath,
  parseErr,
  parseInstallScope,
  parseInstalledPluginId,
  parseMarketplaceId,
  parseOk,
  parsePluginDirName,
  parsePluginName,
  splitInstalledPluginId,
} from "../domain/types.ts";
import type {
  AbsolutePath,
  Diagnostic,
  DiagnosticSeverity,
  InstalledPlugin,
  InstalledPluginSelector,
  InstallScope,
  InstallTarget,
  MarketplaceId,
  ParseError,
  ParsedMarketplaceInput,
  ParseResult,
  PluginDirName,
  WorkspaceSnapshot,
} from "../domain/types.ts";
import type {
  PluginEngine,
  PluginEngineConfig,
  SyncMarketplacesInput,
  UpdatePluginsInput,
  ValidateTargetInput,
  ValidationReport,
} from "../engine/contract.ts";
import { createPluginEngine } from "../engine/index.ts";
import { createTheme, isColorSupported, padVisible } from "../tui/ansi.ts";
import type { AnsiTheme } from "../tui/ansi.ts";
import { runTui } from "../tui/index.ts";
import { formatEngineError } from "../tui/state.ts";
import { createNodeTerminal } from "../tui/terminal.ts";
import type { TerminalPort } from "../tui/terminal.ts";

export function readCliVersion(): string {
  try {
    const pkgPath = new URL("../../package.json", import.meta.url);
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      typeof parsed.version === "string"
    ) {
      return parsed.version;
    }
  } catch {
    // Fall back to static package version when package.json cannot be read.
  }
  return "0.1.0";
}

export const CLI_VERSION = readCliVersion();

export interface CliGlobalOptions {
  readonly configDirRaw?: string;
  readonly workspaceRaw?: string;
  readonly json: boolean;
  readonly help: boolean;
  readonly version: boolean;
}

export type CliCommand =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "tui" }
  | {
      readonly kind: "discover";
      readonly text?: string;
      readonly marketplaceId?: MarketplaceId;
      readonly category?: string;
      readonly installFilter: "all" | "installed" | "not-installed";
    }
  | {
      readonly kind: "install";
      readonly target: InstallTarget;
      readonly scope: InstallScope;
      readonly dirName?: PluginDirName;
      readonly allowNameCollision: boolean;
    }
  | {
      readonly kind: "uninstall";
      readonly selector: InstalledPluginSelector;
    }
  | {
      readonly kind: "set-enabled";
      readonly selector: InstalledPluginSelector;
      readonly enabled: boolean;
    }
  | {
      readonly kind: "list";
      readonly scope?: InstallScope;
      readonly state?: "active" | "disabled" | "shadowed" | "broken";
    }
  | {
      readonly kind: "update";
      readonly input: UpdatePluginsInput;
    }
  | {
      readonly kind: "validate";
      readonly target: ValidateTargetInput;
      readonly strict: boolean;
    }
  | {
      readonly kind: "errors";
      readonly text?: string;
      readonly severity?: DiagnosticSeverity;
    }
  | { readonly kind: "stats" }
  | {
      readonly kind: "marketplace-add";
      readonly source: ParsedMarketplaceInput;
      readonly id?: MarketplaceId;
    }
  | { readonly kind: "marketplace-list" }
  | {
      readonly kind: "marketplace-update";
      readonly input: SyncMarketplacesInput;
    }
  | {
      readonly kind: "marketplace-remove";
      readonly id: MarketplaceId;
    };

export interface ParsedCliInvocation {
  readonly globals: CliGlobalOptions;
  readonly config: PluginEngineConfig;
  readonly command: CliCommand;
}

export interface ParseCliContext {
  readonly cwd: string;
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface CliIo {
  readonly cwd: string;
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isTTY: boolean;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly terminal?: TerminalPort;
}

export type EngineFactory = (config: PluginEngineConfig) => PluginEngine;

function expandTilde(rawPath: string, homeDir: string): string {
  if (rawPath === "~") {
    return homeDir;
  }
  if (rawPath.startsWith("~/")) {
    return path.join(homeDir, rawPath.slice(2));
  }
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

interface ExtractedArgs {
  readonly globals: CliGlobalOptions;
  readonly rest: readonly string[];
}

function hasJsonFlagBeforeSeparator(argv: readonly string[]): boolean {
  for (const token of argv) {
    if (token === "--") {
      return false;
    }
    if (token === "--json") {
      return true;
    }
  }
  return false;
}

function extractGlobalOptions(argv: readonly string[]): ParseResult<ExtractedArgs> {
  let configDirRaw: string | undefined;
  let workspaceRaw: string | undefined;
  let json = false;
  let help = false;
  let version = false;
  const rest: string[] = [];
  let stopFlags = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (stopFlags) {
      rest.push(token);
      continue;
    }
    if (token === "--") {
      stopFlags = true;
      rest.push(token);
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }
    if (token === "--version" || token === "-v") {
      version = true;
      continue;
    }
    if (token === "--config-dir") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return parseErr("invalid-cli-args", token, "Missing value for --config-dir.");
      }
      configDirRaw = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--config-dir=")) {
      configDirRaw = token.slice("--config-dir=".length);
      continue;
    }
    if (token === "--workspace") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return parseErr("invalid-cli-args", token, "Missing value for --workspace.");
      }
      workspaceRaw = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--workspace=")) {
      workspaceRaw = token.slice("--workspace=".length);
      continue;
    }
    rest.push(token);
  }

  return parseOk({
    globals: { configDirRaw, workspaceRaw, json, help, version },
    rest,
  });
}

interface ParsedTokenStream {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

function parseCommandTokens(
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

function getStringFlag(
  flags: ReadonlyMap<string, string | true>,
  name: string,
): string | undefined {
  const val = flags.get(name);
  return typeof val === "string" ? val : undefined;
}

function parseInstalledSelector(
  raw: string,
  scopeOpt?: InstallScope,
): ParseResult<InstalledPluginSelector> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return parseErr("empty-input", raw, "Plugin selector cannot be empty.");
  }
  if (trimmed.includes(":")) {
    const parsedId = parseInstalledPluginId(trimmed);
    if (!parsedId.ok) {
      return parsedId;
    }
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
  if (!parsedName.ok) {
    return parsedName;
  }
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

function parseValidateTarget(
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
    if (!parsedSource.ok) {
      return parsedSource;
    }
    return parseOk({ kind: "source", source: parsedSource.value });
  }
  const parsedName = parsePluginName(trimmed);
  if (!parsedName.ok) {
    return parsedName;
  }
  return parseOk({
    kind: "installed",
    selector:
      scopeOpt !== undefined
        ? { kind: "name", name: parsedName.value, scope: scopeOpt }
        : { kind: "name", name: parsedName.value },
  });
}

function parseInstalledStateFilter(
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

function parseDiagnosticSeverityFlag(raw: string): ParseResult<DiagnosticSeverity> {
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

function resolveEngineConfig(
  globals: CliGlobalOptions,
  ctx: ParseCliContext,
): ParseResult<PluginEngineConfig> {
  const homeRes = resolveUserPath(ctx.homeDir, "/", "/");
  if (!homeRes.ok) {
    return homeRes;
  }
  const cwdRes = resolveUserPath(ctx.cwd, homeRes.value, homeRes.value);
  if (!cwdRes.ok) {
    return cwdRes;
  }
  const workspaceRes =
    globals.workspaceRaw !== undefined
      ? resolveUserPath(globals.workspaceRaw, cwdRes.value, homeRes.value)
      : parseOk(cwdRes.value);
  if (!workspaceRes.ok) {
    return workspaceRes;
  }
  const envConfigDir = ctx.env.AGY_CONFIG_DIR;
  const rawConfigDir =
    globals.configDirRaw ??
    (envConfigDir !== undefined && envConfigDir.trim().length > 0
      ? envConfigDir
      : path.join(homeRes.value, ".gemini", "config"));
  const configDirRes = resolveUserPath(rawConfigDir, cwdRes.value, homeRes.value);
  if (!configDirRes.ok) {
    return configDirRes;
  }

  return parseOk({
    homeDir: homeRes.value,
    configDir: configDirRes.value,
    workspaceDir: workspaceRes.value,
  });
}

function resolveFallbackConfig(ctx: ParseCliContext): PluginEngineConfig {
  const safePath = (raw: string): AbsolutePath => {
    const parsed = parseAbsolutePath(path.resolve(raw));
    return parsed.ok ? parsed.value : makeAbsolutePath("/");
  };
  const homeDir = safePath(ctx.homeDir);
  return {
    homeDir,
    configDir: safePath(path.join(homeDir, ".gemini", "config")),
    workspaceDir: safePath(ctx.cwd),
  };
}

export function parseCliArgs(
  argv: readonly string[],
  ctx: ParseCliContext,
): ParseResult<ParsedCliInvocation> {
  const globalsRes = extractGlobalOptions(argv);
  if (!globalsRes.ok) {
    return globalsRes;
  }
  const { globals, rest } = globalsRes.value;

  if (globals.help) {
    return parseOk({
      globals,
      config: resolveFallbackConfig(ctx),
      command: { kind: "help" },
    });
  }
  if (globals.version) {
    return parseOk({
      globals,
      config: resolveFallbackConfig(ctx),
      command: { kind: "version" },
    });
  }

  const configRes = resolveEngineConfig(globals, ctx);
  if (!configRes.ok) {
    return configRes;
  }
  const config = configRes.value;

  const commandTokens = rest[0] === "--" ? rest.slice(1) : rest;
  const subcommand = commandTokens[0];
  if (subcommand === undefined) {
    return parseOk({ globals, config, command: { kind: "tui" } });
  }

  if (subcommand.startsWith("-")) {
    return parseErr("invalid-cli-args", subcommand, `Unknown flag: ${subcommand}`);
  }

  const tail = commandTokens.slice(1);

  switch (subcommand) {
    case "tui": {
      const parsed = parseCommandTokens(tail, new Set(), new Set());
      if (!parsed.ok) return parsed;
      if (parsed.value.positionals.length > 0) {
        return parseErr(
          "invalid-cli-args",
          parsed.value.positionals.join(" "),
          `Unexpected arguments for tui: ${parsed.value.positionals.join(" ")}`,
        );
      }
      return parseOk({ globals, config, command: { kind: "tui" } });
    }

    case "discover": {
      const parsed = parseCommandTokens(
        tail,
        new Set(["--marketplace", "--category"]),
        new Set(["--installed", "--available"]),
      );
      if (!parsed.ok) return parsed;
      const { positionals, flags } = parsed.value;
      if (positionals.length > 1) {
        return parseErr("invalid-cli-args", positionals.slice(1).join(" "), "Too many arguments for discover.");
      }
      const wantInstalled = flags.has("--installed");
      const wantAvailable = flags.has("--available");
      if (wantInstalled && wantAvailable) {
        return parseErr("invalid-cli-args", "--installed --available", "Cannot combine --installed and --available.");
      }
      let marketplaceId: MarketplaceId | undefined;
      const mktRaw = getStringFlag(flags, "--marketplace");
      if (mktRaw !== undefined) {
        const mktRes = parseMarketplaceId(mktRaw);
        if (!mktRes.ok) return mktRes;
        marketplaceId = mktRes.value;
      }
      const category = getStringFlag(flags, "--category");
      return parseOk({
        globals,
        config,
        command: {
          kind: "discover",
          text: positionals[0],
          marketplaceId,
          category,
          installFilter: wantInstalled ? "installed" : wantAvailable ? "not-installed" : "all",
        },
      });
    }

    case "install": {
      const parsed = parseCommandTokens(
        tail,
        new Set(["--scope", "--dir-name"]),
        new Set(["--force"]),
      );
      if (!parsed.ok) return parsed;
      const { positionals, flags } = parsed.value;
      const rawTarget = positionals[0];
      if (rawTarget === undefined || positionals.length > 1) {
        return parseErr("invalid-cli-args", tail.join(" "), "Expected: install <target> [--scope user|project] [--dir-name <dir>] [--force]");
      }
      const targetRes = parseInstallTarget({
        raw: rawTarget,
        cwd: config.workspaceDir,
        homeDir: config.homeDir,
      });
      if (!targetRes.ok) return targetRes;

      let scope: InstallScope = "user";
      const scopeRaw = getStringFlag(flags, "--scope");
      if (scopeRaw !== undefined) {
        const scopeRes = parseInstallScope(scopeRaw);
        if (!scopeRes.ok) return scopeRes;
        scope = scopeRes.value;
      }

      let dirName: PluginDirName | undefined;
      const dirRaw = getStringFlag(flags, "--dir-name");
      if (dirRaw !== undefined) {
        const dirRes = parsePluginDirName(dirRaw);
        if (!dirRes.ok) return dirRes;
        dirName = dirRes.value;
      }

      return parseOk({
        globals,
        config,
        command: {
          kind: "install",
          target: targetRes.value,
          scope,
          dirName,
          allowNameCollision: flags.has("--force"),
        },
      });
    }

    case "uninstall":
    case "enable":
    case "disable": {
      const parsed = parseCommandTokens(tail, new Set(["--scope"]), new Set());
      if (!parsed.ok) return parsed;
      const { positionals, flags } = parsed.value;
      const rawSelector = positionals[0];
      if (rawSelector === undefined || positionals.length > 1) {
        return parseErr("invalid-cli-args", tail.join(" "), `Expected: ${subcommand} <scope:dir | name> [--scope user|project]`);
      }
      let scopeOpt: InstallScope | undefined;
      const scopeRaw = getStringFlag(flags, "--scope");
      if (scopeRaw !== undefined) {
        const scopeRes = parseInstallScope(scopeRaw);
        if (!scopeRes.ok) return scopeRes;
        scopeOpt = scopeRes.value;
      }
      const selectorRes = parseInstalledSelector(rawSelector, scopeOpt);
      if (!selectorRes.ok) return selectorRes;

      if (subcommand === "uninstall") {
        return parseOk({
          globals,
          config,
          command: { kind: "uninstall", selector: selectorRes.value },
        });
      }
      return parseOk({
        globals,
        config,
        command: {
          kind: "set-enabled",
          selector: selectorRes.value,
          enabled: subcommand === "enable",
        },
      });
    }

    case "list": {
      const parsed = parseCommandTokens(tail, new Set(["--scope", "--state"]), new Set());
      if (!parsed.ok) return parsed;
      const { positionals, flags } = parsed.value;
      if (positionals.length > 0) {
        return parseErr("invalid-cli-args", positionals.join(" "), "list does not take positional arguments.");
      }
      let scope: InstallScope | undefined;
      const scopeRaw = getStringFlag(flags, "--scope");
      if (scopeRaw !== undefined) {
        const scopeRes = parseInstallScope(scopeRaw);
        if (!scopeRes.ok) return scopeRes;
        scope = scopeRes.value;
      }
      let state: "active" | "disabled" | "shadowed" | "broken" | undefined;
      const stateRaw = getStringFlag(flags, "--state");
      if (stateRaw !== undefined) {
        const stateRes = parseInstalledStateFilter(stateRaw);
        if (!stateRes.ok) return stateRes;
        state = stateRes.value;
      }
      return parseOk({
        globals,
        config,
        command: { kind: "list", scope, state },
      });
    }

    case "update": {
      const parsed = parseCommandTokens(tail, new Set(["--scope"]), new Set(["--all"]));
      if (!parsed.ok) return parsed;
      const { positionals, flags } = parsed.value;
      const isAll = flags.has("--all");
      if (isAll && positionals.length > 0) {
        return parseErr("invalid-cli-args", tail.join(" "), "Cannot pass both a plugin selector and --all.");
      }
      if (positionals.length > 1) {
        return parseErr("invalid-cli-args", positionals.join(" "), "Too many arguments for update.");
      }
      let scopeOpt: InstallScope | undefined;
      const scopeRaw = getStringFlag(flags, "--scope");
      if (scopeRaw !== undefined) {
        const scopeRes = parseInstallScope(scopeRaw);
        if (!scopeRes.ok) return scopeRes;
        scopeOpt = scopeRes.value;
      }
      const rawSelector = positionals[0];
      if (rawSelector !== undefined) {
        const selectorRes = parseInstalledSelector(rawSelector, scopeOpt);
        if (!selectorRes.ok) return selectorRes;
        return parseOk({
          globals,
          config,
          command: {
            kind: "update",
            input: { kind: "single", selector: selectorRes.value },
          },
        });
      }
      return parseOk({
        globals,
        config,
        command: {
          kind: "update",
          input: scopeOpt !== undefined ? { kind: "all", scope: scopeOpt } : { kind: "all" },
        },
      });
    }

    case "validate": {
      const parsed = parseCommandTokens(tail, new Set(["--scope"]), new Set(["--strict"]));
      if (!parsed.ok) return parsed;
      const { positionals, flags } = parsed.value;
      if (positionals.length > 1) {
        return parseErr("invalid-cli-args", positionals.join(" "), "Too many arguments for validate.");
      }
      let scopeOpt: InstallScope | undefined;
      const scopeRaw = getStringFlag(flags, "--scope");
      if (scopeRaw !== undefined) {
        const scopeRes = parseInstallScope(scopeRaw);
        if (!scopeRes.ok) return scopeRes;
        scopeOpt = scopeRes.value;
      }
      const rawTarget = positionals[0];
      let target: ValidateTargetInput = { kind: "workspace" };
      if (rawTarget === undefined) {
        if (scopeOpt !== undefined) {
          return parseErr("invalid-cli-args", "--scope", "--scope requires an installed plugin selector.");
        }
      } else {
        const targetRes = parseValidateTarget(
          rawTarget,
          scopeOpt,
          config.workspaceDir,
          config.homeDir,
        );
        if (!targetRes.ok) return targetRes;
        target = targetRes.value;
      }
      return parseOk({
        globals,
        config,
        command: { kind: "validate", target, strict: flags.has("--strict") },
      });
    }

    case "errors": {
      const parsed = parseCommandTokens(tail, new Set(["--severity"]), new Set());
      if (!parsed.ok) return parsed;
      const { positionals, flags } = parsed.value;
      if (positionals.length > 1) {
        return parseErr("invalid-cli-args", positionals.join(" "), "Too many arguments for errors.");
      }
      let severity: DiagnosticSeverity | undefined;
      const sevRaw = getStringFlag(flags, "--severity");
      if (sevRaw !== undefined) {
        const sevRes = parseDiagnosticSeverityFlag(sevRaw);
        if (!sevRes.ok) return sevRes;
        severity = sevRes.value;
      }
      return parseOk({
        globals,
        config,
        command: { kind: "errors", text: positionals[0], severity },
      });
    }

    case "stats": {
      const parsed = parseCommandTokens(tail, new Set(), new Set());
      if (!parsed.ok) return parsed;
      if (parsed.value.positionals.length > 0) {
        return parseErr(
          "invalid-cli-args",
          parsed.value.positionals.join(" "),
          "stats does not accept arguments or extra flags.",
        );
      }
      return parseOk({ globals, config, command: { kind: "stats" } });
    }

    case "marketplace": {
      const mktTokens = tail[0] === "--" ? tail.slice(1) : tail;
      const mktAction = mktTokens[0];
      if (mktAction === undefined) {
        return parseErr(
          "invalid-cli-args",
          "marketplace",
          "Expected marketplace subcommand: add | list | update | remove",
        );
      }
      const mktTail = mktTokens.slice(1);
      switch (mktAction) {
        case "add": {
          const parsed = parseCommandTokens(mktTail, new Set(["--id"]), new Set());
          if (!parsed.ok) return parsed;
          const { positionals, flags } = parsed.value;
          const rawSource = positionals[0];
          if (rawSource === undefined || positionals.length > 1) {
            return parseErr("invalid-cli-args", mktTail.join(" "), "Expected: marketplace add <source> [--id <id>]");
          }
          const srcRes = parseMarketplaceInput({
            raw: rawSource,
            cwd: config.workspaceDir,
            homeDir: config.homeDir,
          });
          if (!srcRes.ok) return srcRes;
          let id: MarketplaceId | undefined;
          const idRaw = getStringFlag(flags, "--id");
          if (idRaw !== undefined) {
            const idRes = parseMarketplaceId(idRaw);
            if (!idRes.ok) return idRes;
            id = idRes.value;
          }
          return parseOk({
            globals,
            config,
            command: { kind: "marketplace-add", source: srcRes.value, id },
          });
        }
        case "list": {
          const parsed = parseCommandTokens(mktTail, new Set(), new Set());
          if (!parsed.ok) return parsed;
          if (parsed.value.positionals.length > 0) {
            return parseErr(
              "invalid-cli-args",
              parsed.value.positionals.join(" "),
              "marketplace list does not take arguments.",
            );
          }
          return parseOk({ globals, config, command: { kind: "marketplace-list" } });
        }
        case "update": {
          const parsed = parseCommandTokens(mktTail, new Set(), new Set(["--all"]));
          if (!parsed.ok) return parsed;
          const { positionals, flags } = parsed.value;
          const isAll = flags.has("--all");
          if (isAll && positionals.length > 0) {
            return parseErr("invalid-cli-args", mktTail.join(" "), "Cannot pass both <id> and --all to marketplace update.");
          }
          if (positionals.length > 1) {
            return parseErr("invalid-cli-args", positionals.join(" "), "Too many arguments for marketplace update.");
          }
          const rawId = positionals[0];
          if (rawId !== undefined) {
            const idRes = parseMarketplaceId(rawId);
            if (!idRes.ok) return idRes;
            return parseOk({
              globals,
              config,
              command: {
                kind: "marketplace-update",
                input: { kind: "single", id: idRes.value },
              },
            });
          }
          return parseOk({
            globals,
            config,
            command: { kind: "marketplace-update", input: { kind: "all" } },
          });
        }
        case "remove": {
          const parsed = parseCommandTokens(mktTail, new Set(), new Set());
          if (!parsed.ok) return parsed;
          const { positionals } = parsed.value;
          const rawId = positionals[0];
          if (rawId === undefined || positionals.length > 1) {
            return parseErr("invalid-cli-args", mktTail.join(" "), "Expected: marketplace remove <id>");
          }
          const idRes = parseMarketplaceId(rawId);
          if (!idRes.ok) return idRes;
          return parseOk({
            globals,
            config,
            command: { kind: "marketplace-remove", id: idRes.value },
          });
        }
        default:
          return parseErr(
            "invalid-cli-args",
            mktAction,
            `Unknown marketplace subcommand "${mktAction}". Expected: add | list | update | remove`,
          );
      }
    }

    default:
      return parseErr("invalid-cli-args", subcommand, `Unknown command: "${subcommand}". Run --help for usage.`);
  }
}

function getSimpleHelpText(): string {
  return `agy-plugin v${CLI_VERSION} — Antigravity local multi-marketplace plugin manager

Usage:
  agy-plugin [global-flags] [command]

Commands:
  (none) | tui                          Launch interactive 5-tab TUI
  discover [query] [flags]              Search synced marketplace catalogs
    --marketplace <id> --category <cat> --installed | --available
  install <target> [flags]              Install and adapt a plugin atomically
    --scope user|project --dir-name <dir> --force
  uninstall <scope:dir|name> [flags]    Uninstall a plugin (--scope user|project)
  enable <scope:dir|name> [flags]       Enable a plugin (--scope user|project)
  disable <scope:dir|name> [flags]      Disable a plugin (--scope user|project)
  list [flags]                          List installed plugins
    --scope user|project --state active|disabled|shadowed|broken
  update [<scope:dir|name>|--all]       Update one or all managed plugins
    --scope user|project
  validate [<path-or-url>|<sel>]        Validate workspace, source, or installed plugin
    --strict --scope user|project
  errors [text] [--severity error|warning]
  stats                                 Show catalog, token, and disk footprint
  marketplace add <source> [--id <id>]  Register GitHub/SSH/HTTPS/local marketplace
  marketplace list                      List configured marketplaces
  marketplace update [<id>|--all]       Sync one or all marketplaces
  marketplace remove <id>               Remove a marketplace registration

Global Flags (accepted before or after commands):
  --config-dir <path>   Override AGY_CONFIG_DIR (default ~/.gemini/config)
  --workspace <path>    Override workspace root (default cwd)
  --json                Emit single-object JSON output without ANSI codes
  -h, --help            Print this help text and exit 0
  -v, --version         Print package version and exit 0

Exit Codes:
  0  Success
  1  Runtime, network, collision, or validation error
  2  Invalid CLI arguments or boundary parse error
`;
}

function writeJsonEnvelope(
  io: CliIo,
  payload:
    | { readonly ok: true; readonly data: unknown }
    | { readonly ok: false; readonly error: unknown },
): void {
  io.stdout(`${JSON.stringify(payload)}\n`);
}

function renderSimpleTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  widths: readonly number[],
  theme: AnsiTheme,
): string {
  const headerLine = headers
    .map((h, i) => theme.bold(padVisible(h, widths[i] ?? 12)))
    .join("  ");
  const sepLine = theme.dim(widths.map((w) => "─".repeat(w)).join("  "));
  const bodyLines = rows.map((row) =>
    row.map((cell, i) => padVisible(cell, widths[i] ?? 12)).join("  "),
  );
  return [headerLine, sepLine, ...bodyLines].join("\n");
}

function formatInstalledLabel(plugin: InstalledPlugin): string {
  if (plugin.kind === "broken") {
    return "broken";
  }
  return plugin.activation.kind === "shadowed"
    ? `shadowed(${plugin.activation.shadowedBy})`
    : plugin.activation.kind;
}

function formatDiagnosticLine(diag: Diagnostic, theme: AnsiTheme): string {
  const level =
    diag.severity === "error" ? theme.red("ERROR") : theme.yellow("WARN ");
  const fix = diag.remediation !== undefined ? theme.green(` [fix: ${diag.remediation.label}]`) : "";
  return `${level} ${theme.cyan(diag.detail.kind)} — ${diag.message}${fix}\n      Hint: ${diag.hint}`;
}

function formatValidationHuman(report: ValidationReport, strict: boolean, theme: AnsiTheme): string {
  const lines: string[] = [];
  const passed = report.valid && (!strict || report.diagnostics.length === 0);
  lines.push(
    `${passed ? theme.green("PASS") : theme.red("FAIL")} validate: ${report.targetLabel}`,
  );
  if (report.manifest !== null) {
    lines.push(
      `Plugin: ${report.manifest.name}${report.manifest.version ? ` v${report.manifest.version}` : ""}`,
    );
  }
  if (report.components !== null) {
    lines.push(`Components: ${formatComponentsCompact(report.components.counts)}`);
  }
  for (const diag of report.diagnostics) {
    lines.push(formatDiagnosticLine(diag, theme));
  }
  return `${lines.join("\n")}\n`;
}

function formatStatsHuman(snapshot: WorkspaceSnapshot, theme: AnsiTheme): string {
  const { stats } = snapshot;
  const c = stats.activeComponents;
  const lines: string[] = [
    theme.bold("Workspace Plugin Stats"),
    `Discoverable : ${stats.discoverableCount} (${snapshot.marketplaces.length} marketplaces)`,
    `Installed    : ${stats.installedCount} total (${stats.activeCount} active, ${stats.disabledCount} disabled, ${stats.shadowedCount} shadowed, ${stats.brokenCount} broken)`,
    `Components   : ${c.skills} skills, ${c.agents} agents, ${c.rules} rules, ${c.hooks} hooks, ${c.mcpServers} MCP servers`,
    `Desc Tokens  : ~${stats.estimatedDescriptionTokens}`,
    `Disk Usage   : ${formatBytes(stats.totalDiskBytes)}`,
    `Diagnostics  : ${stats.errorCount} error(s), ${stats.warningCount} warning(s)`,
  ];
  return `${lines.join("\n")}\n`;
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  createEngine: EngineFactory = createPluginEngine,
  runTuiFn: typeof runTui = runTui,
): Promise<number> {
  const parsed = parseCliArgs(argv, {
    cwd: io.cwd,
    homeDir: io.homeDir,
    env: io.env,
  });

  if (!parsed.ok) {
    if (hasJsonFlagBeforeSeparator(argv)) {
      writeJsonEnvelope(io, { ok: false, error: parsed.error });
    } else {
      io.stderr(`Error (${parsed.error.code}): ${parsed.error.message}\n`);
    }
    return 2;
  }

  const { globals, config, command } = parsed.value;
  const theme = createTheme(io.isTTY && !globals.json && isColorSupported(io.env));

  if (command.kind === "help") {
    if (globals.json) {
      writeJsonEnvelope(io, { ok: true, data: { help: getSimpleHelpText() } });
    } else {
      io.stdout(getSimpleHelpText());
    }
    return 0;
  }

  if (command.kind === "version") {
    if (globals.json) {
      writeJsonEnvelope(io, { ok: true, data: { version: CLI_VERSION } });
    } else {
      io.stdout(`${CLI_VERSION}\n`);
    }
    return 0;
  }

  const engine = createEngine(config);

  const emitParseOrRuntimeError = (code: string, message: string, detail?: unknown): void => {
    if (globals.json) {
      writeJsonEnvelope(io, {
        ok: false,
        error: detail ?? { code, message },
      });
    } else {
      io.stderr(`Error: ${message}\n`);
    }
  };

  try {
    switch (command.kind) {
      case "tui": {
        if (globals.json) {
          emitParseOrRuntimeError("invalid-cli-args", "--json cannot be used with interactive TUI mode.");
          return 2;
        }
        const terminal = io.terminal ?? (io.isTTY ? createNodeTerminal({ env: io.env }) : undefined);
        if (terminal === undefined || !terminal.isTTY) {
          emitParseOrRuntimeError(
            "not-a-tty",
            "Interactive TUI requires a TTY. Use subcommands (discover, list, install, stats, --json).",
          );
          return 1;
        }
        return await runTuiFn(engine, terminal);
      }

      case "discover": {
        const snapshot = await engine.snapshot();
        const matches = queryCatalog(snapshot, {
          text: command.text,
          marketplaceId: command.marketplaceId,
          category: command.category,
          installFilter: command.installFilter,
        });
        if (globals.json) {
          writeJsonEnvelope(io, {
            ok: true,
            data: { total: matches.length, matches },
          });
          return 0;
        }
        if (matches.length === 0) {
          io.stdout("No matching plugins found.\n");
          return 0;
        }
        const rows = matches.map((m) => [
          m.entry.id,
          m.entry.displayName || m.entry.name,
          formatComponentsCompact(m.entry.componentCounts),
          m.entry.version ?? "-",
          m.installStatus.kind === "installed"
            ? m.installStatus.scopes.join(",")
            : "available",
        ]);
        io.stdout(
          `${renderSimpleTable(
            ["ID", "Name", "Components", "Version", "Status"],
            rows,
            [28, 22, 16, 10, 14],
            theme,
          )}\n`,
        );
        return 0;
      }

      case "install": {
        const res = await engine.install({
          target: command.target,
          scope: command.scope,
          dirName: command.dirName,
          allowNameCollision: command.allowNameCollision,
        });
        if (!res.ok) {
          if (globals.json) {
            writeJsonEnvelope(io, { ok: false, error: res.error });
          } else {
            io.stderr(`${formatEngineError(res.error)}\n`);
          }
          return 1;
        }
        if (globals.json) {
          writeJsonEnvelope(io, { ok: true, data: res.report });
          return 0;
        }
        io.stdout(
          `${theme.green("✔")} ${res.report.outcome} ${res.report.pluginId} (${res.report.installPath})\n`,
        );
        for (const warn of res.report.warnings) {
          io.stdout(`${formatDiagnosticLine(warn, theme)}\n`);
        }
        return 0;
      }

      case "uninstall": {
        const res = await engine.uninstall({ selector: command.selector });
        if (!res.ok) {
          if (globals.json) {
            writeJsonEnvelope(io, { ok: false, error: res.error });
          } else {
            io.stderr(`${formatEngineError(res.error)}\n`);
          }
          return 1;
        }
        if (globals.json) {
          writeJsonEnvelope(io, { ok: true, data: res.report });
          return 0;
        }
        io.stdout(`${theme.green("✔")} ${res.report.outcome}: ${res.report.pluginId}\n`);
        return 0;
      }

      case "set-enabled": {
        const res = await engine.setEnabled({
          selector: command.selector,
          enabled: command.enabled,
        });
        if (!res.ok) {
          if (globals.json) {
            writeJsonEnvelope(io, { ok: false, error: res.error });
          } else {
            io.stderr(`${formatEngineError(res.error)}\n`);
          }
          return 1;
        }
        if (globals.json) {
          writeJsonEnvelope(io, { ok: true, data: res.report });
          return 0;
        }
        io.stdout(
          `${theme.green("✔")} ${res.report.enabled ? "enabled" : "disabled"} ${res.report.pluginId} (${res.report.outcome})\n`,
        );
        return 0;
      }

      case "list": {
        const snapshot = await engine.snapshot();
        const plugins = queryInstalled(snapshot, {
          scope: command.scope,
          state: command.state,
        });
        if (globals.json) {
          writeJsonEnvelope(io, {
            ok: true,
            data: { total: plugins.length, installed: plugins },
          });
          return 0;
        }
        if (plugins.length === 0) {
          io.stdout("No installed plugins found.\n");
          return 0;
        }
        const rows = plugins.map((p) => [
          p.id,
          p.kind === "valid" ? p.manifest.name : p.dirName,
          p.scope,
          p.kind === "valid" ? (p.manifest.version ?? "-") : "-",
          formatInstalledLabel(p),
          p.kind === "valid" ? formatComponentsCompact(p.components.counts) : "-",
        ]);
        io.stdout(
          `${renderSimpleTable(
            ["ID", "Name", "Scope", "Version", "State", "Components"],
            rows,
            [22, 20, 8, 10, 16, 16],
            theme,
          )}\n`,
        );
        return 0;
      }

      case "update": {
        const res = await engine.update(command.input);
        if (!res.ok) {
          if (globals.json) {
            writeJsonEnvelope(io, { ok: false, error: res.error });
          } else {
            io.stderr(`${formatEngineError(res.error)}\n`);
          }
          return 1;
        }
        const failed = res.report.outcomes.filter((o) => o.status === "failed");
        if (globals.json) {
          if (failed.length > 0) {
            writeJsonEnvelope(io, {
              ok: false,
              error: {
                kind: "update-failed",
                message: `${failed.length} plugin update(s) failed.`,
                outcomes: res.report.outcomes,
              },
            });
            return 1;
          }
          writeJsonEnvelope(io, { ok: true, data: res.report });
          return 0;
        }
        for (const outcome of res.report.outcomes) {
          io.stdout(
            `${outcome.pluginId}: ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}\n`,
          );
        }
        return failed.length > 0 ? 1 : 0;
      }

      case "validate": {
        const report = await engine.validate(command.target);
        const hasWarnings = report.diagnostics.some((d) => d.severity === "warning");
        const passed = report.valid && (!command.strict || !hasWarnings);
        if (globals.json) {
          if (passed) {
            writeJsonEnvelope(io, { ok: true, data: report });
          } else {
            writeJsonEnvelope(io, {
              ok: false,
              error: {
                kind: "validation-failed",
                strict: command.strict,
                report,
              },
            });
          }
          return passed ? 0 : 1;
        }
        io.stdout(formatValidationHuman(report, command.strict, theme));
        return passed ? 0 : 1;
      }

      case "errors": {
        const snapshot = await engine.snapshot();
        const diagnostics = queryDiagnostics(snapshot, {
          text: command.text,
          severity: command.severity,
        });
        if (globals.json) {
          writeJsonEnvelope(io, {
            ok: true,
            data: { total: diagnostics.length, diagnostics },
          });
          return 0;
        }
        if (diagnostics.length === 0) {
          io.stdout("No diagnostics found.\n");
          return 0;
        }
        for (const diag of diagnostics) {
          io.stdout(`${formatDiagnosticLine(diag, theme)}\n`);
        }
        return 0;
      }

      case "stats": {
        const snapshot = await engine.snapshot();
        if (globals.json) {
          writeJsonEnvelope(io, { ok: true, data: snapshot.stats });
          return 0;
        }
        io.stdout(formatStatsHuman(snapshot, theme));
        return 0;
      }

      case "marketplace-add": {
        const res = await engine.addMarketplace({
          source: command.source,
          id: command.id,
        });
        if (!res.ok) {
          if (globals.json) {
            writeJsonEnvelope(io, { ok: false, error: res.error });
          } else {
            io.stderr(`${formatEngineError(res.error)}\n`);
          }
          return 1;
        }
        const failed = res.report.outcome.status === "failed";
        if (globals.json) {
          if (failed) {
            writeJsonEnvelope(io, { ok: false, error: res.report.outcome });
            return 1;
          }
          writeJsonEnvelope(io, { ok: true, data: res.report });
          return 0;
        }
        const o = res.report.outcome;
        io.stdout(
          failed
            ? `${theme.red("✖")} ${o.marketplaceId}: sync failed (${o.reason ?? "unknown"})\n`
            : `${theme.green("✔")} ${o.marketplaceId}: synced ${o.pluginCount} plugins (${o.format ?? "unknown"})\n`,
        );
        return failed ? 1 : 0;
      }

      case "marketplace-list": {
        const snapshot = await engine.snapshot();
        const marketplaces = queryMarketplaces(snapshot);
        if (globals.json) {
          writeJsonEnvelope(io, {
            ok: true,
            data: { total: marketplaces.length, marketplaces },
          });
          return 0;
        }
        if (marketplaces.length === 0) {
          io.stdout("No marketplaces registered.\n");
          return 0;
        }
        const rows = marketplaces.map((m) => [
          m.id,
          m.source.kind,
          formatMarketplaceSource(m.source),
          m.sync.kind === "synced" ? String(m.sync.pluginCount) : "-",
          m.sync.kind,
        ]);
        io.stdout(
          `${renderSimpleTable(
            ["ID", "Kind", "Source", "Plugins", "Status"],
            rows,
            [22, 12, 34, 8, 13],
            theme,
          )}\n`,
        );
        return 0;
      }

      case "marketplace-update": {
        const res = await engine.syncMarketplaces(command.input);
        if (!res.ok) {
          if (globals.json) {
            writeJsonEnvelope(io, { ok: false, error: res.error });
          } else {
            io.stderr(`${formatEngineError(res.error)}\n`);
          }
          return 1;
        }
        const failed = res.report.outcomes.filter((o) => o.status === "failed");
        if (globals.json) {
          if (failed.length > 0) {
            writeJsonEnvelope(io, {
              ok: false,
              error: {
                kind: "marketplace-sync-failed",
                outcomes: res.report.outcomes,
              },
            });
            return 1;
          }
          writeJsonEnvelope(io, { ok: true, data: res.report });
          return 0;
        }
        for (const o of res.report.outcomes) {
          io.stdout(
            `${o.marketplaceId}: ${o.status} (${o.pluginCount} plugins)${o.reason ? ` — ${o.reason}` : ""}\n`,
          );
        }
        return failed.length > 0 ? 1 : 0;
      }

      case "marketplace-remove": {
        const res = await engine.removeMarketplace({ id: command.id });
        if (!res.ok) {
          if (globals.json) {
            writeJsonEnvelope(io, { ok: false, error: res.error });
          } else {
            io.stderr(`${formatEngineError(res.error)}\n`);
          }
          return 1;
        }
        if (globals.json) {
          writeJsonEnvelope(io, { ok: true, data: res.report });
          return 0;
        }
        io.stdout(`${theme.green("✔")} removed marketplace ${res.report.id}\n`);
        return 0;
      }

      default: {
        const _exhaustive: never = command;
        return _exhaustive;
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    emitParseOrRuntimeError("runtime-error", message);
    return 1;
  }
}
