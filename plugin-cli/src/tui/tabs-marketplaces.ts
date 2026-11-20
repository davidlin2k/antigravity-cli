import { formatMarketplaceSource, queryMarketplaces } from "../domain/query.ts";
import type { MarketplaceRecord } from "../domain/types.ts";
import { EMPTY_TEXT_INPUT } from "./state.ts";
import { defineTab } from "./tab-registry.ts";
import type { StyledCell } from "./tab-registry.ts";

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatShortTimestamp(iso: string): string {
  return iso.slice(0, 10);
}

function marketplaceSyncStatusCell(record: MarketplaceRecord): StyledCell {
  switch (record.sync.kind) {
    case "synced":
      return { text: "synced", tone: "success" };
    case "never-synced":
      return { text: "pending", tone: "warning" };
    case "sync-failed":
      return { text: "failed", tone: "error" };
    default: {
      const _exhaustive: never = record.sync;
      return _exhaustive;
    }
  }
}

export const marketplacesTab = defineTab<"marketplaces", MarketplaceRecord>({
  id: "marketplaces",
  number: 3,
  label: "Marketplaces",
  searchable: true,
  badge: (snapshot) => String(snapshot.marketplaces.length),
  selectRows: (state) =>
    queryMarketplaces(state.snapshot, state.searchByTab.marketplaces.value),
  rowKey: (row) => row.id,
  modeBadge: (state) => ({
    text: `${formatNumber(state.snapshot.marketplaces.length)} configured`,
    tone: "muted",
  }),
  emptyMessage: (state) =>
    state.searchByTab.marketplaces.value.trim().length > 0
      ? `No marketplaces matching "${state.searchByTab.marketplaces.value.trim()}".`
      : "No marketplaces registered. Press 'a' to add GitHub, SSH, HTTPS, or local sources.",
  columns: [
    {
      id: "name",
      header: "Name",
      width: { kind: "flex", min: 14, weight: 2 },
      cell: (row) => ({ text: row.id, tone: "accent" }),
    },
    {
      id: "kind",
      header: "Kind",
      width: { kind: "fixed", chars: 12 },
      cell: (row) => ({ text: row.source.kind, tone: "muted" }),
    },
    {
      id: "source",
      header: "Source",
      width: { kind: "flex", min: 18, weight: 4 },
      cell: (row) => ({ text: formatMarketplaceSource(row.source), tone: "default" }),
    },
    {
      id: "plugins",
      header: "Plugins",
      width: { kind: "fixed", chars: 8 },
      align: "right",
      cell: (row) => ({
        text: row.sync.kind === "synced" ? formatNumber(row.sync.pluginCount) : "-",
        tone: "default",
      }),
    },
    {
      id: "synced",
      header: "Synced",
      width: { kind: "fixed", chars: 11 },
      cell: (row) => {
        if (row.sync.kind === "synced") {
          return { text: formatShortTimestamp(row.sync.syncedAt), tone: "muted" };
        }
        if (row.sync.kind === "sync-failed" && row.sync.lastGoodSyncAt !== null) {
          return { text: formatShortTimestamp(row.sync.lastGoodSyncAt), tone: "muted" };
        }
        return { text: "never", tone: "muted" };
      },
    },
    {
      id: "status",
      header: "Status",
      width: { kind: "fixed", chars: 8 },
      cell: (row) => marketplaceSyncStatusCell(row),
    },
  ],
  actions: [
    {
      scope: "tab",
      id: "add-marketplace",
      key: { kind: "char", ch: "a" },
      hintKeys: "a",
      hintLabel: "add",
      run: () => ({
        kind: "open-overlay",
        overlay: {
          kind: "add-marketplace",
          sourceInput: EMPTY_TEXT_INPUT,
          idInput: EMPTY_TEXT_INPUT,
          focusedField: "source",
          preview: { kind: "empty" },
        },
      }),
    },
    {
      scope: "row",
      id: "open-marketplace-detail",
      key: "enter",
      hintKeys: "Enter",
      hintLabel: "details",
      run: (row) => ({
        kind: "open-overlay",
        overlay: {
          kind: "marketplace-detail",
          marketplaceId: row.id,
          focusedAction: "update",
        },
      }),
    },
    {
      scope: "row",
      id: "update-marketplace",
      key: { kind: "char", ch: "u" },
      hintKeys: "u",
      hintLabel: "update",
      run: (row) => ({
        kind: "mutate",
        mutation: {
          kind: "sync-marketplaces",
          input: { kind: "single", id: row.id },
          label: `Syncing marketplace ${row.id}`,
        },
      }),
    },
    {
      scope: "tab",
      id: "update-all-marketplaces",
      key: { kind: "char", ch: "U" },
      hintKeys: "U",
      hintLabel: "update all",
      when: (state) => state.snapshot.marketplaces.length > 0,
      run: () => ({
        kind: "mutate",
        mutation: {
          kind: "sync-marketplaces",
          input: { kind: "all" },
          label: "Syncing all marketplaces",
        },
      }),
    },
    {
      scope: "row",
      id: "remove-marketplace",
      key: { kind: "char", ch: "d" },
      hintKeys: "d",
      hintLabel: "remove",
      run: (row) => ({
        kind: "open-overlay",
        overlay: {
          kind: "confirm",
          title: "Remove marketplace",
          message: `Remove marketplace "${row.id}" and its local mirror? Installed plugins remain untouched.`,
          confirmLabel: "Remove",
          mutation: {
            kind: "remove-marketplace",
            input: { id: row.id },
            label: `Removing marketplace ${row.id}`,
          },
          returnOverlay: { kind: "none" },
          focusedChoice: "cancel",
        },
      }),
    },
  ],
});
