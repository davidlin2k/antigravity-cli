import { compareStrings, isNonEmpty } from "./primitives.ts";
import type {
  InstalledPluginId,
  InstallScope,
  MarketplaceId,
  NonEmpty,
} from "./primitives.ts";
import type {
  CatalogEntry,
  ComponentCounts,
  Diagnostic,
  DiagnosticSeverity,
  InstalledPlugin,
  MarketplaceRecord,
  WorkspaceSnapshot,
} from "./models.ts";
import { formatMarketplaceSource } from "./parse-source.ts";

export * from "./parse-source.ts";

export type CatalogInstallFilter = "all" | "installed" | "not-installed";

export interface CatalogQuery {
  readonly text?: string;
  readonly marketplaceId?: MarketplaceId;
  readonly category?: string;
  readonly installFilter?: CatalogInstallFilter;
}

export type CatalogInstallStatus =
  | { readonly kind: "not-installed" }
  | {
      readonly kind: "installed";
      readonly installedIds: NonEmpty<InstalledPluginId>;
      readonly scopes: NonEmpty<InstallScope>;
      readonly hasUpdate: boolean;
    };

export interface CatalogMatch {
  readonly entry: CatalogEntry;
  readonly score: number;
  readonly installStatus: CatalogInstallStatus;
}

export interface InstalledQuery {
  readonly text?: string;
  readonly scope?: InstallScope;
  readonly state?: "all" | "active" | "disabled" | "shadowed" | "broken";
}

export interface DiagnosticQuery {
  readonly text?: string;
  readonly severity?: DiagnosticSeverity;
}

interface IndexedCatalogEntry {
  readonly entry: CatalogEntry;
  readonly nameLower: string;
  readonly slugLower: string;
  readonly displayNameLower: string;
  readonly marketplaceIdLower: string;
  readonly categoryLower: string;
  readonly tagsLower: readonly string[];
  readonly descriptionLower: string;
  readonly authorLower: string;
}

interface NormalizedCatalogIndex {
  readonly items: readonly IndexedCatalogEntry[];
}

const catalogIndexCache = new WeakMap<WorkspaceSnapshot, NormalizedCatalogIndex>();

function getCatalogIndex(snapshot: WorkspaceSnapshot): NormalizedCatalogIndex {
  const cached = catalogIndexCache.get(snapshot);
  if (cached !== undefined) {
    return cached;
  }
  const items: IndexedCatalogEntry[] = new Array(snapshot.catalog.length);
  for (let i = 0; i < snapshot.catalog.length; i += 1) {
    const entry = snapshot.catalog[i];
    if (entry === undefined) continue;
    items[i] = {
      entry,
      nameLower: entry.name.toLowerCase(),
      slugLower: entry.slug.toLowerCase(),
      displayNameLower: entry.displayName.toLowerCase(),
      marketplaceIdLower: entry.marketplaceId.toLowerCase(),
      categoryLower: entry.category !== null ? entry.category.toLowerCase() : "",
      tagsLower: entry.tags.map((tag) => tag.toLowerCase()),
      descriptionLower: entry.description.toLowerCase(),
      authorLower: entry.author !== null ? entry.author.toLowerCase() : "",
    };
  }
  items.sort((a, b) => {
    const nameCmp = compareStrings(a.nameLower, b.nameLower);
    return nameCmp !== 0 ? nameCmp : compareStrings(a.entry.id, b.entry.id);
  });
  const index: NormalizedCatalogIndex = { items };
  catalogIndexCache.set(snapshot, index);
  return index;
}

function scoreCatalogToken(item: IndexedCatalogEntry, needle: string): number {
  if (item.nameLower === needle || item.slugLower === needle) {
    return 1000;
  }
  if (item.displayNameLower === needle) {
    return 980;
  }
  if (item.nameLower.startsWith(needle) || item.slugLower.startsWith(needle)) {
    return 700 + Math.max(0, 30 - item.nameLower.length);
  }
  if (item.displayNameLower.startsWith(needle)) {
    return 680;
  }
  if (item.nameLower.includes(needle) || item.slugLower.includes(needle)) {
    return 500;
  }
  if (item.displayNameLower.includes(needle)) {
    return 480;
  }
  if (item.categoryLower === needle) {
    return 360;
  }
  let tagSubstring = false;
  for (let i = 0; i < item.tagsLower.length; i += 1) {
    const tag = item.tagsLower[i];
    if (tag === undefined) continue;
    if (tag === needle) {
      return 350;
    }
    if (!tagSubstring && tag.includes(needle)) {
      tagSubstring = true;
    }
  }
  if (tagSubstring || (item.categoryLower.length > 0 && item.categoryLower.includes(needle))) {
    return 250;
  }
  if (item.descriptionLower.includes(needle)) {
    return 150;
  }
  if (item.authorLower.includes(needle) || item.marketplaceIdLower.includes(needle)) {
    return 100;
  }
  return 0;
}

function resolveCatalogInstallStatus(
  snapshot: WorkspaceSnapshot,
  entry: CatalogEntry,
): CatalogInstallStatus {
  const ids = snapshot.installedIdsByPluginName.get(entry.name);
  if (ids === undefined || !isNonEmpty(ids)) {
    return { kind: "not-installed" };
  }
  const scopes: InstallScope[] = [];
  let hasUpdate = false;
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    if (id === undefined) continue;
    const plugin = snapshot.installedById.get(id);
    if (plugin === undefined) continue;
    if (!scopes.includes(plugin.scope)) {
      scopes.push(plugin.scope);
    }
    if (plugin.kind === "valid" && plugin.updateAvailable !== null) {
      hasUpdate = true;
    }
  }
  if (!isNonEmpty(scopes)) {
    return { kind: "not-installed" };
  }
  return {
    kind: "installed",
    installedIds: ids,
    scopes,
    hasUpdate,
  };
}

/**
 * Pure, synchronous ranked search across thousands of catalog entries.
 * Memoizes a pre-lowercased index per snapshot in a WeakMap and joins
 * install status in O(1) via `snapshot.installedIdsByPluginName`.
 */
export function queryCatalog(
  snapshot: WorkspaceSnapshot,
  query: CatalogQuery,
): readonly CatalogMatch[] {
  const index = getCatalogIndex(snapshot);
  const marketplaceFilter = query.marketplaceId;
  const categoryFilter =
    query.category !== undefined && query.category.trim().length > 0
      ? query.category.trim().toLowerCase()
      : null;
  const installFilter = query.installFilter ?? "all";
  const normalizedText = (query.text ?? "").trim().toLowerCase();
  const tokens =
    normalizedText.length > 0
      ? normalizedText.split(/\s+/).filter((token) => token.length > 0)
      : [];

  const matches: CatalogMatch[] = [];

  for (let i = 0; i < index.items.length; i += 1) {
    const item = index.items[i];
    if (item === undefined) continue;

    if (marketplaceFilter !== undefined && item.entry.marketplaceId !== marketplaceFilter) {
      continue;
    }
    if (categoryFilter !== null && item.categoryLower !== categoryFilter) {
      continue;
    }

    let score = 0;
    if (tokens.length === 1) {
      const token = tokens[0];
      if (token !== undefined) {
        score = scoreCatalogToken(item, token);
        if (score === 0) {
          continue;
        }
      }
    } else if (tokens.length > 1) {
      let matchedAll = true;
      for (let t = 0; t < tokens.length; t += 1) {
        const token = tokens[t];
        if (token === undefined) continue;
        const tokenScore = scoreCatalogToken(item, token);
        if (tokenScore === 0) {
          matchedAll = false;
          break;
        }
        score += tokenScore;
      }
      if (!matchedAll) {
        continue;
      }
      if (
        item.nameLower.includes(normalizedText) ||
        item.displayNameLower.includes(normalizedText) ||
        item.descriptionLower.includes(normalizedText)
      ) {
        score += 200;
      }
    }

    const installStatus = resolveCatalogInstallStatus(snapshot, item.entry);
    if (installFilter === "installed" && installStatus.kind !== "installed") {
      continue;
    }
    if (installFilter === "not-installed" && installStatus.kind !== "not-installed") {
      continue;
    }

    matches.push({ entry: item.entry, score, installStatus });
  }

  if (tokens.length > 0 && matches.length > 1) {
    matches.sort((a, b) => b.score - a.score);
  }

  return matches;
}

function matchesInstalledState(
  plugin: InstalledPlugin,
  state: NonNullable<InstalledQuery["state"]>,
): boolean {
  switch (state) {
    case "all":
      return true;
    case "broken":
      return plugin.kind === "broken";
    case "active":
      return plugin.kind === "valid" && plugin.activation.kind === "active";
    case "disabled":
      return plugin.kind === "valid" && plugin.activation.kind === "disabled";
    case "shadowed":
      return plugin.kind === "valid" && plugin.activation.kind === "shadowed";
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function installedSortKey(plugin: InstalledPlugin): string {
  return plugin.kind === "valid" ? plugin.manifest.name.toLowerCase() : plugin.dirName.toLowerCase();
}

export function queryInstalled(
  snapshot: WorkspaceSnapshot,
  query: InstalledQuery,
): readonly InstalledPlugin[] {
  const stateFilter = query.state ?? "all";
  const normalizedText = (query.text ?? "").trim().toLowerCase();
  const tokens =
    normalizedText.length > 0
      ? normalizedText.split(/\s+/).filter((token) => token.length > 0)
      : [];

  const filtered: InstalledPlugin[] = [];

  for (const plugin of snapshot.installed) {
    if (query.scope !== undefined && plugin.scope !== query.scope) {
      continue;
    }
    if (!matchesInstalledState(plugin, stateFilter)) {
      continue;
    }
    if (tokens.length > 0) {
      const marketplacePart =
        plugin.provenance.kind === "marketplace" ? plugin.provenance.marketplaceId : "";
      const haystack =
        plugin.kind === "valid"
          ? `${plugin.id} ${plugin.dirName} ${plugin.manifest.name} ${plugin.manifest.displayName ?? ""} ${plugin.manifest.description ?? ""} ${plugin.manifest.author ?? ""} ${marketplacePart}`.toLowerCase()
          : `${plugin.id} ${plugin.dirName} ${marketplacePart} broken`.toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) {
        continue;
      }
    }
    filtered.push(plugin);
  }

  filtered.sort((a, b) => {
    const keyA = installedSortKey(a);
    const keyB = installedSortKey(b);
    if (normalizedText.length > 0) {
      const exactA = keyA === normalizedText ? 2 : keyA.startsWith(normalizedText) ? 1 : 0;
      const exactB = keyB === normalizedText ? 2 : keyB.startsWith(normalizedText) ? 1 : 0;
      if (exactB !== exactA) {
        return exactB - exactA;
      }
    }
    const nameCmp = keyA.localeCompare(keyB);
    if (nameCmp !== 0) {
      return nameCmp;
    }
    return a.id.localeCompare(b.id);
  });

  return filtered;
}

function diagnosticSubjectLabel(subject: Diagnostic["subject"]): string {
  switch (subject.kind) {
    case "installed":
      return subject.pluginId;
    case "marketplace":
      return subject.marketplaceId;
    case "path":
      return subject.path;
    default: {
      const _exhaustive: never = subject;
      return _exhaustive;
    }
  }
}

export function queryDiagnostics(
  snapshot: WorkspaceSnapshot,
  query: DiagnosticQuery,
): readonly Diagnostic[] {
  const normalizedText = (query.text ?? "").trim().toLowerCase();
  const tokens =
    normalizedText.length > 0
      ? normalizedText.split(/\s+/).filter((token) => token.length > 0)
      : [];

  const filtered: Diagnostic[] = [];
  for (const diagnostic of snapshot.diagnostics) {
    if (query.severity !== undefined && diagnostic.severity !== query.severity) {
      continue;
    }
    if (tokens.length > 0) {
      const haystack =
        `${diagnostic.id} ${diagnostic.severity} ${diagnostic.detail.kind} ${diagnosticSubjectLabel(diagnostic.subject)} ${diagnostic.message} ${diagnostic.hint}`.toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) {
        continue;
      }
    }
    filtered.push(diagnostic);
  }

  filtered.sort((a, b) => {
    if (a.severity !== b.severity) {
      return a.severity === "error" ? -1 : 1;
    }
    return a.id.localeCompare(b.id);
  });

  return filtered;
}

export function queryMarketplaces(
  snapshot: WorkspaceSnapshot,
  text?: string,
): readonly MarketplaceRecord[] {
  const normalizedText = (text ?? "").trim().toLowerCase();
  const tokens =
    normalizedText.length > 0
      ? normalizedText.split(/\s+/).filter((token) => token.length > 0)
      : [];

  const filtered: MarketplaceRecord[] = [];
  for (const record of snapshot.marketplaces) {
    if (tokens.length > 0) {
      const reason = record.sync.kind === "sync-failed" ? record.sync.reason : "";
      const haystack =
        `${record.id} ${formatMarketplaceSource(record.source)} ${record.sync.kind} ${reason}`.toLowerCase();
      if (!tokens.every((token) => haystack.includes(token))) {
        continue;
      }
    }
    filtered.push(record);
  }

  filtered.sort((a, b) => {
    if (normalizedText.length > 0) {
      const aId = a.id.toLowerCase();
      const bId = b.id.toLowerCase();
      const rankA = aId === normalizedText ? 2 : aId.startsWith(normalizedText) ? 1 : 0;
      const rankB = bId === normalizedText ? 2 : bId.startsWith(normalizedText) ? 1 : 0;
      if (rankB !== rankA) {
        return rankB - rankA;
      }
    }
    return a.id.localeCompare(b.id);
  });

  return filtered;
}

export function formatComponentsCompact(counts: ComponentCounts | null | undefined): string {
  if (counts === null || counts === undefined) {
    return "-";
  }
  const parts: string[] = [];
  if (counts.skills > 0) parts.push(`${counts.skills}S`);
  if (counts.agents > 0) parts.push(`${counts.agents}A`);
  if (counts.rules > 0) parts.push(`${counts.rules}R`);
  if (counts.hooks > 0) parts.push(`${counts.hooks}H`);
  if (counts.mcpServers > 0) parts.push(`${counts.mcpServers}M`);
  return parts.length > 0 ? parts.join(" ") : "-";
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  let value = bytes;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  const unit = BYTE_UNITS[unitIdx] ?? "TB";
  return `${value.toFixed(1)} ${unit}`;
}
