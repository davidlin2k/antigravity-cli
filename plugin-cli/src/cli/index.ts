import fs from "node:fs";
import os from "node:os";
import {
  queryCatalog,
  queryDiagnostics,
  queryInstalled,
  queryMarketplaces,
} from "../domain/query.ts";
import { createPluginEngine } from "../engine/index.ts";
import { createTheme, isColorSupported } from "../tui/ansi.ts";
import { runTui } from "../tui/index.ts";
import { createNodeTerminal } from "../tui/terminal.ts";
import { hasJsonFlagBeforeSeparator, parseCliArgs } from "./args.ts";
import type {
  CliCommand,
  CliGlobalOptions,
  CliIo,
  EngineFactory,
  ExitCode,
  JsonEnvelope,
  OutputMode,
  ParseCliContext,
  ParsedCliInvocation,
} from "./args.ts";
import {
  formatCliError,
  formatDiscoverResult,
  formatErrorsResult,
  formatHelpResult,
  formatInstallResult,
  formatListResult,
  formatMarketplaceAddResult,
  formatMarketplaceListResult,
  formatMarketplaceRemoveResult,
  formatMarketplaceUpdateResult,
  formatParseError,
  formatSetEnabledResult,
  formatStatsResult,
  formatUninstallResult,
  formatUpdateResult,
  formatValidateResult,
  formatVersionResult,
} from "./format.ts";
import type { FormatContext, FormattedOutput } from "./format.ts";

export { parseCliArgs };
export type {
  CliCommand,
  CliGlobalOptions,
  CliIo,
  EngineFactory,
  ExitCode,
  JsonEnvelope,
  OutputMode,
  ParseCliContext,
  ParsedCliInvocation,
};

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
  }
  return "0.1.0";
}

export const CLI_VERSION = readCliVersion();

export function createDefaultCliIo(): CliIo {
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    cwd: process.cwd(),
    homeDir: os.homedir(),
    env: process.env,
    isTTY,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    terminal: isTTY ? createNodeTerminal() : undefined,
  };
}

function emitOutput(io: CliIo, output: FormattedOutput): ExitCode {
  if (output.text.length > 0) {
    if (output.stream === "stderr") {
      io.stderr(output.text);
    } else {
      io.stdout(output.text);
    }
  }
  return output.exitCode;
}

export async function runCli(
  argv: readonly string[],
  io: CliIo = createDefaultCliIo(),
  createEngine: EngineFactory = createPluginEngine,
  runTuiFn: typeof runTui = runTui,
): Promise<number> {
  const parsed = parseCliArgs(argv, {
    cwd: io.cwd,
    homeDir: io.homeDir,
    env: io.env,
  });

  if (!parsed.ok) {
    const mode: OutputMode = hasJsonFlagBeforeSeparator(argv) ? "json" : "human";
    return emitOutput(io, formatParseError(parsed.error, mode));
  }

  const { globals, config, command } = parsed.value;
  const mode: OutputMode = globals.json ? "json" : "human";
  const theme = createTheme(io.isTTY && !globals.json && isColorSupported(io.env));
  const fmt: FormatContext = { mode, theme };

  if (command.kind === "help") {
    return emitOutput(io, formatHelpResult(CLI_VERSION, mode));
  }

  if (command.kind === "version") {
    return emitOutput(io, formatVersionResult(CLI_VERSION, mode));
  }

  const engine = createEngine(config);

  try {
    switch (command.kind) {
      case "tui": {
        if (globals.json) {
          return emitOutput(
            io,
            formatCliError(
              "invalid-cli-args",
              "--json cannot be used with interactive TUI mode.",
              mode,
              2,
            ),
          );
        }
        const terminal = io.terminal ?? (io.isTTY ? createNodeTerminal({ env: io.env }) : undefined);
        if (terminal === undefined || !terminal.isTTY) {
          return emitOutput(
            io,
            formatCliError(
              "not-a-tty",
              "Interactive TUI requires a TTY. Use subcommands (discover, list, install, stats, --json).",
              mode,
              1,
            ),
          );
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
        return emitOutput(io, formatDiscoverResult(matches, fmt));
      }

      case "install": {
        const res = await engine.install({
          target: command.target,
          scope: command.scope,
          dirName: command.dirName,
          allowNameCollision: command.allowNameCollision,
        });
        return emitOutput(io, formatInstallResult(res, fmt));
      }

      case "uninstall": {
        const res = await engine.uninstall({ selector: command.selector });
        return emitOutput(io, formatUninstallResult(res, fmt));
      }

      case "set-enabled": {
        const res = await engine.setEnabled({
          selector: command.selector,
          enabled: command.enabled,
        });
        return emitOutput(io, formatSetEnabledResult(res, fmt));
      }

      case "list": {
        const snapshot = await engine.snapshot();
        const plugins = queryInstalled(snapshot, {
          scope: command.scope,
          state: command.state,
        });
        return emitOutput(io, formatListResult(plugins, fmt));
      }

      case "update": {
        const res = await engine.update(command.input);
        return emitOutput(io, formatUpdateResult(res, fmt));
      }

      case "validate": {
        const report = await engine.validate(command.target);
        return emitOutput(io, formatValidateResult(report, command.strict, fmt));
      }

      case "errors": {
        const snapshot = await engine.snapshot();
        const diagnostics = queryDiagnostics(snapshot, {
          text: command.text,
          severity: command.severity,
        });
        return emitOutput(io, formatErrorsResult(diagnostics, fmt));
      }

      case "stats": {
        const snapshot = await engine.snapshot();
        return emitOutput(io, formatStatsResult(snapshot, fmt));
      }

      case "marketplace-add": {
        const res = await engine.addMarketplace({
          source: command.source,
          id: command.id,
        });
        return emitOutput(io, formatMarketplaceAddResult(res, fmt));
      }

      case "marketplace-list": {
        const snapshot = await engine.snapshot();
        const marketplaces = queryMarketplaces(snapshot);
        return emitOutput(io, formatMarketplaceListResult(marketplaces, fmt));
      }

      case "marketplace-update": {
        const res = await engine.syncMarketplaces(command.input);
        return emitOutput(io, formatMarketplaceUpdateResult(res, fmt));
      }

      case "marketplace-remove": {
        const res = await engine.removeMarketplace({ id: command.id });
        return emitOutput(io, formatMarketplaceRemoveResult(res, fmt));
      }

      default: {
        const _exhaustive: never = command;
        return _exhaustive;
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return emitOutput(io, formatCliError("runtime-error", message, mode, 1));
  }
}
