import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  isAbsolutePath,
  isCatalogEntryId,
  isDiagnosticId,
  isHttpUrl,
  isInstallScope,
  isInstalledPluginId,
  isIsoTimestamp,
  isManifestEcosystem,
  isMarketplaceId,
  isNonEmpty,
  isPluginDirName,
  isPluginName,
  isRelativeSubpath,
  isSshGitUrl,
  joinAbsolutePath,
  makeAbsolutePath,
  makeRelativeSubpath,
} from "../../domain/types.ts";
import type {
  AbsolutePath,
  AgentSummary,
  CatalogEntry,
  ComponentCounts,
  ComponentInventory,
  Diagnostic,
  DiagnosticDetail,
  DiagnosticSeverity,
  DiagnosticSubject,
  HookSummary,
  InstallProvenance,
  InstallScope,
  InstalledPluginId,
  IsoTimestamp,
  MarketplaceId,
  MarketplaceSource,
  MarketplaceSyncState,
  McpServerSummary,
  PluginDirName,
  PluginInstallSource,
  RemediationPlan,
  RemoteGitUrl,
  RuleSummary,
  SkillSummary,
  WorkspacePaths,
  WorkspaceSnapshot,
} from "../../domain/types.ts";
import type { PluginEngineConfig } from "../contract.ts";

export const STAGING_PREFIX = ".agy-stage-";
export const BACKUP_PREFIX = ".agy-backup-";
export const LOCK_PREFIX = ".agy-lock-";

const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRIES = 6;
const DEFAULT_LOCK_RETRY_DELAY_MS = 40;

export class LockBusyError extends Error {
  readonly target: string;

  constructor(target: string) {
    super(`Lock is held by another active process: ${target}`);
    this.name = "LockBusyError";
    this.target = target;
  }
}

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

export interface StaleStagingArtifact {
  readonly path: AbsolutePath;
  readonly name: string;
  readonly scope: InstallScope;
  readonly artifactKind: "staging" | "backup";
  readonly targetDirName: PluginDirName | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWithinCanonicalRoot(resolvedPath: string, canonicalRoot: string): boolean {
  return resolvedPath === canonicalRoot || resolvedPath.startsWith(`${canonicalRoot}${path.sep}`);
}

export async function resolvePossiblyDanglingTarget(
  canonicalStartDir: string,
  rawTarget: string,
  maxHops = 40,
): Promise<string> {
  const resolveStep = async (startDir: string, target: string, hops: number): Promise<string> => {
    let cur = path.isAbsolute(target) ? path.parse(target).root : startDir;
    const remainder = path.isAbsolute(target) ? target.slice(cur.length) : target;
    const segments = remainder.split(/[\\/]+/);

    for (const seg of segments) {
      if (seg.length === 0 || seg === ".") {
        continue;
      }
      if (seg === "..") {
        cur = path.dirname(cur);
        continue;
      }
      const next = path.join(cur, seg);
      try {
        cur = await fs.realpath(next);
      } catch {
        if (hops < maxHops) {
          try {
            const nestedLink = await fs.readlink(next);
            cur = await resolveStep(cur, nestedLink, hops + 1);
            continue;
          } catch {
            // Non-existent literal segment; keep lexical path for subsequent `..` resolution.
          }
        }
        cur = next;
      }
    }
    return cur;
  };

  return resolveStep(canonicalStartDir, rawTarget, 0);
}

export type ContainedPathCheck =
  | { readonly kind: "missing" }
  | { readonly kind: "contained"; readonly realPath: string }
  | { readonly kind: "escaped"; readonly resolvedOutsideRoot: string };

export async function checkContainedPath(
  candidatePath: AbsolutePath,
  canonicalRoot: string,
): Promise<ContainedPathCheck> {
  let lstat;
  try {
    lstat = await fs.lstat(candidatePath);
  } catch {
    return { kind: "missing" };
  }
  try {
    const realPath = await fs.realpath(candidatePath);
    if (!isWithinCanonicalRoot(realPath, canonicalRoot)) {
      return { kind: "escaped", resolvedOutsideRoot: realPath };
    }
    return { kind: "contained", realPath };
  } catch {
    if (lstat.isSymbolicLink()) {
      const linkRaw = await fs.readlink(candidatePath).catch(() => "");
      const parentReal = await fs
        .realpath(path.dirname(candidatePath))
        .catch(() => path.dirname(candidatePath));
      const resolved = await resolvePossiblyDanglingTarget(parentReal, linkRaw);
      if (!isWithinCanonicalRoot(resolved, canonicalRoot)) {
        return { kind: "escaped", resolvedOutsideRoot: resolved };
      }
    }
    return { kind: "missing" };
  }
}

export function getErrnoCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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

export function knownMarketplacesPath(paths: WorkspacePaths): AbsolutePath {
  return makeAbsolutePath(path.join(paths.managerDir, "known_marketplaces.json"));
}

export function catalogCachePath(paths: WorkspacePaths): AbsolutePath {
  return makeAbsolutePath(path.join(paths.managerDir, "catalog-cache.json"));
}

export function installedPluginsIndexPath(paths: WorkspacePaths): AbsolutePath {
  return makeAbsolutePath(path.join(paths.managerDir, "installed_plugins.json"));
}

export function marketplacesMirrorRoot(paths: WorkspacePaths): AbsolutePath {
  return makeAbsolutePath(path.join(paths.managerDir, "marketplaces"));
}

export function marketplaceMirrorPath(paths: WorkspacePaths, id: MarketplaceId): AbsolutePath {
  return makeAbsolutePath(path.join(paths.managerDir, "marketplaces", id));
}

export function syncCacheDir(paths: WorkspacePaths): AbsolutePath {
  return makeAbsolutePath(path.join(paths.managerDir, "cache", "sync"));
}

export function syncCachePath(paths: WorkspacePaths, id: MarketplaceId): AbsolutePath {
  return makeAbsolutePath(path.join(paths.managerDir, "cache", "sync", `${id}.json`));
}

export function receiptsDir(paths: WorkspacePaths): AbsolutePath {
  return makeAbsolutePath(path.join(paths.managerDir, "cache", "receipts"));
}

export function receiptPath(
  paths: WorkspacePaths,
  scope: InstallScope,
  dirName: PluginDirName,
): AbsolutePath {
  return makeAbsolutePath(
    path.join(paths.managerDir, "cache", "receipts", `${scope}--${dirName}.json`),
  );
}

export function targetLockPath(scopeRoot: AbsolutePath, dirName: PluginDirName): AbsolutePath {
  return makeAbsolutePath(path.join(scopeRoot, `${LOCK_PREFIX}${dirName}`));
}

export function registryLockPath(paths: WorkspacePaths): AbsolutePath {
  return makeAbsolutePath(path.join(paths.managerDir, `${LOCK_PREFIX}marketplaces`));
}

export async function writeFileAtomic(
  filePath: AbsolutePath,
  content: string | Uint8Array,
  mode = 0o644,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const nonce = crypto.randomBytes(6).toString("hex");
  const tmpPath = path.join(dir, `.agy-tmp-${process.pid}-${nonce}`);
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tmpPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, mode);
    if (typeof content === "string") {
      await handle.writeFile(content, "utf8");
    } else {
      await handle.writeFile(content);
    }
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    if (handle !== null) {
      await handle.close().catch(() => {});
    }
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}

export async function writeJsonAtomic(
  filePath: AbsolutePath,
  data: unknown,
  mode = 0o600,
): Promise<void> {
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  await writeFileAtomic(filePath, serialized, mode);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return getErrnoCode(err) === "EPERM";
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function isLockStale(lockFilePath: AbsolutePath, staleMs: number): Promise<boolean> {
  let stat;
  try {
    stat = await fs.stat(lockFilePath);
  } catch (err) {
    return getErrnoCode(err) === "ENOENT";
  }
  const ageByMtime = Date.now() - stat.mtimeMs;
  if (ageByMtime > staleMs) {
    return true;
  }
  try {
    const raw = await fs.readFile(lockFilePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      const pid = typeof parsed.pid === "number" ? parsed.pid : null;
      const createdAt = typeof parsed.createdAt === "number" ? parsed.createdAt : null;
      if (pid !== null && !isPidAlive(pid)) {
        return true;
      }
      if (createdAt !== null && Date.now() - createdAt > staleMs) {
        return true;
      }
    }
  } catch {
    // A brand-new lockfile may still be mid-write; only reclaim corrupt locks past staleMs.
    return ageByMtime > staleMs;
  }
  return false;
}

export async function withTargetLock<T>(
  lockFilePath: AbsolutePath,
  fn: () => Promise<T>,
  options?: {
    readonly staleMs?: number;
    readonly retries?: number;
    readonly retryDelayMs?: number;
  },
): Promise<T> {
  const staleMs = options?.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const retries = options?.retries ?? DEFAULT_LOCK_RETRIES;
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;

  await fs.mkdir(path.dirname(lockFilePath), { recursive: true });

  let acquired = false;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(
        lockFilePath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
      const payload = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
      await handle.writeFile(payload, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      acquired = true;
      break;
    } catch (err) {
      if (handle !== null) {
        await handle.close().catch(() => {});
      }
      if (getErrnoCode(err) !== "EEXIST") {
        throw err;
      }
      const stale = await isLockStale(lockFilePath, staleMs);
      if (stale) {
        await fs.rm(lockFilePath, { force: true }).catch(() => {});
        continue;
      }
      if (attempt < retries) {
        await sleep(retryDelayMs * (attempt + 1));
      }
    }
  }

  if (!acquired) {
    throw new LockBusyError(lockFilePath);
  }

  try {
    return await fn();
  } finally {
    await fs.rm(lockFilePath, { force: true }).catch(() => {});
  }
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readRemoteGitUrl(value: unknown): RemoteGitUrl | null {
  if (typeof value !== "string") {
    return null;
  }
  if (isHttpUrl(value)) {
    return value;
  }
  if (isSshGitUrl(value)) {
    return value;
  }
  return null;
}

function decodeMarketplaceSource(raw: unknown): MarketplaceSource | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return null;
  }
  switch (raw.kind) {
    case "github": {
      if (typeof raw.owner !== "string" || typeof raw.repo !== "string") {
        return null;
      }
      const ref = readOptionalString(raw, "ref");
      const rawSubdir = readOptionalString(raw, "subdir");
      const subdir = rawSubdir !== undefined && isRelativeSubpath(rawSubdir) ? rawSubdir : undefined;
      return {
        kind: "github",
        owner: raw.owner,
        repo: raw.repo,
        ...(ref !== undefined ? { ref } : {}),
        ...(subdir !== undefined ? { subdir } : {}),
      };
    }
    case "ssh": {
      if (typeof raw.url !== "string" || !isSshGitUrl(raw.url)) {
        return null;
      }
      const ref = readOptionalString(raw, "ref");
      const rawSubdir = readOptionalString(raw, "subdir");
      const subdir = rawSubdir !== undefined && isRelativeSubpath(rawSubdir) ? rawSubdir : undefined;
      return {
        kind: "ssh",
        url: raw.url,
        ...(ref !== undefined ? { ref } : {}),
        ...(subdir !== undefined ? { subdir } : {}),
      };
    }
    case "https-git": {
      if (typeof raw.url !== "string" || !isHttpUrl(raw.url)) {
        return null;
      }
      const ref = readOptionalString(raw, "ref");
      const rawSubdir = readOptionalString(raw, "subdir");
      const subdir = rawSubdir !== undefined && isRelativeSubpath(rawSubdir) ? rawSubdir : undefined;
      return {
        kind: "https-git",
        url: raw.url,
        ...(ref !== undefined ? { ref } : {}),
        ...(subdir !== undefined ? { subdir } : {}),
      };
    }
    case "https-json": {
      if (typeof raw.url !== "string" || !isHttpUrl(raw.url)) {
        return null;
      }
      return { kind: "https-json", url: raw.url };
    }
    case "local-folder": {
      if (typeof raw.path !== "string" || !isAbsolutePath(raw.path)) {
        return null;
      }
      return { kind: "local-folder", path: raw.path };
    }
    case "local-json": {
      if (typeof raw.path !== "string" || !isAbsolutePath(raw.path)) {
        return null;
      }
      return { kind: "local-json", path: raw.path };
    }
    default:
      return null;
  }
}

function decodePluginInstallSource(raw: unknown): PluginInstallSource | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return null;
  }
  switch (raw.kind) {
    case "marketplace-root": {
      if (typeof raw.marketplaceId !== "string" || !isMarketplaceId(raw.marketplaceId)) {
        return null;
      }
      return {
        kind: "marketplace-root",
        marketplaceId: raw.marketplaceId,
      };
    }
    case "marketplace-subdir": {
      if (
        typeof raw.marketplaceId !== "string" ||
        !isMarketplaceId(raw.marketplaceId) ||
        typeof raw.subdir !== "string" ||
        !isRelativeSubpath(raw.subdir)
      ) {
        return null;
      }
      return {
        kind: "marketplace-subdir",
        marketplaceId: raw.marketplaceId,
        subdir: raw.subdir,
      };
    }
    case "git-subdir": {
      const repoUrl = readRemoteGitUrl(raw.repoUrl);
      if (repoUrl === null || typeof raw.subdir !== "string" || !isRelativeSubpath(raw.subdir)) {
        return null;
      }
      const ref = readOptionalString(raw, "ref");
      const sha = readOptionalString(raw, "sha");
      return {
        kind: "git-subdir",
        repoUrl,
        subdir: raw.subdir,
        ...(ref !== undefined ? { ref } : {}),
        ...(sha !== undefined ? { sha } : {}),
      };
    }
    case "git-repo": {
      const repoUrl = readRemoteGitUrl(raw.repoUrl);
      if (repoUrl === null) {
        return null;
      }
      const ref = readOptionalString(raw, "ref");
      const sha = readOptionalString(raw, "sha");
      return {
        kind: "git-repo",
        repoUrl,
        ...(ref !== undefined ? { ref } : {}),
        ...(sha !== undefined ? { sha } : {}),
      };
    }
    case "archive-url": {
      if (typeof raw.url !== "string" || !isHttpUrl(raw.url)) {
        return null;
      }
      const sha256 = readOptionalString(raw, "sha256");
      return {
        kind: "archive-url",
        url: raw.url,
        ...(sha256 !== undefined ? { sha256 } : {}),
      };
    }
    case "local-dir": {
      if (typeof raw.path !== "string" || !isAbsolutePath(raw.path)) {
        return null;
      }
      return { kind: "local-dir", path: raw.path };
    }
    default:
      return null;
  }
}

function decodeComponentCounts(raw: unknown): ComponentCounts | null {
  if (!isRecord(raw)) {
    return null;
  }
  const { skills, agents, rules, hooks, mcpServers } = raw;
  if (
    typeof skills !== "number" ||
    typeof agents !== "number" ||
    typeof rules !== "number" ||
    typeof hooks !== "number" ||
    typeof mcpServers !== "number"
  ) {
    return null;
  }
  return { skills, agents, rules, hooks, mcpServers };
}

function decodeComponentInventory(raw: unknown): ComponentInventory | null {
  if (!isRecord(raw)) {
    return null;
  }
  const counts = decodeComponentCounts(raw.counts);
  if (counts === null) {
    return null;
  }
  const skills: SkillSummary[] = [];
  if (Array.isArray(raw.skills)) {
    for (const item of raw.skills) {
      if (
        isRecord(item) &&
        typeof item.name === "string" &&
        typeof item.folderName === "string" &&
        typeof item.description === "string" &&
        typeof item.frontmatterNamePresent === "boolean" &&
        typeof item.estimatedTokens === "number"
      ) {
        skills.push({
          name: item.name,
          folderName: item.folderName,
          description: item.description,
          frontmatterNamePresent: item.frontmatterNamePresent,
          estimatedTokens: item.estimatedTokens,
        });
      }
    }
  }
  const agents: AgentSummary[] = [];
  if (Array.isArray(raw.agents)) {
    for (const item of raw.agents) {
      if (
        isRecord(item) &&
        typeof item.name === "string" &&
        typeof item.fileName === "string" &&
        typeof item.description === "string"
      ) {
        agents.push({
          name: item.name,
          fileName: item.fileName,
          description: item.description,
        });
      }
    }
  }
  const rules: RuleSummary[] = [];
  if (Array.isArray(raw.rules)) {
    for (const item of raw.rules) {
      if (
        isRecord(item) &&
        typeof item.name === "string" &&
        typeof item.relativePath === "string" &&
        isRelativeSubpath(item.relativePath)
      ) {
        rules.push({
          name: item.name,
          relativePath: item.relativePath,
        });
      }
    }
  }
  const hooks: HookSummary[] = [];
  if (Array.isArray(raw.hooks)) {
    for (const item of raw.hooks) {
      if (
        isRecord(item) &&
        typeof item.event === "string" &&
        typeof item.commandCount === "number"
      ) {
        hooks.push({
          event: item.event,
          commandCount: item.commandCount,
        });
      }
    }
  }
  const mcpServers: McpServerSummary[] = [];
  if (Array.isArray(raw.mcpServers)) {
    for (const item of raw.mcpServers) {
      if (
        isRecord(item) &&
        typeof item.name === "string" &&
        (item.transport === "stdio" || item.transport === "http" || item.transport === "unknown") &&
        typeof item.eager === "boolean"
      ) {
        mcpServers.push({
          name: item.name,
          transport: item.transport,
          eager: item.eager,
        });
      }
    }
  }
  return { counts, skills, agents, rules, hooks, mcpServers };
}

function decodeCatalogEntry(raw: unknown): CatalogEntry | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    typeof raw.id !== "string" ||
    !isCatalogEntryId(raw.id) ||
    typeof raw.marketplaceId !== "string" ||
    !isMarketplaceId(raw.marketplaceId) ||
    typeof raw.slug !== "string" ||
    !isPluginDirName(raw.slug) ||
    typeof raw.name !== "string" ||
    !isPluginName(raw.name) ||
    typeof raw.displayName !== "string" ||
    typeof raw.description !== "string" ||
    typeof raw.sourceFormat !== "string" ||
    !isManifestEcosystem(raw.sourceFormat)
  ) {
    return null;
  }
  const installSource = decodePluginInstallSource(raw.installSource);
  if (installSource === null) {
    return null;
  }
  const tags: string[] = [];
  if (Array.isArray(raw.tags)) {
    for (const tag of raw.tags) {
      if (typeof tag === "string") {
        tags.push(tag);
      }
    }
  }
  return {
    id: raw.id,
    marketplaceId: raw.marketplaceId,
    slug: raw.slug,
    name: raw.name,
    displayName: raw.displayName,
    description: raw.description,
    version: readNullableString(raw, "version"),
    author: readNullableString(raw, "author"),
    category: readNullableString(raw, "category"),
    tags,
    homepage: readNullableString(raw, "homepage"),
    repository: readNullableString(raw, "repository"),
    sourceFormat: raw.sourceFormat,
    installSource,
    componentCounts: decodeComponentCounts(raw.componentCounts),
    componentsPreview: decodeComponentInventory(raw.componentsPreview),
  };
}

function decodeMarketplaceSyncState(raw: unknown): MarketplaceSyncState | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return null;
  }
  switch (raw.kind) {
    case "never-synced":
      return { kind: "never-synced" };
    case "synced": {
      if (
        typeof raw.syncedAt !== "string" ||
        !isIsoTimestamp(raw.syncedAt) ||
        typeof raw.format !== "string" ||
        !isManifestEcosystem(raw.format) ||
        typeof raw.pluginCount !== "number"
      ) {
        return null;
      }
      return {
        kind: "synced",
        syncedAt: raw.syncedAt,
        resolvedRef: readNullableString(raw, "resolvedRef"),
        resolvedSha: readNullableString(raw, "resolvedSha"),
        format: raw.format,
        pluginCount: raw.pluginCount,
      };
    }
    case "sync-failed": {
      if (
        typeof raw.attemptedAt !== "string" ||
        !isIsoTimestamp(raw.attemptedAt) ||
        typeof raw.reason !== "string"
      ) {
        return null;
      }
      const lastGoodSyncAt =
        typeof raw.lastGoodSyncAt === "string" && isIsoTimestamp(raw.lastGoodSyncAt)
          ? raw.lastGoodSyncAt
          : null;
      return {
        kind: "sync-failed",
        attemptedAt: raw.attemptedAt,
        lastGoodSyncAt,
        reason: raw.reason,
      };
    }
    default:
      return null;
  }
}

function decodeRemediationPlan(raw: unknown): RemediationPlan | undefined {
  if (!isRecord(raw) || typeof raw.kind !== "string" || typeof raw.label !== "string") {
    return undefined;
  }
  switch (raw.kind) {
    case "readapt-bundle":
    case "disable-plugin":
    case "remove-plugin":
      if (typeof raw.pluginId === "string" && isInstalledPluginId(raw.pluginId)) {
        return { kind: raw.kind, pluginId: raw.pluginId, label: raw.label };
      }
      return undefined;
    case "clean-stale-staging": {
      const artifactPath =
        typeof raw.path === "string" && isAbsolutePath(raw.path) ? raw.path : undefined;
      return {
        kind: "clean-stale-staging",
        ...(artifactPath !== undefined ? { path: artifactPath } : {}),
        label: raw.label,
      };
    }
    case "retry-marketplace-sync":
      if (typeof raw.marketplaceId === "string" && isMarketplaceId(raw.marketplaceId)) {
        return { kind: "retry-marketplace-sync", marketplaceId: raw.marketplaceId, label: raw.label };
      }
      return undefined;
    default:
      return undefined;
  }
}

function decodeDiagnosticSubject(raw: unknown): DiagnosticSubject | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return null;
  }
  switch (raw.kind) {
    case "installed":
      return typeof raw.pluginId === "string" && isInstalledPluginId(raw.pluginId)
        ? { kind: "installed", pluginId: raw.pluginId }
        : null;
    case "marketplace":
      return typeof raw.marketplaceId === "string" && isMarketplaceId(raw.marketplaceId)
        ? { kind: "marketplace", marketplaceId: raw.marketplaceId }
        : null;
    case "path":
      return typeof raw.path === "string" && isAbsolutePath(raw.path)
        ? { kind: "path", path: raw.path }
        : null;
    default:
      return null;
  }
}

function decodePersistedDiagnosticDetail(raw: unknown): DiagnosticDetail | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return null;
  }
  switch (raw.kind) {
    case "marketplace-sync-failed":
      if (
        typeof raw.marketplaceId === "string" &&
        isMarketplaceId(raw.marketplaceId) &&
        typeof raw.reason === "string"
      ) {
        return {
          kind: "marketplace-sync-failed",
          marketplaceId: raw.marketplaceId,
          reason: raw.reason,
        };
      }
      return null;
    case "marketplace-manifest-invalid":
      if (
        typeof raw.marketplaceId === "string" &&
        isMarketplaceId(raw.marketplaceId) &&
        typeof raw.filePath === "string" &&
        isAbsolutePath(raw.filePath) &&
        typeof raw.reason === "string"
      ) {
        return {
          kind: "marketplace-manifest-invalid",
          marketplaceId: raw.marketplaceId,
          filePath: raw.filePath,
          reason: raw.reason,
        };
      }
      return null;
    case "manifest-json-syntax":
      if (
        typeof raw.filePath === "string" &&
        isAbsolutePath(raw.filePath) &&
        typeof raw.hadUtf8Bom === "boolean" &&
        typeof raw.syntaxError === "string"
      ) {
        return {
          kind: "manifest-json-syntax",
          filePath: raw.filePath,
          line: typeof raw.line === "number" ? raw.line : null,
          column: typeof raw.column === "number" ? raw.column : null,
          hadUtf8Bom: raw.hadUtf8Bom,
          syntaxError: raw.syntaxError,
        };
      }
      return null;
    case "path-traversal-rejected":
      if (
        typeof raw.offendingPath === "string" &&
        typeof raw.resolvedOutsideRoot === "string"
      ) {
        return {
          kind: "path-traversal-rejected",
          offendingPath: raw.offendingPath,
          resolvedOutsideRoot: raw.resolvedOutsideRoot,
        };
      }
      return null;
    default:
      return null;
  }
}

function decodePersistedDiagnostic(raw: unknown): Diagnostic | null {
  if (!isRecord(raw)) {
    return null;
  }
  const severity: DiagnosticSeverity | null =
    raw.severity === "error" || raw.severity === "warning" ? raw.severity : null;
  if (
    typeof raw.id !== "string" ||
    !isDiagnosticId(raw.id) ||
    severity === null ||
    typeof raw.message !== "string" ||
    typeof raw.hint !== "string"
  ) {
    return null;
  }
  const subject = decodeDiagnosticSubject(raw.subject);
  const detail = decodePersistedDiagnosticDetail(raw.detail);
  if (subject === null || detail === null) {
    return null;
  }
  const remediation = decodeRemediationPlan(raw.remediation);
  return {
    id: raw.id,
    severity,
    subject,
    detail,
    message: raw.message,
    hint: raw.hint,
    ...(remediation !== undefined ? { remediation } : {}),
  };
}

function decodeManagedProvenance(raw: unknown): ManagedProvenance | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return null;
  }
  const installSource = decodePluginInstallSource(raw.installSource);
  if (
    installSource === null ||
    typeof raw.installedAt !== "string" ||
    !isIsoTimestamp(raw.installedAt)
  ) {
    return null;
  }
  const installedVersion = readNullableString(raw, "installedVersion");
  const installedSha = readNullableString(raw, "installedSha");
  if (raw.kind === "marketplace") {
    if (
      typeof raw.marketplaceId !== "string" ||
      !isMarketplaceId(raw.marketplaceId) ||
      typeof raw.entryId !== "string" ||
      !isCatalogEntryId(raw.entryId)
    ) {
      return null;
    }
    return {
      kind: "marketplace",
      marketplaceId: raw.marketplaceId,
      entryId: raw.entryId,
      installSource,
      installedVersion,
      installedSha,
      installedAt: raw.installedAt,
    };
  }
  if (raw.kind === "direct") {
    return {
      kind: "direct",
      installSource,
      installedVersion,
      installedSha,
      installedAt: raw.installedAt,
    };
  }
  return null;
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
  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.marketplaces)
      ? parsed.marketplaces
      : [];
  const entries: KnownMarketplaceEntry[] = [];
  const seen = new Set<MarketplaceId>();
  for (const item of list) {
    if (!isRecord(item)) {
      continue;
    }
    if (
      typeof item.id !== "string" ||
      !isMarketplaceId(item.id) ||
      typeof item.addedAt !== "string" ||
      !isIsoTimestamp(item.addedAt)
    ) {
      continue;
    }
    const source = decodeMarketplaceSource(item.source);
    if (source === null || seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    entries.push({ id: item.id, source, addedAt: item.addedAt });
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return entries;
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

function decodeSyncCache(raw: unknown): PersistedSyncCache | null {
  if (!isRecord(raw) || typeof raw.marketplaceId !== "string" || !isMarketplaceId(raw.marketplaceId)) {
    return null;
  }
  const sync = decodeMarketplaceSyncState(raw.sync);
  if (sync === null) {
    return null;
  }
  const localMirrorPath =
    typeof raw.localMirrorPath === "string" && isAbsolutePath(raw.localMirrorPath)
      ? raw.localMirrorPath
      : null;
  const sourceMtimeMs = typeof raw.sourceMtimeMs === "number" ? raw.sourceMtimeMs : null;
  const entries: CatalogEntry[] = [];
  if (Array.isArray(raw.entries)) {
    for (const item of raw.entries) {
      const decoded = decodeCatalogEntry(item);
      if (decoded !== null) {
        entries.push(decoded);
      }
    }
  }
  const diagnostics: Diagnostic[] = [];
  if (Array.isArray(raw.diagnostics)) {
    for (const item of raw.diagnostics) {
      const decoded = decodePersistedDiagnostic(item);
      if (decoded !== null) {
        diagnostics.push(decoded);
      }
    }
  }
  return {
    schemaVersion: 1,
    marketplaceId: raw.marketplaceId,
    sync,
    localMirrorPath,
    sourceMtimeMs,
    entries,
    diagnostics,
  };
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

function decodeReceipt(raw: unknown): PersistedReceipt | null {
  if (!isRecord(raw)) {
    return null;
  }
  if (
    typeof raw.id !== "string" ||
    !isInstalledPluginId(raw.id) ||
    typeof raw.scope !== "string" ||
    !isInstallScope(raw.scope) ||
    typeof raw.dirName !== "string" ||
    !isPluginDirName(raw.dirName)
  ) {
    return null;
  }
  const provenance = decodeManagedProvenance(raw.provenance);
  if (provenance === null) {
    return null;
  }
  return {
    schemaVersion: 1,
    id: raw.id,
    scope: raw.scope,
    dirName: raw.dirName,
    provenance,
  };
}

export async function loadReceipt(
  paths: WorkspacePaths,
  scope: InstallScope,
  dirName: PluginDirName,
): Promise<PersistedReceipt | null> {
  const raw = await readJsonSafe(receiptPath(paths, scope, dirName));
  return decodeReceipt(raw);
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

function extractTargetDirName(artifactName: string, prefix: string): PluginDirName | null {
  const rest = artifactName.slice(prefix.length);
  if (rest.length === 0) {
    return null;
  }
  const lastDash = rest.lastIndexOf("-");
  if (lastDash > 0 && /^[0-9a-f]{8,}$/i.test(rest.slice(lastDash + 1))) {
    const candidate = rest.slice(0, lastDash);
    if (isPluginDirName(candidate)) {
      return candidate;
    }
  }
  return isPluginDirName(rest) ? rest : null;
}

async function isLockHeldByLiveProcess(lockFilePath: AbsolutePath): Promise<boolean> {
  return !(await isLockStale(lockFilePath, DEFAULT_LOCK_STALE_MS));
}

/**
 * Strictly read-only scan for stale `.agy-stage-*` and `.agy-backup-*` entries inside a scope root.
 */
export async function listStaleStagingPaths(
  scopeRoot: AbsolutePath,
  scope: InstallScope,
): Promise<readonly StaleStagingArtifact[]> {
  let names: string[];
  try {
    names = await fs.readdir(scopeRoot);
  } catch {
    return [];
  }
  const artifacts: StaleStagingArtifact[] = [];
  for (const name of names) {
    if (name.startsWith(STAGING_PREFIX)) {
      artifacts.push({
        path: makeAbsolutePath(path.join(scopeRoot, name)),
        name,
        scope,
        artifactKind: "staging",
        targetDirName: extractTargetDirName(name, STAGING_PREFIX),
      });
    } else if (name.startsWith(BACKUP_PREFIX)) {
      artifacts.push({
        path: makeAbsolutePath(path.join(scopeRoot, name)),
        name,
        scope,
        artifactKind: "backup",
        targetDirName: extractTargetDirName(name, BACKUP_PREFIX),
      });
    }
  }
  artifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return artifacts;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recovers missing target directories from `.agy-backup-*` artifacts and removes stale
 * `.agy-stage-*` and redundant `.agy-backup-*` entries. Called only on mutations or remediation.
 */
export async function recoverAndCleanStagingArtifacts(
  scopeRoot: AbsolutePath,
  scope: InstallScope,
  dirNameFilter?: PluginDirName,
  onlyPath?: AbsolutePath,
): Promise<readonly AbsolutePath[]> {
  const artifacts = await listStaleStagingPaths(scopeRoot, scope);
  const removedPaths: AbsolutePath[] = [];

  for (const artifact of artifacts) {
    if (onlyPath !== undefined && artifact.path !== onlyPath) {
      continue;
    }
    if (dirNameFilter !== undefined) {
      if (artifact.targetDirName !== dirNameFilter) {
        continue;
      }
    } else if (artifact.targetDirName !== null) {
      const lockFile = targetLockPath(scopeRoot, artifact.targetDirName);
      if (await isLockHeldByLiveProcess(lockFile)) {
        continue;
      }
    }
    if (artifact.artifactKind === "backup" && artifact.targetDirName !== null) {
      const targetPath = joinAbsolutePath(scopeRoot, artifact.targetDirName);
      if (!(await pathExists(targetPath))) {
        try {
          await fs.rename(artifact.path, targetPath);
          removedPaths.push(artifact.path);
          continue;
        } catch {
          // Fall through to removal only if rename failed because target appeared concurrently.
          if (!(await pathExists(targetPath))) {
            continue;
          }
        }
      }
    }
    await fs.rm(artifact.path, { recursive: true, force: true });
    removedPaths.push(artifact.path);
  }

  return removedPaths;
}

export function isNonEmptyList<T>(items: readonly T[]): items is readonly [T, ...T[]] {
  return isNonEmpty(items);
}

export function safeJoinRelative(base: AbsolutePath, rawRelative: string): AbsolutePath {
  return joinAbsolutePath(base, makeRelativeSubpath(rawRelative));
}
