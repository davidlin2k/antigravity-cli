import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isAbsolutePath,
  isHttpUrl,
  isMarketplaceId,
  isNonEmpty,
  isSshGitUrl,
  makeMarketplaceId,
  parseErr,
  parseMarketplaceId,
  parseOk,
  parsePluginName,
  parseRelativeSubpath,
} from "./types.ts";
import type {
  AbsolutePath,
  CatalogEntry,
  ComponentCounts,
  Diagnostic,
  DiagnosticSeverity,
  InstalledPlugin,
  InstalledPluginId,
  InstallScope,
  InstallTarget,
  MarketplaceId,
  MarketplaceRecord,
  MarketplaceSource,
  NonEmpty,
  ParsedMarketplaceInput,
  ParseResult,
  WorkspaceSnapshot,
} from "./types.ts";

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

const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const WHITESPACE_RE = /\s/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const COLON_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
const SCP_PREFIX_RE = /^[a-zA-Z0-9._-]+@[^:/\s]+:/;
const GITHUB_OWNER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const GITHUB_REPO_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const GENERIC_CATALOG_NAMES = new Set(["marketplace", "catalog", "index", "plugins"]);

function isValidGitRef(ref: string): boolean {
  return (
    ref.length > 0 &&
    ref.length <= 256 &&
    !CONTROL_CHAR_RE.test(ref) &&
    !WHITESPACE_RE.test(ref) &&
    !ref.includes("..") &&
    !ref.startsWith("/") &&
    !ref.endsWith("/")
  );
}

function stripGitSuffix(repo: string): string {
  return repo.endsWith(".git") && repo.length > 4 ? repo.slice(0, -4) : repo;
}

function rawUrlPathHasTraversal(rawUrl: string): boolean {
  const withoutHash = rawUrl.split("#", 1)[0] ?? rawUrl;
  const withoutQuery = withoutHash.split("?", 1)[0] ?? withoutHash;
  const schemeEnd = withoutQuery.indexOf("://");
  if (schemeEnd === -1) {
    return false;
  }
  const pathStart = withoutQuery.indexOf("/", schemeEnd + 3);
  if (pathStart === -1) {
    return false;
  }
  const rawPath = withoutQuery.slice(pathStart + 1);
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

function classifyLocalPath(
  resolved: string,
  originalInput: string,
): ParseResult<Extract<MarketplaceSource, { readonly kind: "local-folder" | "local-json" }>> {
  if (!isAbsolutePath(resolved)) {
    return parseErr("invalid-path", originalInput, `Could not resolve local path: "${originalInput}".`);
  }
  if (resolved.toLowerCase().endsWith(".json")) {
    return parseOk({ kind: "local-json", path: resolved });
  }
  return parseOk({ kind: "local-folder", path: resolved });
}

function parseSshMarketplace(
  trimmed: string,
  originalInput: string,
): ParseResult<Extract<MarketplaceSource, { readonly kind: "ssh" }>> {
  let urlPart = trimmed;
  let ref: string | undefined;

  const hashIdx = trimmed.indexOf("#");
  if (hashIdx !== -1) {
    urlPart = trimmed.slice(0, hashIdx);
    ref = trimmed.slice(hashIdx + 1);
  } else if (trimmed.startsWith("ssh://")) {
    const firstSlash = trimmed.indexOf("/", "ssh://".length);
    if (firstSlash !== -1) {
      const atIdx = trimmed.lastIndexOf("@");
      if (atIdx > firstSlash) {
        urlPart = trimmed.slice(0, atIdx);
        ref = trimmed.slice(atIdx + 1);
      }
    }
  } else {
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx !== -1) {
      const atIdx = trimmed.lastIndexOf("@");
      if (atIdx > colonIdx) {
        urlPart = trimmed.slice(0, atIdx);
        ref = trimmed.slice(atIdx + 1);
      }
    }
  }

  if (ref !== undefined && !isValidGitRef(ref)) {
    return parseErr("invalid-ssh-url", originalInput, `Invalid git ref "${ref}" in SSH source.`);
  }
  if (!isSshGitUrl(urlPart)) {
    return parseErr("invalid-ssh-url", originalInput, `Invalid SSH git URL: "${originalInput}".`);
  }
  return parseOk(ref !== undefined ? { kind: "ssh", url: urlPart, ref } : { kind: "ssh", url: urlPart });
}

function parseHttpMarketplace(
  trimmed: string,
  originalInput: string,
): ParseResult<ParsedMarketplaceInput> {
  if (WHITESPACE_RE.test(trimmed)) {
    return parseErr("invalid-url", originalInput, `URL cannot contain whitespace: "${originalInput}".`);
  }
  // Check raw segments before WHATWG URL normalizes `..` away.
  if (rawUrlPathHasTraversal(trimmed)) {
    return parseErr("path-traversal", originalInput, `URL path cannot traverse parent directories: "${originalInput}".`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return parseErr("invalid-url", originalInput, `Invalid URL: "${originalInput}".`);
  }

  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.hostname.length === 0) {
    return parseErr("invalid-url", originalInput, `Unsupported URL protocol or host: "${originalInput}".`);
  }

  let hashRef: string | undefined;
  const hashIdx = trimmed.indexOf("#");
  const cleanRaw = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx);
  if (hashIdx !== -1) {
    hashRef = trimmed.slice(hashIdx + 1);
    if (!isValidGitRef(hashRef)) {
      return parseErr("invalid-url", originalInput, `Invalid git ref "${hashRef}" in URL.`);
    }
  }

  const hostLower = parsed.hostname.toLowerCase();
  if (hostLower === "github.com" || hostLower === "www.github.com") {
    const segments = parsed.pathname.split("/").filter((seg) => seg.length > 0);
    if (segments.length < 2) {
      return parseErr("invalid-url", originalInput, `GitHub URL must include owner and repository: "${originalInput}".`);
    }
    const owner = segments[0];
    const repoSegment = segments[1];
    if (owner !== undefined && repoSegment !== undefined) {
      const repo = stripGitSuffix(repoSegment);
      if (segments.length === 2 && GITHUB_OWNER_RE.test(owner) && GITHUB_REPO_RE.test(repo)) {
        return parseOk(
          hashRef !== undefined
            ? { kind: "github", owner, repo, ref: hashRef }
            : { kind: "github", owner, repo },
        );
      }
      if (segments.length >= 4 && segments[2] === "tree") {
        const treeRefRaw = segments[3];
        if (treeRefRaw === undefined || !GITHUB_OWNER_RE.test(owner) || !GITHUB_REPO_RE.test(repo)) {
          return parseErr("invalid-url", originalInput, `Invalid GitHub tree URL: "${originalInput}".`);
        }
        let treeRef: string;
        try {
          treeRef = decodeURIComponent(treeRefRaw);
        } catch {
          return parseErr("invalid-url", originalInput, `Invalid percent-encoding in GitHub ref: "${originalInput}".`);
        }
        if (!isValidGitRef(treeRef)) {
          return parseErr("invalid-url", originalInput, `Invalid git ref "${treeRef}" in GitHub URL.`);
        }
        if (segments.length > 4) {
          let decodedSubpath: string;
          try {
            decodedSubpath = segments.slice(4).map((seg) => decodeURIComponent(seg)).join("/");
          } catch {
            return parseErr("invalid-url", originalInput, `Invalid percent-encoding in GitHub subpath: "${originalInput}".`);
          }
          const subpathResult = parseRelativeSubpath(decodedSubpath);
          if (!subpathResult.ok) {
            return subpathResult;
          }
          return parseOk({
            kind: "github",
            owner,
            repo,
            ref: treeRef,
            subdir: subpathResult.value,
          });
        }
        return parseOk({ kind: "github", owner, repo, ref: treeRef });
      }
    }
  }

  if (!isHttpUrl(cleanRaw)) {
    return parseErr("invalid-url", originalInput, `Invalid HTTP(S) URL: "${originalInput}".`);
  }

  const lowerPath = parsed.pathname.toLowerCase();
  if (lowerPath.endsWith(".git")) {
    return parseOk(
      hashRef !== undefined
        ? { kind: "https-git", url: cleanRaw, ref: hashRef }
        : { kind: "https-git", url: cleanRaw },
    );
  }
  if (lowerPath.endsWith(".json")) {
    return parseOk({ kind: "https-json", url: cleanRaw });
  }
  return parseOk(
    hashRef !== undefined
      ? { kind: "https-auto", url: cleanRaw, ref: hashRef }
      : { kind: "https-auto", url: cleanRaw },
  );
}

function isExplicitLocalPath(value: string): boolean {
  return (
    value === "." ||
    value === ".." ||
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("\\") ||
    WINDOWS_DRIVE_RE.test(value)
  );
}

/**
 * Pure synchronous parser shared by CLI argument parsing and the TUI Add Marketplace
 * live preview. Classifies GitHub shorthand/URL, SSH git, HTTPS git/JSON/auto, and
 * local folders or JSON catalogs without touching disk or network.
 */
export function parseMarketplaceInput(input: {
  readonly raw: string;
  readonly cwd: AbsolutePath;
  readonly homeDir: AbsolutePath;
}): ParseResult<ParsedMarketplaceInput> {
  const trimmed = input.raw.trim();
  if (trimmed.length === 0) {
    return parseErr("empty-input", input.raw, "Marketplace source cannot be empty.");
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    return parseErr("invalid-source", input.raw, "Marketplace source cannot contain control characters.");
  }

  if (trimmed.startsWith("file://")) {
    try {
      const localPath = path.resolve(fileURLToPath(trimmed));
      return classifyLocalPath(localPath, input.raw);
    } catch {
      return parseErr("invalid-path", input.raw, `Invalid file:// URL: "${input.raw}".`);
    }
  }

  if (trimmed === "~") {
    return parseOk({ kind: "local-folder", path: input.homeDir });
  }
  if (trimmed.startsWith("~/")) {
    const resolved = path.resolve(input.homeDir, trimmed.slice(2));
    return classifyLocalPath(resolved, input.raw);
  }

  if (isExplicitLocalPath(trimmed)) {
    const resolved = path.resolve(input.cwd, trimmed);
    return classifyLocalPath(resolved, input.raw);
  }

  if (trimmed.startsWith("ssh://") || SCP_PREFIX_RE.test(trimmed)) {
    return parseSshMarketplace(trimmed, input.raw);
  }

  if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    return parseHttpMarketplace(trimmed, input.raw);
  }

  if (SCHEME_RE.test(trimmed) || (COLON_SCHEME_RE.test(trimmed) && !WINDOWS_DRIVE_RE.test(trimmed))) {
    return parseErr("invalid-url", input.raw, `Unsupported URL scheme: "${input.raw}".`);
  }

  const slashIdx = trimmed.indexOf("/");
  if (
    slashIdx > 0 &&
    slashIdx < trimmed.length - 1 &&
    trimmed.indexOf("/", slashIdx + 1) === -1 &&
    !trimmed.includes("\\") &&
    !WHITESPACE_RE.test(trimmed)
  ) {
    const owner = trimmed.slice(0, slashIdx);
    const repoWithRef = trimmed.slice(slashIdx + 1);
    if (!repoWithRef.toLowerCase().endsWith(".json")) {
      const atIdx = repoWithRef.indexOf("@");
      const hashIdx = repoWithRef.indexOf("#");
      const refSplitIdx =
        atIdx !== -1 && hashIdx !== -1
          ? Math.min(atIdx, hashIdx)
          : atIdx !== -1
            ? atIdx
            : hashIdx;

      const repoRaw = refSplitIdx === -1 ? repoWithRef : repoWithRef.slice(0, refSplitIdx);
      const ref = refSplitIdx === -1 ? undefined : repoWithRef.slice(refSplitIdx + 1);
      const repo = stripGitSuffix(repoRaw);

      if (GITHUB_OWNER_RE.test(owner) && GITHUB_REPO_RE.test(repo)) {
        if (ref !== undefined && !isValidGitRef(ref)) {
          return parseErr("invalid-source", input.raw, `Invalid git ref "${ref}" in GitHub shorthand.`);
        }
        return parseOk(
          ref !== undefined
            ? { kind: "github", owner, repo, ref }
            : { kind: "github", owner, repo },
        );
      }
    }
  }

  const resolved = path.resolve(input.cwd, trimmed);
  return classifyLocalPath(resolved, input.raw);
}

function slugifyMarketplaceId(raw: string, fallback = "marketplace"): MarketplaceId {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  if (isMarketplaceId(cleaned)) {
    return cleaned;
  }
  if (isMarketplaceId(fallback)) {
    return fallback;
  }
  return makeMarketplaceId("marketplace");
}

function combineOwnerRepoSlug(owner: string, repo: string): string {
  const ownerSlug = owner.toLowerCase();
  const repoSlug = repo.toLowerCase();
  if (repoSlug === ownerSlug || repoSlug.startsWith(`${ownerSlug}-`)) {
    return repoSlug;
  }
  return `${ownerSlug}-${repoSlug}`;
}

function deriveSlugFromPathSegments(
  segments: readonly string[],
  hostFallback: string,
  stripExtension: ".git" | ".json",
): string {
  if (segments.length === 0) {
    return hostFallback;
  }
  const lastRaw = segments[segments.length - 1] ?? "";
  const lastClean =
    lastRaw.toLowerCase().endsWith(stripExtension) && lastRaw.length > stripExtension.length
      ? lastRaw.slice(0, -stripExtension.length)
      : lastRaw;

  if (segments.length >= 2) {
    const prev = segments[segments.length - 2] ?? "";
    if (stripExtension === ".json" && GENERIC_CATALOG_NAMES.has(lastClean.toLowerCase())) {
      return prev;
    }
    return combineOwnerRepoSlug(prev, lastClean);
  }
  if (stripExtension === ".json" && GENERIC_CATALOG_NAMES.has(lastClean.toLowerCase())) {
    return `${hostFallback}-${lastClean}`;
  }
  return lastClean;
}

export function deriveMarketplaceId(source: ParsedMarketplaceInput): MarketplaceId {
  switch (source.kind) {
    case "github": {
      const base = combineOwnerRepoSlug(source.owner, source.repo);
      const raw = source.subdir !== undefined ? `${base}-${source.subdir}` : base;
      return slugifyMarketplaceId(raw, "github-marketplace");
    }
    case "ssh": {
      let rawPath: string;
      let host = "ssh";
      if (source.url.startsWith("ssh://")) {
        const parsed = new URL(source.url);
        host = parsed.hostname;
        rawPath = parsed.pathname;
      } else {
        const atIdx = source.url.indexOf("@");
        const colonIdx = source.url.indexOf(":");
        host = source.url.slice(atIdx + 1, colonIdx);
        rawPath = source.url.slice(colonIdx + 1);
      }
      const segments = rawPath.split("/").filter((seg) => seg.length > 0);
      const base = deriveSlugFromPathSegments(segments, host, ".git");
      const raw = source.subdir !== undefined ? `${base}-${source.subdir}` : base;
      return slugifyMarketplaceId(raw, "ssh-marketplace");
    }
    case "https-git":
    case "https-auto": {
      const parsed = new URL(source.url);
      const segments = parsed.pathname.split("/").filter((seg) => seg.length > 0);
      const base = deriveSlugFromPathSegments(segments, parsed.hostname, ".git");
      const raw = source.subdir !== undefined ? `${base}-${source.subdir}` : base;
      return slugifyMarketplaceId(raw, "remote-marketplace");
    }
    case "https-json": {
      const parsed = new URL(source.url);
      const segments = parsed.pathname.split("/").filter((seg) => seg.length > 0);
      const base = deriveSlugFromPathSegments(segments, parsed.hostname, ".json");
      return slugifyMarketplaceId(base, "json-marketplace");
    }
    case "local-folder": {
      const base = path.basename(source.path);
      return slugifyMarketplaceId(base, "local-marketplace");
    }
    case "local-json": {
      const stem = path.basename(source.path, path.extname(source.path));
      const parent = path.basename(path.dirname(source.path));
      const candidate =
        GENERIC_CATALOG_NAMES.has(stem.toLowerCase()) && parent.length > 0 ? parent : stem;
      return slugifyMarketplaceId(candidate, "local-catalog");
    }
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

export function formatMarketplaceSource(
  source: MarketplaceSource | ParsedMarketplaceInput,
): string {
  switch (source.kind) {
    case "github": {
      const refPart = source.ref !== undefined ? `@${source.ref}` : "";
      const subdirPart = source.subdir !== undefined ? `:${source.subdir}` : "";
      return `github:${source.owner}/${source.repo}${refPart}${subdirPart}`;
    }
    case "ssh":
    case "https-git":
    case "https-auto": {
      const refPart = source.ref !== undefined ? `#${source.ref}` : "";
      const subdirPart = source.subdir !== undefined ? `:${source.subdir}` : "";
      return `${source.url}${refPart}${subdirPart}`;
    }
    case "https-json":
      return source.url;
    case "local-folder":
    case "local-json":
      return source.path;
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

/**
 * Parses an install target string into a catalog lookup, an ambiguous two-segment
 * `<left>/<right>` target (resolved against `catalogById` first, then GitHub), or
 * a direct source install.
 */
export function parseInstallTarget(input: {
  readonly raw: string;
  readonly cwd: AbsolutePath;
  readonly homeDir: AbsolutePath;
}): ParseResult<InstallTarget> {
  const trimmed = input.raw.trim();
  if (trimmed.length === 0) {
    return parseErr("empty-input", input.raw, "Install target cannot be empty.");
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    return parseErr("invalid-source", input.raw, "Install target cannot contain control characters.");
  }

  const isDirectIndicator =
    trimmed.startsWith("https://") ||
    trimmed.startsWith("http://") ||
    trimmed.startsWith("ssh://") ||
    trimmed.startsWith("file://") ||
    trimmed === "~" ||
    trimmed.startsWith("~/") ||
    isExplicitLocalPath(trimmed) ||
    SCP_PREFIX_RE.test(trimmed) ||
    SCHEME_RE.test(trimmed);

  if (isDirectIndicator) {
    const parsedSource = parseMarketplaceInput({
      raw: trimmed,
      cwd: input.cwd,
      homeDir: input.homeDir,
    });
    if (!parsedSource.ok) {
      return parsedSource;
    }
    return parseOk({ kind: "direct-source", source: parsedSource.value });
  }

  if (trimmed.includes("/")) {
    if (trimmed.includes("\\") || WHITESPACE_RE.test(trimmed)) {
      return parseErr(
        "invalid-source",
        input.raw,
        `Invalid install target "${input.raw}". Prefix local paths with "./".`,
      );
    }
    const parts = trimmed.split("/");
    if (parts.length !== 2) {
      return parseErr(
        "invalid-source",
        input.raw,
        `Ambiguous multi-segment path "${input.raw}". Prefix local paths with "./".`,
      );
    }
    const left = parts[0] ?? "";
    const right = parts[1] ?? "";
    if (left.length === 0 || right.length === 0) {
      return parseErr("invalid-source", input.raw, `Invalid install target: "${input.raw}".`);
    }

    if (right.includes("@") || right.includes("#") || right.endsWith(".git")) {
      const parsedSource = parseMarketplaceInput({
        raw: trimmed,
        cwd: input.cwd,
        homeDir: input.homeDir,
      });
      if (!parsedSource.ok) {
        return parsedSource;
      }
      if (parsedSource.value.kind !== "github") {
        return parseErr("invalid-source", input.raw, `Invalid GitHub install target: "${input.raw}".`);
      }
      return parseOk({ kind: "direct-source", source: parsedSource.value });
    }

    const parsedGithub = parseMarketplaceInput({
      raw: trimmed,
      cwd: input.cwd,
      homeDir: input.homeDir,
    });
    if (!parsedGithub.ok) {
      return parsedGithub;
    }
    if (parsedGithub.value.kind !== "github") {
      return parseErr(
        "invalid-source",
        input.raw,
        `Invalid install target "${input.raw}". Prefix local paths with "./".`,
      );
    }
    return parseOk({
      kind: "catalog-or-github",
      left,
      right,
      githubSource: parsedGithub.value,
    });
  }

  const atIdx = trimmed.lastIndexOf("@");
  if (atIdx !== -1) {
    if (atIdx === 0 || atIdx === trimmed.length - 1) {
      return parseErr(
        "invalid-source",
        input.raw,
        `Expected "<plugin>@<marketplace>", got "${input.raw}".`,
      );
    }
    const rawName = trimmed.slice(0, atIdx);
    const rawMarketplace = trimmed.slice(atIdx + 1);
    const parsedName = parsePluginName(rawName);
    if (!parsedName.ok) {
      return parsedName;
    }
    const parsedMarketplace = parseMarketplaceId(rawMarketplace);
    if (!parsedMarketplace.ok) {
      return parsedMarketplace;
    }
    return parseOk({
      kind: "catalog-name",
      name: parsedName.value,
      marketplaceId: parsedMarketplace.value,
    });
  }

  const parsedName = parsePluginName(trimmed);
  if (!parsedName.ok) {
    return parsedName;
  }
  return parseOk({ kind: "catalog-name", name: parsedName.value });
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

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

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
