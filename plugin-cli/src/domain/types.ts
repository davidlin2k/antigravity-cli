import path from "node:path";

export type NonEmpty<T> = readonly [T, ...T[]];
export type AtLeastTwo<T> = readonly [T, T, ...T[]];

export function isNonEmpty<T>(items: readonly T[]): items is NonEmpty<T> {
  return items.length > 0;
}

export function isAtLeastTwo<T>(items: readonly T[]): items is AtLeastTwo<T> {
  return items.length >= 2;
}

export type ParseErrorCode =
  | "empty-input"
  | "invalid-path"
  | "path-traversal"
  | "invalid-marketplace-id"
  | "invalid-plugin-name"
  | "invalid-dir-name"
  | "invalid-installed-id"
  | "invalid-catalog-id"
  | "invalid-diagnostic-id"
  | "invalid-revision"
  | "invalid-request-id"
  | "invalid-url"
  | "invalid-ssh-url"
  | "invalid-scope"
  | "invalid-timestamp"
  | "invalid-source"
  | "invalid-cli-args";

export interface ParseError {
  readonly code: ParseErrorCode;
  readonly input: string;
  readonly message: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ParseError };

export function parseOk<T>(value: T): ParseResult<T> {
  return { ok: true, value };
}

export function parseErr(
  code: ParseErrorCode,
  input: string,
  message: string,
): ParseResult<never> {
  return { ok: false, error: { code, input, message } };
}

export type AbsolutePath = string & { readonly __brand: "AbsolutePath" };
export type RelativeSubpath = string & { readonly __brand: "RelativeSubpath" };
export type MarketplaceId = string & { readonly __brand: "MarketplaceId" };
export type PluginName = string & { readonly __brand: "PluginName" };
export type PluginDirName = string & { readonly __brand: "PluginDirName" };
export type InstalledPluginId = string & { readonly __brand: "InstalledPluginId" };
export type CatalogEntryId = string & { readonly __brand: "CatalogEntryId" };
export type DiagnosticId = string & { readonly __brand: "DiagnosticId" };
export type SnapshotRevision = number & { readonly __brand: "SnapshotRevision" };
export type IsoTimestamp = string & { readonly __brand: "IsoTimestamp" };
export type HttpUrl = string & { readonly __brand: "HttpUrl" };
export type SshGitUrl = string & { readonly __brand: "SshGitUrl" };
export type RequestId = number & { readonly __brand: "RequestId" };

export type RemoteGitUrl = HttpUrl | SshGitUrl;

export const INSTALL_SCOPES = ["user", "project"] as const;
export type InstallScope = (typeof INSTALL_SCOPES)[number];

export const MANIFEST_ECOSYSTEMS = [
  "antigravity",
  "claude",
  "cursor",
  "single-plugin",
] as const;
export type ManifestEcosystem = (typeof MANIFEST_ECOSYSTEMS)[number];

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const WHITESPACE_RE = /\s/;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;
const MARKETPLACE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// First char must be alphanumeric so `.`, `..`, and `.agy-*` internal staging/backup dirs cannot be valid plugin dir names.
const PLUGIN_DIR_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const ISO_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;
const SCP_SSH_GIT_RE =
  /^[a-zA-Z0-9._-]+@([a-zA-Z0-9_](?:[a-zA-Z0-9_-]*[a-zA-Z0-9_])?(?:\.[a-zA-Z0-9_](?:[a-zA-Z0-9_-]*[a-zA-Z0-9_])?)*):([^\s]+)$/;

function hasDotDotSegment(rawPath: string): boolean {
  for (const segment of rawPath.split("/")) {
    if (segment === "..") {
      return true;
    }
    try {
      if (decodeURIComponent(segment) === "..") {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

function unwrapOrThrow<T>(result: ParseResult<T>): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

export function isAbsolutePath(value: string): value is AbsolutePath {
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    path.isAbsolute(value) &&
    path.resolve(value) === value
  );
}

export function parseAbsolutePath(raw: string): ParseResult<AbsolutePath> {
  if (raw.trim().length === 0) {
    return parseErr("empty-input", raw, "Path cannot be empty.");
  }
  if (raw.includes("\0")) {
    return parseErr("invalid-path", raw, "Path cannot contain NUL bytes.");
  }
  if (!path.isAbsolute(raw)) {
    return parseErr("invalid-path", raw, `Expected an absolute path, got "${raw}".`);
  }
  const resolved = path.resolve(raw);
  if (!isAbsolutePath(resolved)) {
    return parseErr("invalid-path", raw, `Path could not be normalized: "${raw}".`);
  }
  return parseOk(resolved);
}

export function makeAbsolutePath(raw: string): AbsolutePath {
  return unwrapOrThrow(parseAbsolutePath(raw));
}

export function joinAbsolutePath(
  base: AbsolutePath,
  ...segments: readonly (RelativeSubpath | PluginDirName)[]
): AbsolutePath {
  const resolved = path.resolve(base, ...segments);
  if (!isAbsolutePath(resolved)) {
    throw new Error(`Resolved path is not canonical: "${resolved}".`);
  }
  return resolved;
}

export function isRelativeSubpath(value: string): value is RelativeSubpath {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    WINDOWS_DRIVE_RE.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

export function parseRelativeSubpath(raw: string): ParseResult<RelativeSubpath> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return parseErr("empty-input", raw, "Relative subpath cannot be empty.");
  }
  if (trimmed.includes("\0")) {
    return parseErr("invalid-path", raw, "Relative subpath cannot contain NUL bytes.");
  }
  const slashed = trimmed.replaceAll("\\", "/");
  if (slashed.startsWith("/") || WINDOWS_DRIVE_RE.test(slashed)) {
    return parseErr("invalid-path", raw, `Expected a relative subpath, got "${raw}".`);
  }
  if (slashed.split("/").some((seg) => seg === "..")) {
    return parseErr("path-traversal", raw, `Relative subpath cannot traverse parent directories: "${raw}".`);
  }
  const normalized = slashed.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  if (!isRelativeSubpath(normalized)) {
    return parseErr("invalid-path", raw, `Invalid relative subpath: "${raw}".`);
  }
  return parseOk(normalized);
}

export function makeRelativeSubpath(raw: string): RelativeSubpath {
  return unwrapOrThrow(parseRelativeSubpath(raw));
}

export function isMarketplaceId(value: string): value is MarketplaceId {
  return MARKETPLACE_ID_RE.test(value);
}

export function parseMarketplaceId(raw: string): ParseResult<MarketplaceId> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return parseErr("empty-input", raw, "Marketplace ID cannot be empty.");
  }
  const normalized = trimmed.toLowerCase();
  if (!isMarketplaceId(normalized)) {
    return parseErr(
      "invalid-marketplace-id",
      raw,
      `Marketplace ID must match ${MARKETPLACE_ID_RE.source}, got "${raw}".`,
    );
  }
  return parseOk(normalized);
}

export function makeMarketplaceId(raw: string): MarketplaceId {
  return unwrapOrThrow(parseMarketplaceId(raw));
}

export function isPluginName(value: string): value is PluginName {
  return (
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value &&
    value !== "." &&
    value !== ".." &&
    !CONTROL_CHAR_RE.test(value) &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

export function parsePluginName(raw: string): ParseResult<PluginName> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return parseErr("empty-input", raw, "Plugin name cannot be empty.");
  }
  if (!isPluginName(trimmed)) {
    return parseErr("invalid-plugin-name", raw, `Invalid plugin name: "${raw}".`);
  }
  return parseOk(trimmed);
}

export function makePluginName(raw: string): PluginName {
  return unwrapOrThrow(parsePluginName(raw));
}

export function isPluginDirName(value: string): value is PluginDirName {
  return PLUGIN_DIR_NAME_RE.test(value);
}

export function parsePluginDirName(raw: string): ParseResult<PluginDirName> {
  if (raw.length === 0 || raw.trim().length === 0) {
    return parseErr("empty-input", raw, "Plugin directory name cannot be empty.");
  }
  if (!isPluginDirName(raw)) {
    return parseErr(
      "invalid-dir-name",
      raw,
      `Plugin directory name must match ${PLUGIN_DIR_NAME_RE.source}, got "${raw}".`,
    );
  }
  return parseOk(raw);
}

export function makePluginDirName(raw: string): PluginDirName {
  return unwrapOrThrow(parsePluginDirName(raw));
}

export function slugifyPluginDirName(raw: string, fallback = "plugin"): PluginDirName {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+/g, "-")
    .replace(/[-.]+$/, "")
    .slice(0, 128);
  if (isPluginDirName(cleaned)) {
    return cleaned;
  }
  if (isPluginDirName(fallback)) {
    return fallback;
  }
  return makePluginDirName("plugin");
}

export function isInstallScope(value: string): value is InstallScope {
  return value === "user" || value === "project";
}

export function parseInstallScope(raw: string): ParseResult<InstallScope> {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) {
    return parseErr("empty-input", raw, "Install scope cannot be empty.");
  }
  if (!isInstallScope(normalized)) {
    return parseErr("invalid-scope", raw, `Expected "user" or "project", got "${raw}".`);
  }
  return parseOk(normalized);
}

export function isManifestEcosystem(value: string): value is ManifestEcosystem {
  return (
    value === "antigravity" ||
    value === "claude" ||
    value === "cursor" ||
    value === "single-plugin"
  );
}

export function isInstalledPluginId(value: string): value is InstalledPluginId {
  const colon = value.indexOf(":");
  if (colon <= 0 || colon === value.length - 1 || value.indexOf(":", colon + 1) !== -1) {
    return false;
  }
  const scope = value.slice(0, colon);
  const dirName = value.slice(colon + 1);
  return isInstallScope(scope) && isPluginDirName(dirName);
}

export function parseInstalledPluginId(raw: string): ParseResult<InstalledPluginId> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return parseErr("empty-input", raw, "Installed plugin ID cannot be empty.");
  }
  if (!isInstalledPluginId(trimmed)) {
    return parseErr(
      "invalid-installed-id",
      raw,
      `Expected "<scope>:<dirName>", got "${raw}".`,
    );
  }
  return parseOk(trimmed);
}

export function makeInstalledPluginId(
  scope: InstallScope,
  dirName: PluginDirName,
): InstalledPluginId {
  const candidate = `${scope}:${dirName}`;
  if (!isInstalledPluginId(candidate)) {
    throw new Error(`Invalid installed plugin ID: "${candidate}".`);
  }
  return candidate;
}

export function splitInstalledPluginId(id: InstalledPluginId): {
  readonly scope: InstallScope;
  readonly dirName: PluginDirName;
} {
  const colon = id.indexOf(":");
  const scope = id.slice(0, colon);
  const dirName = id.slice(colon + 1);
  if (!isInstallScope(scope) || !isPluginDirName(dirName)) {
    throw new Error(`Corrupted installed plugin ID: "${id}".`);
  }
  return { scope, dirName };
}

export function isCatalogEntryId(value: string): value is CatalogEntryId {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1 || value.indexOf("/", slash + 1) !== -1) {
    return false;
  }
  const marketplaceId = value.slice(0, slash);
  const slug = value.slice(slash + 1);
  return isMarketplaceId(marketplaceId) && isPluginDirName(slug);
}

export function parseCatalogEntryId(raw: string): ParseResult<CatalogEntryId> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return parseErr("empty-input", raw, "Catalog entry ID cannot be empty.");
  }
  if (!isCatalogEntryId(trimmed)) {
    return parseErr(
      "invalid-catalog-id",
      raw,
      `Expected "<marketplaceId>/<slug>", got "${raw}".`,
    );
  }
  return parseOk(trimmed);
}

export function makeCatalogEntryId(
  marketplaceId: MarketplaceId,
  slug: PluginDirName,
): CatalogEntryId {
  const candidate = `${marketplaceId}/${slug}`;
  if (!isCatalogEntryId(candidate)) {
    throw new Error(`Invalid catalog entry ID: "${candidate}".`);
  }
  return candidate;
}

export function isDiagnosticId(value: string): value is DiagnosticId {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    !CONTROL_CHAR_RE.test(value) &&
    !WHITESPACE_RE.test(value)
  );
}

export function parseDiagnosticId(raw: string): ParseResult<DiagnosticId> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return parseErr("empty-input", raw, "Diagnostic ID cannot be empty.");
  }
  if (!isDiagnosticId(trimmed)) {
    return parseErr("invalid-diagnostic-id", raw, `Invalid diagnostic ID: "${raw}".`);
  }
  return parseOk(trimmed);
}

export function makeDiagnosticId(prefix: string, ...parts: readonly string[]): DiagnosticId {
  const sanitized = [prefix, ...parts]
    .map((part) => part.trim().replace(/[\u0000-\u001f\u007f\s]+/g, "_"))
    .filter((part) => part.length > 0)
    .join(":")
    .slice(0, 256);
  if (!isDiagnosticId(sanitized)) {
    throw new Error(`Invalid diagnostic ID from "${prefix}".`);
  }
  return sanitized;
}

export function isSnapshotRevision(value: number): value is SnapshotRevision {
  return Number.isSafeInteger(value) && value >= 0;
}

export function parseSnapshotRevision(raw: number): ParseResult<SnapshotRevision> {
  if (!isSnapshotRevision(raw)) {
    return parseErr(
      "invalid-revision",
      String(raw),
      `Expected a non-negative safe integer revision, got "${String(raw)}".`,
    );
  }
  return parseOk(raw);
}

export function makeSnapshotRevision(value: number): SnapshotRevision {
  if (!isSnapshotRevision(value)) {
    throw new RangeError(`Expected a non-negative safe integer revision, got ${String(value)}.`);
  }
  return value;
}

export function nextSnapshotRevision(current: SnapshotRevision): SnapshotRevision {
  return makeSnapshotRevision(current + 1);
}

export function isRequestId(value: number): value is RequestId {
  return Number.isSafeInteger(value) && value >= 1;
}

export function parseRequestId(raw: number): ParseResult<RequestId> {
  if (!isRequestId(raw)) {
    return parseErr(
      "invalid-request-id",
      String(raw),
      `Expected a positive safe integer request ID, got "${String(raw)}".`,
    );
  }
  return parseOk(raw);
}

export function makeRequestId(value: number): RequestId {
  if (!isRequestId(value)) {
    throw new RangeError(`Expected a positive safe integer request ID, got ${String(value)}.`);
  }
  return value;
}

export function nextRequestId(current: RequestId): RequestId {
  return makeRequestId(current + 1);
}

export function isIsoTimestamp(value: string): value is IsoTimestamp {
  const match = ISO_TIMESTAMP_RE.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  // Date.UTC rolls invalid calendar dates like Feb 31 forward; verify exact round-trip.
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    return false;
  }
  if (match[9] !== undefined && match[10] !== undefined) {
    const offsetHour = Number(match[9]);
    const offsetMinute = Number(match[10]);
    if (offsetHour > 23 || offsetMinute > 59) {
      return false;
    }
  }
  return !Number.isNaN(Date.parse(value));
}

export function parseIsoTimestamp(raw: string): ParseResult<IsoTimestamp> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return parseErr("empty-input", raw, "Timestamp cannot be empty.");
  }
  if (!isIsoTimestamp(trimmed)) {
    return parseErr("invalid-timestamp", raw, `Invalid ISO-8601 timestamp: "${raw}".`);
  }
  return parseOk(trimmed);
}

export function makeIsoTimestamp(date: Date = new Date()): IsoTimestamp {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError("Cannot construct IsoTimestamp from an invalid Date.");
  }
  const iso = date.toISOString();
  if (!isIsoTimestamp(iso)) {
    throw new Error(`Date.toISOString produced an invalid timestamp: "${iso}".`);
  }
  return iso;
}

export function isHttpUrl(value: string): value is HttpUrl {
  if (value.length === 0 || CONTROL_CHAR_RE.test(value) || WHITESPACE_RE.test(value)) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

export function parseHttpUrl(raw: string): ParseResult<HttpUrl> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return parseErr("empty-input", raw, "URL cannot be empty.");
  }
  if (!isHttpUrl(trimmed)) {
    return parseErr("invalid-url", raw, `Invalid HTTP(S) URL: "${raw}".`);
  }
  return parseOk(trimmed);
}

export function makeHttpUrl(raw: string): HttpUrl {
  return unwrapOrThrow(parseHttpUrl(raw));
}

export function isSshGitUrl(value: string): value is SshGitUrl {
  if (
    value.length === 0 ||
    CONTROL_CHAR_RE.test(value) ||
    WHITESPACE_RE.test(value) ||
    value.includes("#") ||
    value.includes("?") ||
    value.includes("\\")
  ) {
    return false;
  }
  if (value.startsWith("ssh://")) {
    const withoutScheme = value.slice("ssh://".length);
    const firstSlash = withoutScheme.indexOf("/");
    if (firstSlash <= 0) {
      return false;
    }
    const rawPath = withoutScheme.slice(firstSlash + 1);
    if (rawPath.length === 0 || hasDotDotSegment(rawPath)) {
      return false;
    }
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === "ssh:" &&
        parsed.hostname.length > 0 &&
        parsed.pathname.length > 1
      );
    } catch {
      return false;
    }
  }
  const scpMatch = SCP_SSH_GIT_RE.exec(value);
  if (!scpMatch) {
    return false;
  }
  const repoPath = scpMatch[2];
  if (repoPath === undefined || repoPath.length === 0 || repoPath === "/") {
    return false;
  }
  return !hasDotDotSegment(repoPath);
}

export function parseSshGitUrl(raw: string): ParseResult<SshGitUrl> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return parseErr("empty-input", raw, "SSH git URL cannot be empty.");
  }
  if (!isSshGitUrl(trimmed)) {
    return parseErr("invalid-ssh-url", raw, `Invalid SSH git URL: "${raw}".`);
  }
  return parseOk(trimmed);
}

export function makeSshGitUrl(raw: string): SshGitUrl {
  return unwrapOrThrow(parseSshGitUrl(raw));
}

/**
 * Concrete persisted marketplace source. Ambiguous HTTPS URLs are resolved once at
 * the `addMarketplace` boundary into either `https-git` or `https-json`.
 */
export type MarketplaceSource =
  | {
      readonly kind: "github";
      readonly owner: string;
      readonly repo: string;
      readonly ref?: string;
      readonly subdir?: RelativeSubpath;
    }
  | {
      readonly kind: "ssh";
      readonly url: SshGitUrl;
      readonly ref?: string;
      readonly subdir?: RelativeSubpath;
    }
  | {
      readonly kind: "https-git";
      readonly url: HttpUrl;
      readonly ref?: string;
      readonly subdir?: RelativeSubpath;
    }
  | {
      readonly kind: "https-json";
      readonly url: HttpUrl;
    }
  | {
      readonly kind: "local-folder";
      readonly path: AbsolutePath;
    }
  | {
      readonly kind: "local-json";
      readonly path: AbsolutePath;
    };

export type GithubMarketplaceSource = Extract<MarketplaceSource, { readonly kind: "github" }>;

/**
 * Result of pure synchronous parsing of user-typed marketplace input.
 * Shared by CLI argument parsing and the TUI Add Marketplace live preview.
 */
export type ParsedMarketplaceInput =
  | MarketplaceSource
  | {
      readonly kind: "https-auto";
      readonly url: HttpUrl;
      readonly ref?: string;
      readonly subdir?: RelativeSubpath;
    };

/**
 * Concrete source from which an individual plugin bundle can be materialized.
 */
export type PluginInstallSource =
  | {
      readonly kind: "marketplace-root";
      readonly marketplaceId: MarketplaceId;
    }
  | {
      readonly kind: "marketplace-subdir";
      readonly marketplaceId: MarketplaceId;
      readonly subdir: RelativeSubpath;
    }
  | {
      readonly kind: "git-subdir";
      readonly repoUrl: RemoteGitUrl;
      readonly subdir: RelativeSubpath;
      readonly ref?: string;
      readonly sha?: string;
    }
  | {
      readonly kind: "git-repo";
      readonly repoUrl: RemoteGitUrl;
      readonly ref?: string;
      readonly sha?: string;
    }
  | {
      readonly kind: "archive-url";
      readonly url: HttpUrl;
      readonly sha256?: string;
    }
  | {
      readonly kind: "local-dir";
      readonly path: AbsolutePath;
    };

/**
 * Strictly valid Antigravity root `plugin.json` fields. Unknown fields from Claude or
 * Cursor manifests are stripped during adaptation because Antigravity drops them silently.
 */
export interface NormalizedPluginManifest {
  readonly name: PluginName;
  readonly displayName?: string;
  readonly description?: string;
  readonly version?: string;
  readonly author?: string;
  readonly homepage?: string;
  readonly repository?: string;
  readonly logo?: string;
  readonly suggestedPrompts?: readonly string[];
  readonly disabled?: boolean;
}

export interface ComponentCounts {
  readonly skills: number;
  readonly agents: number;
  readonly rules: number;
  readonly hooks: number;
  readonly mcpServers: number;
}

export const EMPTY_COMPONENT_COUNTS: ComponentCounts = {
  skills: 0,
  agents: 0,
  rules: 0,
  hooks: 0,
  mcpServers: 0,
};

export interface SkillSummary {
  readonly name: string;
  readonly folderName: string;
  readonly description: string;
  readonly frontmatterNamePresent: boolean;
  readonly estimatedTokens: number;
}

export interface AgentSummary {
  readonly name: string;
  readonly fileName: string;
  readonly description: string;
}

export interface RuleSummary {
  readonly name: string;
  readonly relativePath: RelativeSubpath;
}

export interface HookSummary {
  readonly event: string;
  readonly commandCount: number;
}

export interface McpServerSummary {
  readonly name: string;
  readonly transport: "stdio" | "http" | "unknown";
  readonly eager: boolean;
}

export interface ComponentInventory {
  readonly counts: ComponentCounts;
  readonly skills: readonly SkillSummary[];
  readonly agents: readonly AgentSummary[];
  readonly rules: readonly RuleSummary[];
  readonly hooks: readonly HookSummary[];
  readonly mcpServers: readonly McpServerSummary[];
}

export const EMPTY_COMPONENT_INVENTORY: ComponentInventory = {
  counts: EMPTY_COMPONENT_COUNTS,
  skills: [],
  agents: [],
  rules: [],
  hooks: [],
  mcpServers: [],
};

export interface CatalogEntry {
  readonly id: CatalogEntryId;
  readonly marketplaceId: MarketplaceId;
  readonly slug: PluginDirName;
  readonly name: PluginName;
  readonly displayName: string;
  readonly description: string;
  readonly version: string | null;
  readonly author: string | null;
  readonly category: string | null;
  readonly tags: readonly string[];
  readonly homepage: string | null;
  readonly repository: string | null;
  readonly sourceFormat: ManifestEcosystem;
  readonly installSource: PluginInstallSource;
  readonly componentCounts: ComponentCounts | null;
  readonly componentsPreview: ComponentInventory | null;
}

export type InstallProvenance =
  | {
      readonly kind: "marketplace";
      readonly marketplaceId: MarketplaceId;
      readonly entryId: CatalogEntryId;
      readonly installSource: PluginInstallSource;
      readonly installedVersion: string | null;
      readonly installedSha: string | null;
      readonly installedAt: IsoTimestamp;
    }
  | {
      readonly kind: "direct";
      readonly installSource: PluginInstallSource;
      readonly installedVersion: string | null;
      readonly installedSha: string | null;
      readonly installedAt: IsoTimestamp;
    }
  | {
      readonly kind: "unmanaged";
    };

/**
 * Effective runtime status in Antigravity. A disabled plugin cannot be shadowed,
 * making `{ disabled: true, shadowedBy: ... }` unrepresentable.
 */
export type PluginActivation =
  | { readonly kind: "active" }
  | { readonly kind: "disabled" }
  | { readonly kind: "shadowed"; readonly shadowedBy: InstalledPluginId };

export interface VersionUpdate {
  readonly latestVersion: string;
  readonly sourceEntryId: CatalogEntryId;
}

export interface ValidInstalledPlugin {
  readonly kind: "valid";
  readonly id: InstalledPluginId;
  readonly scope: InstallScope;
  readonly dirName: PluginDirName;
  readonly installPath: AbsolutePath;
  readonly manifest: NormalizedPluginManifest;
  readonly activation: PluginActivation;
  readonly provenance: InstallProvenance;
  readonly components: ComponentInventory;
  readonly diskBytes: number;
  readonly estimatedDescriptionTokens: number;
  readonly updateAvailable: VersionUpdate | null;
  readonly diagnosticIds: readonly DiagnosticId[];
}

export interface BrokenInstalledPlugin {
  readonly kind: "broken";
  readonly id: InstalledPluginId;
  readonly scope: InstallScope;
  readonly dirName: PluginDirName;
  readonly installPath: AbsolutePath;
  readonly provenance: InstallProvenance;
  readonly diskBytes: number;
  readonly diagnosticIds: NonEmpty<DiagnosticId>;
}

export type InstalledPlugin = ValidInstalledPlugin | BrokenInstalledPlugin;

export type MarketplaceSyncState =
  | {
      readonly kind: "synced";
      readonly syncedAt: IsoTimestamp;
      readonly resolvedRef: string | null;
      readonly resolvedSha: string | null;
      readonly format: ManifestEcosystem;
      readonly pluginCount: number;
    }
  | {
      readonly kind: "never-synced";
    }
  | {
      readonly kind: "sync-failed";
      readonly attemptedAt: IsoTimestamp;
      readonly lastGoodSyncAt: IsoTimestamp | null;
      readonly reason: string;
    };

export interface MarketplaceRecord {
  readonly id: MarketplaceId;
  readonly source: MarketplaceSource;
  readonly addedAt: IsoTimestamp;
  readonly sync: MarketplaceSyncState;
  readonly localMirrorPath: AbsolutePath | null;
}

export type RemediationPlan =
  | {
      readonly kind: "readapt-bundle";
      readonly pluginId: InstalledPluginId;
      readonly label: string;
    }
  | {
      readonly kind: "disable-plugin";
      readonly pluginId: InstalledPluginId;
      readonly label: string;
    }
  | {
      readonly kind: "remove-plugin";
      readonly pluginId: InstalledPluginId;
      readonly label: string;
    }
  | {
      readonly kind: "clean-stale-staging";
      readonly path?: AbsolutePath;
      readonly label: string;
    }
  | {
      readonly kind: "retry-marketplace-sync";
      readonly marketplaceId: MarketplaceId;
      readonly label: string;
    };

export type DiagnosticSeverity = "error" | "warning";

export type DiagnosticSubject =
  | { readonly kind: "installed"; readonly pluginId: InstalledPluginId }
  | { readonly kind: "marketplace"; readonly marketplaceId: MarketplaceId }
  | { readonly kind: "path"; readonly path: AbsolutePath };

export type DiagnosticDetail =
  | {
      readonly kind: "manifest-json-syntax";
      readonly filePath: AbsolutePath;
      readonly line: number | null;
      readonly column: number | null;
      readonly hadUtf8Bom: boolean;
      readonly syntaxError: string;
    }
  | {
      readonly kind: "manifest-schema-invalid";
      readonly filePath: AbsolutePath;
      readonly fieldErrors: NonEmpty<string>;
    }
  | {
      readonly kind: "name-collision";
      readonly collidingName: PluginName;
      readonly winnerId: InstalledPluginId;
      readonly participants: AtLeastTwo<InstalledPluginId>;
    }
  | {
      readonly kind: "skill-frontmatter-missing";
      readonly skillFilePath: AbsolutePath;
      readonly folderName: string;
      readonly missingFields: NonEmpty<"frontmatter" | "name" | "description">;
    }
  | {
      readonly kind: "path-traversal-rejected";
      readonly offendingPath: string;
      readonly resolvedOutsideRoot: string;
    }
  | {
      readonly kind: "hooks-invalid";
      readonly filePath: AbsolutePath;
      readonly reason: string;
    }
  | {
      readonly kind: "mcp-config-invalid";
      readonly filePath: AbsolutePath;
      readonly reason: string;
    }
  | {
      readonly kind: "unadapted-hooks-path";
      readonly sourcePath: AbsolutePath;
      readonly expectedPath: AbsolutePath;
    }
  | {
      readonly kind: "unadapted-mcp-path";
      readonly sourcePath: AbsolutePath;
      readonly expectedPath: AbsolutePath;
    }
  | {
      readonly kind: "unexpanded-plugin-root";
      readonly filePath: AbsolutePath;
      readonly variables: NonEmpty<string>;
    }
  | {
      readonly kind: "stale-staging-artifact";
      readonly artifactPath: AbsolutePath;
      readonly scope: InstallScope;
      readonly artifactKind: "staging" | "backup";
    }
  | {
      readonly kind: "marketplace-sync-failed";
      readonly marketplaceId: MarketplaceId;
      readonly reason: string;
    }
  | {
      readonly kind: "marketplace-manifest-invalid";
      readonly marketplaceId: MarketplaceId;
      readonly filePath: AbsolutePath;
      readonly reason: string;
    }
  | {
      readonly kind: "orphaned-install-dir";
      readonly dirPath: AbsolutePath;
      readonly reason: string;
    }
  | {
      readonly kind: "orphaned-receipt";
      readonly pluginId: InstalledPluginId;
      readonly expectedPath: AbsolutePath;
    };

export interface Diagnostic {
  readonly id: DiagnosticId;
  readonly severity: DiagnosticSeverity;
  readonly subject: DiagnosticSubject;
  readonly detail: DiagnosticDetail;
  readonly message: string;
  readonly hint: string;
  readonly remediation?: RemediationPlan;
}

export interface ScopeStats {
  readonly scope: InstallScope;
  readonly pluginsRoot: AbsolutePath;
  readonly installedCount: number;
  readonly activeCount: number;
  readonly disabledCount: number;
  readonly brokenCount: number;
  readonly diskBytes: number;
  readonly componentTotals: ComponentCounts;
}

export interface MarketplaceStats {
  readonly marketplaceId: MarketplaceId;
  readonly catalogCount: number;
  readonly installedFromCount: number;
  readonly syncStatus: MarketplaceSyncState["kind"];
}

export interface PluginFootprint {
  readonly pluginId: InstalledPluginId;
  readonly pluginName: PluginName;
  readonly scope: InstallScope;
  readonly estimatedDescriptionTokens: number;
  readonly diskBytes: number;
  readonly skillCount: number;
}

export interface WorkspaceStats {
  readonly discoverableCount: number;
  readonly installedCount: number;
  readonly activeCount: number;
  readonly disabledCount: number;
  readonly shadowedCount: number;
  readonly brokenCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly activeComponents: ComponentCounts;
  readonly installedComponents: ComponentCounts;
  readonly estimatedDescriptionTokens: number;
  readonly totalDiskBytes: number;
  readonly byScope: Readonly<Record<InstallScope, ScopeStats>>;
  readonly byMarketplace: readonly MarketplaceStats[];
  readonly topTokenConsumers: readonly PluginFootprint[];
}

export interface WorkspacePaths {
  readonly homeDir: AbsolutePath;
  readonly configDir: AbsolutePath;
  readonly workspaceDir: AbsolutePath;
  readonly userPluginsDir: AbsolutePath;
  readonly projectPluginsDir: AbsolutePath;
  readonly managerDir: AbsolutePath;
}

/**
 * Single immutable projection of the entire plugin workspace.
 * Every CLI command and every TUI frame renders exclusively from this value.
 */
export interface WorkspaceSnapshot {
  readonly revision: SnapshotRevision;
  readonly projectedAt: IsoTimestamp;
  readonly paths: WorkspacePaths;
  readonly catalog: readonly CatalogEntry[];
  readonly installed: readonly InstalledPlugin[];
  readonly marketplaces: readonly MarketplaceRecord[];
  readonly diagnostics: readonly Diagnostic[];
  readonly staleStagingPaths: readonly AbsolutePath[];
  readonly stats: WorkspaceStats;
  readonly catalogById: ReadonlyMap<CatalogEntryId, CatalogEntry>;
  readonly installedById: ReadonlyMap<InstalledPluginId, InstalledPlugin>;
  readonly marketplacesById: ReadonlyMap<MarketplaceId, MarketplaceRecord>;
  readonly diagnosticsById: ReadonlyMap<DiagnosticId, Diagnostic>;
  readonly installedIdsByPluginName: ReadonlyMap<PluginName, readonly InstalledPluginId[]>;
}

export type InstallTarget =
  | { readonly kind: "catalog-entry"; readonly entryId: CatalogEntryId }
  | {
      readonly kind: "catalog-name";
      readonly name: PluginName;
      readonly marketplaceId?: MarketplaceId;
    }
  | {
      readonly kind: "catalog-or-github";
      readonly left: string;
      readonly right: string;
      readonly githubSource: GithubMarketplaceSource;
    }
  | { readonly kind: "direct-source"; readonly source: ParsedMarketplaceInput };

export type InstalledPluginSelector =
  | { readonly kind: "id"; readonly id: InstalledPluginId }
  | { readonly kind: "name"; readonly name: PluginName; readonly scope?: InstallScope };

export type EngineError =
  | { readonly kind: "marketplace-exists"; readonly id: MarketplaceId }
  | { readonly kind: "marketplace-not-found"; readonly id: MarketplaceId }
  | { readonly kind: "marketplace-sync-failed"; readonly id: MarketplaceId; readonly reason: string }
  | { readonly kind: "plugin-not-found"; readonly selector: string }
  | {
      readonly kind: "ambiguous-plugin-selector";
      readonly name: PluginName;
      readonly matches: AtLeastTwo<InstalledPluginId>;
    }
  | { readonly kind: "catalog-entry-not-found"; readonly target: string }
  | {
      readonly kind: "ambiguous-catalog-target";
      readonly name: PluginName;
      readonly candidates: AtLeastTwo<CatalogEntryId>;
    }
  | {
      readonly kind: "name-collision";
      readonly pluginName: PluginName;
      readonly existingId: InstalledPluginId;
      readonly targetScope: InstallScope;
    }
  | {
      readonly kind: "bundle-invalid";
      readonly diagnostics: NonEmpty<Diagnostic>;
    }
  | { readonly kind: "path-traversal"; readonly offendingPath: string }
  | { readonly kind: "lock-busy"; readonly target: string }
  | {
      readonly kind: "remediation-failed";
      readonly planKind: RemediationPlan["kind"];
      readonly reason: string;
    }
  | { readonly kind: "io-failed"; readonly operation: string; readonly reason: string };

/**
 * Every engine mutation returns a fresh WorkspaceSnapshot on both success and failure,
 * keeping callers synchronized with on-disk state and persisted sync failures.
 */
export type EngineResult<TReport> =
  | { readonly ok: true; readonly report: TReport; readonly snapshot: WorkspaceSnapshot }
  | { readonly ok: false; readonly error: EngineError; readonly snapshot: WorkspaceSnapshot };
