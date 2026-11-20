import fs from "node:fs/promises";
import path from "node:path";
import {
  isHttpUrl,
  isPluginDirName,
  isSshGitUrl,
  joinAbsolutePath,
  makeCatalogEntryId,
  makeHttpUrl,
  makePluginDirName,
  parseHttpUrl,
  parsePluginName,
  parseRelativeSubpath,
  parseSshGitUrl,
  slugifyPluginDirName,
} from "../../domain/types.ts";
import type {
  AbsolutePath,
  CatalogEntry,
  MarketplaceId,
  PluginDirName,
  PluginInstallSource,
  RelativeSubpath,
  RemoteGitUrl,
} from "../../domain/types.ts";
import { checkContainedPath, isRecord } from "./fs-safety.ts";
import { extractAuthorString, extractStringArray } from "./manifest.ts";

const ARCHIVE_EXT_RE = /\.(?:tar\.gz|tgz|zip)$/i;
const GITHUB_REPO_PAIR_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;

type ResolvePluginSourceResult =
  | { readonly ok: true; readonly source: PluginInstallSource }
  | { readonly ok: false; readonly kind: "skip" }
  | { readonly ok: false; readonly kind: "invalid"; readonly reason: string }
  | {
      readonly ok: false;
      readonly kind: "path-traversal";
      readonly offendingPath: string;
      readonly resolvedOutsideRoot: string;
      readonly reason: string;
    };

function isCurrentDirPath(raw: string): boolean {
  const slashed = raw.trim().replaceAll("\\", "/");
  if (slashed.length === 0 || slashed.startsWith("/")) {
    return false;
  }
  const segments = slashed.split("/");
  return segments.some((seg) => seg === ".") && segments.every((seg) => seg === "" || seg === ".");
}

export function allocateUniqueSlug(baseRaw: string, usedSlugs: Set<string>): PluginDirName {
  const base = slugifyPluginDirName(baseRaw, "plugin");
  if (!usedSlugs.has(base)) {
    usedSlugs.add(base);
    return base;
  }
  let counter = 2;
  while (counter < 100_000) {
    const suffix = `-${counter}`;
    const trimmedBase = base.slice(0, Math.max(1, 128 - suffix.length)).replace(/[-.]+$/, "");
    const candidate = `${trimmedBase.length > 0 ? trimmedBase : "plugin"}${suffix}`;
    if (isPluginDirName(candidate) && !usedSlugs.has(candidate)) {
      usedSlugs.add(candidate);
      return candidate;
    }
    counter += 1;
  }
  const fallback = makePluginDirName(`plugin-${usedSlugs.size + 1}`);
  usedSlugs.add(fallback);
  return fallback;
}

function parseRemoteGitUrl(raw: string): RemoteGitUrl | null {
  const trimmed = raw.trim();
  const http = parseHttpUrl(trimmed);
  if (http.ok) {
    return http.value;
  }
  const ssh = parseSshGitUrl(trimmed);
  if (ssh.ok) {
    return ssh.value;
  }
  return null;
}

export function normalizeDirectoryCacheListings(
  marketplaceId: MarketplaceId,
  listings: readonly unknown[],
): readonly CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const usedSlugs = new Set<string>();

  for (const item of listings) {
    if (!isRecord(item)) {
      continue;
    }
    const rawName =
      typeof item.name === "string" && item.name.trim().length > 0
        ? item.name.trim()
        : typeof item.id === "string" && item.id.trim().length > 0
          ? item.id.trim()
          : null;
    if (rawName === null) {
      continue;
    }

    const sourceObj = isRecord(item.source) ? item.source : null;
    const repoObj = sourceObj !== null && isRecord(sourceObj.repository) ? sourceObj.repository : null;
    const rawRepoUrl = repoObj !== null && typeof repoObj.url === "string" ? repoObj.url.trim() : null;
    if (rawRepoUrl === null) {
      continue;
    }
    const repoUrl = parseRemoteGitUrl(rawRepoUrl);
    if (repoUrl === null) {
      continue;
    }

    const reviewedCommit =
      repoObj !== null &&
      typeof repoObj.reviewed_commit === "string" &&
      repoObj.reviewed_commit.trim().length > 0
        ? repoObj.reviewed_commit.trim()
        : undefined;

    let installSource: PluginInstallSource;
    if (repoObj !== null && typeof repoObj.path === "string" && repoObj.path.trim().length > 0) {
      const parsedSubpath = parseRelativeSubpath(repoObj.path);
      if (!parsedSubpath.ok) {
        continue;
      }
      installSource = {
        kind: "git-subdir",
        repoUrl,
        subdir: parsedSubpath.value,
        ...(reviewedCommit !== undefined ? { sha: reviewedCommit } : {}),
      };
    } else {
      installSource = {
        kind: "git-repo",
        repoUrl,
        ...(reviewedCommit !== undefined ? { sha: reviewedCommit } : {}),
      };
    }

    const slug = allocateUniqueSlug(rawName, usedSlugs);
    const verifiedName = parsePluginName(rawName);
    const safeName = verifiedName.ok ? verifiedName : parsePluginName(slug);
    if (!safeName.ok) {
      continue;
    }

    const releaseObj = isRecord(item.release) ? item.release : null;
    const version =
      releaseObj !== null && typeof releaseObj.version === "string" && releaseObj.version.trim().length > 0
        ? releaseObj.version.trim()
        : typeof item.version === "string" && item.version.trim().length > 0
          ? item.version.trim()
          : null;

    const publisherObj = isRecord(item.publisher) ? item.publisher : null;
    const author =
      publisherObj !== null && typeof publisherObj.name === "string" && publisherObj.name.trim().length > 0
        ? publisherObj.name.trim()
        : typeof item.publisher === "string" && item.publisher.trim().length > 0
          ? item.publisher.trim()
          : (() => {
              const auth = extractAuthorString(item.author);
              return auth.ok ? (auth.value ?? null) : null;
            })();

    const linksObj = isRecord(item.links) ? item.links : null;
    const homepage =
      linksObj !== null && typeof linksObj.homepage === "string" && linksObj.homepage.trim().length > 0
        ? linksObj.homepage.trim()
        : linksObj !== null && typeof linksObj.documentation === "string" && linksObj.documentation.trim().length > 0
          ? linksObj.documentation.trim()
          : typeof item.homepage === "string" && item.homepage.trim().length > 0
            ? item.homepage.trim()
            : null;

    const description =
      typeof item.summary === "string"
        ? item.summary
        : typeof item.description === "string"
          ? item.description
          : "";

    const category =
      typeof item.category === "string" && item.category.trim().length > 0
        ? item.category.trim()
        : null;
    const tags = [
      ...new Set([...extractStringArray(item.tags), ...extractStringArray(item.keywords)]),
    ];

    entries.push({
      id: makeCatalogEntryId(marketplaceId, slug),
      marketplaceId,
      slug,
      name: safeName.value,
      displayName: rawName,
      description,
      version,
      author,
      category,
      tags,
      homepage,
      repository: repoUrl,
      sourceFormat: "claude",
      installSource,
      componentCounts: null,
      componentsPreview: null,
    });
  }

  return entries;
}

async function resolveRelativeSubdirWithPrefix(input: {
  readonly subpath: RelativeSubpath;
  readonly pluginRootPrefix: RelativeSubpath | null;
  readonly rootDir: AbsolutePath | undefined;
  readonly canonicalRootDir: string | null;
}): Promise<RelativeSubpath> {
  const { subpath, pluginRootPrefix, rootDir, canonicalRootDir } = input;
  if (
    pluginRootPrefix === null ||
    subpath === pluginRootPrefix ||
    subpath.startsWith(`${pluginRootPrefix}/`)
  ) {
    return subpath;
  }
  const combined = parseRelativeSubpath(`${pluginRootPrefix}/${subpath}`);
  if (!combined.ok) {
    return subpath;
  }
  if (rootDir === undefined) {
    return combined.value;
  }
  const directPath = joinAbsolutePath(rootDir, subpath);
  const prefixedPath = joinAbsolutePath(rootDir, combined.value);
  if (canonicalRootDir !== null) {
    const directCheck = await checkContainedPath(directPath, canonicalRootDir);
    if (directCheck.kind === "escaped") {
      return subpath;
    }
    const directExists =
      directCheck.kind === "contained" &&
      (await fs
        .stat(directCheck.realPath)
        .then((s) => s.isDirectory())
        .catch(() => false));
    if (directExists) {
      return subpath;
    }
    const prefixedCheck = await checkContainedPath(prefixedPath, canonicalRootDir);
    const prefixedExists =
      prefixedCheck.kind === "contained" &&
      (await fs
        .stat(prefixedCheck.realPath)
        .then((s) => s.isDirectory())
        .catch(() => false));
    return prefixedExists ? combined.value : subpath;
  }
  const directExists = await fs
    .stat(directPath)
    .then((s) => s.isDirectory())
    .catch(() => false);
  const prefixedExists = await fs
    .stat(prefixedPath)
    .then((s) => s.isDirectory())
    .catch(() => false);
  return !directExists && prefixedExists ? combined.value : subpath;
}

export async function resolveMarketplacePluginSource(input: {
  readonly rawSource: unknown;
  readonly marketplaceId: MarketplaceId;
  readonly pluginRootPrefix: RelativeSubpath | null;
  readonly rootDir: AbsolutePath | undefined;
  readonly canonicalRootDir: string | null;
}): Promise<ResolvePluginSourceResult> {
  const { rawSource, marketplaceId, pluginRootPrefix, rootDir, canonicalRootDir } = input;

  if (typeof rawSource === "string") {
    const trimmed = rawSource.trim();
    if (trimmed.length === 0) {
      return { ok: false, kind: "invalid", reason: "Plugin source string cannot be empty." };
    }
    if (isHttpUrl(trimmed)) {
      if (ARCHIVE_EXT_RE.test(trimmed)) {
        return { ok: true, source: { kind: "archive-url", url: trimmed } };
      }
      return { ok: true, source: { kind: "git-repo", repoUrl: trimmed } };
    }
    if (isSshGitUrl(trimmed)) {
      return { ok: true, source: { kind: "git-repo", repoUrl: trimmed } };
    }
    if (isCurrentDirPath(trimmed)) {
      return { ok: true, source: { kind: "marketplace-root", marketplaceId } };
    }

    const parsedSubpath = parseRelativeSubpath(trimmed);
    if (!parsedSubpath.ok) {
      return { ok: false, kind: "invalid", reason: parsedSubpath.error.message };
    }

    const finalSubpath = await resolveRelativeSubdirWithPrefix({
      subpath: parsedSubpath.value,
      pluginRootPrefix,
      rootDir,
      canonicalRootDir,
    });

    return {
      ok: true,
      source: {
        kind: "marketplace-subdir",
        marketplaceId,
        subdir: finalSubpath,
      },
    };
  }

  if (!isRecord(rawSource) || typeof rawSource.source !== "string") {
    return { ok: false, kind: "invalid", reason: "Plugin entry is missing a valid 'source' field." };
  }

  const ref = typeof rawSource.ref === "string" && rawSource.ref.trim().length > 0 ? rawSource.ref.trim() : undefined;
  const sha = typeof rawSource.sha === "string" && rawSource.sha.trim().length > 0 ? rawSource.sha.trim() : undefined;

  switch (rawSource.source) {
    case "git-subdir": {
      if (typeof rawSource.url !== "string" || typeof rawSource.path !== "string") {
        return { ok: false, kind: "invalid", reason: "git-subdir source requires 'url' and 'path'." };
      }
      const repoUrl = parseRemoteGitUrl(rawSource.url);
      if (repoUrl === null) {
        return { ok: false, kind: "invalid", reason: `Invalid git-subdir URL: "${rawSource.url}".` };
      }
      const parsedPath = parseRelativeSubpath(rawSource.path);
      if (!parsedPath.ok) {
        return { ok: false, kind: "invalid", reason: parsedPath.error.message };
      }
      return {
        ok: true,
        source: {
          kind: "git-subdir",
          repoUrl,
          subdir: parsedPath.value,
          ...(ref !== undefined ? { ref } : {}),
          ...(sha !== undefined ? { sha } : {}),
        },
      };
    }
    case "url": {
      if (typeof rawSource.url !== "string") {
        return { ok: false, kind: "invalid", reason: "url source requires 'url'." };
      }
      const repoUrl = parseRemoteGitUrl(rawSource.url);
      if (repoUrl === null) {
        return { ok: false, kind: "invalid", reason: `Invalid source URL: "${rawSource.url}".` };
      }
      if (typeof rawSource.path === "string" && rawSource.path.trim().length > 0) {
        const parsedPath = parseRelativeSubpath(rawSource.path);
        if (!parsedPath.ok) {
          return { ok: false, kind: "invalid", reason: parsedPath.error.message };
        }
        return {
          ok: true,
          source: {
            kind: "git-subdir",
            repoUrl,
            subdir: parsedPath.value,
            ...(ref !== undefined ? { ref } : {}),
            ...(sha !== undefined ? { sha } : {}),
          },
        };
      }
      if (isHttpUrl(repoUrl) && ARCHIVE_EXT_RE.test(repoUrl)) {
        const sha256 =
          typeof rawSource.sha256 === "string" && rawSource.sha256.trim().length > 0
            ? rawSource.sha256.trim()
            : undefined;
        return {
          ok: true,
          source: {
            kind: "archive-url",
            url: repoUrl,
            ...(sha256 !== undefined ? { sha256 } : {}),
          },
        };
      }
      return {
        ok: true,
        source: {
          kind: "git-repo",
          repoUrl,
          ...(ref !== undefined ? { ref } : {}),
          ...(sha !== undefined ? { sha } : {}),
        },
      };
    }
    case "github": {
      if (typeof rawSource.repo !== "string" || !GITHUB_REPO_PAIR_RE.test(rawSource.repo.trim())) {
        return { ok: false, kind: "invalid", reason: `Invalid GitHub repo specifier: "${String(rawSource.repo)}".` };
      }
      const repoUrl = makeHttpUrl(`https://github.com/${rawSource.repo.trim()}.git`);
      if (typeof rawSource.path === "string" && rawSource.path.trim().length > 0) {
        const parsedPath = parseRelativeSubpath(rawSource.path);
        if (!parsedPath.ok) {
          return { ok: false, kind: "invalid", reason: parsedPath.error.message };
        }
        return {
          ok: true,
          source: {
            kind: "git-subdir",
            repoUrl,
            subdir: parsedPath.value,
            ...(ref !== undefined ? { ref } : {}),
            ...(sha !== undefined ? { sha } : {}),
          },
        };
      }
      return {
        ok: true,
        source: {
          kind: "git-repo",
          repoUrl,
          ...(ref !== undefined ? { ref } : {}),
          ...(sha !== undefined ? { sha } : {}),
        },
      };
    }
    case "directory":
    case "local": {
      if (typeof rawSource.path !== "string") {
        return { ok: false, kind: "invalid", reason: "Local directory source requires 'path'." };
      }
      const trimmedPath = rawSource.path.trim();
      if (trimmedPath.length === 0) {
        return { ok: false, kind: "invalid", reason: "Local directory source path cannot be empty." };
      }
      if (
        path.isAbsolute(trimmedPath) ||
        trimmedPath.startsWith("/") ||
        trimmedPath.startsWith("\\") ||
        WINDOWS_DRIVE_RE.test(trimmedPath)
      ) {
        return {
          ok: false,
          kind: "path-traversal",
          offendingPath: trimmedPath,
          resolvedOutsideRoot: trimmedPath,
          reason: `Absolute path "${trimmedPath}" is not allowed in marketplace manifests.`,
        };
      }
      if (isCurrentDirPath(trimmedPath)) {
        return { ok: true, source: { kind: "marketplace-root", marketplaceId } };
      }
      const rel = parseRelativeSubpath(trimmedPath);
      if (!rel.ok) {
        if (rel.error.code === "path-traversal") {
          return {
            ok: false,
            kind: "path-traversal",
            offendingPath: trimmedPath,
            resolvedOutsideRoot: trimmedPath,
            reason: rel.error.message,
          };
        }
        return { ok: false, kind: "invalid", reason: rel.error.message };
      }
      const finalSubpath = await resolveRelativeSubdirWithPrefix({
        subpath: rel.value,
        pluginRootPrefix,
        rootDir,
        canonicalRootDir,
      });
      return {
        ok: true,
        source: {
          kind: "marketplace-subdir",
          marketplaceId,
          subdir: finalSubpath,
        },
      };
    }
    case "command":
      return { ok: false, kind: "skip" };
    default:
      return { ok: false, kind: "invalid", reason: `Unsupported plugin source kind "${rawSource.source}".` };
  }
}
