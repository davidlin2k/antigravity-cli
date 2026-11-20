import fs from "node:fs/promises";
import path from "node:path";
import { makeAbsolutePath } from "../../domain/types.ts";
import type {
  AbsolutePath,
  CatalogEntry,
  Diagnostic,
  InstallProvenance,
  InstallScope,
  InstalledPluginId,
  IsoTimestamp,
  MarketplaceId,
  MarketplaceSource,
  MarketplaceSyncState,
  PluginDirName,
  WorkspacePaths,
  WorkspaceSnapshot,
} from "../../domain/types.ts";
import type { PluginEngineConfig } from "../contract.ts";
import { decodeKnownMarketplaces, decodeReceipt, decodeSyncCache } from "./codecs.ts";
import { LOCK_PREFIX, writeJsonAtomic } from "./fs-safety.ts";

export interface KnownMarketplaceEntry {
  readonly id: MarketplaceId;
  readonly source: MarketplaceSource;
  readonly addedAt: IsoTimestamp;
}

export interface PersistedSyncCache {
  readonly schemaVersion: 1;
  readonly marketplaceId: MarketplaceId;
  readonly sync: MarketplaceSyncState;
  readonly localMirrorPath: AbsolutePath | null;
  readonly sourceMtimeMs: number | null;
  readonly entries: readonly CatalogEntry[];
  readonly diagnostics: readonly Diagnostic[];
}

export type ManagedProvenance = Exclude<InstallProvenance, { readonly kind: "unmanaged" }>;

export interface PersistedReceipt {
  readonly schemaVersion: 1;
  readonly id: InstalledPluginId;
  readonly scope: InstallScope;
  readonly dirName: PluginDirName;
  readonly provenance: ManagedProvenance;
}

export function deriveWorkspacePaths(config: PluginEngineConfig): WorkspacePaths {
  return {
    homeDir: config.homeDir,
    configDir: config.configDir,
    workspaceDir: config.workspaceDir,
    userPluginsDir: makeAbsolutePath(path.join(config.configDir, "plugins")),
    projectPluginsDir: makeAbsolutePath(path.join(config.workspaceDir, ".agents", "plugins")),
    managerDir: makeAbsolutePath(path.join(config.configDir, "plugin-manager")),
  };
}

export function scopeRootFor(paths: WorkspacePaths, scope: InstallScope): AbsolutePath {
  return scope === "user" ? paths.userPluginsDir : paths.projectPluginsDir;
}

function knownMarketplacesPath(paths: WorkspacePaths): AbsolutePath {
  return makeAbsolutePath(path.join(paths.managerDir, "known_marketplaces.json"));
}

function catalogCachePath(paths: WorkspacePaths): AbsolutePath {
  return makeAbsolutePath(path.join(paths.managerDir, "catalog-cache.json"));
}

function installedPluginsIndexPath(paths: WorkspacePaths): AbsolutePath {
  return makeAbsolutePath(path.join(paths.managerDir, "installed_plugins.json"));
}

export function marketplaceMirrorPath(paths: WorkspacePaths, id: MarketplaceId): AbsolutePath {
  return makeAbsolutePath(path.join(paths.managerDir, "marketplaces", id));
}

function syncCacheDir(paths: WorkspacePaths): AbsolutePath {
  return makeAbsolutePath(path.join(paths.managerDir, "cache", "sync"));
}

export function syncCachePath(paths: WorkspacePaths, id: MarketplaceId): AbsolutePath {
  return makeAbsolutePath(path.join(paths.managerDir, "cache", "sync", `${id}.json`));
}

function receiptsDir(paths: WorkspacePaths): AbsolutePath {
  return makeAbsolutePath(path.join(paths.managerDir, "cache", "receipts"));
}

function receiptPath(
  paths: WorkspacePaths,
  scope: InstallScope,
  dirName: PluginDirName,
): AbsolutePath {
  return makeAbsolutePath(
    path.join(paths.managerDir, "cache", "receipts", `${scope}--${dirName}.json`),
  );
}

export function registryLockPath(paths: WorkspacePaths): AbsolutePath {
  return makeAbsolutePath(path.join(paths.managerDir, `${LOCK_PREFIX}marketplaces`));
}

async function readJsonSafe(filePath: AbsolutePath): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function loadKnownMarketplaces(
  paths: WorkspacePaths,
): Promise<readonly KnownMarketplaceEntry[]> {
  const parsed = await readJsonSafe(knownMarketplacesPath(paths));
  return decodeKnownMarketplaces(parsed);
}

export async function saveKnownMarketplaces(
  paths: WorkspacePaths,
  entries: readonly KnownMarketplaceEntry[],
): Promise<void> {
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  await writeJsonAtomic(knownMarketplacesPath(paths), {
    schemaVersion: 1,
    marketplaces: sorted,
  });
}

export async function loadSyncCache(
  paths: WorkspacePaths,
  marketplaceId: MarketplaceId,
): Promise<PersistedSyncCache | null> {
  const raw = await readJsonSafe(syncCachePath(paths, marketplaceId));
  return decodeSyncCache(raw);
}

export async function loadAllSyncCaches(
  paths: WorkspacePaths,
): Promise<Map<MarketplaceId, PersistedSyncCache>> {
  const result = new Map<MarketplaceId, PersistedSyncCache>();
  const dir = syncCacheDir(paths);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return result;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const raw = await readJsonSafe(makeAbsolutePath(path.join(dir, name)));
    const decoded = decodeSyncCache(raw);
    if (decoded !== null) {
      result.set(decoded.marketplaceId, decoded);
    }
  }
  return result;
}

export async function saveSyncCache(
  paths: WorkspacePaths,
  cache: PersistedSyncCache,
): Promise<void> {
  await writeJsonAtomic(syncCachePath(paths, cache.marketplaceId), cache);
}

export async function deleteSyncCache(
  paths: WorkspacePaths,
  marketplaceId: MarketplaceId,
): Promise<void> {
  await fs.rm(syncCachePath(paths, marketplaceId), { force: true }).catch(() => {});
}

export async function loadAllReceipts(
  paths: WorkspacePaths,
): Promise<Map<InstalledPluginId, PersistedReceipt>> {
  const result = new Map<InstalledPluginId, PersistedReceipt>();
  const dir = receiptsDir(paths);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return result;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    const raw = await readJsonSafe(makeAbsolutePath(path.join(dir, name)));
    const decoded = decodeReceipt(raw);
    if (decoded !== null) {
      result.set(decoded.id, decoded);
    }
  }
  return result;
}

export async function saveReceipt(
  paths: WorkspacePaths,
  receipt: PersistedReceipt,
): Promise<void> {
  await writeJsonAtomic(receiptPath(paths, receipt.scope, receipt.dirName), receipt);
}

export async function deleteReceipt(
  paths: WorkspacePaths,
  scope: InstallScope,
  dirName: PluginDirName,
): Promise<void> {
  await fs.rm(receiptPath(paths, scope, dirName), { force: true }).catch(() => {});
}

export async function writeDerivedCaches(
  paths: WorkspacePaths,
  snapshot: WorkspaceSnapshot,
): Promise<void> {
  await Promise.all([
    writeJsonAtomic(catalogCachePath(paths), {
      schemaVersion: 1,
      generatedAt: snapshot.projectedAt,
      count: snapshot.catalog.length,
      entries: snapshot.catalog,
    }),
    writeJsonAtomic(installedPluginsIndexPath(paths), {
      schemaVersion: 1,
      generatedAt: snapshot.projectedAt,
      plugins: snapshot.installed.map((plugin) => ({
        id: plugin.id,
        kind: plugin.kind,
        scope: plugin.scope,
        dirName: plugin.dirName,
        installPath: plugin.installPath,
        name: plugin.kind === "valid" ? plugin.manifest.name : null,
        version: plugin.kind === "valid" ? (plugin.manifest.version ?? null) : null,
        activation: plugin.kind === "valid" ? plugin.activation : null,
        provenance: plugin.provenance,
      })),
    }),
  ]);
}
