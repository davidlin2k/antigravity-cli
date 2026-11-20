import type { WorkspaceSnapshot } from "../domain/types.ts";
import type { KeyEvent } from "./ansi.ts";
import type {
  OverlayState,
  PendingMutationSpec,
  TabId,
  TuiState,
} from "./state.ts";

export type CellTone = "default" | "muted" | "accent" | "success" | "warning" | "error";

export interface StyledCell {
  readonly text: string;
  readonly tone?: CellTone;
}

export type ColumnWidth =
  | { readonly kind: "fixed"; readonly chars: number }
  | { readonly kind: "flex"; readonly min: number; readonly weight: number };

export interface ColumnDef<TRow> {
  readonly id: string;
  readonly header: string;
  readonly width: ColumnWidth;
  readonly align?: "left" | "right";
  readonly cell: (row: TRow, state: TuiState) => StyledCell;
}

export interface SummaryCard {
  readonly label: string;
  readonly value: string;
  readonly subtext?: string;
  readonly tone?: CellTone;
}

export interface KeyHint {
  readonly keys: string;
  readonly label: string;
}

export type KeyPattern =
  | "enter"
  | "space"
  | { readonly kind: "char"; readonly ch: string };

export type ActionCommand =
  | { readonly kind: "open-overlay"; readonly overlay: OverlayState }
  | { readonly kind: "mutate"; readonly mutation: PendingMutationSpec }
  | { readonly kind: "rescan" }
  | { readonly kind: "cycle-discover-filter" }
  | { readonly kind: "cycle-installed-scope" }
  | { readonly kind: "cycle-error-severity" }
  | { readonly kind: "cycle-stats-mode" }
  | { readonly kind: "focus-search" };

export type KeyAction<TRow> =
  | {
      readonly scope: "row";
      readonly id: string;
      readonly key: KeyPattern;
      readonly hintKeys: string;
      readonly hintLabel: string;
      readonly when?: (row: TRow, state: TuiState) => boolean;
      readonly run: (row: TRow, state: TuiState) => ActionCommand | null;
    }
  | {
      readonly scope: "tab";
      readonly id: string;
      readonly key: KeyPattern;
      readonly hintKeys: string;
      readonly hintLabel: string;
      readonly when?: (state: TuiState) => boolean;
      readonly run: (state: TuiState) => ActionCommand | null;
    };

export interface TypedTabSpec<TId extends TabId, TRow> {
  readonly id: TId;
  readonly number: 1 | 2 | 3 | 4 | 5;
  readonly label: string;
  readonly searchable: boolean;
  readonly badge: (snapshot: WorkspaceSnapshot) => string | null;
  readonly selectRows: (state: TuiState) => readonly TRow[];
  readonly rowKey: (row: NoInfer<TRow>) => string;
  readonly modeBadge?: (state: TuiState, rows: readonly NoInfer<TRow>[]) => StyledCell | null;
  readonly summaryCards?: (state: TuiState) => readonly SummaryCard[];
  readonly emptyMessage: (state: TuiState) => string;
  readonly columns: readonly ColumnDef<NoInfer<TRow>>[];
  readonly actions: readonly KeyAction<NoInfer<TRow>>[];
}

export interface PreparedColumnHeader {
  readonly id: string;
  readonly header: string;
  readonly width: ColumnWidth;
  readonly align: "left" | "right";
}

export interface PreparedTabView {
  readonly id: TabId;
  readonly number: 1 | 2 | 3 | 4 | 5;
  readonly label: string;
  readonly badge: string | null;
  readonly searchable: boolean;
  readonly modeBadge: StyledCell | null;
  readonly summaryCards: readonly SummaryCard[];
  readonly emptyMessage: string;
  readonly columns: readonly PreparedColumnHeader[];
  readonly rowCount: number;
  readonly rowKeyAt: (index: number) => string | null;
  readonly cellsAt: (index: number) => readonly StyledCell[];
  readonly hintsForIndex: (index: number) => readonly KeyHint[];
  readonly dispatchKeyAt: (index: number, key: KeyEvent) => ActionCommand | null;
}

export interface TabDescriptor<TId extends TabId> {
  readonly id: TId;
  readonly number: 1 | 2 | 3 | 4 | 5;
  readonly label: string;
  readonly searchable: boolean;
  readonly badge: (snapshot: WorkspaceSnapshot) => string | null;
  readonly prepare: (state: TuiState) => PreparedTabView;
}

function matchesKeyPattern(pattern: KeyPattern, key: KeyEvent): boolean {
  if (pattern === "enter") {
    return key.kind === "enter";
  }
  if (pattern === "space") {
    return key.kind === "char" && key.ch === " ";
  }
  return key.kind === "char" && key.ch === pattern.ch;
}

function isActionActive<TRow>(
  action: KeyAction<TRow>,
  row: TRow | undefined,
  state: TuiState,
): boolean {
  if (action.scope === "row") {
    if (row === undefined) {
      return false;
    }
    return action.when === undefined || action.when(row, state);
  }
  return action.when === undefined || action.when(state);
}

/**
 * Registers a typed tab while preserving a single source of truth between
 * footer key hints and runtime key dispatch.
 */
export function defineTab<TId extends TabId, TRow>(
  spec: TypedTabSpec<TId, TRow>,
): TabDescriptor<TId> {
  const columns: readonly PreparedColumnHeader[] = spec.columns.map((col) => ({
    id: col.id,
    header: col.header,
    width: col.width,
    align: col.align ?? "left",
  }));

  return {
    id: spec.id,
    number: spec.number,
    label: spec.label,
    searchable: spec.searchable,
    badge: spec.badge,
    prepare(state: TuiState): PreparedTabView {
      const rows = spec.selectRows(state);
      const badge = spec.badge(state.snapshot);
      const modeBadge = spec.modeBadge !== undefined ? spec.modeBadge(state, rows) : null;
      const summaryCards = spec.summaryCards !== undefined ? spec.summaryCards(state) : [];
      const emptyMessage = spec.emptyMessage(state);

      return {
        id: spec.id,
        number: spec.number,
        label: spec.label,
        badge,
        searchable: spec.searchable,
        modeBadge,
        summaryCards,
        emptyMessage,
        columns,
        rowCount: rows.length,
        rowKeyAt(index: number): string | null {
          const row = rows[index];
          return row === undefined ? null : spec.rowKey(row);
        },
        cellsAt(index: number): readonly StyledCell[] {
          const row = rows[index];
          if (row === undefined) {
            return [];
          }
          return spec.columns.map((col) => col.cell(row, state));
        },
        hintsForIndex(index: number): readonly KeyHint[] {
          const row = rows[index];
          const hints: KeyHint[] = [];
          for (const action of spec.actions) {
            if (isActionActive(action, row, state)) {
              hints.push({ keys: action.hintKeys, label: action.hintLabel });
            }
          }
          return hints;
        },
        dispatchKeyAt(index: number, key: KeyEvent): ActionCommand | null {
          const row = rows[index];
          for (const action of spec.actions) {
            if (!matchesKeyPattern(action.key, key)) {
              continue;
            }
            if (!isActionActive(action, row, state)) {
              continue;
            }
            if (action.scope === "row") {
              if (row === undefined) {
                continue;
              }
              return action.run(row, state);
            }
            return action.run(state);
          }
          return null;
        },
      };
    },
  };
}
