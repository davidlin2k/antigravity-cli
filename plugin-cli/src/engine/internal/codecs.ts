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
  isPluginDirName,
  isPluginName,
  isRelativeSubpath,
  isSshGitUrl,
} from "../../domain/types.ts";
import type {
  AgentSummary,
  CatalogEntry,
  ComponentCounts,
  ComponentInventory,
  Diagnostic,
  DiagnosticDetail,
  DiagnosticSeverity,
  DiagnosticSubject,
  HookSummary,
  MarketplaceId,
  MarketplaceSource,
  MarketplaceSyncState,
  McpServerSummary,
  PluginInstallSource,
  RelativeSubpath,
  RemediationPlan,
  RemoteGitUrl,
  RuleSummary,
  SkillSummary,
} from "../../domain/types.ts";
import { isRecord } from "./fs-safety.ts";
import type {
  KnownMarketplaceEntry,
  ManagedProvenance,
  PersistedReceipt,
  PersistedSyncCache,
} from "./stores.ts";

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readGuardedString<T extends string>(
  value: unknown,
  guard: (candidate: string) => candidate is T,
): T | null {
  return typeof value === "string" && guard(value) ? value : null;
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

function decodeArray<T>(raw: unknown, decodeItem: (item: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: T[] = [];
  for (const item of raw) {
    const decoded = decodeItem(item);
    if (decoded !== null) {
      out.push(decoded);
    }
  }
  return out;
}

function readGitSourceOptions(raw: Record<string, unknown>): {
  readonly ref?: string;
  readonly subdir?: RelativeSubpath;
} {
  const ref = readOptionalString(raw, "ref");
  const subdir = readGuardedString(raw.subdir, isRelativeSubpath) ?? undefined;
  return {
    ...(ref !== undefined ? { ref } : {}),
    ...(subdir !== undefined ? { subdir } : {}),
  };
}

function readGitCommitOptions(raw: Record<string, unknown>): {
  readonly ref?: string;
  readonly sha?: string;
} {
  const ref = readOptionalString(raw, "ref");
  const sha = readOptionalString(raw, "sha");
  return {
    ...(ref !== undefined ? { ref } : {}),
    ...(sha !== undefined ? { sha } : {}),
  };
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
      return {
        kind: "github",
        owner: raw.owner,
        repo: raw.repo,
        ...readGitSourceOptions(raw),
      };
    }
    case "ssh": {
      const url = readGuardedString(raw.url, isSshGitUrl);
      return url === null ? null : { kind: "ssh", url, ...readGitSourceOptions(raw) };
    }
    case "https-git": {
      const url = readGuardedString(raw.url, isHttpUrl);
      return url === null ? null : { kind: "https-git", url, ...readGitSourceOptions(raw) };
    }
    case "https-json": {
      const url = readGuardedString(raw.url, isHttpUrl);
      return url === null ? null : { kind: "https-json", url };
    }
    case "local-folder": {
      const localPath = readGuardedString(raw.path, isAbsolutePath);
      return localPath === null ? null : { kind: "local-folder", path: localPath };
    }
    case "local-json": {
      const localPath = readGuardedString(raw.path, isAbsolutePath);
      return localPath === null ? null : { kind: "local-json", path: localPath };
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
      const marketplaceId = readGuardedString(raw.marketplaceId, isMarketplaceId);
      return marketplaceId === null ? null : { kind: "marketplace-root", marketplaceId };
    }
    case "marketplace-subdir": {
      const marketplaceId = readGuardedString(raw.marketplaceId, isMarketplaceId);
      const subdir = readGuardedString(raw.subdir, isRelativeSubpath);
      return marketplaceId === null || subdir === null
        ? null
        : { kind: "marketplace-subdir", marketplaceId, subdir };
    }
    case "git-subdir": {
      const repoUrl = readRemoteGitUrl(raw.repoUrl);
      const subdir = readGuardedString(raw.subdir, isRelativeSubpath);
      return repoUrl === null || subdir === null
        ? null
        : { kind: "git-subdir", repoUrl, subdir, ...readGitCommitOptions(raw) };
    }
    case "git-repo": {
      const repoUrl = readRemoteGitUrl(raw.repoUrl);
      return repoUrl === null ? null : { kind: "git-repo", repoUrl, ...readGitCommitOptions(raw) };
    }
    case "archive-url": {
      const url = readGuardedString(raw.url, isHttpUrl);
      if (url === null) {
        return null;
      }
      const sha256 = readOptionalString(raw, "sha256");
      return { kind: "archive-url", url, ...(sha256 !== undefined ? { sha256 } : {}) };
    }
    case "local-dir": {
      const localPath = readGuardedString(raw.path, isAbsolutePath);
      return localPath === null ? null : { kind: "local-dir", path: localPath };
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

function decodeSkillSummary(item: unknown): SkillSummary | null {
  if (
    !isRecord(item) ||
    typeof item.name !== "string" ||
    typeof item.folderName !== "string" ||
    typeof item.description !== "string" ||
    typeof item.frontmatterNamePresent !== "boolean" ||
    typeof item.estimatedTokens !== "number"
  ) {
    return null;
  }
  return {
    name: item.name,
    folderName: item.folderName,
    description: item.description,
    frontmatterNamePresent: item.frontmatterNamePresent,
    estimatedTokens: item.estimatedTokens,
  };
}

function decodeAgentSummary(item: unknown): AgentSummary | null {
  if (
    !isRecord(item) ||
    typeof item.name !== "string" ||
    typeof item.fileName !== "string" ||
    typeof item.description !== "string"
  ) {
    return null;
  }
  return { name: item.name, fileName: item.fileName, description: item.description };
}

function decodeRuleSummary(item: unknown): RuleSummary | null {
  if (!isRecord(item) || typeof item.name !== "string") {
    return null;
  }
  const relativePath = readGuardedString(item.relativePath, isRelativeSubpath);
  return relativePath === null ? null : { name: item.name, relativePath };
}

function decodeHookSummary(item: unknown): HookSummary | null {
  if (!isRecord(item) || typeof item.event !== "string" || typeof item.commandCount !== "number") {
    return null;
  }
  return { event: item.event, commandCount: item.commandCount };
}

function decodeMcpServerSummary(item: unknown): McpServerSummary | null {
  if (
    !isRecord(item) ||
    typeof item.name !== "string" ||
    (item.transport !== "stdio" && item.transport !== "http" && item.transport !== "unknown") ||
    typeof item.eager !== "boolean"
  ) {
    return null;
  }
  return { name: item.name, transport: item.transport, eager: item.eager };
}

function decodeComponentInventory(raw: unknown): ComponentInventory | null {
  if (!isRecord(raw)) {
    return null;
  }
  const counts = decodeComponentCounts(raw.counts);
  if (counts === null) {
    return null;
  }
  return {
    counts,
    skills: decodeArray(raw.skills, decodeSkillSummary),
    agents: decodeArray(raw.agents, decodeAgentSummary),
    rules: decodeArray(raw.rules, decodeRuleSummary),
    hooks: decodeArray(raw.hooks, decodeHookSummary),
    mcpServers: decodeArray(raw.mcpServers, decodeMcpServerSummary),
  };
}

function decodeCatalogEntry(raw: unknown): CatalogEntry | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = readGuardedString(raw.id, isCatalogEntryId);
  const marketplaceId = readGuardedString(raw.marketplaceId, isMarketplaceId);
  const slug = readGuardedString(raw.slug, isPluginDirName);
  const name = readGuardedString(raw.name, isPluginName);
  const sourceFormat = readGuardedString(raw.sourceFormat, isManifestEcosystem);
  if (
    id === null ||
    marketplaceId === null ||
    slug === null ||
    name === null ||
    typeof raw.displayName !== "string" ||
    typeof raw.description !== "string" ||
    sourceFormat === null
  ) {
    return null;
  }
  const installSource = decodePluginInstallSource(raw.installSource);
  if (installSource === null) {
    return null;
  }
  return {
    id,
    marketplaceId,
    slug,
    name,
    displayName: raw.displayName,
    description: raw.description,
    version: readNullableString(raw, "version"),
    author: readNullableString(raw, "author"),
    category: readNullableString(raw, "category"),
    tags: decodeArray(raw.tags, (tag) => (typeof tag === "string" ? tag : null)),
    homepage: readNullableString(raw, "homepage"),
    repository: readNullableString(raw, "repository"),
    sourceFormat,
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
      const syncedAt = readGuardedString(raw.syncedAt, isIsoTimestamp);
      const format = readGuardedString(raw.format, isManifestEcosystem);
      if (syncedAt === null || format === null || typeof raw.pluginCount !== "number") {
        return null;
      }
      return {
        kind: "synced",
        syncedAt,
        resolvedRef: readNullableString(raw, "resolvedRef"),
        resolvedSha: readNullableString(raw, "resolvedSha"),
        format,
        pluginCount: raw.pluginCount,
      };
    }
    case "sync-failed": {
      const attemptedAt = readGuardedString(raw.attemptedAt, isIsoTimestamp);
      if (attemptedAt === null || typeof raw.reason !== "string") {
        return null;
      }
      return {
        kind: "sync-failed",
        attemptedAt,
        lastGoodSyncAt: readGuardedString(raw.lastGoodSyncAt, isIsoTimestamp),
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
    case "remove-plugin": {
      const pluginId = readGuardedString(raw.pluginId, isInstalledPluginId);
      return pluginId === null ? undefined : { kind: raw.kind, pluginId, label: raw.label };
    }
    case "clean-stale-staging": {
      const artifactPath = readGuardedString(raw.path, isAbsolutePath) ?? undefined;
      return {
        kind: "clean-stale-staging",
        ...(artifactPath !== undefined ? { path: artifactPath } : {}),
        label: raw.label,
      };
    }
    case "retry-marketplace-sync": {
      const marketplaceId = readGuardedString(raw.marketplaceId, isMarketplaceId);
      return marketplaceId === null
        ? undefined
        : { kind: "retry-marketplace-sync", marketplaceId, label: raw.label };
    }
    default:
      return undefined;
  }
}

function decodeDiagnosticSubject(raw: unknown): DiagnosticSubject | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return null;
  }
  switch (raw.kind) {
    case "installed": {
      const pluginId = readGuardedString(raw.pluginId, isInstalledPluginId);
      return pluginId === null ? null : { kind: "installed", pluginId };
    }
    case "marketplace": {
      const marketplaceId = readGuardedString(raw.marketplaceId, isMarketplaceId);
      return marketplaceId === null ? null : { kind: "marketplace", marketplaceId };
    }
    case "path": {
      const targetPath = readGuardedString(raw.path, isAbsolutePath);
      return targetPath === null ? null : { kind: "path", path: targetPath };
    }
    default:
      return null;
  }
}

function decodePersistedDiagnosticDetail(raw: unknown): DiagnosticDetail | null {
  if (!isRecord(raw) || typeof raw.kind !== "string") {
    return null;
  }
  switch (raw.kind) {
    case "marketplace-sync-failed": {
      const marketplaceId = readGuardedString(raw.marketplaceId, isMarketplaceId);
      if (marketplaceId === null || typeof raw.reason !== "string") {
        return null;
      }
      return { kind: "marketplace-sync-failed", marketplaceId, reason: raw.reason };
    }
    case "marketplace-manifest-invalid": {
      const marketplaceId = readGuardedString(raw.marketplaceId, isMarketplaceId);
      const filePath = readGuardedString(raw.filePath, isAbsolutePath);
      if (marketplaceId === null || filePath === null || typeof raw.reason !== "string") {
        return null;
      }
      return { kind: "marketplace-manifest-invalid", marketplaceId, filePath, reason: raw.reason };
    }
    case "manifest-json-syntax": {
      const filePath = readGuardedString(raw.filePath, isAbsolutePath);
      if (
        filePath === null ||
        typeof raw.hadUtf8Bom !== "boolean" ||
        typeof raw.syntaxError !== "string"
      ) {
        return null;
      }
      return {
        kind: "manifest-json-syntax",
        filePath,
        line: typeof raw.line === "number" ? raw.line : null,
        column: typeof raw.column === "number" ? raw.column : null,
        hadUtf8Bom: raw.hadUtf8Bom,
        syntaxError: raw.syntaxError,
      };
    }
    case "path-traversal-rejected": {
      if (typeof raw.offendingPath !== "string" || typeof raw.resolvedOutsideRoot !== "string") {
        return null;
      }
      return {
        kind: "path-traversal-rejected",
        offendingPath: raw.offendingPath,
        resolvedOutsideRoot: raw.resolvedOutsideRoot,
      };
    }
    default:
      return null;
  }
}

function decodePersistedDiagnostic(raw: unknown): Diagnostic | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = readGuardedString(raw.id, isDiagnosticId);
  const severity: DiagnosticSeverity | null =
    raw.severity === "error" || raw.severity === "warning" ? raw.severity : null;
  if (
    id === null ||
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
    id,
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
  const installedAt = readGuardedString(raw.installedAt, isIsoTimestamp);
  if (installSource === null || installedAt === null) {
    return null;
  }
  const installedVersion = readNullableString(raw, "installedVersion");
  const installedSha = readNullableString(raw, "installedSha");
  if (raw.kind === "marketplace") {
    const marketplaceId = readGuardedString(raw.marketplaceId, isMarketplaceId);
    const entryId = readGuardedString(raw.entryId, isCatalogEntryId);
    if (marketplaceId === null || entryId === null) {
      return null;
    }
    return {
      kind: "marketplace",
      marketplaceId,
      entryId,
      installSource,
      installedVersion,
      installedSha,
      installedAt,
    };
  }
  if (raw.kind === "direct") {
    return { kind: "direct", installSource, installedVersion, installedSha, installedAt };
  }
  return null;
}

export function decodeKnownMarketplaces(raw: unknown): readonly KnownMarketplaceEntry[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.marketplaces)
      ? raw.marketplaces
      : [];
  const entries: KnownMarketplaceEntry[] = [];
  const seen = new Set<MarketplaceId>();
  for (const item of list) {
    if (!isRecord(item)) {
      continue;
    }
    const id = readGuardedString(item.id, isMarketplaceId);
    const addedAt = readGuardedString(item.addedAt, isIsoTimestamp);
    if (id === null || addedAt === null || seen.has(id)) {
      continue;
    }
    const source = decodeMarketplaceSource(item.source);
    if (source === null) {
      continue;
    }
    seen.add(id);
    entries.push({ id, source, addedAt });
  }
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return entries;
}

export function decodeSyncCache(raw: unknown): PersistedSyncCache | null {
  if (!isRecord(raw)) {
    return null;
  }
  const marketplaceId = readGuardedString(raw.marketplaceId, isMarketplaceId);
  const sync = decodeMarketplaceSyncState(raw.sync);
  if (marketplaceId === null || sync === null) {
    return null;
  }
  return {
    schemaVersion: 1,
    marketplaceId,
    sync,
    localMirrorPath: readGuardedString(raw.localMirrorPath, isAbsolutePath),
    sourceMtimeMs: typeof raw.sourceMtimeMs === "number" ? raw.sourceMtimeMs : null,
    entries: decodeArray(raw.entries, decodeCatalogEntry),
    diagnostics: decodeArray(raw.diagnostics, decodePersistedDiagnostic),
  };
}

export function decodeReceipt(raw: unknown): PersistedReceipt | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = readGuardedString(raw.id, isInstalledPluginId);
  const scope = readGuardedString(raw.scope, isInstallScope);
  const dirName = readGuardedString(raw.dirName, isPluginDirName);
  const provenance = decodeManagedProvenance(raw.provenance);
  if (id === null || scope === null || dirName === null || provenance === null) {
    return null;
  }
  return {
    schemaVersion: 1,
    id,
    scope,
    dirName,
    provenance,
  };
}
