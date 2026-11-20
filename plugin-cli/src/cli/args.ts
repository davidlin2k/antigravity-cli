import { parseInstallTarget, parseMarketplaceInput } from "../domain/query.ts";
import {
  parseErr,
  parseInstallScope,
  parseMarketplaceId,
  parseOk,
  parsePluginDirName,
} from "../domain/types.ts";
import type {
  DiagnosticSeverity,
  InstalledPluginSelector,
  InstallScope,
  InstallTarget,
  MarketplaceId,
  ParsedMarketplaceInput,
  ParseResult,
  PluginDirName,
} from "../domain/types.ts";
import type {
  PluginEngine,
  PluginEngineConfig,
  SyncMarketplacesInput,
  UpdatePluginsInput,
  ValidateTargetInput,
} from "../engine/contract.ts";
import type { TerminalPort } from "../tui/terminal.ts";
import {
  EMPTY_FLAGS,
  getStringFlag,
  parseCommandTokens,
  parseDiagnosticSeverityFlag,
  parseInstalledSelector,
  parseInstalledStateFilter,
  parseOptionalFlag,
  parseValidateTarget,
  resolveEngineConfig,
  resolveFallbackConfig,
} from "./tokens.ts";

export type ExitCode = 0 | 1 | 2;

export type OutputMode = "human" | "json";

export type JsonEnvelope<TData = unknown, TError = unknown> =
  | { readonly ok: true; readonly data: TData }
  | { readonly ok: false; readonly error: TError };

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

export interface ExtractedArgs {
  readonly globals: CliGlobalOptions;
  readonly rest: readonly string[];
}

export function hasJsonFlagBeforeSeparator(argv: readonly string[]): boolean {
  for (const token of argv) {
    if (token === "--") return false;
    if (token === "--json") return true;
  }
  return false;
}

export function extractGlobalOptions(argv: readonly string[]): ParseResult<ExtractedArgs> {
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

function parseDiscoverCommand(tail: readonly string[]): ParseResult<CliCommand> {
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
  const mktRes = parseOptionalFlag(flags, "--marketplace", parseMarketplaceId);
  if (!mktRes.ok) return mktRes;
  return parseOk({
    kind: "discover",
    text: positionals[0],
    marketplaceId: mktRes.value,
    category: getStringFlag(flags, "--category"),
    installFilter: wantInstalled ? "installed" : wantAvailable ? "not-installed" : "all",
  });
}

function parseInstallCommand(
  tail: readonly string[],
  config: PluginEngineConfig,
): ParseResult<CliCommand> {
  const parsed = parseCommandTokens(tail, new Set(["--scope", "--dir-name"]), new Set(["--force"]));
  if (!parsed.ok) return parsed;
  const { positionals, flags } = parsed.value;
  const rawTarget = positionals[0];
  if (rawTarget === undefined || positionals.length > 1) {
    return parseErr(
      "invalid-cli-args",
      tail.join(" "),
      "Expected: install <target> [--scope user|project] [--dir-name <dir>] [--force]",
    );
  }
  const targetRes = parseInstallTarget({
    raw: rawTarget,
    cwd: config.workspaceDir,
    homeDir: config.homeDir,
  });
  if (!targetRes.ok) return targetRes;

  const scopeRes = parseOptionalFlag(flags, "--scope", parseInstallScope);
  if (!scopeRes.ok) return scopeRes;
  const dirRes = parseOptionalFlag(flags, "--dir-name", parsePluginDirName);
  if (!dirRes.ok) return dirRes;

  return parseOk({
    kind: "install",
    target: targetRes.value,
    scope: scopeRes.value ?? "user",
    dirName: dirRes.value,
    allowNameCollision: flags.has("--force"),
  });
}

function parseSelectorMutationCommand(
  subcommand: "uninstall" | "enable" | "disable",
  tail: readonly string[],
): ParseResult<CliCommand> {
  const parsed = parseCommandTokens(tail, new Set(["--scope"]), EMPTY_FLAGS);
  if (!parsed.ok) return parsed;
  const { positionals, flags } = parsed.value;
  const rawSelector = positionals[0];
  if (rawSelector === undefined || positionals.length > 1) {
    return parseErr(
      "invalid-cli-args",
      tail.join(" "),
      `Expected: ${subcommand} <scope:dir | name> [--scope user|project]`,
    );
  }
  const scopeRes = parseOptionalFlag(flags, "--scope", parseInstallScope);
  if (!scopeRes.ok) return scopeRes;
  const selectorRes = parseInstalledSelector(rawSelector, scopeRes.value);
  if (!selectorRes.ok) return selectorRes;

  if (subcommand === "uninstall") {
    return parseOk({ kind: "uninstall", selector: selectorRes.value });
  }
  return parseOk({
    kind: "set-enabled",
    selector: selectorRes.value,
    enabled: subcommand === "enable",
  });
}

function parseListCommand(tail: readonly string[]): ParseResult<CliCommand> {
  const parsed = parseCommandTokens(tail, new Set(["--scope", "--state"]), EMPTY_FLAGS);
  if (!parsed.ok) return parsed;
  const { positionals, flags } = parsed.value;
  if (positionals.length > 0) {
    return parseErr("invalid-cli-args", positionals.join(" "), "list does not take positional arguments.");
  }
  const scopeRes = parseOptionalFlag(flags, "--scope", parseInstallScope);
  if (!scopeRes.ok) return scopeRes;
  const stateRes = parseOptionalFlag(flags, "--state", parseInstalledStateFilter);
  if (!stateRes.ok) return stateRes;
  return parseOk({ kind: "list", scope: scopeRes.value, state: stateRes.value });
}

function parseUpdateCommand(tail: readonly string[]): ParseResult<CliCommand> {
  const parsed = parseCommandTokens(tail, new Set(["--scope"]), new Set(["--all"]));
  if (!parsed.ok) return parsed;
  const { positionals, flags } = parsed.value;
  if (flags.has("--all") && positionals.length > 0) {
    return parseErr("invalid-cli-args", tail.join(" "), "Cannot pass both a plugin selector and --all.");
  }
  if (positionals.length > 1) {
    return parseErr("invalid-cli-args", positionals.join(" "), "Too many arguments for update.");
  }
  const scopeRes = parseOptionalFlag(flags, "--scope", parseInstallScope);
  if (!scopeRes.ok) return scopeRes;
  const rawSelector = positionals[0];
  if (rawSelector !== undefined) {
    const selectorRes = parseInstalledSelector(rawSelector, scopeRes.value);
    if (!selectorRes.ok) return selectorRes;
    return parseOk({ kind: "update", input: { kind: "single", selector: selectorRes.value } });
  }
  return parseOk({
    kind: "update",
    input: scopeRes.value !== undefined ? { kind: "all", scope: scopeRes.value } : { kind: "all" },
  });
}

function parseValidateCommand(
  tail: readonly string[],
  config: PluginEngineConfig,
): ParseResult<CliCommand> {
  const parsed = parseCommandTokens(tail, new Set(["--scope"]), new Set(["--strict"]));
  if (!parsed.ok) return parsed;
  const { positionals, flags } = parsed.value;
  if (positionals.length > 1) {
    return parseErr("invalid-cli-args", positionals.join(" "), "Too many arguments for validate.");
  }
  const scopeRes = parseOptionalFlag(flags, "--scope", parseInstallScope);
  if (!scopeRes.ok) return scopeRes;
  const rawTarget = positionals[0];
  if (rawTarget === undefined) {
    if (scopeRes.value !== undefined) {
      return parseErr("invalid-cli-args", "--scope", "--scope requires an installed plugin selector.");
    }
    return parseOk({ kind: "validate", target: { kind: "workspace" }, strict: flags.has("--strict") });
  }
  const targetRes = parseValidateTarget(rawTarget, scopeRes.value, config.workspaceDir, config.homeDir);
  if (!targetRes.ok) return targetRes;
  return parseOk({ kind: "validate", target: targetRes.value, strict: flags.has("--strict") });
}

function parseErrorsCommand(tail: readonly string[]): ParseResult<CliCommand> {
  const parsed = parseCommandTokens(tail, new Set(["--severity"]), EMPTY_FLAGS);
  if (!parsed.ok) return parsed;
  const { positionals, flags } = parsed.value;
  if (positionals.length > 1) {
    return parseErr("invalid-cli-args", positionals.join(" "), "Too many arguments for errors.");
  }
  const sevRes = parseOptionalFlag(flags, "--severity", parseDiagnosticSeverityFlag);
  if (!sevRes.ok) return sevRes;
  return parseOk({ kind: "errors", text: positionals[0], severity: sevRes.value });
}

function parseMarketplaceCommand(
  tail: readonly string[],
  config: PluginEngineConfig,
): ParseResult<CliCommand> {
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
      const parsed = parseCommandTokens(mktTail, new Set(["--id"]), EMPTY_FLAGS);
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
      const idRes = parseOptionalFlag(flags, "--id", parseMarketplaceId);
      if (!idRes.ok) return idRes;
      return parseOk({ kind: "marketplace-add", source: srcRes.value, id: idRes.value });
    }
    case "list": {
      const parsed = parseCommandTokens(mktTail, EMPTY_FLAGS, EMPTY_FLAGS);
      if (!parsed.ok) return parsed;
      if (parsed.value.positionals.length > 0) {
        return parseErr(
          "invalid-cli-args",
          parsed.value.positionals.join(" "),
          "marketplace list does not take arguments.",
        );
      }
      return parseOk({ kind: "marketplace-list" });
    }
    case "update": {
      const parsed = parseCommandTokens(mktTail, EMPTY_FLAGS, new Set(["--all"]));
      if (!parsed.ok) return parsed;
      const { positionals, flags } = parsed.value;
      if (flags.has("--all") && positionals.length > 0) {
        return parseErr("invalid-cli-args", mktTail.join(" "), "Cannot pass both <id> and --all to marketplace update.");
      }
      if (positionals.length > 1) {
        return parseErr("invalid-cli-args", positionals.join(" "), "Too many arguments for marketplace update.");
      }
      const rawId = positionals[0];
      if (rawId !== undefined) {
        const idRes = parseMarketplaceId(rawId);
        if (!idRes.ok) return idRes;
        return parseOk({ kind: "marketplace-update", input: { kind: "single", id: idRes.value } });
      }
      return parseOk({ kind: "marketplace-update", input: { kind: "all" } });
    }
    case "remove": {
      const parsed = parseCommandTokens(mktTail, EMPTY_FLAGS, EMPTY_FLAGS);
      if (!parsed.ok) return parsed;
      const { positionals } = parsed.value;
      const rawId = positionals[0];
      if (rawId === undefined || positionals.length > 1) {
        return parseErr("invalid-cli-args", mktTail.join(" "), "Expected: marketplace remove <id>");
      }
      const idRes = parseMarketplaceId(rawId);
      if (!idRes.ok) return idRes;
      return parseOk({ kind: "marketplace-remove", id: idRes.value });
    }
    default:
      return parseErr(
        "invalid-cli-args",
        mktAction,
        `Unknown marketplace subcommand "${mktAction}". Expected: add | list | update | remove`,
      );
  }
}

function parseSubcommand(
  subcommand: string,
  tail: readonly string[],
  config: PluginEngineConfig,
): ParseResult<CliCommand> {
  switch (subcommand) {
    case "tui": {
      const parsed = parseCommandTokens(tail, EMPTY_FLAGS, EMPTY_FLAGS);
      if (!parsed.ok) return parsed;
      if (parsed.value.positionals.length > 0) {
        return parseErr(
          "invalid-cli-args",
          parsed.value.positionals.join(" "),
          `Unexpected arguments for tui: ${parsed.value.positionals.join(" ")}`,
        );
      }
      return parseOk({ kind: "tui" });
    }
    case "discover":
      return parseDiscoverCommand(tail);
    case "install":
      return parseInstallCommand(tail, config);
    case "uninstall":
    case "enable":
    case "disable":
      return parseSelectorMutationCommand(subcommand, tail);
    case "list":
      return parseListCommand(tail);
    case "update":
      return parseUpdateCommand(tail);
    case "validate":
      return parseValidateCommand(tail, config);
    case "errors":
      return parseErrorsCommand(tail);
    case "stats": {
      const parsed = parseCommandTokens(tail, EMPTY_FLAGS, EMPTY_FLAGS);
      if (!parsed.ok) return parsed;
      if (parsed.value.positionals.length > 0) {
        return parseErr(
          "invalid-cli-args",
          parsed.value.positionals.join(" "),
          "stats does not accept arguments or extra flags.",
        );
      }
      return parseOk({ kind: "stats" });
    }
    case "marketplace":
      return parseMarketplaceCommand(tail, config);
    default:
      return parseErr("invalid-cli-args", subcommand, `Unknown command: "${subcommand}". Run --help for usage.`);
  }
}

export function parseCliArgs(
  argv: readonly string[],
  ctx: ParseCliContext,
): ParseResult<ParsedCliInvocation> {
  const globalsRes = extractGlobalOptions(argv);
  if (!globalsRes.ok) return globalsRes;
  const { globals, rest } = globalsRes.value;

  if (globals.help) {
    return parseOk({
      globals,
      config: resolveFallbackConfig(ctx.cwd, ctx.homeDir),
      command: { kind: "help" },
    });
  }
  if (globals.version) {
    return parseOk({
      globals,
      config: resolveFallbackConfig(ctx.cwd, ctx.homeDir),
      command: { kind: "version" },
    });
  }

  const configRes = resolveEngineConfig({
    configDirRaw: globals.configDirRaw,
    workspaceRaw: globals.workspaceRaw,
    cwd: ctx.cwd,
    homeDir: ctx.homeDir,
    env: ctx.env,
  });
  if (!configRes.ok) return configRes;
  const config = configRes.value;

  const commandTokens = rest[0] === "--" ? rest.slice(1) : rest;
  const subcommand = commandTokens[0];
  if (subcommand === undefined) {
    return parseOk({ globals, config, command: { kind: "tui" } });
  }
  if (subcommand.startsWith("-")) {
    return parseErr("invalid-cli-args", subcommand, `Unknown flag: ${subcommand}`);
  }

  const commandRes = parseSubcommand(subcommand, commandTokens.slice(1), config);
  if (!commandRes.ok) return commandRes;
  return parseOk({ globals, config, command: commandRes.value });
}
