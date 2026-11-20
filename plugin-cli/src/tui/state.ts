import type {
  CatalogEntryId,
  DiagnosticId,
  DiagnosticSeverity,
  EngineError,
  InstalledPluginId,
  InstallScope,
  MarketplaceId,
  ParsedMarketplaceInput,
  RequestId,
  WorkspaceSnapshot,
} from "../domain/types.ts";
import { makeRequestId } from "../domain/types.ts";
import type {
  AddMarketplaceInput,
  BulkSyncReport,
  InstallPluginInput,
  InstallReport,
  MarketplaceSyncReport,
  RemediateInput,
  RemediateReport,
  RemoveMarketplaceInput,
  RemoveMarketplaceReport,
  SetPluginEnabledInput,
  ToggleReport,
  UninstallPluginInput,
  UninstallReport,
  UpdatePluginsInput,
  UpdateReport,
} from "../engine/contract.ts";
import type { EngineResult } from "../domain/types.ts";
import { sanitizeInputText, splitGraphemes } from "./ansi.ts";
import type { KeyEvent } from "./ansi.ts";

export const TAB_IDS = ["discover", "installed", "marketplaces", "errors", "stats"] as const;
export type TabId = (typeof TAB_IDS)[number];

export type SearchableTabId = "discover" | "installed" | "marketplaces" | "errors";

export type DiscoverFilterMode = "all" | "available" | "installed";
export type InstalledScopeFilter = "all" | InstallScope;
export type ErrorSeverityFilter = "all" | DiagnosticSeverity;
export type StatsBreakdownMode = "by-plugin" | "by-marketplace" | "by-scope";

export interface TextInputState {
  readonly value: string;
  readonly cursor: number;
}

export const EMPTY_TEXT_INPUT: TextInputState = { value: "", cursor: 0 };

export interface TableCursorState<TId extends string = string> {
  readonly selectedId: TId | null;
  readonly fallbackIndex: number;
  readonly scrollOffset: number;
}

export function createEmptyCursor<TId extends string>(): TableCursorState<TId> {
  return { selectedId: null, fallbackIndex: 0, scrollOffset: 0 };
}

export function resolveSelectedIndex<TRow, TId extends string>(
  cursor: TableCursorState<TId>,
  rows: readonly TRow[],
  rowKey: (row: TRow) => TId,
): number {
  if (rows.length === 0) {
    return -1;
  }
  if (cursor.selectedId !== null) {
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (row !== undefined && rowKey(row) === cursor.selectedId) {
        return i;
      }
    }
  }
  return Math.max(0, Math.min(rows.length - 1, cursor.fallbackIndex));
}

export type PendingMutationSpec =
  | { readonly kind: "install"; readonly input: InstallPluginInput; readonly label: string }
  | { readonly kind: "uninstall"; readonly input: UninstallPluginInput; readonly label: string }
  | { readonly kind: "set-enabled"; readonly input: SetPluginEnabledInput; readonly label: string }
  | { readonly kind: "update"; readonly input: UpdatePluginsInput; readonly label: string }
  | { readonly kind: "add-marketplace"; readonly input: AddMarketplaceInput; readonly label: string }
  | { readonly kind: "sync-marketplaces"; readonly input: { readonly kind: "single"; readonly id: MarketplaceId } | { readonly kind: "all" }; readonly label: string }
  | { readonly kind: "remove-marketplace"; readonly input: RemoveMarketplaceInput; readonly label: string }
  | { readonly kind: "remediate"; readonly input: RemediateInput; readonly label: string };

export type MutationOutcome =
  | { readonly kind: "install"; readonly result: EngineResult<InstallReport> }
  | { readonly kind: "uninstall"; readonly result: EngineResult<UninstallReport> }
  | { readonly kind: "set-enabled"; readonly result: EngineResult<ToggleReport> }
  | { readonly kind: "update"; readonly result: EngineResult<UpdateReport> }
  | { readonly kind: "add-marketplace"; readonly result: EngineResult<MarketplaceSyncReport> }
  | { readonly kind: "sync-marketplaces"; readonly result: EngineResult<BulkSyncReport> }
  | { readonly kind: "remove-marketplace"; readonly result: EngineResult<RemoveMarketplaceReport> }
  | { readonly kind: "remediate"; readonly result: EngineResult<RemediateReport> };

export type AddMarketplacePreview =
  | { readonly kind: "empty" }
  | {
      readonly kind: "valid";
      readonly source: ParsedMarketplaceInput;
      readonly suggestedId: MarketplaceId;
    }
  | { readonly kind: "invalid"; readonly message: string };

export type OverlayState =
  | { readonly kind: "none" }
  | { readonly kind: "search-input" }
  | {
      readonly kind: "discover-detail";
      readonly entryId: CatalogEntryId;
      readonly targetScope: InstallScope;
      readonly focusedButton: "primary" | "scope" | "close";
      readonly pendingRequestId?: RequestId;
    }
  | {
      readonly kind: "installed-detail";
      readonly pluginId: InstalledPluginId;
      readonly focusedAction: "toggle" | "update" | "uninstall" | "close";
      readonly pendingRequestId?: RequestId;
    }
  | {
      readonly kind: "marketplace-detail";
      readonly marketplaceId: MarketplaceId;
      readonly focusedAction: "update" | "remove" | "close";
      readonly pendingRequestId?: RequestId;
    }
  | {
      readonly kind: "add-marketplace";
      readonly sourceInput: TextInputState;
      readonly idInput: TextInputState;
      readonly focusedField: "source" | "id" | "submit" | "cancel";
      readonly preview: AddMarketplacePreview;
      readonly pendingRequestId?: RequestId;
    }
  | {
      readonly kind: "diagnostic-detail";
      readonly diagnosticId: DiagnosticId;
      readonly focusedAction: "fix" | "close";
      readonly pendingRequestId?: RequestId;
    }
  | {
      readonly kind: "confirm";
      readonly title: string;
      readonly message: string;
      readonly confirmLabel: string;
      readonly mutation: PendingMutationSpec;
      readonly returnOverlay: OverlayState;
      readonly focusedChoice: "confirm" | "cancel";
    }
  | {
      readonly kind: "help";
      readonly returnOverlay: OverlayState;
    };

export type PendingOperation =
  | { readonly kind: "idle" }
  | { readonly kind: "running"; readonly requestId: RequestId; readonly label: string };

export interface ToastMessage {
  readonly tone: "info" | "success" | "warning" | "error";
  readonly text: string;
  readonly id: number;
}

export interface Viewport {
  readonly cols: number;
  readonly rows: number;
}

export interface CursorPosition {
  readonly row: number;
  readonly col: number;
  readonly visible: boolean;
}

export interface RenderedFrame {
  readonly viewport: Viewport;
  readonly lines: readonly string[];
  readonly cursor: CursorPosition | null;
}

export interface TabCursorMap {
  readonly discover: TableCursorState<CatalogEntryId>;
  readonly installed: TableCursorState<InstalledPluginId>;
  readonly marketplaces: TableCursorState<MarketplaceId>;
  readonly errors: TableCursorState<DiagnosticId>;
  readonly stats: TableCursorState<string>;
}

export interface TuiState {
  readonly snapshot: WorkspaceSnapshot;
  readonly activeTab: TabId;
  readonly searchByTab: Readonly<Record<SearchableTabId, TextInputState>>;
  readonly discoverFilter: DiscoverFilterMode;
  readonly installedScopeFilter: InstalledScopeFilter;
  readonly errorSeverityFilter: ErrorSeverityFilter;
  readonly statsMode: StatsBreakdownMode;
  readonly cursors: TabCursorMap;
  readonly overlay: OverlayState;
  readonly pending: PendingOperation;
  readonly nextRequestId: RequestId;
  readonly spinnerTick: number;
  readonly toast: ToastMessage | null;
  readonly nextToastId: number;
  readonly defaultInstallScope: InstallScope;
  readonly colorEnabled: boolean;
}

export type TuiEvent =
  | { readonly kind: "key"; readonly key: KeyEvent }
  | { readonly kind: "resize"; readonly viewport: Viewport }
  | { readonly kind: "spinner-tick" }
  | { readonly kind: "dismiss-toast" }
  | {
      readonly kind: "mutation-finished";
      readonly requestId: RequestId;
      readonly label: string;
      readonly outcome: MutationOutcome;
    }
  | {
      readonly kind: "rescan-finished";
      readonly requestId: RequestId;
      readonly snapshot: WorkspaceSnapshot;
    }
  | {
      readonly kind: "rescan-failed";
      readonly requestId: RequestId;
      readonly message: string;
    };

export type TuiEffect =
  | {
      readonly kind: "run-mutation";
      readonly requestId: RequestId;
      readonly mutation: PendingMutationSpec;
    }
  | { readonly kind: "run-rescan"; readonly requestId: RequestId }
  | { readonly kind: "exit"; readonly code: number };

export interface InitialTuiStateOptions {
  readonly initialTab?: TabId;
  readonly defaultInstallScope?: InstallScope;
  readonly colorEnabled?: boolean;
}

export function createInitialTuiState(
  snapshot: WorkspaceSnapshot,
  options: InitialTuiStateOptions = {},
): TuiState {
  return {
    snapshot,
    activeTab: options.initialTab ?? "discover",
    searchByTab: {
      discover: EMPTY_TEXT_INPUT,
      installed: EMPTY_TEXT_INPUT,
      marketplaces: EMPTY_TEXT_INPUT,
      errors: EMPTY_TEXT_INPUT,
    },
    discoverFilter: "all",
    installedScopeFilter: "all",
    errorSeverityFilter: "all",
    statsMode: "by-plugin",
    cursors: {
      discover: createEmptyCursor<CatalogEntryId>(),
      installed: createEmptyCursor<InstalledPluginId>(),
      marketplaces: createEmptyCursor<MarketplaceId>(),
      errors: createEmptyCursor<DiagnosticId>(),
      stats: createEmptyCursor<string>(),
    },
    overlay: { kind: "none" },
    pending: { kind: "idle" },
    nextRequestId: makeRequestId(1),
    spinnerTick: 0,
    toast: null,
    nextToastId: 1,
    defaultInstallScope: options.defaultInstallScope ?? "user",
    colorEnabled: options.colorEnabled ?? true,
  };
}

export function reduceTextInput(
  input: TextInputState,
  key: KeyEvent,
): { readonly next: TextInputState; readonly handled: boolean } {
  const graphemes = splitGraphemes(input.value);
  const cursor = Math.max(0, Math.min(graphemes.length, input.cursor));

  switch (key.kind) {
    case "char": {
      const safeCh = sanitizeInputText(key.ch);
      if (safeCh.length === 0) {
        return { next: input, handled: true };
      }
      const prefix = graphemes.slice(0, cursor).join("");
      const suffix = graphemes.slice(cursor).join("");
      const nextPrefix = `${prefix}${safeCh}`;
      return {
        next: { value: `${nextPrefix}${suffix}`, cursor: splitGraphemes(nextPrefix).length },
        handled: true,
      };
    }
    case "backspace": {
      if (cursor === 0) {
        return { next: input, handled: true };
      }
      const nextGraphemes = [...graphemes.slice(0, cursor - 1), ...graphemes.slice(cursor)];
      return {
        next: { value: nextGraphemes.join(""), cursor: cursor - 1 },
        handled: true,
      };
    }
    case "delete": {
      if (cursor >= graphemes.length) {
        return { next: input, handled: true };
      }
      const nextGraphemes = [...graphemes.slice(0, cursor), ...graphemes.slice(cursor + 1)];
      return {
        next: { value: nextGraphemes.join(""), cursor },
        handled: true,
      };
    }
    case "left":
      return {
        next: { value: input.value, cursor: Math.max(0, cursor - 1) },
        handled: true,
      };
    case "right":
      return {
        next: { value: input.value, cursor: Math.min(graphemes.length, cursor + 1) },
        handled: true,
      };
    case "home":
      return { next: { value: input.value, cursor: 0 }, handled: true };
    case "end":
      return { next: { value: input.value, cursor: graphemes.length }, handled: true };
    case "ctrl-u": {
      const nextGraphemes = graphemes.slice(cursor);
      return { next: { value: nextGraphemes.join(""), cursor: 0 }, handled: true };
    }
    case "ctrl-w": {
      let cut = cursor;
      while (cut > 0 && /\s/.test(graphemes[cut - 1] ?? "")) {
        cut -= 1;
      }
      while (cut > 0 && !/\s/.test(graphemes[cut - 1] ?? "")) {
        cut -= 1;
      }
      const nextGraphemes = [...graphemes.slice(0, cut), ...graphemes.slice(cursor)];
      return { next: { value: nextGraphemes.join(""), cursor: cut }, handled: true };
    }
    default:
      return { next: input, handled: false };
  }
}

export function formatEngineError(error: EngineError): string {
  switch (error.kind) {
    case "marketplace-exists":
      return `Marketplace "${error.id}" already exists.`;
    case "marketplace-not-found":
      return `Marketplace "${error.id}" was not found.`;
    case "marketplace-sync-failed":
      return `Marketplace "${error.id}" sync failed: ${error.reason}`;
    case "plugin-not-found":
      return `Plugin "${error.selector}" was not found.`;
    case "ambiguous-plugin-selector":
      return `Ambiguous plugin "${error.name}" (${error.matches.join(", ")}); specify scope.`;
    case "catalog-entry-not-found":
      return `Catalog entry "${error.target}" was not found.`;
    case "ambiguous-catalog-target":
      return `Ambiguous target "${error.name}" (${error.candidates.join(", ")}); specify marketplace.`;
    case "name-collision":
      return `Name collision for "${error.pluginName}" with ${error.existingId} (use --force to allow).`;
    case "bundle-invalid": {
      const first = error.diagnostics[0];
      return `Bundle validation failed (${error.diagnostics.length}): ${first.message}`;
    }
    case "path-traversal":
      return `Rejected unsafe path outside root: ${error.offendingPath}`;
    case "lock-busy":
      return `Target is locked by another process: ${error.target}`;
    case "remediation-failed":
      return `Remediation "${error.planKind}" failed: ${error.reason}`;
    case "io-failed":
      return `I/O error during ${error.operation}: ${error.reason}`;
    default: {
      const _exhaustive: never = error;
      return _exhaustive;
    }
  }
}
