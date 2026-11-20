import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
  makeRequestId,
  makeSnapshotRevision,
  nextSnapshotRevision,
} from "../src/domain/types.ts";
import type {
  AbsolutePath,
  CatalogEntry,
  CatalogEntryId,
  Diagnostic,
  DiagnosticId,
  EngineResult,
  InstalledPlugin,
  InstalledPluginId,
  MarketplaceId,
  MarketplaceRecord,
  PluginName,
  WorkspaceSnapshot,
} from "../src/domain/types.ts";
import type {
  AddMarketplaceInput,
  BulkSyncReport,
  InstallPluginInput,
  InstallReport,
  MarketplaceSyncReport,
  PluginEngine,
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
import {
  SYNC_END,
  SYNC_START,
  TAB_IDS,
  TAB_REGISTRY,
  clampViewport,
  createInitialTuiState,
  createKeyDecoder,
  diffFrames,
  displayWidth,
  padVisible,
  parseKeyBytes,
  reduce,
  renderFrame,
  resolveActiveSelectedIndex,
  runTui,
  stripAnsi,
  truncateVisible,
} from "../src/tui/index.ts";
import type {
  KeyEvent,
  TerminalPort,
  TuiState,
  Viewport,
} from "../src/tui/index.ts";

const HOME_DIR = makeAbsolutePath("/home/tester");
const CONFIG_DIR = makeAbsolutePath("/home/tester/.gemini/config");
const WORKSPACE_DIR = makeAbsolutePath("/workspace/app");
const USER_PLUGINS_DIR = makeAbsolutePath("/home/tester/.gemini/config/plugins");
const PROJECT_PLUGINS_DIR = makeAbsolutePath("/workspace/app/.agents/plugins");
const MANAGER_DIR = makeAbsolutePath("/home/tester/.gemini/config/plugin-manager");
const TS_ISO = makeIsoTimestamp(new Date("2026-11-20T00:00:00.000Z"));

function makeCatalogItem(
  mkt: string,
  slug: string,
  overrides: {
    readonly name?: string;
    readonly displayName?: string;
    readonly description?: string;
    readonly version?: string | null;
    readonly category?: string | null;
    readonly tags?: readonly string[];
  } = {},
): CatalogEntry {
  const marketplaceId = makeMarketplaceId(mkt);
  const dirSlug = makePluginDirName(slug);
  const name = makePluginName(overrides.name ?? slug);
  return {
    id: makeCatalogEntryId(marketplaceId, dirSlug),
    marketplaceId,
    slug: dirSlug,
    name,
    displayName: overrides.displayName ?? name,
    description: overrides.description ?? `Description for ${name}`,
    version: overrides.version !== undefined ? overrides.version : "1.0.0",
    author: "Test Author",
    category: overrides.category ?? "productivity",
    tags: overrides.tags ?? ["workflow"],
    homepage: null,
    repository: null,
    sourceFormat: "cursor",
    installSource: {
      kind: "marketplace-subdir",
      marketplaceId,
      subdir: makeRelativeSubpath(slug),
    },
    componentCounts: { skills: 3, agents: 1, rules: 0, hooks: 0, mcpServers: 0 },
    componentsPreview: {
      counts: { skills: 3, agents: 1, rules: 0, hooks: 0, mcpServers: 0 },
      skills: [
        {
          name: "alpha-skill",
          folderName: "alpha-skill",
          description: "Alpha workflow",
          frontmatterNamePresent: true,
          estimatedTokens: 120,
        },
      ],
      agents: [{ name: "helper-agent", fileName: "helper-agent.md", description: "Helper" }],
      rules: [],
      hooks: [],
      mcpServers: [],
    },
  };
}

function makeInstalledItem(
  scope: "user" | "project",
  dirName: string,
  options: {
    readonly pluginName?: string;
    readonly disabled?: boolean;
    readonly shadowedBy?: InstalledPluginId;
    readonly tokens?: number;
    readonly diskBytes?: number;
    readonly marketplaceId?: string;
  } = {},
): InstalledPlugin {
  const dir = makePluginDirName(dirName);
  const id = makeInstalledPluginId(scope, dir);
  const name = makePluginName(options.pluginName ?? dirName);
  const rootDir = scope === "user" ? USER_PLUGINS_DIR : PROJECT_PLUGINS_DIR;
  const mktId = makeMarketplaceId(options.marketplaceId ?? "cursor-plugins");

  return {
    kind: "valid",
    id,
    scope,
    dirName: dir,
    installPath: makeAbsolutePath(`${rootDir}/${dir}`),
    manifest: {
      name,
      displayName: name,
      description: `Installed ${name}`,
      version: "1.2.0",
      disabled: options.disabled,
    },
    activation: options.disabled
      ? { kind: "disabled" }
      : options.shadowedBy !== undefined
        ? { kind: "shadowed", shadowedBy: options.shadowedBy }
        : { kind: "active" },
    provenance: {
      kind: "marketplace",
      marketplaceId: mktId,
      entryId: makeCatalogEntryId(mktId, dir),
      installSource: {
        kind: "marketplace-subdir",
        marketplaceId: mktId,
        subdir: makeRelativeSubpath(dirName),
      },
      installedVersion: "1.2.0",
      installedSha: null,
      installedAt: TS_ISO,
    },
    components: {
      counts: { skills: 2, agents: 1, rules: 0, hooks: 1, mcpServers: 0 },
      skills: [],
      agents: [],
      rules: [],
      hooks: [],
      mcpServers: [],
    },
    diskBytes: options.diskBytes ?? 4096,
    estimatedDescriptionTokens: options.tokens ?? 350,
    updateAvailable: null,
    diagnosticIds: [],
  };
}

function buildTestSnapshot(options: {
  readonly revision?: number;
  readonly catalog?: readonly CatalogEntry[];
  readonly installed?: readonly InstalledPlugin[];
  readonly marketplaces?: readonly MarketplaceRecord[];
  readonly diagnostics?: readonly Diagnostic[];
} = {}): WorkspaceSnapshot {
  const catalog = options.catalog ?? [];
  const installed = options.installed ?? [];
  const marketplaces = options.marketplaces ?? [];
  const diagnostics = options.diagnostics ?? [];

  const catalogById = new Map<CatalogEntryId, CatalogEntry>();
  for (const entry of catalog) catalogById.set(entry.id, entry);

  const installedById = new Map<InstalledPluginId, InstalledPlugin>();
  const installedIdsByPluginName = new Map<PluginName, InstalledPluginId[]>();
  let activeCount = 0;
  let disabledCount = 0;
  let shadowedCount = 0;
  let brokenCount = 0;
  let totalTokens = 0;
  let totalDisk = 0;

  for (const plugin of installed) {
    installedById.set(plugin.id, plugin);
    totalDisk += plugin.diskBytes;
    if (plugin.kind === "broken") {
      brokenCount += 1;
    } else {
      totalTokens += plugin.estimatedDescriptionTokens;
      const list = installedIdsByPluginName.get(plugin.manifest.name) ?? [];
      list.push(plugin.id);
      installedIdsByPluginName.set(plugin.manifest.name, list);
      if (plugin.activation.kind === "active") activeCount += 1;
      else if (plugin.activation.kind === "disabled") disabledCount += 1;
      else shadowedCount += 1;
    }
  }

  const marketplacesById = new Map<MarketplaceId, MarketplaceRecord>();
  for (const mkt of marketplaces) marketplacesById.set(mkt.id, mkt);

  const diagnosticsById = new Map<DiagnosticId, Diagnostic>();
  let errorCount = 0;
  let warningCount = 0;
  for (const diag of diagnostics) {
    diagnosticsById.set(diag.id, diag);
    if (diag.severity === "error") errorCount += 1;
    else warningCount += 1;
  }

  return {
    revision: makeSnapshotRevision(options.revision ?? 1),
    projectedAt: TS_ISO,
    paths: {
      homeDir: HOME_DIR,
      configDir: CONFIG_DIR,
      workspaceDir: WORKSPACE_DIR,
      userPluginsDir: USER_PLUGINS_DIR,
      projectPluginsDir: PROJECT_PLUGINS_DIR,
      managerDir: MANAGER_DIR,
    },
    catalog,
    installed,
    marketplaces,
    diagnostics,
    staleStagingPaths: [],
    stats: {
      discoverableCount: catalog.length,
      installedCount: installed.length,
      activeCount,
      disabledCount,
      shadowedCount,
      brokenCount,
      errorCount,
      warningCount,
      activeComponents: EMPTY_COMPONENT_COUNTS,
      installedComponents: EMPTY_COMPONENT_COUNTS,
      estimatedDescriptionTokens: totalTokens,
      totalDiskBytes: totalDisk,
      byScope: {
        user: {
          scope: "user",
          pluginsRoot: USER_PLUGINS_DIR,
          installedCount: installed.filter((p) => p.scope === "user").length,
          activeCount: installed.filter(
            (p) => p.scope === "user" && p.kind === "valid" && p.activation.kind === "active",
          ).length,
          disabledCount: installed.filter(
            (p) => p.scope === "user" && p.kind === "valid" && p.activation.kind === "disabled",
          ).length,
          brokenCount: installed.filter((p) => p.scope === "user" && p.kind === "broken").length,
          diskBytes: installed.filter((p) => p.scope === "user").reduce((s, p) => s + p.diskBytes, 0),
          componentTotals: EMPTY_COMPONENT_COUNTS,
        },
        project: {
          scope: "project",
          pluginsRoot: PROJECT_PLUGINS_DIR,
          installedCount: installed.filter((p) => p.scope === "project").length,
          activeCount: installed.filter(
            (p) => p.scope === "project" && p.kind === "valid" && p.activation.kind === "active",
          ).length,
          disabledCount: installed.filter(
            (p) => p.scope === "project" && p.kind === "valid" && p.activation.kind === "disabled",
          ).length,
          brokenCount: installed.filter((p) => p.scope === "project" && p.kind === "broken").length,
          diskBytes: installed
            .filter((p) => p.scope === "project")
            .reduce((s, p) => s + p.diskBytes, 0),
          componentTotals: EMPTY_COMPONENT_COUNTS,
        },
      },
      byMarketplace: marketplaces.map((m) => ({
        marketplaceId: m.id,
        catalogCount: catalog.filter((c) => c.marketplaceId === m.id).length,
        installedFromCount: installed.filter(
          (p) => p.provenance.kind === "marketplace" && p.provenance.marketplaceId === m.id,
        ).length,
        syncStatus: m.sync.kind,
      })),
      topTokenConsumers: [],
    },
    catalogById,
    installedById,
    marketplacesById,
    diagnosticsById,
    installedIdsByPluginName,
  };
}

function sendKeys(
  initial: TuiState,
  keys: readonly KeyEvent[],
  env = { cwd: WORKSPACE_DIR, homeDir: HOME_DIR },
) {
  let state = initial;
  const allEffects: ReturnType<typeof reduce>[1][number][] = [];
  for (const key of keys) {
    const [nextState, effects] = reduce(state, { kind: "key", key }, env);
    state = nextState;
    allEffects.push(...effects);
  }
  return { state, effects: allEffects };
}

function typeChars(text: string): readonly KeyEvent[] {
  return Array.from(text).map((ch) => ({ kind: "char" as const, ch }));
}

function createFakeTerminal(viewport: Viewport = { cols: 120, rows: 36 }): {
  readonly port: TerminalPort;
  readonly writes: string[];
  readonly pushBytes: (bytes: Uint8Array) => void;
  readonly resize: (v: Viewport) => void;
  readonly getEnteredCount: () => number;
  readonly getLeftCount: () => number;
} {
  let currentViewport = viewport;
  let entered = 0;
  let left = 0;
  const writes: string[] = [];
  const dataListeners = new Set<(chunk: Uint8Array) => void>();
  const resizeListeners = new Set<(v: Viewport) => void>();

  const port: TerminalPort = {
    isTTY: true,
    colorEnabled: false,
    getViewport: () => currentViewport,
    enterRawAltScreen: () => {
      entered += 1;
    },
    leaveRawAltScreen: () => {
      left += 1;
    },
    write: (text: string) => {
      writes.push(text);
    },
    onData: (listener) => {
      dataListeners.add(listener);
      return () => dataListeners.delete(listener);
    },
    onResize: (listener) => {
      resizeListeners.add(listener);
      return () => resizeListeners.delete(listener);
    },
    onSignal: () => () => {},
  };

  return {
    port,
    writes,
    pushBytes: (bytes) => {
      for (const listener of dataListeners) listener(bytes);
    },
    resize: (v) => {
      currentViewport = v;
      for (const listener of resizeListeners) listener(v);
    },
    getEnteredCount: () => entered,
    getLeftCount: () => left,
  };
}

function createStubEngine(initialSnapshot: WorkspaceSnapshot): {
  readonly engine: PluginEngine;
  readonly calls: { readonly kind: string; readonly arg: unknown }[];
} {
  let current = initialSnapshot;
  const calls: { readonly kind: string; readonly arg: unknown }[] = [];

  const bump = (): WorkspaceSnapshot => {
    current = { ...current, revision: nextSnapshotRevision(current.revision) };
    return current;
  };

  const engine: PluginEngine = {
    snapshot: async () => current,
    install: async (input: InstallPluginInput): Promise<EngineResult<InstallReport>> => {
      calls.push({ kind: "install", arg: input });
      return {
        ok: true,
        report: {
          pluginId: makeInstalledPluginId(input.scope, makePluginDirName("pstack")),
          pluginName: makePluginName("pstack"),
          scope: input.scope,
          installPath: makeAbsolutePath(`${USER_PLUGINS_DIR}/pstack`),
          outcome: "installed",
          adaptedHooks: false,
          adaptedMcp: false,
          warnings: [],
        },
        snapshot: bump(),
      };
    },
    uninstall: async (input: UninstallPluginInput): Promise<EngineResult<UninstallReport>> => {
      calls.push({ kind: "uninstall", arg: input });
      return {
        ok: true,
        report: {
          pluginId: makeInstalledPluginId("user", makePluginDirName("pstack")),
          removedPath: makeAbsolutePath(`${USER_PLUGINS_DIR}/pstack`),
          outcome: "removed",
        },
        snapshot: bump(),
      };
    },
    setEnabled: async (input: SetPluginEnabledInput): Promise<EngineResult<ToggleReport>> => {
      calls.push({ kind: "setEnabled", arg: input });
      return {
        ok: true,
        report: {
          pluginId: makeInstalledPluginId("user", makePluginDirName("pstack")),
          enabled: input.enabled,
          outcome: "changed",
        },
        snapshot: bump(),
      };
    },
    update: async (input: UpdatePluginsInput): Promise<EngineResult<UpdateReport>> => {
      calls.push({ kind: "update", arg: input });
      return { ok: true, report: { outcomes: [] }, snapshot: bump() };
    },
    addMarketplace: async (
      input: AddMarketplaceInput,
    ): Promise<EngineResult<MarketplaceSyncReport>> => {
      calls.push({ kind: "addMarketplace", arg: input });
      return {
        ok: true,
        report: {
          outcome: {
            marketplaceId: input.id ?? makeMarketplaceId("cursor-plugins"),
            status: "synced",
            pluginCount: 5,
            format: "cursor",
          },
        },
        snapshot: bump(),
      };
    },
    syncMarketplaces: async (
      input: SyncMarketplacesInput,
    ): Promise<EngineResult<BulkSyncReport>> => {
      calls.push({ kind: "syncMarketplaces", arg: input });
      return { ok: true, report: { outcomes: [] }, snapshot: bump() };
    },
    removeMarketplace: async (
      input: RemoveMarketplaceInput,
    ): Promise<EngineResult<RemoveMarketplaceReport>> => {
      calls.push({ kind: "removeMarketplace", arg: input });
      return {
        ok: true,
        report: { id: input.id, removedMirror: true },
        snapshot: bump(),
      };
    },
    validate: async (_input: ValidateTargetInput): Promise<ValidationReport> => ({
      valid: true,
      targetLabel: "workspace",
      manifest: null,
      components: EMPTY_COMPONENT_INVENTORY,
      diagnostics: [],
    }),
    remediate: async (input: RemediateInput): Promise<EngineResult<RemediateReport>> => {
      calls.push({ kind: "remediate", arg: input });
      return {
        ok: true,
        report: { kind: "cleaned-stale-staging", removedPaths: [] },
        snapshot: bump(),
      };
    },
  };

  return { engine, calls };
}

describe("ANSI key decoder and width utilities", () => {
  it("decodes CSI arrows, SS3 arrows, navigation keys, modifiers, control keys, and UTF-8", () => {
    assert.deepEqual(parseKeyBytes(Buffer.from("\x1b[A\x1b[B\x1b[C\x1b[D")), [
      { kind: "up" },
      { kind: "down" },
      { kind: "right" },
      { kind: "left" },
    ]);
    assert.deepEqual(parseKeyBytes(Buffer.from("\x1bOA\x1bOB\x1bOC\x1bOD")), [
      { kind: "up" },
      { kind: "down" },
      { kind: "right" },
      { kind: "left" },
    ]);
    assert.deepEqual(
      parseKeyBytes(Buffer.from("\x1b[H\x1b[F\x1b[5~\x1b[6~\x1b[3~\x1b[Z")),
      [
        { kind: "home" },
        { kind: "end" },
        { kind: "page-up" },
        { kind: "page-down" },
        { kind: "delete" },
        { kind: "shift-tab" },
      ],
    );
    assert.deepEqual(
      parseKeyBytes(Uint8Array.from([0x1b])),
      [{ kind: "escape" }],
    );
    assert.deepEqual(
      parseKeyBytes(Uint8Array.from([0x7f, 0x0d, 0x0a, 0x09, 0x03, 0x15, 0x17])),
      [
        { kind: "backspace" },
        { kind: "enter" },
        { kind: "tab" },
        { kind: "ctrl-c" },
        { kind: "ctrl-u" },
        { kind: "ctrl-w" },
      ],
    );
    assert.deepEqual(parseKeyBytes(Uint8Array.from([0x0a])), [{ kind: "enter" }]);
    assert.deepEqual(parseKeyBytes(Uint8Array.from([0x08])), [{ kind: "backspace" }]);
    assert.deepEqual(parseKeyBytes(Buffer.from("café🚀", "utf8")), [
      { kind: "char", ch: "c" },
      { kind: "char", ch: "a" },
      { kind: "char", ch: "f" },
      { kind: "char", ch: "é" },
      { kind: "char", ch: "🚀" },
    ]);
  });

  it("buffers split CSI and UTF-8 sequences across chunks in createKeyDecoder", () => {
    const decoder = createKeyDecoder();
    assert.deepEqual(decoder.push(Uint8Array.from([0x1b])), []);
    assert.equal(decoder.hasPendingEscape(), true);
    assert.deepEqual(decoder.push(Buffer.from("[A")), [{ kind: "up" }]);
    assert.equal(decoder.hasPendingEscape(), false);

    const rocket = Buffer.from("🚀", "utf8");
    assert.deepEqual(decoder.push(rocket.subarray(0, 2)), []);
    assert.deepEqual(decoder.push(rocket.subarray(2)), [{ kind: "char", ch: "🚀" }]);

    assert.deepEqual(decoder.push(Uint8Array.from([0x1b])), []);
    assert.deepEqual(decoder.flush(), [{ kind: "escape" }]);
  });

  it("computes ANSI-stripped visual width, truncation, and padding accurately", () => {
    const colored = "\x1b[36mhello\x1b[0m \x1b[32m世界\x1b[0m";
    assert.equal(stripAnsi(colored), "hello 世界");
    assert.equal(displayWidth(colored), 10);
    const truncated8 = truncateVisible(colored, 8);
    assert.ok(displayWidth(truncated8) <= 8);
    assert.equal(stripAnsi(truncated8), "hello …");
    const truncated9 = truncateVisible(colored, 9);
    assert.equal(displayWidth(truncated9), 9);
    assert.equal(stripAnsi(truncated9), "hello 世…");
    const padded = padVisible(colored, 14, "left");
    assert.equal(displayWidth(padded), 14);
  });
});

describe("TUI reducer flows", () => {
  it("switches across all 5 tabs with arrow keys and number keys 1..5", () => {
    const snapshot = buildTestSnapshot();
    let state = createInitialTuiState(snapshot, { colorEnabled: false });
    assert.equal(state.activeTab, "discover");

    state = sendKeys(state, [{ kind: "left" }]).state;
    assert.equal(state.activeTab, "stats");

    state = sendKeys(state, [{ kind: "right" }]).state;
    assert.equal(state.activeTab, "discover");

    for (let i = 0; i < TAB_IDS.length; i += 1) {
      assert.equal(state.activeTab, TAB_IDS[i]);
      state = sendKeys(state, [{ kind: "right" }]).state;
    }
    assert.equal(state.activeTab, "discover");

    state = sendKeys(state, [{ kind: "char", ch: "4" }]).state;
    assert.equal(state.activeTab, "errors");
    state = sendKeys(state, [{ kind: "char", ch: "2" }]).state;
    assert.equal(state.activeTab, "installed");
  });

  it("filters 1,000+ catalog entries live with /, preserves filter on Enter, and resets on Esc", () => {
    const entries: CatalogEntry[] = [];
    for (let i = 0; i < 1200; i += 1) {
      entries.push(
        makeCatalogItem("cursor-plugins", `plugin-${String(i).padStart(4, "0")}`, {
          description: i === 777 ? "Special needle target plugin" : `Standard entry ${i}`,
        }),
      );
    }
    const snapshot = buildTestSnapshot({ catalog: entries });
    const initial = createInitialTuiState(snapshot, { colorEnabled: false });

    const { state: searching } = sendKeys(initial, [
      { kind: "char", ch: "/" },
      ...typeChars("plugin-0777"),
    ]);
    assert.equal(searching.overlay.kind, "search-input");
    assert.equal(searching.searchByTab.discover.value, "plugin-0777");
    const filteredView = TAB_REGISTRY.discover.prepare(searching);
    assert.equal(filteredView.rowCount, 1);
    assert.equal(filteredView.rowKeyAt(0), "cursor-plugins/plugin-0777");

    const { state: tableFocused } = sendKeys(searching, [{ kind: "enter" }]);
    assert.equal(tableFocused.overlay.kind, "none");
    assert.equal(tableFocused.searchByTab.discover.value, "plugin-0777");

    const { state: cleared } = sendKeys(tableFocused, [{ kind: "escape" }]);
    assert.equal(cleared.searchByTab.discover.value, "");
    assert.equal(TAB_REGISTRY.discover.prepare(cleared).rowCount, 1200);
  });

  it("pins selection by domain ID across filtering and snapshot updates and rejects stale revisions", () => {
    const catalog = [
      makeCatalogItem("cursor-plugins", "beta"),
      makeCatalogItem("cursor-plugins", "gamma"),
      makeCatalogItem("cursor-plugins", "zeta"),
    ];
    const snapshot = buildTestSnapshot({ revision: 5, catalog });
    const initial = createInitialTuiState(snapshot, { colorEnabled: false });

    const { state: moved } = sendKeys(initial, [{ kind: "down" }, { kind: "down" }]);
    assert.equal(moved.cursors.discover.selectedId, "cursor-plugins/zeta");

    const updatedSnapshot = buildTestSnapshot({
      revision: 6,
      catalog: [
        makeCatalogItem("cursor-plugins", "alpha"),
        makeCatalogItem("cursor-plugins", "aardvark"),
        ...catalog,
      ],
    });
    const [refreshed] = reduce(
      moved,
      { kind: "rescan-finished", requestId: makeRequestId(1), snapshot: updatedSnapshot },
      { cwd: WORKSPACE_DIR, homeDir: HOME_DIR },
    );
    const prepared = TAB_REGISTRY.discover.prepare(refreshed);
    const resolvedIdx = resolveActiveSelectedIndex(refreshed, prepared);
    assert.equal(prepared.rowKeyAt(resolvedIdx), "cursor-plugins/zeta");
    assert.equal(resolvedIdx, 4);

    const staleSnapshot = buildTestSnapshot({ revision: 3, catalog: [] });
    const [afterStale] = reduce(
      refreshed,
      { kind: "rescan-finished", requestId: makeRequestId(2), snapshot: staleSnapshot },
      { cwd: WORKSPACE_DIR, homeDir: HOME_DIR },
    );
    assert.equal(afterStale.snapshot.revision, 6);
    assert.equal(afterStale.snapshot.catalog.length, 5);
  });

  it("handles discover detail modal scope switching and install/uninstall effects", () => {
    const pstackEntry = makeCatalogItem("cursor-plugins", "pstack");
    const installedUser = makeInstalledItem("user", "pstack");
    const snapshot = buildTestSnapshot({
      catalog: [pstackEntry],
      installed: [installedUser],
    });
    const initial = createInitialTuiState(snapshot, { colorEnabled: false });

    const { state: modal, effects: openEffects } = sendKeys(initial, [{ kind: "enter" }]);
    assert.equal(openEffects.length, 0);
    assert.equal(modal.overlay.kind, "discover-detail");

    const { effects: uninstallEffects } = sendKeys(modal, [{ kind: "enter" }]);
    assert.equal(uninstallEffects.length, 1);
    assert.equal(uninstallEffects[0]?.kind, "run-mutation");
    if (uninstallEffects[0]?.kind === "run-mutation") {
      assert.equal(uninstallEffects[0].mutation.kind, "uninstall");
    }

    const { state: switchedScope, effects: installEffects } = sendKeys(modal, [
      { kind: "char", ch: "s" },
      { kind: "enter" },
    ]);
    assert.equal(switchedScope.overlay.kind, "discover-detail");
    if (switchedScope.overlay.kind === "discover-detail") {
      assert.equal(switchedScope.overlay.targetScope, "project");
    }
    assert.equal(installEffects.length, 1);
    if (installEffects[0]?.kind === "run-mutation") {
      assert.equal(installEffects[0].mutation.kind, "install");
      if (installEffects[0].mutation.kind === "install") {
        assert.equal(installEffects[0].mutation.input.scope, "project");
      }
    }
  });

  it("handles installed toggle, update, and uninstall confirmation", () => {
    const pstack = makeInstalledItem("user", "pstack");
    const snapshot = buildTestSnapshot({ installed: [pstack] });
    const initial = createInitialTuiState(snapshot, {
      initialTab: "installed",
      colorEnabled: false,
    });

    const { effects: toggleEffects } = sendKeys(initial, [{ kind: "char", ch: " " }]);
    assert.equal(toggleEffects[0]?.kind, "run-mutation");
    if (toggleEffects[0]?.kind === "run-mutation") {
      assert.equal(toggleEffects[0].mutation.kind, "set-enabled");
      if (toggleEffects[0].mutation.kind === "set-enabled") {
        assert.equal(toggleEffects[0].mutation.input.enabled, false);
      }
    }

    const { state: confirmModal } = sendKeys(initial, [{ kind: "char", ch: "x" }]);
    assert.equal(confirmModal.overlay.kind, "confirm");
    const { state: canceled, effects: cancelEffects } = sendKeys(confirmModal, [{ kind: "enter" }]);
    assert.equal(canceled.overlay.kind, "none");
    assert.equal(cancelEffects.length, 0);

    const { effects: uninstallEffects } = sendKeys(confirmModal, [
      { kind: "tab" },
      { kind: "enter" },
    ]);
    assert.equal(uninstallEffects.length, 1);
    if (uninstallEffects[0]?.kind === "run-mutation") {
      assert.equal(uninstallEffects[0].mutation.kind, "uninstall");
    }
  });

  it("provides live source-type preview for GitHub, SSH, HTTPS, and local folder in Add Marketplace", () => {
    const snapshot = buildTestSnapshot();
    const initial = createInitialTuiState(snapshot, {
      initialTab: "marketplaces",
      colorEnabled: false,
    });

    const { state: modal } = sendKeys(initial, [{ kind: "char", ch: "a" }]);
    assert.equal(modal.overlay.kind, "add-marketplace");

    const cases: readonly [string, string][] = [
      ["cursor/plugins", "github"],
      ["git@github.com:org/team-kit.git", "ssh"],
      ["https://example.com/org/plugins.git", "https-git"],
      ["https://example.com/marketplace.json", "https-json"],
      ["./local-mkt", "local-folder"],
    ];

    for (const [inputText, expectedKind] of cases) {
      const { state: typed } = sendKeys(modal, typeChars(inputText));
      assert.equal(typed.overlay.kind, "add-marketplace");
      if (typed.overlay.kind === "add-marketplace") {
        assert.equal(typed.overlay.preview.kind, "valid");
        if (typed.overlay.preview.kind === "valid") {
          assert.equal(typed.overlay.preview.source.kind, expectedKind);
        }
      }
    }

    const { effects } = sendKeys(modal, [
      ...typeChars("cursor/plugins"),
      { kind: "tab" },
      ...typeChars("custom-id"),
      { kind: "tab" },
      { kind: "enter" },
    ]);
    assert.equal(effects.length, 1);
    if (effects[0]?.kind === "run-mutation") {
      assert.equal(effects[0].mutation.kind, "add-marketplace");
      if (effects[0].mutation.kind === "add-marketplace") {
        assert.equal(effects[0].mutation.input.id, "custom-id");
        assert.equal(effects[0].mutation.input.source.kind, "github");
      }
    }
  });

  it("supports Errors one-key f remediation and Stats mode cycling", () => {
    const diag: Diagnostic = {
      id: makeDiagnosticId("stale", "stage"),
      severity: "warning",
      subject: { kind: "path", path: makeAbsolutePath(`${USER_PLUGINS_DIR}/.agy-stage-1`) },
      detail: {
        kind: "stale-staging-artifact",
        artifactPath: makeAbsolutePath(`${USER_PLUGINS_DIR}/.agy-stage-1`),
        scope: "user",
        artifactKind: "staging",
      },
      message: "Leftover staging directory from interrupted install",
      hint: "Clean stale staging directory",
      remediation: {
        kind: "clean-stale-staging",
        label: "Clean staging directory",
      },
    };
    const mkt: MarketplaceRecord = {
      id: makeMarketplaceId("cursor-plugins"),
      source: { kind: "github", owner: "cursor", repo: "plugins" },
      addedAt: TS_ISO,
      sync: {
        kind: "synced",
        syncedAt: TS_ISO,
        resolvedRef: "main",
        resolvedSha: "abc123",
        format: "cursor",
        pluginCount: 1,
      },
      localMirrorPath: null,
    };
    const snapshot = buildTestSnapshot({
      catalog: [makeCatalogItem("cursor-plugins", "pstack")],
      installed: [makeInstalledItem("user", "pstack")],
      marketplaces: [mkt],
      diagnostics: [diag],
    });
    const errorsState = createInitialTuiState(snapshot, {
      initialTab: "errors",
      colorEnabled: false,
    });
    const { effects: fixEffects } = sendKeys(errorsState, [{ kind: "char", ch: "f" }]);
    assert.equal(fixEffects.length, 1);
    if (fixEffects[0]?.kind === "run-mutation") {
      assert.equal(fixEffects[0].mutation.kind, "remediate");
    }

    const { state: diagModal } = sendKeys(errorsState, [{ kind: "enter" }]);
    assert.equal(diagModal.overlay.kind, "diagnostic-detail");
    const { effects: modalFixEffects } = sendKeys(diagModal, [{ kind: "enter" }]);
    assert.equal(modalFixEffects[0]?.kind, "run-mutation");

    const installedModal = sendKeys(
      createInitialTuiState(snapshot, { initialTab: "installed", colorEnabled: false }),
      [{ kind: "enter" }],
    ).state;
    assert.equal(installedModal.overlay.kind, "installed-detail");
    const { effects: detailUpdateEffects } = sendKeys(installedModal, [
      { kind: "tab" },
      { kind: "enter" },
    ]);
    assert.equal(detailUpdateEffects[0]?.kind, "run-mutation");
    if (detailUpdateEffects[0]?.kind === "run-mutation") {
      assert.equal(detailUpdateEffects[0].mutation.kind, "update");
    }

    const mktModal = sendKeys(
      createInitialTuiState(snapshot, { initialTab: "marketplaces", colorEnabled: false }),
      [{ kind: "enter" }],
    ).state;
    assert.equal(mktModal.overlay.kind, "marketplace-detail");
    const { effects: mktSyncEffects } = sendKeys(mktModal, [{ kind: "enter" }]);
    assert.equal(mktSyncEffects[0]?.kind, "run-mutation");
    if (mktSyncEffects[0]?.kind === "run-mutation") {
      assert.equal(mktSyncEffects[0].mutation.kind, "sync-marketplaces");
    }

    const statsState = sendKeys(errorsState, [{ kind: "char", ch: "5" }]).state;
    assert.equal(statsState.activeTab, "stats");
    assert.equal(statsState.statsMode, "by-plugin");
    const statsMkt = sendKeys(statsState, [{ kind: "char", ch: "m" }]).state;
    assert.equal(statsMkt.statsMode, "by-marketplace");
    assert.equal(TAB_REGISTRY.stats.prepare(statsMkt).rowCount, 1);
    const statsScope = sendKeys(statsMkt, [{ kind: "char", ch: "m" }]).state;
    assert.equal(statsScope.statsMode, "by-scope");
    assert.equal(TAB_REGISTRY.stats.prepare(statsScope).rowCount, 2);
  });
});

describe("TUI rendering, frame geometry, and diffFrames", () => {
  it("renders exact viewport geometry at 120x36 and 80x24 with header tabs and footer hints", () => {
    const snapshot = buildTestSnapshot({
      catalog: [
        makeCatalogItem("cursor-plugins", "pstack", { description: "Workflows 🚀 中文" }),
        makeCatalogItem("cursor-plugins", "helper"),
      ],
      installed: [makeInstalledItem("user", "pstack")],
    });
    const state = createInitialTuiState(snapshot, { colorEnabled: true });

    for (const rawSize of [
      { cols: 120, rows: 36 },
      { cols: 80, rows: 24 },
      { cols: 60, rows: 18 },
    ]) {
      const vp = clampViewport(rawSize.cols, rawSize.rows);
      const frame = renderFrame(state, vp);
      assert.equal(frame.lines.length, vp.rows, `line count at ${vp.cols}x${vp.rows}`);
      for (const line of frame.lines) {
        assert.ok(
          displayWidth(line) <= vp.cols,
          `line exceeded ${vp.cols} cols: ${displayWidth(line)}`,
        );
      }
      const joined = stripAnsi(frame.lines.join("\n"));
      assert.match(joined, /1 Discover/);
      if (vp.cols >= 80) {
        assert.match(joined, /2 Installed/);
        assert.match(joined, /3 Marketplaces/);
        assert.match(joined, /4 Errors/);
      }
      assert.match(joined, /5 Stats/);
      assert.match(joined, /←\/→/);
      assert.match(joined, /Esc/);
    }

    const noColorState = createInitialTuiState(snapshot, { colorEnabled: false });
    const noColorFrame = renderFrame(noColorState, { cols: 80, rows: 24 });
    for (const line of noColorFrame.lines) {
      assert.equal(stripAnsi(line), line, "NO_COLOR frame should emit zero ANSI codes");
    }

    const withModal = sendKeys(state, [{ kind: "enter" }]).state;
    const modalFrame = renderFrame(withModal, { cols: 80, rows: 24 });
    assert.equal(modalFrame.lines.length, 24);
    for (const line of modalFrame.lines) {
      assert.ok(displayWidth(line) <= 80);
    }
    assert.match(stripAnsi(modalFrame.lines.join("\n")), /Plugin Details/);

    const addMktState = sendKeys(state, [{ kind: "char", ch: "a" }, ...typeChars("cursor/plugins")]).state;
    const addMktFrame = renderFrame(addMktState, { cols: 80, rows: 24 });
    assert.equal(addMktFrame.lines.length, 24);
    for (const line of addMktFrame.lines) {
      assert.ok(displayWidth(line) <= 80);
    }
    assert.match(stripAnsi(addMktFrame.lines.join("\n")), /Detected: github/);

    const helpState = sendKeys(state, [{ kind: "char", ch: "?" }]).state;
    const helpFrame = renderFrame(helpState, { cols: 80, rows: 24 });
    assert.equal(helpFrame.lines.length, 24);
    assert.match(stripAnsi(helpFrame.lines.join("\n")), /Plugin Manager Help/);
  });

  it("wraps frame diffs in synchronized output mode and skips unchanged lines", () => {
    const snapshot = buildTestSnapshot({
      catalog: [
        makeCatalogItem("cursor-plugins", "alpha"),
        makeCatalogItem("cursor-plugins", "beta"),
        makeCatalogItem("cursor-plugins", "gamma"),
      ],
    });
    const state1 = createInitialTuiState(snapshot, { colorEnabled: false });
    const state2 = sendKeys(state1, [{ kind: "down" }]).state;

    const f1 = renderFrame(state1, { cols: 90, rows: 20 });
    const f2 = renderFrame(state2, { cols: 90, rows: 20 });

    assert.equal(diffFrames(f1, f1), "");

    const diff = diffFrames(f1, f2);
    assert.ok(diff.startsWith(SYNC_START));
    assert.ok(diff.endsWith(SYNC_END));
    assert.ok(!diff.includes("1 Discover"), "unchanged header line should not repaint");
    assert.ok(diff.includes("▸ beta"), "newly selected row should repaint");
  });

  it("keeps hintsForIndex aligned with dispatchKeyAt from a single actions source", () => {
    const snapshot = buildTestSnapshot({
      catalog: [makeCatalogItem("cursor-plugins", "alpha")],
    });
    const state = createInitialTuiState(snapshot, { colorEnabled: false });
    const prepared = TAB_REGISTRY.discover.prepare(state);
    const hints = prepared.hintsForIndex(0);
    assert.ok(hints.some((h) => h.keys === "Enter" && h.label === "open"));
    assert.ok(hints.some((h) => h.keys === "i" && h.label === "install"));
    assert.equal(prepared.dispatchKeyAt(0, { kind: "char", ch: "i" })?.kind, "mutate");
    assert.equal(prepared.hintsForIndex(-1).some((h) => h.keys === "i"), false);
    assert.equal(prepared.dispatchKeyAt(-1, { kind: "char", ch: "i" }), null);
  });

  it("runs full interactive TUI loop and restores terminal on exit", async () => {
    const snapshot = buildTestSnapshot({
      catalog: [makeCatalogItem("cursor-plugins", "pstack")],
    });
    const { engine, calls } = createStubEngine(snapshot);
    const fakeTerm = createFakeTerminal({ cols: 100, rows: 24 });

    const runPromise = runTui(engine, fakeTerm.port, {
      escapeFlushMs: 10,
      spinnerIntervalMs: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    fakeTerm.pushBytes(Buffer.from("i"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    fakeTerm.pushBytes(Buffer.from("q"));

    const exitCode = await runPromise;
    assert.equal(exitCode, 0);
    assert.equal(fakeTerm.getEnteredCount(), 1);
    assert.equal(fakeTerm.getLeftCount(), 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.kind, "install");
    assert.ok(fakeTerm.writes.some((w) => w.includes(SYNC_START)));
  });
});
