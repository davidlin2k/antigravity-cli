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
  EMPTY_TEXT_INPUT,
  SYNC_END,
  SYNC_START,
  TAB_IDS,
  TAB_REGISTRY,
  clampViewport,
  computeFooterHints,
  createInitialTuiState,
  createKeyDecoder,
  diffFrames,
  displayWidth,
  findInstalledForEntryInScope,
  findSameNameCollisionInScope,
  overlaySegmentOnLine,
  padVisible,
  parseKeyBytes,
  reduce,
  reduceTextInput,
  renderFrame,
  resolveActiveSelectedIndex,
  runTui,
  sanitizeInlineText,
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

    const { state: confirmModal, effects: preConfirmEffects } = sendKeys(modal, [{ kind: "enter" }]);
    assert.equal(preConfirmEffects.length, 0);
    assert.equal(confirmModal.overlay.kind, "confirm");

    const { state: backToDetail, effects: cancelEffects } = sendKeys(confirmModal, [{ kind: "enter" }]);
    assert.equal(cancelEffects.length, 0);
    assert.equal(backToDetail.overlay.kind, "discover-detail");

    const { effects: uninstallEffects } = sendKeys(confirmModal, [
      { kind: "tab" },
      { kind: "enter" },
    ]);
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

describe("TUI hardening regression suite", () => {
  it("never lets modals overwrite header bar, validation toast, or bottom footer at 40x12..120x36", () => {
    const snapshot = buildTestSnapshot({
      catalog: [makeCatalogItem("cursor-plugins", "pstack")],
      installed: [makeInstalledItem("user", "pstack")],
    });
    const base = createInitialTuiState(snapshot, { colorEnabled: false });
    const addEmptySubmit = sendKeys(base, [{ kind: "char", ch: "a" }, { kind: "enter" }]).state;
    assert.equal(addEmptySubmit.overlay.kind, "add-marketplace");
    assert.equal(addEmptySubmit.toast?.tone, "error");

    const helpModal = sendKeys(base, [{ kind: "char", ch: "?" }]).state;
    const detailModal = sendKeys(base, [{ kind: "enter" }]).state;

    for (const vp of [
      { cols: 40, rows: 12 },
      { cols: 60, rows: 18 },
      { cols: 80, rows: 24 },
      { cols: 120, rows: 36 },
    ]) {
      const fToast = renderFrame(addEmptySubmit, vp);
      assert.equal(fToast.lines.length, vp.rows);
      assert.match(fToast.lines[1] ?? "", /1 Disc/, `header preserved at ${vp.cols}x${vp.rows}`);
      assert.match(
        fToast.lines[vp.rows - 3] ?? "",
        /Enter a GitHub repo/,
        `toast preserved at ${vp.cols}x${vp.rows}`,
      );
      assert.match(fToast.lines[vp.rows - 2] ?? "", /Esc/, `footer preserved at ${vp.cols}x${vp.rows}`);
      assert.match(fToast.lines.join("\n"), /Add Marketplace/, `modal visible at ${vp.cols}x${vp.rows}`);
      assert.match(fToast.lines.join("\n"), /Cancel/, `modal buttons visible at ${vp.cols}x${vp.rows}`);

      for (const modalState of [helpModal, detailModal]) {
        const frame = renderFrame(modalState, vp);
        assert.equal(frame.lines.length, vp.rows);
        assert.match(frame.lines[1] ?? "", /1 Disc/);
        assert.match(frame.lines[vp.rows - 2] ?? "", /Esc/);
        for (const line of frame.lines) {
          assert.ok(displayWidth(line) <= vp.cols);
        }
      }
    }
  });

  it("renders unmistakable button focus and mid-string text cursor when NO_COLOR is active", () => {
    const snapshot = buildTestSnapshot({
      catalog: [makeCatalogItem("cursor-plugins", "pstack")],
    });
    const base = createInitialTuiState(snapshot, { colorEnabled: false });

    const confirm1 = sendKeys(base, [{ kind: "enter" }]).state;
    const confirm2 = sendKeys(confirm1, [{ kind: "tab" }]).state;
    const fBtn1 = renderFrame(confirm1, { cols: 80, rows: 24 });
    const fBtn2 = renderFrame(confirm2, { cols: 80, rows: 24 });
    assert.notEqual(fBtn1.lines.join("\n"), fBtn2.lines.join("\n"));
    assert.match(fBtn1.lines.join("\n"), /▸ \[ Install \]/);
    assert.match(fBtn2.lines.join("\n"), /▸ \[ Switch Scope \]/);

    const searchEnd = sendKeys(base, [{ kind: "char", ch: "/" }, ...typeChars("abc")]).state;
    const searchMid = sendKeys(searchEnd, [{ kind: "left" }]).state;
    const searchEarly = sendKeys(searchMid, [{ kind: "left" }]).state;
    const searchHome = sendKeys(searchEarly, [{ kind: "home" }]).state;

    const rendered = [searchEnd, searchMid, searchEarly, searchHome].map((s) =>
      renderFrame(s, { cols: 80, rows: 24 }).lines[3] ?? "",
    );
    assert.equal(new Set(rendered).size, 4, "all cursor positions must render distinctly without color");
    assert.match(rendered[0] ?? "", /abc_/);
    assert.match(rendered[1] ?? "", /ab▏c/);
    assert.match(rendered[2] ?? "", /a▏bc/);
    assert.match(rendered[3] ?? "", /▏abc/);
  });

  it("windows CJK text inputs by display width without clipping cursor or adding leading ellipsis at Home", () => {
    const snapshot = buildTestSnapshot();
    const base = createInitialTuiState(snapshot, { colorEnabled: false });
    const cjk = "日本語プラグイン検索テスト文字列追加";

    const searchTyped = sendKeys(base, [{ kind: "char", ch: "/" }, ...typeChars(cjk)]).state;
    const endFrame = renderFrame(searchTyped, { cols: 40, rows: 12 });
    const endSubheader = endFrame.lines[3] ?? "";
    assert.ok(displayWidth(endSubheader) <= 40);
    assert.match(endSubheader, /追加_/, "end cursor and newest CJK chars stay visible");

    const searchHome = sendKeys(searchTyped, [{ kind: "home" }]).state;
    const homeFrame = renderFrame(searchHome, { cols: 40, rows: 12 });
    const homeSubheader = homeFrame.lines[3] ?? "";
    assert.ok(displayWidth(homeSubheader) <= 40);
    assert.match(homeSubheader, /Search \[\/\]: ▏日本/, "Home must never prepend bogus ellipsis");
    assert.doesNotMatch(homeSubheader, /Search \[\/\]: …/);

    const addTyped = sendKeys(base, [{ kind: "char", ch: "a" }, ...typeChars(cjk)]).state;
    const addEndFrame = renderFrame(addTyped, { cols: 40, rows: 12 });
    assert.match(addEndFrame.lines.join("\n"), /追加_/, "Add Marketplace keeps CJK cursor visible");
    const addHome = sendKeys(addTyped, [{ kind: "home" }]).state;
    const addHomeFrame = renderFrame(addHome, { cols: 40, rows: 12 });
    assert.match(addHomeFrame.lines.join("\n"), /Source: ▏日本/);
    assert.doesNotMatch(addHomeFrame.lines.join("\n"), /Source: …/);
  });

  it("sanitizes ANSI escapes and control characters from untrusted metadata across tables, headers, toasts, and modals", () => {
    const evilEntry = makeCatalogItem("cursor-plugins", "evil-plugin", {
      displayName: "Evil\x1b[2J\x1b[31m\r\n\tPlugin",
      description: "Line1\r\n\t\x1b]0;pwn\x07\x1b[31mInjected\x1b[0m",
    });
    const evilDiag: Diagnostic = {
      id: makeDiagnosticId("evil", "diag"),
      severity: "error",
      subject: { kind: "marketplace", marketplaceId: makeMarketplaceId("bad-mkt") },
      detail: {
        kind: "marketplace-sync-failed",
        marketplaceId: makeMarketplaceId("bad-mkt"),
        reason: "Fail\x1b[2J\r\n\tReason",
      },
      message: "Bad\x1b[31m\r\n\tMessage\x9b2J",
      hint: "Fix\t\r\n\x1b[1mHint",
      remediation: {
        kind: "retry-marketplace-sync",
        marketplaceId: makeMarketplaceId("bad-mkt"),
        label: "Retry\x1b[32m\r\n\tSync",
      },
    };
    const evilMkt: MarketplaceRecord = {
      id: makeMarketplaceId("bad-mkt"),
      source: { kind: "github", owner: "org", repo: "repo" },
      addedAt: TS_ISO,
      sync: {
        kind: "sync-failed",
        attemptedAt: TS_ISO,
        lastGoodSyncAt: null,
        reason: "Remote\x1b[2J\r\n\tError",
      },
      localMirrorPath: null,
    };

    assert.equal(sanitizeInlineText("a\x1b[31mb\r\n\t\x1b]0;t\x07c"), "ab c");

    const snapshot = buildTestSnapshot({
      catalog: [evilEntry],
      marketplaces: [evilMkt],
      diagnostics: [evilDiag],
    });
    const base = createInitialTuiState(snapshot, { colorEnabled: false });
    const withToast: TuiState = {
      ...base,
      toast: { id: 1, tone: "error", text: "Toast\x1b[2J\r\n\tBoom" },
    };

    const statesToRender: readonly TuiState[] = [
      withToast,
      sendKeys(withToast, [{ kind: "enter" }]).state,
      sendKeys(withToast, [{ kind: "char", ch: "3" }, { kind: "enter" }]).state,
      sendKeys(withToast, [{ kind: "char", ch: "4" }]).state,
      sendKeys(withToast, [{ kind: "char", ch: "4" }, { kind: "enter" }]).state,
    ];

    for (const s of statesToRender) {
      const frame = renderFrame(s, { cols: 80, rows: 24 });
      assert.equal(frame.lines.length, 24);
      for (const line of frame.lines) {
        assert.equal(stripAnsi(line), line, "no ANSI escapes may leak into NO_COLOR frame");
        assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f]/, "no C0/C1 control chars may leak");
      }
    }
  });

  it("compacts Stats KPI header at rows <= 15 so data rows remain visible at 40x12 and 80x12", () => {
    const installed = [
      makeInstalledItem("user", "alpha-plugin", { tokens: 1200 }),
      makeInstalledItem("user", "beta-plugin", { tokens: 900 }),
      makeInstalledItem("user", "gamma-plugin", { tokens: 700 }),
    ];
    const snapshot = buildTestSnapshot({ installed });
    const state = createInitialTuiState(snapshot, { initialTab: "stats", colorEnabled: false });

    for (const vp of [
      { cols: 40, rows: 12 },
      { cols: 80, rows: 12 },
    ]) {
      const frame = renderFrame(state, vp);
      assert.equal(frame.lines.length, 12);
      const joined = frame.lines.join("\n");
      assert.match(joined, /\[m\] By Plugin/);
      assert.match(joined, /alpha/, `first stats row visible at ${vp.cols}x${vp.rows}`);
      assert.match(joined, /beta/, `second stats row visible at ${vp.cols}x${vp.rows}`);
    }

    const tall = renderFrame(state, { cols: 80, rows: 16 });
    assert.match(tall.lines.join("\n"), /Discoverable/);
    assert.match(tall.lines.join("\n"), /Desc Tokens/);
  });

  it("keeps all 5 header tabs legible at 40 cols and keeps modal buttons unclipped", () => {
    const diag: Diagnostic = {
      id: makeDiagnosticId("long", "fix"),
      severity: "error",
      subject: { kind: "path", path: makeAbsolutePath(`${USER_PLUGINS_DIR}/broken`) },
      detail: {
        kind: "unadapted-hooks-path",
        sourcePath: makeAbsolutePath(`${USER_PLUGINS_DIR}/broken/hooks.json`),
        expectedPath: makeAbsolutePath(`${USER_PLUGINS_DIR}/broken/hooks/hooks.json`),
      },
      message: "Unadapted hook path detected",
      hint: "Run remediation",
      remediation: {
        kind: "clean-stale-staging",
        label: "Very long remediation action description that previously clipped the Close button",
      },
    };
    const snapshot = buildTestSnapshot({
      catalog: [makeCatalogItem("cursor-plugins", "pstack")],
      installed: [makeInstalledItem("user", "pstack")],
      diagnostics: [diag],
    });

    const base = createInitialTuiState(snapshot, { colorEnabled: false });
    for (const [keyChar, activePattern] of [
      ["1", /\[1 Disc\]/],
      ["2", /\[2 Inst 1\]/],
      ["3", /\[3 Mkts 0\]/],
      ["4", /\[4 Err 1\]/],
      ["5", /\[5 Stats\]/],
    ] as const) {
      const tabState = sendKeys(base, [{ kind: "char", ch: keyChar }]).state;
      const header = renderFrame(tabState, { cols: 40, rows: 12 }).lines[1] ?? "";
      assert.match(header, activePattern);
      for (const n of ["1", "2", "3", "4", "5"]) {
        assert.ok(header.includes(n), `tab ${n} visible in 40-col header: ${header}`);
      }
    }

    const diagModal = sendKeys(base, [{ kind: "char", ch: "4" }, { kind: "enter" }]).state;
    for (const vp of [
      { cols: 40, rows: 12 },
      { cols: 80, rows: 24 },
    ]) {
      const text = renderFrame(diagModal, vp).lines.join("\n");
      assert.match(text, /Fix:/);
      assert.match(text, /\[ Close \]/, `Close button must never clip at ${vp.cols}x${vp.rows}`);
    }

    const installedModal = sendKeys(base, [{ kind: "char", ch: "2" }, { kind: "enter" }]).state;
    const installedText = renderFrame(installedModal, { cols: 40, rows: 12 }).lines.join("\n");
    assert.match(installedText, /\[ Disable \]/);
    assert.match(installedText, /\[ Update \]/);
    assert.match(installedText, /\[ Uninstall \]/);
    assert.match(installedText, /\[ Close \]/);
  });

  it("handles grapheme clusters (ZWJ emoji, skin tone, VS16, combining marks) accurately in width, editing, and overlay", () => {
    assert.equal(displayWidth("👨‍👩‍👧‍👦"), 2);
    assert.equal(displayWidth("👩‍💻"), 2);
    assert.equal(displayWidth("👍🏽"), 2);
    assert.equal(displayWidth("⚠️"), 2);
    assert.equal(displayWidth("❤️"), 2);
    assert.equal(displayWidth("e\u0301"), 1);

    let input = EMPTY_TEXT_INPUT;
    for (const ch of Array.from("a👨‍👩‍👧‍👦👍🏽⚠️b")) {
      input = reduceTextInput(input, { kind: "char", ch }).next;
    }
    assert.equal(input.value, "a👨‍👩‍👧‍👦👍🏽⚠️b");
    assert.equal(input.cursor, 5);

    input = reduceTextInput(input, { kind: "backspace" }).next;
    assert.equal(input.value, "a👨‍👩‍👧‍👦👍🏽⚠️");
    input = reduceTextInput(input, { kind: "backspace" }).next;
    assert.equal(input.value, "a👨‍👩‍👧‍👦👍🏽");
    input = reduceTextInput(input, { kind: "backspace" }).next;
    assert.equal(input.value, "a👨‍👩‍👧‍👦");
    input = reduceTextInput(input, { kind: "backspace" }).next;
    assert.equal(input.value, "a");

    const accented = reduceTextInput(EMPTY_TEXT_INPUT, { kind: "char", ch: "e\u0301" }).next;
    assert.equal(reduceTextInput(accented, { kind: "backspace" }).next.value, "");

    const bgLine = `│ cafe\u0301 abcde\u0301ghij${" ".repeat(19)} │`;
    const overlaid = overlaySegmentOnLine(bgLine, 5, "┌MODAL┐", 38, false);
    assert.equal(displayWidth(overlaid), 38);
    assert.doesNotMatch(overlaid, /\u0301┌|┐\u0301|│\u0301/, "no combining mark may attach to modal border");
    assert.ok(overlaid.includes("┌MODAL┐ghij"), `expected clean right continuation, got: ${overlaid}`);
  });

  it("omits Space toggle hint in installed-detail for broken plugins", () => {
    const brokenId = makeInstalledPluginId("user", makePluginDirName("broken-plug"));
    const brokenPlugin: InstalledPlugin = {
      kind: "broken",
      id: brokenId,
      scope: "user",
      dirName: makePluginDirName("broken-plug"),
      installPath: makeAbsolutePath(`${USER_PLUGINS_DIR}/broken-plug`),
      provenance: { kind: "unmanaged" },
      diskBytes: 128,
      diagnosticIds: [makeDiagnosticId("broken", "json")],
    };
    const validPlugin = makeInstalledItem("user", "valid-plug");
    const snapshot = buildTestSnapshot({ installed: [brokenPlugin, validPlugin] });

    const brokenModal = sendKeys(
      createInitialTuiState(snapshot, { initialTab: "installed", colorEnabled: false }),
      [{ kind: "enter" }],
    ).state;
    assert.equal(brokenModal.overlay.kind, "installed-detail");
    const brokenHints = computeFooterHints(
      brokenModal,
      TAB_REGISTRY.installed.prepare(brokenModal),
      0,
    );
    assert.equal(brokenHints.some((h) => h.keys === "Space"), false);
    const { effects } = sendKeys(brokenModal, [{ kind: "char", ch: " " }]);
    assert.equal(effects.length, 0);

    const validModal = sendKeys(
      createInitialTuiState(snapshot, { initialTab: "installed", colorEnabled: false }),
      [{ kind: "down" }, { kind: "enter" }],
    ).state;
    const validHints = computeFooterHints(
      validModal,
      TAB_REGISTRY.installed.prepare(validModal),
      1,
    );
    assert.equal(validHints.some((h) => h.keys === "Space" && h.label === "toggle"), true);
  });

  it("applies ANSI SGR styling cleanly per wrapped line without breaking across lines", () => {
    const mkt: MarketplaceRecord = {
      id: makeMarketplaceId("failing-mkt"),
      source: { kind: "github", owner: "org", repo: "repo" },
      addedAt: TS_ISO,
      sync: {
        kind: "sync-failed",
        attemptedAt: TS_ISO,
        lastGoodSyncAt: null,
        reason:
          "Network timeout while fetching marketplace metadata from upstream repository mirror after retries",
      },
      localMirrorPath: null,
    };
    const snapshot = buildTestSnapshot({ marketplaces: [mkt] });
    const mktModal = sendKeys(
      createInitialTuiState(snapshot, { initialTab: "marketplaces", colorEnabled: true }),
      [{ kind: "enter" }],
    ).state;
    const frame = renderFrame(mktModal, { cols: 56, rows: 20 });
    const redLines = frame.lines.filter((line) => line.includes("\x1b[31m") || line.includes("repository mirror"));
    assert.ok(redLines.length >= 2, "expected wrapped sync-failed error lines");
    for (const line of redLines) {
      assert.ok(line.includes("\x1b[31m"), "every wrapped error line must start red SGR");
      assert.ok(line.includes("Sync failed:") ? line.includes("\x1b[0m") : line.includes("\x1b[31m"));
      const redIdx = line.indexOf("\x1b[31m");
      const resetAfterRed = line.indexOf("\x1b[0m", redIdx);
      assert.ok(resetAfterRed > redIdx, "every red SGR span must reset on the same line");
    }
  });

  it("preserves open Add Marketplace and Confirm modals when unrelated background mutations finish", () => {
    const mkt: MarketplaceRecord = {
      id: makeMarketplaceId("cursor-plugins"),
      source: { kind: "github", owner: "cursor", repo: "plugins" },
      addedAt: TS_ISO,
      sync: {
        kind: "synced",
        syncedAt: TS_ISO,
        resolvedRef: "main",
        resolvedSha: "abc",
        format: "cursor",
        pluginCount: 1,
      },
      localMirrorPath: null,
    };
    const snapshot = buildTestSnapshot({
      revision: 1,
      marketplaces: [mkt],
      catalog: [makeCatalogItem("cursor-plugins", "pstack")],
    });
    const env = { cwd: WORKSPACE_DIR, homeDir: HOME_DIR };

    const initial = createInitialTuiState(snapshot, { initialTab: "marketplaces", colorEnabled: false });
    const { state: syncing, effects: syncEffects } = sendKeys(initial, [{ kind: "char", ch: "U" }], env);
    assert.equal(syncEffects[0]?.kind, "run-mutation");
    const syncReqId = syncEffects[0]?.kind === "run-mutation" ? syncEffects[0].requestId : makeRequestId(1);

    const { state: typingModal } = sendKeys(
      syncing,
      [{ kind: "char", ch: "a" }, ...typeChars("my-org/plugins")],
      env,
    );
    assert.equal(typingModal.overlay.kind, "add-marketplace");

    const updatedSnap = buildTestSnapshot({
      revision: 2,
      marketplaces: [mkt],
      catalog: [makeCatalogItem("cursor-plugins", "pstack")],
    });
    const [afterUnrelated] = reduce(
      typingModal,
      {
        kind: "mutation-finished",
        requestId: syncReqId,
        label: "Syncing",
        outcome: {
          kind: "sync-marketplaces",
          result: { ok: true, report: { outcomes: [] }, snapshot: updatedSnap },
        },
      },
      env,
    );
    assert.equal(afterUnrelated.overlay.kind, "add-marketplace");
    if (afterUnrelated.overlay.kind === "add-marketplace") {
      assert.equal(afterUnrelated.overlay.sourceInput.value, "my-org/plugins");
    }

    const { state: submitted, effects: addEffects } = sendKeys(afterUnrelated, [{ kind: "enter" }], env);
    assert.equal(addEffects[0]?.kind, "run-mutation");
    const addReqId = addEffects[0]?.kind === "run-mutation" ? addEffects[0].requestId : makeRequestId(2);
    const [afterOwnFinish] = reduce(
      submitted,
      {
        kind: "mutation-finished",
        requestId: addReqId,
        label: "Adding",
        outcome: {
          kind: "add-marketplace",
          result: {
            ok: true,
            report: {
              outcome: {
                marketplaceId: makeMarketplaceId("plugins"),
                status: "synced",
                pluginCount: 1,
                format: "cursor",
              },
            },
            snapshot: buildTestSnapshot({ revision: 3, marketplaces: [mkt] }),
          },
        },
      },
      env,
    );
    assert.equal(afterOwnFinish.overlay.kind, "none");
  });

  it("matches discover-detail installed plugins strictly by provenance and warns on cross-marketplace collisions", () => {
    const entryA = makeCatalogItem("mkt-a", "foo");
    const entryB = makeCatalogItem("mkt-b", "foo");
    const installedFromA = makeInstalledItem("user", "foo", { marketplaceId: "mkt-a" });
    const snapshot = buildTestSnapshot({
      catalog: [entryA, entryB],
      installed: [installedFromA],
    });

    assert.equal(findInstalledForEntryInScope(snapshot, entryA, "user")?.id, installedFromA.id);
    assert.equal(findInstalledForEntryInScope(snapshot, entryB, "user"), undefined);
    assert.equal(findSameNameCollisionInScope(snapshot, entryB, "user")?.id, installedFromA.id);

    const base = createInitialTuiState(snapshot, { colorEnabled: false });
    const modalB = sendKeys(base, [{ kind: "down" }, { kind: "enter" }]).state;
    const modalBText = renderFrame(modalB, { cols: 80, rows: 24 }).lines.join("\n");
    assert.match(modalBText, /\[ Install \]/);
    assert.doesNotMatch(modalBText, /\[ Uninstall \]/);
    assert.match(modalBText, /Collision in user scope/);

    const { effects: installBEffects } = sendKeys(modalB, [{ kind: "enter" }]);
    assert.equal(installBEffects[0]?.kind, "run-mutation");
    if (installBEffects[0]?.kind === "run-mutation") {
      assert.equal(installBEffects[0].mutation.kind, "install");
    }
  });

  it("flushes incomplete CSI/SS3 prefixes cleanly without hanging or swallowing next keypress", async () => {
    const decoder = createKeyDecoder();
    assert.deepEqual(decoder.push(Buffer.from("\x1b[")), []);
    assert.equal(decoder.hasPendingEscape(), true);
    assert.deepEqual(decoder.flush(), []);
    assert.equal(decoder.hasPendingEscape(), false);
    assert.deepEqual(decoder.push(Buffer.from("a")), [{ kind: "char", ch: "a" }]);

    assert.deepEqual(decoder.push(Buffer.from("\x1bO")), []);
    assert.equal(decoder.hasPendingEscape(), true);
    assert.deepEqual(decoder.flush(), []);
    assert.deepEqual(decoder.push(Buffer.from("b")), [{ kind: "char", ch: "b" }]);

    assert.deepEqual(decoder.push(Buffer.from("\x1b[1;")), []);
    assert.equal(decoder.hasPendingEscape(), true);
    assert.deepEqual(decoder.flush(), []);
    assert.deepEqual(decoder.push(Buffer.from("c")), [{ kind: "char", ch: "c" }]);

    const snapshot = buildTestSnapshot({
      installed: [makeInstalledItem("user", "pstack")],
    });
    const { engine } = createStubEngine(snapshot);
    const fakeTerm = createFakeTerminal({ cols: 90, rows: 24 });
    const runPromise = runTui(engine, fakeTerm.port, {
      escapeFlushMs: 10,
      spinnerIntervalMs: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    fakeTerm.pushBytes(Buffer.from("\x1b["));
    await new Promise((resolve) => setTimeout(resolve, 30));
    fakeTerm.pushBytes(Buffer.from("2"));
    await new Promise((resolve) => setTimeout(resolve, 15));
    fakeTerm.pushBytes(Buffer.from("q"));

    const exitCode = await runPromise;
    assert.equal(exitCode, 0);
    assert.ok(
      fakeTerm.writes.some((w) => w.includes("2 Installed")),
      "keypress '2' after flushed incomplete CSI must not be swallowed",
    );
  });

  it("respects terminals smaller than 40x12 and renders compact notice strictly within bounds", () => {
    assert.deepEqual(clampViewport(32, 10), { cols: 32, rows: 10 });
    assert.deepEqual(clampViewport(1, 1), { cols: 1, rows: 1 });

    const snapshot = buildTestSnapshot({
      catalog: [makeCatalogItem("cursor-plugins", "pstack")],
    });
    const state = createInitialTuiState(snapshot, { colorEnabled: false });

    const f32 = renderFrame(state, { cols: 32, rows: 10 });
    assert.equal(f32.lines.length, 10);
    for (const line of f32.lines) {
      assert.ok(displayWidth(line) <= 32);
    }
    const text32 = f32.lines.join("\n");
    assert.match(text32, /Terminal too small/);
    assert.match(text32, /32x10/);
    assert.match(text32, /40x12/);
    assert.match(text32, /Esc\/q/);

    for (const tiny of [
      { cols: 20, rows: 6 },
      { cols: 10, rows: 3 },
      { cols: 1, rows: 1 },
    ]) {
      const f = renderFrame(state, tiny);
      assert.equal(f.lines.length, tiny.rows);
      for (const line of f.lines) {
        assert.ok(displayWidth(line) <= tiny.cols);
      }
    }
  });
});
