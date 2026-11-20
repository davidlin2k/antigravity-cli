import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runCli } from "../src/cli/index.ts";
import type { CliIo } from "../src/cli/index.ts";
import {
  EMPTY_COMPONENT_COUNTS,
  EMPTY_COMPONENT_INVENTORY,
  makeAbsolutePath,
  makeCatalogEntryId,
  makeDiagnosticId,
  makeInstalledPluginId,
  makeIsoTimestamp,
  makeMarketplaceId,
  makePluginDirName,
  makePluginName,
  makeRelativeSubpath,
  makeSnapshotRevision,
} from "../src/domain/types.ts";
import type {
  CatalogEntry,
  Diagnostic,
  EngineResult,
  InstalledPlugin,
  MarketplaceRecord,
  WorkspaceSnapshot,
} from "../src/domain/types.ts";
import type {
  AddMarketplaceInput,
  BulkSyncReport,
  InstallPluginInput,
  InstallReport,
  MarketplaceSyncReport,
  PluginEngine,
  PluginEngineConfig,
  RemediateInput,
  RemediateReport,
  RemoveMarketplaceInput,
  RemoveMarketplaceReport,
  SetPluginEnabledInput,
  SyncMarketplacesInput,
  ToggleReport,
  UninstallPluginInput,
  UninstallReport,
  UpdatePluginsInput,
  UpdateReport,
  ValidateTargetInput,
  ValidationReport,
} from "../src/engine/contract.ts";
import { stripAnsi } from "../src/tui/ansi.ts";

const TS_ISO = makeIsoTimestamp(new Date("2026-11-20T00:00:00.000Z"));

function makeSnapshot(options: {
  readonly catalog?: readonly CatalogEntry[];
  readonly installed?: readonly InstalledPlugin[];
  readonly marketplaces?: readonly MarketplaceRecord[];
  readonly diagnostics?: readonly Diagnostic[];
} = {}): WorkspaceSnapshot {
  const homeDir = makeAbsolutePath("/home/tester");
  const configDir = makeAbsolutePath("/home/tester/.gemini/config");
  const workspaceDir = makeAbsolutePath("/workspace/proj");
  const userPluginsDir = makeAbsolutePath("/home/tester/.gemini/config/plugins");
  const projectPluginsDir = makeAbsolutePath("/workspace/proj/.agents/plugins");
  const managerDir = makeAbsolutePath("/home/tester/.gemini/config/plugin-manager");

  const catalog = options.catalog ?? [];
  const installed = options.installed ?? [];
  const marketplaces = options.marketplaces ?? [];
  const diagnostics = options.diagnostics ?? [];

  const catalogById = new Map(catalog.map((e) => [e.id, e]));
  const installedById = new Map(installed.map((p) => [p.id, p]));
  const marketplacesById = new Map(marketplaces.map((m) => [m.id, m]));
  const diagnosticsById = new Map(diagnostics.map((d) => [d.id, d]));
  const installedIdsByPluginName = new Map<InstalledPlugin["kind"] extends never ? never : ReturnType<typeof makePluginName>, readonly ReturnType<typeof makeInstalledPluginId>[]>();

  for (const p of installed) {
    if (p.kind === "valid") {
      const existing = installedIdsByPluginName.get(p.manifest.name) ?? [];
      installedIdsByPluginName.set(p.manifest.name, [...existing, p.id]);
    }
  }

  return {
    revision: makeSnapshotRevision(1),
    projectedAt: TS_ISO,
    paths: {
      homeDir,
      configDir,
      workspaceDir,
      userPluginsDir,
      projectPluginsDir,
      managerDir,
    },
    catalog,
    installed,
    marketplaces,
    diagnostics,
    staleStagingPaths: [],
    stats: {
      discoverableCount: catalog.length,
      installedCount: installed.length,
      activeCount: installed.filter((p) => p.kind === "valid" && p.activation.kind === "active").length,
      disabledCount: installed.filter((p) => p.kind === "valid" && p.activation.kind === "disabled").length,
      shadowedCount: installed.filter((p) => p.kind === "valid" && p.activation.kind === "shadowed").length,
      brokenCount: installed.filter((p) => p.kind === "broken").length,
      errorCount: diagnostics.filter((d) => d.severity === "error").length,
      warningCount: diagnostics.filter((d) => d.severity === "warning").length,
      activeComponents: EMPTY_COMPONENT_COUNTS,
      installedComponents: EMPTY_COMPONENT_COUNTS,
      estimatedDescriptionTokens: 1200,
      totalDiskBytes: 8192,
      byScope: {
        user: {
          scope: "user",
          pluginsRoot: userPluginsDir,
          installedCount: installed.filter((p) => p.scope === "user").length,
          activeCount: 1,
          disabledCount: 0,
          brokenCount: 0,
          diskBytes: 8192,
          componentTotals: EMPTY_COMPONENT_COUNTS,
        },
        project: {
          scope: "project",
          pluginsRoot: projectPluginsDir,
          installedCount: 0,
          activeCount: 0,
          disabledCount: 0,
          brokenCount: 0,
          diskBytes: 0,
          componentTotals: EMPTY_COMPONENT_COUNTS,
        },
      },
      byMarketplace: [],
      topTokenConsumers: [],
    },
    catalogById,
    installedById,
    marketplacesById,
    diagnosticsById,
    installedIdsByPluginName,
  };
}

function createCliHarness(options: {
  readonly snapshot?: WorkspaceSnapshot;
  readonly isTTY?: boolean;
  readonly installResult?: EngineResult<InstallReport>;
  readonly updateResult?: EngineResult<UpdateReport>;
  readonly syncResult?: EngineResult<BulkSyncReport>;
  readonly validateReport?: ValidationReport;
} = {}) {
  const mktId = makeMarketplaceId("cursor-plugins");
  const slug = makePluginDirName("pstack");
  const defaultSnapshot =
    options.snapshot ??
    makeSnapshot({
      catalog: [
        {
          id: makeCatalogEntryId(mktId, slug),
          marketplaceId: mktId,
          slug,
          name: makePluginName("pstack"),
          displayName: "pstack",
          description: "Workflows",
          version: "0.15.46",
          author: "Lauren",
          category: "agents",
          tags: ["poteto"],
          homepage: null,
          repository: null,
          sourceFormat: "cursor",
          installSource: {
            kind: "marketplace-subdir",
            marketplaceId: mktId,
            subdir: makeRelativeSubpath("pstack"),
          },
          componentCounts: { skills: 58, agents: 2, rules: 0, hooks: 0, mcpServers: 0 },
          componentsPreview: null,
        },
      ],
      installed: [
        {
          kind: "valid",
          id: makeInstalledPluginId("user", slug),
          scope: "user",
          dirName: slug,
          installPath: makeAbsolutePath("/home/tester/.gemini/config/plugins/pstack"),
          manifest: { name: makePluginName("pstack"), version: "0.15.46" },
          activation: { kind: "active" },
          provenance: {
            kind: "marketplace",
            marketplaceId: mktId,
            entryId: makeCatalogEntryId(mktId, slug),
            installSource: {
              kind: "marketplace-subdir",
              marketplaceId: mktId,
              subdir: makeRelativeSubpath("pstack"),
            },
            installedVersion: "0.15.46",
            installedSha: null,
            installedAt: TS_ISO,
          },
          components: EMPTY_COMPONENT_INVENTORY,
          diskBytes: 8192,
          estimatedDescriptionTokens: 1200,
          updateAvailable: null,
          diagnosticIds: [],
        },
      ],
      marketplaces: [
        {
          id: mktId,
          source: { kind: "github", owner: "cursor", repo: "plugins" },
          addedAt: TS_ISO,
          sync: {
            kind: "synced",
            syncedAt: TS_ISO,
            resolvedRef: "main",
            resolvedSha: "deadbeef",
            format: "cursor",
            pluginCount: 1,
          },
          localMirrorPath: null,
        },
      ],
      diagnostics: [
        {
          id: makeDiagnosticId("warn", "frontmatter"),
          severity: "warning",
          subject: { kind: "installed", pluginId: makeInstalledPluginId("user", slug) },
          detail: {
            kind: "skill-frontmatter-missing",
            skillFilePath: makeAbsolutePath("/home/tester/.gemini/config/plugins/pstack/skills/x/SKILL.md"),
            folderName: "x",
            missingFields: ["description"],
          },
          message: "Skill frontmatter missing description",
          hint: "Add description field",
        },
      ],
    });

  let stdout = "";
  let stderr = "";
  let capturedConfig: PluginEngineConfig | null = null;
  const calls: { readonly method: string; readonly arg: unknown }[] = [];

  const engine: PluginEngine = {
    snapshot: async () => {
      calls.push({ method: "snapshot", arg: null });
      return defaultSnapshot;
    },
    install: async (input: InstallPluginInput) => {
      calls.push({ method: "install", arg: input });
      return (
        options.installResult ?? {
          ok: true,
          report: {
            pluginId: makeInstalledPluginId(input.scope, slug),
            pluginName: makePluginName("pstack"),
            scope: input.scope,
            installPath: makeAbsolutePath("/home/tester/.gemini/config/plugins/pstack"),
            outcome: "installed",
            adaptedHooks: false,
            adaptedMcp: false,
            warnings: [],
          },
          snapshot: defaultSnapshot,
        }
      );
    },
    uninstall: async (input: UninstallPluginInput): Promise<EngineResult<UninstallReport>> => {
      calls.push({ method: "uninstall", arg: input });
      return {
        ok: true,
        report: {
          pluginId: makeInstalledPluginId("user", slug),
          removedPath: makeAbsolutePath("/home/tester/.gemini/config/plugins/pstack"),
          outcome: "removed",
        },
        snapshot: defaultSnapshot,
      };
    },
    setEnabled: async (input: SetPluginEnabledInput): Promise<EngineResult<ToggleReport>> => {
      calls.push({ method: "setEnabled", arg: input });
      return {
        ok: true,
        report: {
          pluginId: makeInstalledPluginId("user", slug),
          enabled: input.enabled,
          outcome: "changed",
        },
        snapshot: defaultSnapshot,
      };
    },
    update: async (input: UpdatePluginsInput): Promise<EngineResult<UpdateReport>> => {
      calls.push({ method: "update", arg: input });
      return (
        options.updateResult ?? {
          ok: true,
          report: {
            outcomes: [
              {
                pluginId: makeInstalledPluginId("user", slug),
                status: "updated",
                fromVersion: "0.15.45",
                toVersion: "0.15.46",
              },
            ],
          },
          snapshot: defaultSnapshot,
        }
      );
    },
    addMarketplace: async (
      input: AddMarketplaceInput,
    ): Promise<EngineResult<MarketplaceSyncReport>> => {
      calls.push({ method: "addMarketplace", arg: input });
      return {
        ok: true,
        report: {
          outcome: {
            marketplaceId: input.id ?? mktId,
            status: "synced",
            pluginCount: 129,
            format: "cursor",
          },
        },
        snapshot: defaultSnapshot,
      };
    },
    syncMarketplaces: async (
      input: SyncMarketplacesInput,
    ): Promise<EngineResult<BulkSyncReport>> => {
      calls.push({ method: "syncMarketplaces", arg: input });
      return (
        options.syncResult ?? {
          ok: true,
          report: {
            outcomes: [
              {
                marketplaceId: mktId,
                status: "synced",
                pluginCount: 129,
                format: "cursor",
              },
            ],
          },
          snapshot: defaultSnapshot,
        }
      );
    },
    removeMarketplace: async (
      input: RemoveMarketplaceInput,
    ): Promise<EngineResult<RemoveMarketplaceReport>> => {
      calls.push({ method: "removeMarketplace", arg: input });
      return {
        ok: true,
        report: { id: input.id, removedMirror: true },
        snapshot: defaultSnapshot,
      };
    },
    validate: async (input: ValidateTargetInput): Promise<ValidationReport> => {
      calls.push({ method: "validate", arg: input });
      return (
        options.validateReport ?? {
          valid: true,
          targetLabel: "workspace",
          manifest: null,
          components: EMPTY_COMPONENT_INVENTORY,
          diagnostics: [],
        }
      );
    },
    remediate: async (input: RemediateInput): Promise<EngineResult<RemediateReport>> => {
      calls.push({ method: "remediate", arg: input });
      return {
        ok: true,
        report: { kind: "cleaned-stale-staging", removedPaths: [] },
        snapshot: defaultSnapshot,
      };
    },
  };

  const io: CliIo = {
    cwd: "/workspace/proj",
    homeDir: "/home/tester",
    env: {},
    isTTY: options.isTTY ?? false,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };

  const exec = (argv: readonly string[], runTuiFn?: Parameters<typeof runCli>[3]) =>
    runCli(
      argv,
      io,
      (cfg) => {
        capturedConfig = cfg;
        return engine;
      },
      runTuiFn,
    );

  return {
    exec,
    getStdout: () => stdout,
    getStderr: () => stderr,
    getConfig: () => capturedConfig,
    calls,
  };
}

describe("CLI subcommands, global flags, JSON envelopes, and exit codes", () => {
  it("handles --help, --version, and TUI launch / non-TTY error", async () => {
    const h1 = createCliHarness();
    assert.equal(await h1.exec(["--help"]), 0);
    assert.match(h1.getStdout(), /Usage:/);

    const h2 = createCliHarness();
    assert.equal(await h2.exec(["--version", "--json"]), 0);
    const verJson = JSON.parse(h2.getStdout());
    assert.equal(verJson.ok, true);
    assert.equal(typeof verJson.data.version, "string");

    const hNoTty = createCliHarness({ isTTY: false });
    assert.equal(await hNoTty.exec([]), 1);
    assert.match(hNoTty.getStderr(), /requires a TTY/i);

    let tuiLaunched = false;
    const hTty = createCliHarness({ isTTY: true });
    assert.equal(
      await hTty.exec(["tui"], async () => {
        tuiLaunched = true;
        return 0;
      }),
      1,
    );
    assert.equal(tuiLaunched, false);

    const fakeTerm = {
      isTTY: true,
      colorEnabled: false,
      getViewport: () => ({ cols: 80, rows: 24 }),
      enterRawAltScreen: () => {},
      leaveRawAltScreen: () => {},
      write: () => {},
      onData: () => () => {},
      onResize: () => () => {},
      onSignal: () => () => {},
    };
    const codeWithTerm = await runCli(
      [],
      {
        cwd: "/workspace/proj",
        homeDir: "/home/tester",
        env: {},
        isTTY: true,
        stdout: () => {},
        stderr: () => {},
        terminal: fakeTerm,
      },
      () => ({
        snapshot: async () => makeSnapshot(),
        install: async () => { throw new Error("unused"); },
        uninstall: async () => { throw new Error("unused"); },
        setEnabled: async () => { throw new Error("unused"); },
        update: async () => { throw new Error("unused"); },
        addMarketplace: async () => { throw new Error("unused"); },
        syncMarketplaces: async () => { throw new Error("unused"); },
        removeMarketplace: async () => { throw new Error("unused"); },
        validate: async () => { throw new Error("unused"); },
        remediate: async () => { throw new Error("unused"); },
      }),
      async () => {
        tuiLaunched = true;
        return 0;
      },
    );
    assert.equal(codeWithTerm, 0);
    assert.equal(tuiLaunched, true);
  });

  it("supports global --config-dir and --workspace before or after subcommands", async () => {
    const h = createCliHarness();
    const code = await h.exec([
      "list",
      "--scope",
      "user",
      "--config-dir",
      "/custom/cfg",
      "--workspace=/custom/ws",
      "--json",
    ]);
    assert.equal(code, 0);
    assert.equal(h.getConfig()?.configDir, "/custom/cfg");
    assert.equal(h.getConfig()?.workspaceDir, "/custom/ws");
    assert.equal(stripAnsi(h.getStdout()), h.getStdout());
    const parsed = JSON.parse(h.getStdout());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.total, 1);
  });

  it("dispatches discover, install, uninstall, enable, disable, list, update, errors, stats", async () => {
    const hDisc = createCliHarness();
    assert.equal(
      await hDisc.exec(["discover", "pstack", "--marketplace", "cursor-plugins", "--json"]),
      0,
    );
    assert.equal(JSON.parse(hDisc.getStdout()).data.total, 1);

    const hInst = createCliHarness();
    assert.equal(
      await hInst.exec(["install", "cursor-plugins/pstack", "--scope", "project", "--force", "--json"]),
      0,
    );
    assert.equal(hInst.calls[0]?.method, "install");

    const hUninst = createCliHarness();
    assert.equal(await hUninst.exec(["uninstall", "user:pstack"]), 0);
    assert.equal(hUninst.calls[0]?.method, "uninstall");

    const hEn = createCliHarness();
    assert.equal(await hEn.exec(["enable", "pstack", "--scope", "user"]), 0);
    assert.equal(hEn.calls[0]?.method, "setEnabled");

    const hDis = createCliHarness();
    assert.equal(await hDis.exec(["disable", "user:pstack"]), 0);
    assert.equal(hDis.calls[0]?.method, "setEnabled");

    const hUpd = createCliHarness();
    assert.equal(await hUpd.exec(["update", "--all", "--scope", "user", "--json"]), 0);
    assert.equal(hUpd.calls[0]?.method, "update");

    const hErr = createCliHarness();
    assert.equal(await hErr.exec(["errors", "--severity", "warning", "--json"]), 0);
    assert.equal(JSON.parse(hErr.getStdout()).data.total, 1);

    const hStats = createCliHarness();
    assert.equal(await hStats.exec(["stats", "--json"]), 0);
    assert.equal(JSON.parse(hStats.getStdout()).data.estimatedDescriptionTokens, 1200);
  });

  it("dispatches marketplace add, list, update, and remove", async () => {
    const hAdd = createCliHarness();
    assert.equal(
      await hAdd.exec(["marketplace", "add", "cursor/plugins", "--id", "my-mkt", "--json"]),
      0,
    );
    assert.equal(hAdd.calls[0]?.method, "addMarketplace");

    const hList = createCliHarness();
    assert.equal(await hList.exec(["marketplace", "list", "--json"]), 0);
    assert.equal(JSON.parse(hList.getStdout()).data.total, 1);

    const hSync = createCliHarness();
    assert.equal(await hSync.exec(["marketplace", "update", "cursor-plugins"]), 0);
    assert.equal(hSync.calls[0]?.method, "syncMarketplaces");

    const hRem = createCliHarness();
    assert.equal(await hRem.exec(["marketplace", "remove", "cursor-plugins"]), 0);
    assert.equal(hRem.calls[0]?.method, "removeMarketplace");
  });

  it("enforces validate --strict and returns exit codes 0, 1, and 2 accurately", async () => {
    const warningDiag: Diagnostic = {
      id: makeDiagnosticId("w", "1"),
      severity: "warning",
      subject: { kind: "path", path: makeAbsolutePath("/workspace/proj") },
      detail: {
        kind: "skill-frontmatter-missing",
        skillFilePath: makeAbsolutePath("/workspace/proj/skills/a/SKILL.md"),
        folderName: "a",
        missingFields: ["name"],
      },
      message: "Missing name",
      hint: "Add name",
    };

    const hValOk = createCliHarness({
      validateReport: {
        valid: true,
        targetLabel: "./bundle",
        manifest: null,
        components: EMPTY_COMPONENT_INVENTORY,
        diagnostics: [warningDiag],
      },
    });
    assert.equal(await hValOk.exec(["validate", "./bundle"]), 0);
    const hValStrict = createCliHarness({
      validateReport: {
        valid: true,
        targetLabel: "./bundle",
        manifest: null,
        components: EMPTY_COMPONENT_INVENTORY,
        diagnostics: [warningDiag],
      },
    });
    assert.equal(await hValStrict.exec(["validate", "./bundle", "--strict", "--json"]), 1);
    assert.equal(JSON.parse(hValStrict.getStdout()).ok, false);

    const hCollision = createCliHarness({
      installResult: {
        ok: false,
        error: {
          kind: "name-collision",
          pluginName: makePluginName("pstack"),
          existingId: makeInstalledPluginId("project", makePluginDirName("pstack")),
          targetScope: "user",
        },
        snapshot: makeSnapshot(),
      },
    });
    assert.equal(await hCollision.exec(["install", "pstack", "--json"]), 1);
    assert.equal(JSON.parse(hCollision.getStdout()).ok, false);

    const hUpdateFail = createCliHarness({
      updateResult: {
        ok: true,
        report: {
          outcomes: [
            {
              pluginId: makeInstalledPluginId("user", makePluginDirName("pstack")),
              status: "failed",
              fromVersion: "0.1.0",
              toVersion: null,
              reason: "network timeout",
            },
          ],
        },
        snapshot: makeSnapshot(),
      },
    });
    assert.equal(await hUpdateFail.exec(["update", "--all", "--json"]), 1);
    assert.equal(JSON.parse(hUpdateFail.getStdout()).ok, false);

    const hSyncFail = createCliHarness({
      syncResult: {
        ok: true,
        report: {
          outcomes: [
            {
              marketplaceId: makeMarketplaceId("cursor-plugins"),
              status: "failed",
              pluginCount: 0,
              format: null,
              reason: "auth denied",
            },
          ],
        },
        snapshot: makeSnapshot(),
      },
    });
    assert.equal(await hSyncFail.exec(["marketplace", "update", "--all", "--json"]), 1);
    assert.equal(JSON.parse(hSyncFail.getStdout()).ok, false);

    const hHuman = createCliHarness();
    assert.equal(await hHuman.exec(["discover"]), 0);
    assert.equal(await hHuman.exec(["list"]), 0);
    assert.equal(await hHuman.exec(["errors"]), 0);
    assert.equal(await hHuman.exec(["stats"]), 0);
    assert.equal(await hHuman.exec(["validate", "user:pstack"]), 0);
    assert.equal(await hHuman.exec(["validate", "https://github.com/cursor/plugins"]), 0);
    assert.match(hHuman.getStdout(), /Workspace Plugin Stats/);

    const badCalls: readonly (readonly string[])[] = [
      ["unknown-command"],
      ["discover", "--installed", "--available"],
      ["install"],
      ["list", "--state", "bogus"],
      ["update", "pstack", "--all"],
      ["uninstall", "user:pstack", "--scope", "project"],
      ["marketplace", "unknown"],
      ["--json", "unknown"],
      ["--json", "list", "--config-dir"],
      ["--config-dir", "--json"],
    ];
    for (const args of badCalls) {
      const hBad = createCliHarness();
      assert.equal(await hBad.exec(args), 2, `expected exit 2 for: ${args.join(" ")}`);
      if (args.includes("--json")) {
        const envelope = JSON.parse(hBad.getStdout());
        assert.equal(envelope.ok, false);
        assert.equal(hBad.getStderr(), "");
      }
    }

    const hDashList = createCliHarness();
    assert.equal(await hDashList.exec(["--", "list"]), 0);
    assert.match(hDashList.getStdout(), /user:pstack/);

    const hJsonDashList = createCliHarness();
    assert.equal(await hJsonDashList.exec(["--json", "--", "list"]), 0);
    assert.equal(JSON.parse(hJsonDashList.getStdout()).data.total, 1);

    const hDashMkt = createCliHarness();
    assert.equal(await hDashMkt.exec(["--json", "marketplace", "--", "list"]), 0);
    assert.equal(JSON.parse(hDashMkt.getStdout()).data.total, 1);

    const hDashMktRoot = createCliHarness();
    assert.equal(await hDashMktRoot.exec(["--", "marketplace", "list"]), 0);
    assert.match(hDashMktRoot.getStdout(), /cursor-plugins/);

    const hJsonAfterDash = createCliHarness();
    assert.equal(await hJsonAfterDash.exec(["--", "--json"]), 2);
    assert.equal(hJsonAfterDash.getStdout(), "");
    assert.match(hJsonAfterDash.getStderr(), /Unknown flag/);
  });
});
