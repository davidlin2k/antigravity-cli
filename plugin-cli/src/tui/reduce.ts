import { deriveMarketplaceId, parseMarketplaceInput } from "../domain/query.ts";
import {
  isCatalogEntryId,
  isDiagnosticId,
  isInstalledPluginId,
  isMarketplaceId,
  nextRequestId,
  parseMarketplaceId,
} from "../domain/types.ts";
import type {
  AbsolutePath,
  CatalogEntry,
  InstalledPlugin,
  InstallScope,
  MarketplaceId,
  WorkspaceSnapshot,
} from "../domain/types.ts";
import type { KeyEvent } from "./ansi.ts";
import {
  EMPTY_TEXT_INPUT,
  TAB_IDS,
  formatEngineError,
  reduceTextInput,
  resolveSelectedIndex,
} from "./state.ts";
import type {
  AddMarketplacePreview,
  DiscoverFilterMode,
  ErrorSeverityFilter,
  InstalledScopeFilter,
  MutationOutcome,
  OverlayState,
  PendingMutationSpec,
  SearchableTabId,
  StatsBreakdownMode,
  TabId,
  TextInputState,
  TuiEffect,
  TuiEvent,
  TuiState,
} from "./state.ts";
import type { ActionCommand, KeyHint, PreparedTabView } from "./tab-registry.ts";
import { TAB_REGISTRY } from "./tabs.ts";

export interface ReduceEnv {
  readonly cwd: AbsolutePath;
  readonly homeDir: AbsolutePath;
}

const PAGE_STEP = 10;

function isSearchableTab(tab: TabId): tab is SearchableTabId {
  return tab !== "stats";
}

function getSearchInput(state: TuiState, tab: TabId): TextInputState {
  if (!isSearchableTab(tab)) {
    return EMPTY_TEXT_INPUT;
  }
  return state.searchByTab[tab];
}

function withSearchInput(
  state: TuiState,
  tab: SearchableTabId,
  input: TextInputState,
): TuiState {
  return {
    ...state,
    searchByTab: {
      ...state.searchByTab,
      [tab]: input,
    },
  };
}

function withToast(
  state: TuiState,
  tone: "info" | "success" | "warning" | "error",
  text: string,
): TuiState {
  return {
    ...state,
    toast: { tone, text, id: state.nextToastId },
    nextToastId: state.nextToastId + 1,
  };
}

function computeAddMarketplacePreview(raw: string, env: ReduceEnv): AddMarketplacePreview {
  if (raw.trim().length === 0) {
    return { kind: "empty" };
  }
  const parsed = parseMarketplaceInput({
    raw,
    cwd: env.cwd,
    homeDir: env.homeDir,
  });
  if (!parsed.ok) {
    return { kind: "invalid", message: parsed.error.message };
  }
  return {
    kind: "valid",
    source: parsed.value,
    suggestedId: deriveMarketplaceId(parsed.value),
  };
}

export function findInstalledForEntryInScope(
  snapshot: WorkspaceSnapshot,
  entry: CatalogEntry,
  scope: InstallScope,
): InstalledPlugin | undefined {
  const ids = snapshot.installedIdsByPluginName.get(entry.name);
  if (ids === undefined) {
    return undefined;
  }
  for (const id of ids) {
    const plugin = snapshot.installedById.get(id);
    if (plugin !== undefined && plugin.scope === scope) {
      return plugin;
    }
  }
  return undefined;
}

function updateActiveTabCursor(
  state: TuiState,
  nextIndex: number,
  rowKey: string | null,
): TuiState {
  const clampedIndex = Math.max(0, nextIndex);
  switch (state.activeTab) {
    case "discover":
      return {
        ...state,
        cursors: {
          ...state.cursors,
          discover: {
            selectedId: rowKey !== null && isCatalogEntryId(rowKey) ? rowKey : null,
            fallbackIndex: clampedIndex,
            scrollOffset: state.cursors.discover.scrollOffset,
          },
        },
      };
    case "installed":
      return {
        ...state,
        cursors: {
          ...state.cursors,
          installed: {
            selectedId: rowKey !== null && isInstalledPluginId(rowKey) ? rowKey : null,
            fallbackIndex: clampedIndex,
            scrollOffset: state.cursors.installed.scrollOffset,
          },
        },
      };
    case "marketplaces":
      return {
        ...state,
        cursors: {
          ...state.cursors,
          marketplaces: {
            selectedId: rowKey !== null && isMarketplaceId(rowKey) ? rowKey : null,
            fallbackIndex: clampedIndex,
            scrollOffset: state.cursors.marketplaces.scrollOffset,
          },
        },
      };
    case "errors":
      return {
        ...state,
        cursors: {
          ...state.cursors,
          errors: {
            selectedId: rowKey !== null && isDiagnosticId(rowKey) ? rowKey : null,
            fallbackIndex: clampedIndex,
            scrollOffset: state.cursors.errors.scrollOffset,
          },
        },
      };
    case "stats":
      return {
        ...state,
        cursors: {
          ...state.cursors,
          stats: {
            selectedId: rowKey,
            fallbackIndex: clampedIndex,
            scrollOffset: state.cursors.stats.scrollOffset,
          },
        },
      };
    default: {
      const _exhaustive: never = state.activeTab;
      return _exhaustive;
    }
  }
}

export function resolveActiveSelectedIndex(
  state: TuiState,
  prepared: PreparedTabView,
): number {
  const rows = Array.from({ length: prepared.rowCount }, (_, i) => i);
  const keyAt = (idx: number): string => prepared.rowKeyAt(idx) ?? "";

  switch (state.activeTab) {
    case "discover":
      return resolveSelectedIndex(state.cursors.discover, rows, keyAt);
    case "installed":
      return resolveSelectedIndex(state.cursors.installed, rows, keyAt);
    case "marketplaces":
      return resolveSelectedIndex(state.cursors.marketplaces, rows, keyAt);
    case "errors":
      return resolveSelectedIndex(state.cursors.errors, rows, keyAt);
    case "stats":
      return resolveSelectedIndex(state.cursors.stats, rows, keyAt);
    default: {
      const _exhaustive: never = state.activeTab;
      return _exhaustive;
    }
  }
}

function startMutation(
  state: TuiState,
  mutation: PendingMutationSpec,
  nextOverlay?: OverlayState,
): readonly [TuiState, readonly TuiEffect[]] {
  if (state.pending.kind === "running") {
    return [withToast(state, "warning", `Busy: ${state.pending.label}`), []];
  }
  const requestId = state.nextRequestId;
  const nextState: TuiState = {
    ...state,
    overlay: nextOverlay ?? state.overlay,
    pending: { kind: "running", requestId, label: mutation.label },
    nextRequestId: nextRequestId(requestId),
    spinnerTick: 0,
  };
  return [nextState, [{ kind: "run-mutation", requestId, mutation }]];
}

function startRescan(state: TuiState): readonly [TuiState, readonly TuiEffect[]] {
  if (state.pending.kind === "running") {
    return [withToast(state, "warning", `Busy: ${state.pending.label}`), []];
  }
  const requestId = state.nextRequestId;
  const nextState: TuiState = {
    ...state,
    pending: { kind: "running", requestId, label: "Rescanning workspace" },
    nextRequestId: nextRequestId(requestId),
    spinnerTick: 0,
  };
  return [nextState, [{ kind: "run-rescan", requestId }]];
}

function cycleDiscoverFilter(mode: DiscoverFilterMode): DiscoverFilterMode {
  switch (mode) {
    case "all":
      return "available";
    case "available":
      return "installed";
    case "installed":
      return "all";
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

function cycleInstalledScope(scope: InstalledScopeFilter): InstalledScopeFilter {
  switch (scope) {
    case "all":
      return "user";
    case "user":
      return "project";
    case "project":
      return "all";
    default: {
      const _exhaustive: never = scope;
      return _exhaustive;
    }
  }
}

function cycleErrorSeverity(level: ErrorSeverityFilter): ErrorSeverityFilter {
  switch (level) {
    case "all":
      return "error";
    case "error":
      return "warning";
    case "warning":
      return "all";
    default: {
      const _exhaustive: never = level;
      return _exhaustive;
    }
  }
}

function cycleStatsMode(mode: StatsBreakdownMode): StatsBreakdownMode {
  switch (mode) {
    case "by-plugin":
      return "by-marketplace";
    case "by-marketplace":
      return "by-scope";
    case "by-scope":
      return "by-plugin";
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

function applyActionCommand(
  state: TuiState,
  cmd: ActionCommand,
): readonly [TuiState, readonly TuiEffect[]] {
  switch (cmd.kind) {
    case "open-overlay":
      return [{ ...state, overlay: cmd.overlay }, []];
    case "mutate":
      return startMutation(state, cmd.mutation);
    case "rescan":
      return startRescan(state);
    case "cycle-discover-filter":
      return [{ ...state, discoverFilter: cycleDiscoverFilter(state.discoverFilter) }, []];
    case "cycle-installed-scope":
      return [
        { ...state, installedScopeFilter: cycleInstalledScope(state.installedScopeFilter) },
        [],
      ];
    case "cycle-error-severity":
      return [
        { ...state, errorSeverityFilter: cycleErrorSeverity(state.errorSeverityFilter) },
        [],
      ];
    case "cycle-stats-mode":
      return [{ ...state, statsMode: cycleStatsMode(state.statsMode) }, []];
    case "focus-search":
      return isSearchableTab(state.activeTab)
        ? [{ ...state, overlay: { kind: "search-input" } }, []]
        : [state, []];
    default: {
      const _exhaustive: never = cmd;
      return _exhaustive;
    }
  }
}

function cycleFocus<T extends string>(
  items: readonly T[],
  current: T,
  delta: 1 | -1,
): T {
  const idx = items.indexOf(current);
  if (idx === -1) {
    return items[0] ?? current;
  }
  const nextIdx = (idx + delta + items.length) % items.length;
  return items[nextIdx] ?? current;
}

function summarizeMutationOutcome(outcome: MutationOutcome): {
  readonly tone: "success" | "warning" | "error";
  readonly text: string;
} {
  switch (outcome.kind) {
    case "install": {
      if (!outcome.result.ok) {
        return { tone: "error", text: formatEngineError(outcome.result.error) };
      }
      const { report } = outcome.result;
      const warnSuffix =
        report.warnings.length > 0 ? ` (${report.warnings.length} warning(s))` : "";
      return {
        tone: report.warnings.length > 0 ? "warning" : "success",
        text: `${report.outcome === "installed" ? "Installed" : "Updated"} ${report.pluginName} (${report.scope})${warnSuffix}.`,
      };
    }
    case "uninstall": {
      if (!outcome.result.ok) {
        return { tone: "error", text: formatEngineError(outcome.result.error) };
      }
      return {
        tone: "success",
        text: `Removed ${outcome.result.report.pluginId}.`,
      };
    }
    case "set-enabled": {
      if (!outcome.result.ok) {
        return { tone: "error", text: formatEngineError(outcome.result.error) };
      }
      const { report } = outcome.result;
      return {
        tone: "success",
        text: `${report.enabled ? "Enabled" : "Disabled"} ${report.pluginId}.`,
      };
    }
    case "update": {
      if (!outcome.result.ok) {
        return { tone: "error", text: formatEngineError(outcome.result.error) };
      }
      const outcomes = outcome.result.report.outcomes;
      const updated = outcomes.filter((o) => o.status === "updated").length;
      const failed = outcomes.filter((o) => o.status === "failed").length;
      if (failed > 0) {
        return {
          tone: "warning",
          text: `Updated ${updated}, failed ${failed} plugin(s).`,
        };
      }
      return {
        tone: "success",
        text:
          updated > 0
            ? `Updated ${updated} plugin(s).`
            : "All targeted plugins are up to date.",
      };
    }
    case "add-marketplace": {
      if (!outcome.result.ok) {
        return { tone: "error", text: formatEngineError(outcome.result.error) };
      }
      const sync = outcome.result.report.outcome;
      if (sync.status === "failed") {
        return {
          tone: "error",
          text: `Added ${sync.marketplaceId} but sync failed: ${sync.reason ?? "unknown error"}`,
        };
      }
      return {
        tone: "success",
        text: `Added marketplace ${sync.marketplaceId} (${sync.pluginCount} plugins).`,
      };
    }
    case "sync-marketplaces": {
      if (!outcome.result.ok) {
        return { tone: "error", text: formatEngineError(outcome.result.error) };
      }
      const outcomes = outcome.result.report.outcomes;
      const synced = outcomes.filter((o) => o.status === "synced").length;
      const failed = outcomes.filter((o) => o.status === "failed").length;
      if (failed > 0) {
        return {
          tone: "warning",
          text: `Synced ${synced} marketplace(s), ${failed} failed.`,
        };
      }
      return {
        tone: "success",
        text: `Synced ${synced} marketplace(s).`,
      };
    }
    case "remove-marketplace": {
      if (!outcome.result.ok) {
        return { tone: "error", text: formatEngineError(outcome.result.error) };
      }
      return {
        tone: "success",
        text: `Removed marketplace ${outcome.result.report.id}.`,
      };
    }
    case "remediate": {
      if (!outcome.result.ok) {
        return { tone: "error", text: formatEngineError(outcome.result.error) };
      }
      const { report } = outcome.result;
      switch (report.kind) {
        case "readapted-bundle":
          return { tone: "success", text: `Re-adapted bundle ${report.pluginId}.` };
        case "disabled-plugin":
          return { tone: "success", text: `Disabled colliding plugin ${report.pluginId}.` };
        case "removed-plugin":
          return { tone: "success", text: `Removed unsafe plugin ${report.pluginId}.` };
        case "cleaned-stale-staging":
          return {
            tone: "success",
            text: `Cleaned ${report.removedPaths.length} stale staging path(s).`,
          };
        case "retried-marketplace-sync":
          return report.outcome.status === "synced"
            ? {
                tone: "success",
                text: `Synced ${report.outcome.marketplaceId} (${report.outcome.pluginCount} plugins).`,
              }
            : {
                tone: "error",
                text: `Sync retry failed for ${report.outcome.marketplaceId}: ${report.outcome.reason ?? "error"}`,
              };
        default: {
          const _exhaustive: never = report;
          return _exhaustive;
        }
      }
    }
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function submitAddMarketplace(
  state: TuiState,
  overlay: Extract<OverlayState, { readonly kind: "add-marketplace" }>,
): readonly [TuiState, readonly TuiEffect[]] {
  if (overlay.preview.kind === "empty") {
    return [
      withToast(
        { ...state, overlay: { ...overlay, focusedField: "source" } },
        "error",
        "Enter a GitHub repo, SSH URL, HTTPS URL, or local path.",
      ),
      [],
    ];
  }
  if (overlay.preview.kind === "invalid") {
    return [
      withToast(
        { ...state, overlay: { ...overlay, focusedField: "source" } },
        "error",
        overlay.preview.message,
      ),
      [],
    ];
  }

  let customId: MarketplaceId | undefined;
  if (overlay.idInput.value.trim().length > 0) {
    const parsedId = parseMarketplaceId(overlay.idInput.value);
    if (!parsedId.ok) {
      return [
        withToast(
          { ...state, overlay: { ...overlay, focusedField: "id" } },
          "error",
          parsedId.error.message,
        ),
        [],
      ];
    }
    customId = parsedId.value;
  }

  const targetId = customId ?? overlay.preview.suggestedId;
  return startMutation(state, {
    kind: "add-marketplace",
    input: customId !== undefined ? { source: overlay.preview.source, id: customId } : { source: overlay.preview.source },
    label: `Adding marketplace ${targetId}`,
  });
}

function moveTableCursor(
  state: TuiState,
  delta: number,
  mode: "relative" | "home" | "end",
): TuiState {
  const prepared = TAB_REGISTRY[state.activeTab].prepare(state);
  if (prepared.rowCount === 0) {
    return state;
  }
  const current = resolveActiveSelectedIndex(state, prepared);
  const base = current < 0 ? 0 : current;
  let nextIdx = base;
  if (mode === "home") {
    nextIdx = 0;
  } else if (mode === "end") {
    nextIdx = prepared.rowCount - 1;
  } else {
    nextIdx = Math.max(0, Math.min(prepared.rowCount - 1, base + delta));
  }
  return updateActiveTabCursor(state, nextIdx, prepared.rowKeyAt(nextIdx));
}

function reduceTableKey(
  state: TuiState,
  key: KeyEvent,
): readonly [TuiState, readonly TuiEffect[]] {
  if (key.kind === "char" && key.ch === "?") {
    return [{ ...state, overlay: { kind: "help", returnOverlay: { kind: "none" } } }, []];
  }

  if (key.kind === "left" || key.kind === "shift-tab") {
    const idx = TAB_IDS.indexOf(state.activeTab);
    const prevIdx = (idx - 1 + TAB_IDS.length) % TAB_IDS.length;
    const nextTab = TAB_IDS[prevIdx] ?? "discover";
    return [{ ...state, activeTab: nextTab }, []];
  }

  if (key.kind === "right" || key.kind === "tab") {
    const idx = TAB_IDS.indexOf(state.activeTab);
    const nextIdx = (idx + 1) % TAB_IDS.length;
    const nextTab = TAB_IDS[nextIdx] ?? "discover";
    return [{ ...state, activeTab: nextTab }, []];
  }

  if (key.kind === "char") {
    const tabMap: Readonly<Record<string, TabId>> = {
      "1": "discover",
      "2": "installed",
      "3": "marketplaces",
      "4": "errors",
      "5": "stats",
    };
    const jumped = tabMap[key.ch];
    if (jumped !== undefined) {
      return [{ ...state, activeTab: jumped }, []];
    }
  }

  if (key.kind === "char" && key.ch === "/") {
    if (isSearchableTab(state.activeTab)) {
      return [{ ...state, overlay: { kind: "search-input" } }, []];
    }
    return [state, []];
  }

  if (key.kind === "up" || (key.kind === "char" && key.ch === "k")) {
    return [moveTableCursor(state, -1, "relative"), []];
  }
  if (key.kind === "down" || (key.kind === "char" && key.ch === "j")) {
    return [moveTableCursor(state, 1, "relative"), []];
  }
  if (key.kind === "page-up") {
    return [moveTableCursor(state, -PAGE_STEP, "relative"), []];
  }
  if (key.kind === "page-down") {
    return [moveTableCursor(state, PAGE_STEP, "relative"), []];
  }
  if (key.kind === "home") {
    return [moveTableCursor(state, 0, "home"), []];
  }
  if (key.kind === "end") {
    return [moveTableCursor(state, 0, "end"), []];
  }

  if (key.kind === "escape") {
    if (isSearchableTab(state.activeTab) && state.searchByTab[state.activeTab].value.length > 0) {
      return [withSearchInput(state, state.activeTab, EMPTY_TEXT_INPUT), []];
    }
    return [state, [{ kind: "exit", code: 0 }]];
  }

  if (key.kind === "char" && key.ch === "q") {
    return [state, [{ kind: "exit", code: 0 }]];
  }

  const prepared = TAB_REGISTRY[state.activeTab].prepare(state);
  const selectedIndex = resolveActiveSelectedIndex(state, prepared);
  const pinnedState =
    selectedIndex >= 0
      ? updateActiveTabCursor(state, selectedIndex, prepared.rowKeyAt(selectedIndex))
      : state;
  const cmd = prepared.dispatchKeyAt(selectedIndex, key);
  if (cmd !== null) {
    return applyActionCommand(pinnedState, cmd);
  }
  return [state, []];
}

function reduceKey(
  state: TuiState,
  key: KeyEvent,
  env: ReduceEnv,
): readonly [TuiState, readonly TuiEffect[]] {
  if (key.kind === "ctrl-c") {
    return [state, [{ kind: "exit", code: 0 }]];
  }

  const { overlay } = state;

  switch (overlay.kind) {
    case "none":
      return reduceTableKey(state, key);

    case "search-input": {
      if (!isSearchableTab(state.activeTab)) {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      if (key.kind === "enter") {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      if (key.kind === "escape") {
        return [
          withSearchInput({ ...state, overlay: { kind: "none" } }, state.activeTab, EMPTY_TEXT_INPUT),
          [],
        ];
      }
      if (key.kind === "up") {
        return [moveTableCursor({ ...state, overlay: { kind: "none" } }, -1, "relative"), []];
      }
      if (key.kind === "down") {
        return [moveTableCursor({ ...state, overlay: { kind: "none" } }, 1, "relative"), []];
      }
      const current = getSearchInput(state, state.activeTab);
      const edited = reduceTextInput(current, key);
      if (edited.handled) {
        return [withSearchInput(state, state.activeTab, edited.next), []];
      }
      return [state, []];
    }

    case "discover-detail": {
      const entry = state.snapshot.catalogById.get(overlay.entryId);
      if (entry === undefined) {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      if (key.kind === "escape" || (key.kind === "char" && key.ch === "q")) {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      if (key.kind === "tab" || key.kind === "right") {
        const nextBtn = cycleFocus(["primary", "scope", "close"] as const, overlay.focusedButton, 1);
        return [{ ...state, overlay: { ...overlay, focusedButton: nextBtn } }, []];
      }
      if (key.kind === "shift-tab" || key.kind === "left") {
        const prevBtn = cycleFocus(
          ["primary", "scope", "close"] as const,
          overlay.focusedButton,
          -1,
        );
        return [{ ...state, overlay: { ...overlay, focusedButton: prevBtn } }, []];
      }
      if (key.kind === "char" && key.ch === "s") {
        const nextScope: InstallScope = overlay.targetScope === "user" ? "project" : "user";
        return [{ ...state, overlay: { ...overlay, targetScope: nextScope } }, []];
      }
      if (key.kind === "enter") {
        if (overlay.focusedButton === "close") {
          return [{ ...state, overlay: { kind: "none" } }, []];
        }
        if (overlay.focusedButton === "scope") {
          const nextScope: InstallScope = overlay.targetScope === "user" ? "project" : "user";
          return [{ ...state, overlay: { ...overlay, targetScope: nextScope } }, []];
        }
        const installedInScope = findInstalledForEntryInScope(
          state.snapshot,
          entry,
          overlay.targetScope,
        );
        if (installedInScope !== undefined) {
          return startMutation(state, {
            kind: "uninstall",
            input: { selector: { kind: "id", id: installedInScope.id } },
            label: `Uninstalling ${installedInScope.id}`,
          });
        }
        return startMutation(state, {
          kind: "install",
          input: {
            target: { kind: "catalog-entry", entryId: entry.id },
            scope: overlay.targetScope,
          },
          label: `Installing ${entry.name} (${overlay.targetScope})`,
        });
      }
      return [state, []];
    }

    case "installed-detail": {
      const plugin = state.snapshot.installedById.get(overlay.pluginId);
      if (plugin === undefined) {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      if (key.kind === "escape" || (key.kind === "char" && key.ch === "q")) {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      const actions: readonly ("toggle" | "update" | "uninstall" | "close")[] =
        plugin.kind === "valid"
          ? plugin.provenance.kind !== "unmanaged"
            ? ["toggle", "update", "uninstall", "close"]
            : ["toggle", "uninstall", "close"]
          : ["uninstall", "close"];

      if (key.kind === "tab" || key.kind === "right") {
        const nextAction = cycleFocus(actions, overlay.focusedAction, 1);
        return [{ ...state, overlay: { ...overlay, focusedAction: nextAction } }, []];
      }
      if (key.kind === "shift-tab" || key.kind === "left") {
        const prevAction = cycleFocus(actions, overlay.focusedAction, -1);
        return [{ ...state, overlay: { ...overlay, focusedAction: prevAction } }, []];
      }

      const runAction = (
        action: "toggle" | "update" | "uninstall" | "close",
      ): readonly [TuiState, readonly TuiEffect[]] => {
        if (action === "close") {
          return [{ ...state, overlay: { kind: "none" } }, []];
        }
        if (action === "toggle" && plugin.kind === "valid") {
          const enable = plugin.activation.kind === "disabled";
          return startMutation(state, {
            kind: "set-enabled",
            input: { selector: { kind: "id", id: plugin.id }, enabled: enable },
            label: `${enable ? "Enabling" : "Disabling"} ${plugin.manifest.name}`,
          });
        }
        if (action === "update" && plugin.provenance.kind !== "unmanaged") {
          return startMutation(state, {
            kind: "update",
            input: { kind: "single", selector: { kind: "id", id: plugin.id } },
            label: `Updating ${plugin.id}`,
          });
        }
        if (action === "uninstall") {
          const name = plugin.kind === "valid" ? plugin.manifest.name : plugin.dirName;
          return [
            {
              ...state,
              overlay: {
                kind: "confirm",
                title: "Uninstall plugin",
                message: `Remove "${name}" (${plugin.id}) from ${plugin.installPath}?`,
                confirmLabel: "Uninstall",
                mutation: {
                  kind: "uninstall",
                  input: { selector: { kind: "id", id: plugin.id } },
                  label: `Uninstalling ${plugin.id}`,
                },
                returnOverlay: overlay,
                focusedChoice: "cancel",
              },
            },
            [],
          ];
        }
        return [state, []];
      };

      if (key.kind === "char" && key.ch === " ") {
        return runAction("toggle");
      }
      if (key.kind === "char" && key.ch === "u") {
        return runAction("update");
      }
      if (key.kind === "char" && key.ch === "x") {
        return runAction("uninstall");
      }
      if (key.kind === "enter") {
        return runAction(overlay.focusedAction);
      }
      return [state, []];
    }

    case "marketplace-detail": {
      const mkt = state.snapshot.marketplacesById.get(overlay.marketplaceId);
      if (mkt === undefined) {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      if (key.kind === "escape" || (key.kind === "char" && key.ch === "q")) {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      const actions = ["update", "remove", "close"] as const;
      if (key.kind === "tab" || key.kind === "right") {
        return [
          {
            ...state,
            overlay: { ...overlay, focusedAction: cycleFocus(actions, overlay.focusedAction, 1) },
          },
          [],
        ];
      }
      if (key.kind === "shift-tab" || key.kind === "left") {
        return [
          {
            ...state,
            overlay: {
              ...overlay,
              focusedAction: cycleFocus(actions, overlay.focusedAction, -1),
            },
          },
          [],
        ];
      }
      const runMktAction = (
        action: "update" | "remove" | "close",
      ): readonly [TuiState, readonly TuiEffect[]] => {
        if (action === "close") {
          return [{ ...state, overlay: { kind: "none" } }, []];
        }
        if (action === "update") {
          return startMutation(state, {
            kind: "sync-marketplaces",
            input: { kind: "single", id: mkt.id },
            label: `Syncing marketplace ${mkt.id}`,
          });
        }
        return [
          {
            ...state,
            overlay: {
              kind: "confirm",
              title: "Remove marketplace",
              message: `Remove marketplace "${mkt.id}" and its local mirror? Installed plugins remain untouched.`,
              confirmLabel: "Remove",
              mutation: {
                kind: "remove-marketplace",
                input: { id: mkt.id },
                label: `Removing marketplace ${mkt.id}`,
              },
              returnOverlay: overlay,
              focusedChoice: "cancel",
            },
          },
          [],
        ];
      };
      if (key.kind === "char" && key.ch === "u") {
        return runMktAction("update");
      }
      if (key.kind === "char" && key.ch === "d") {
        return runMktAction("remove");
      }
      if (key.kind === "enter") {
        return runMktAction(overlay.focusedAction);
      }
      return [state, []];
    }

    case "add-marketplace": {
      if (key.kind === "escape") {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      const fields = ["source", "id", "submit", "cancel"] as const;
      if (key.kind === "tab" || key.kind === "down") {
        return [
          {
            ...state,
            overlay: { ...overlay, focusedField: cycleFocus(fields, overlay.focusedField, 1) },
          },
          [],
        ];
      }
      if (key.kind === "shift-tab" || key.kind === "up") {
        return [
          {
            ...state,
            overlay: { ...overlay, focusedField: cycleFocus(fields, overlay.focusedField, -1) },
          },
          [],
        ];
      }

      if (overlay.focusedField === "source") {
        if (key.kind === "enter") {
          return submitAddMarketplace(state, overlay);
        }
        const edited = reduceTextInput(overlay.sourceInput, key);
        if (edited.handled) {
          const preview = computeAddMarketplacePreview(edited.next.value, env);
          return [
            {
              ...state,
              overlay: { ...overlay, sourceInput: edited.next, preview },
            },
            [],
          ];
        }
        return [state, []];
      }

      if (overlay.focusedField === "id") {
        if (key.kind === "enter") {
          return submitAddMarketplace(state, overlay);
        }
        const edited = reduceTextInput(overlay.idInput, key);
        if (edited.handled) {
          return [{ ...state, overlay: { ...overlay, idInput: edited.next } }, []];
        }
        return [state, []];
      }

      if (key.kind === "left" || key.kind === "right") {
        const toggled = overlay.focusedField === "submit" ? "cancel" : "submit";
        return [{ ...state, overlay: { ...overlay, focusedField: toggled } }, []];
      }

      if (key.kind === "enter" || (key.kind === "char" && key.ch === " ")) {
        if (overlay.focusedField === "cancel") {
          return [{ ...state, overlay: { kind: "none" } }, []];
        }
        return submitAddMarketplace(state, overlay);
      }

      return [state, []];
    }

    case "diagnostic-detail": {
      const diag = state.snapshot.diagnosticsById.get(overlay.diagnosticId);
      if (diag === undefined) {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      if (key.kind === "escape" || (key.kind === "char" && key.ch === "q")) {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      if (diag.remediation !== undefined) {
        if (
          key.kind === "tab" ||
          key.kind === "shift-tab" ||
          key.kind === "left" ||
          key.kind === "right"
        ) {
          const next = overlay.focusedAction === "fix" ? "close" : "fix";
          return [{ ...state, overlay: { ...overlay, focusedAction: next } }, []];
        }
        if (key.kind === "char" && key.ch === "f") {
          return startMutation(state, {
            kind: "remediate",
            input: { plan: diag.remediation },
            label: diag.remediation.label,
          });
        }
        if (key.kind === "enter" && overlay.focusedAction === "fix") {
          return startMutation(state, {
            kind: "remediate",
            input: { plan: diag.remediation },
            label: diag.remediation.label,
          });
        }
      }
      if (key.kind === "enter") {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      return [state, []];
    }

    case "confirm": {
      if (key.kind === "escape" || (key.kind === "char" && (key.ch === "n" || key.ch === "N"))) {
        return [{ ...state, overlay: overlay.returnOverlay }, []];
      }
      if (
        key.kind === "tab" ||
        key.kind === "shift-tab" ||
        key.kind === "left" ||
        key.kind === "right"
      ) {
        const nextChoice = overlay.focusedChoice === "confirm" ? "cancel" : "confirm";
        return [{ ...state, overlay: { ...overlay, focusedChoice: nextChoice } }, []];
      }
      if (key.kind === "char" && (key.ch === "y" || key.ch === "Y")) {
        return startMutation(state, overlay.mutation, { kind: "none" });
      }
      if (key.kind === "enter") {
        if (overlay.focusedChoice === "confirm") {
          return startMutation(state, overlay.mutation, { kind: "none" });
        }
        return [{ ...state, overlay: overlay.returnOverlay }, []];
      }
      return [state, []];
    }

    case "help": {
      if (
        key.kind === "escape" ||
        key.kind === "enter" ||
        (key.kind === "char" && (key.ch === "q" || key.ch === "?"))
      ) {
        return [{ ...state, overlay: overlay.returnOverlay }, []];
      }
      return [state, []];
    }

    default: {
      const _exhaustive: never = overlay;
      return _exhaustive;
    }
  }
}

export function reduce(
  state: TuiState,
  event: TuiEvent,
  env: ReduceEnv,
): readonly [TuiState, readonly TuiEffect[]] {
  switch (event.kind) {
    case "key":
      return reduceKey(state, event.key, env);

    case "resize":
      return [state, []];

    case "spinner-tick":
      if (state.pending.kind !== "running") {
        return [state, []];
      }
      return [{ ...state, spinnerTick: (state.spinnerTick + 1) % 1000 }, []];

    case "dismiss-toast":
      if (state.toast === null) {
        return [state, []];
      }
      return [{ ...state, toast: null }, []];

    case "rescan-finished": {
      if (event.snapshot.revision < state.snapshot.revision) {
        return [state, []];
      }
      const clearsPending =
        state.pending.kind === "running" && state.pending.requestId === event.requestId;
      const nextState: TuiState = {
        ...state,
        snapshot: event.snapshot,
        pending: clearsPending ? { kind: "idle" } : state.pending,
      };
      return [withToast(nextState, "info", "Workspace refreshed."), []];
    }

    case "rescan-failed": {
      const clearsPending =
        state.pending.kind === "running" && state.pending.requestId === event.requestId;
      if (!clearsPending) {
        return [state, []];
      }
      return [
        withToast({ ...state, pending: { kind: "idle" } }, "error", event.message),
        [],
      ];
    }

    case "mutation-finished": {
      const resultSnapshot = event.outcome.result.snapshot;
      if (resultSnapshot.revision < state.snapshot.revision) {
        return [state, []];
      }
      const clearsPending =
        state.pending.kind === "running" && state.pending.requestId === event.requestId;
      const summary = summarizeMutationOutcome(event.outcome);

      let nextOverlay = state.overlay;
      if (event.outcome.result.ok) {
        if (
          state.overlay.kind === "add-marketplace" ||
          state.overlay.kind === "discover-detail" ||
          state.overlay.kind === "diagnostic-detail" ||
          state.overlay.kind === "confirm"
        ) {
          nextOverlay = { kind: "none" };
        } else if (
          state.overlay.kind === "installed-detail" &&
          resultSnapshot.installedById.get(state.overlay.pluginId) === undefined
        ) {
          nextOverlay = { kind: "none" };
        } else if (
          state.overlay.kind === "marketplace-detail" &&
          resultSnapshot.marketplacesById.get(state.overlay.marketplaceId) === undefined
        ) {
          nextOverlay = { kind: "none" };
        }
      }

      const nextState: TuiState = {
        ...state,
        snapshot: resultSnapshot,
        overlay: nextOverlay,
        pending: clearsPending ? { kind: "idle" } : state.pending,
      };
      return [withToast(nextState, summary.tone, summary.text), []];
    }

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

export function computeFooterHints(
  state: TuiState,
  prepared: PreparedTabView,
  selectedIndex: number,
): readonly KeyHint[] {
  const { overlay } = state;

  switch (overlay.kind) {
    case "none": {
      const hints: KeyHint[] = [
        { keys: "←/→", label: "switch tabs" },
        { keys: "↑/↓", label: "move" },
      ];
      if (prepared.searchable) {
        hints.push({ keys: "/", label: "search" });
      }
      hints.push(...prepared.hintsForIndex(selectedIndex));
      hints.push({ keys: "?", label: "help" });
      const hasSearch =
        isSearchableTab(state.activeTab) && state.searchByTab[state.activeTab].value.length > 0;
      hints.push({ keys: "Esc", label: hasSearch ? "clear" : "close" });
      return hints;
    }
    case "search-input":
      return [
        { keys: "Type", label: "filter" },
        { keys: "Enter", label: "keep filter" },
        { keys: "Ctrl+U", label: "clear" },
        { keys: "Esc", label: "reset" },
      ];
    case "discover-detail":
      return [
        { keys: "Tab/←/→", label: "focus button" },
        { keys: "s", label: "scope" },
        { keys: "Enter", label: "run focused action" },
        { keys: "Esc", label: "back" },
      ];
    case "installed-detail":
      return [
        { keys: "Tab/←/→", label: "focus action" },
        { keys: "Space", label: "toggle" },
        { keys: "Enter", label: "run focused action" },
        { keys: "Esc", label: "back" },
      ];
    case "marketplace-detail":
      return [
        { keys: "Tab/←/→", label: "focus action" },
        { keys: "u", label: "update" },
        { keys: "d", label: "remove" },
        { keys: "Enter", label: "run" },
        { keys: "Esc", label: "back" },
      ];
    case "add-marketplace":
      return [
        { keys: "Tab/↑/↓", label: "next field" },
        { keys: "Enter", label: "submit" },
        { keys: "Esc", label: "cancel" },
      ];
    case "diagnostic-detail": {
      const diag = state.snapshot.diagnosticsById.get(overlay.diagnosticId);
      const hints: KeyHint[] = [];
      if (diag?.remediation !== undefined) {
        hints.push({ keys: "Tab/←/→", label: "focus button" });
        hints.push({ keys: "f", label: "fix" });
      }
      hints.push({ keys: "Enter", label: "run" });
      hints.push({ keys: "Esc", label: "back" });
      return hints;
    }
    case "confirm":
      return [
        { keys: "Tab/←/→", label: "choose" },
        { keys: "y", label: "confirm" },
        { keys: "Enter", label: "run" },
        { keys: "Esc", label: "cancel" },
      ];
    case "help":
      return [{ keys: "Esc/Enter", label: "close help" }];
    default: {
      const _exhaustive: never = overlay;
      return _exhaustive;
    }
  }
}
