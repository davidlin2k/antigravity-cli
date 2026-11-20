import {
  isCatalogEntryId,
  isDiagnosticId,
  isInstalledPluginId,
  isMarketplaceId,
} from "../domain/types.ts";
import type { KeyEvent } from "./keys.ts";
import {
  computeModalFooterHints,
  findInstalledForEntryInScope,
  findSameNameCollisionInScope,
  reduceModalKey,
} from "./reduce-modals.ts";
import type { ReduceEnv } from "./reduce-modals.ts";
import {
  clearOverlayRequestId,
  hasMatchingOverlayRequestId,
  startMutation,
  startRescan,
  summarizeMutationOutcome,
  withToast,
} from "./reduce-mutations.ts";
import {
  EMPTY_TEXT_INPUT,
  TAB_IDS,
  reduceTextInput,
  resolveSelectedIndex,
} from "./state.ts";
import type {
  DiscoverFilterMode,
  ErrorSeverityFilter,
  InstalledScopeFilter,
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

export { findInstalledForEntryInScope, findSameNameCollisionInScope };
export type { ReduceEnv };

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

    default:
      return reduceModalKey(state, overlay, key, env);
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
      const overlayInitiated = hasMatchingOverlayRequestId(state.overlay, event.requestId);

      let nextOverlay = state.overlay;
      if (event.outcome.result.ok) {
        if (state.overlay.kind === "add-marketplace" && overlayInitiated) {
          nextOverlay = { kind: "none" };
        } else if (
          state.overlay.kind === "discover-detail" &&
          (overlayInitiated ||
            resultSnapshot.catalogById.get(state.overlay.entryId) === undefined)
        ) {
          nextOverlay = { kind: "none" };
        } else if (
          state.overlay.kind === "diagnostic-detail" &&
          (overlayInitiated ||
            resultSnapshot.diagnosticsById.get(state.overlay.diagnosticId) === undefined)
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
        } else {
          nextOverlay = clearOverlayRequestId(state.overlay, event.requestId);
        }
      } else {
        nextOverlay = clearOverlayRequestId(state.overlay, event.requestId);
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
    default:
      return computeModalFooterHints(state, overlay);
  }
}
