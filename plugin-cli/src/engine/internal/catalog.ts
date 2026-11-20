import fs from "node:fs/promises";
import path from "node:path";
import {
  EMPTY_COMPONENT_COUNTS,
  EMPTY_COMPONENT_INVENTORY,
  joinAbsolutePath,
  makeCatalogEntryId,
  makeDiagnosticId,
  makeRelativeSubpath,
  parsePluginName,
  parseRelativeSubpath,
  slugifyPluginDirName,
} from "../../domain/types.ts";
import type {
  AbsolutePath,
  CatalogEntry,
  ComponentCounts,
  ComponentInventory,
  Diagnostic,
  ManifestEcosystem,
  MarketplaceId,
  RelativeSubpath,
} from "../../domain/types.ts";
import {
  allocateUniqueSlug,
  normalizeDirectoryCacheListings,
  resolveMarketplacePluginSource,
} from "./catalog-sources.ts";
import { checkContainedPath, isRecord } from "./fs-safety.ts";
import { parseJsoncBomSafe } from "./jsonc.ts";
import {
  extractAuthorString,
  extractRepositoryString,
  extractStringArray,
  findPluginManifestFile,
  normalizeAntigravityManifest,
  previewPluginComponents,
} from "./manifest.ts";

interface CatalogNormalizationResult {
  readonly ok: boolean;
  readonly format: ManifestEcosystem | null;
  readonly entries: readonly CatalogEntry[];
  readonly diagnostics: readonly Diagnostic[];
}

interface MarketplaceCandidate {
  readonly relativePath: string;
  readonly ecosystem: ManifestEcosystem;
}

const NATIVE_MARKETPLACE_CANDIDATES: readonly MarketplaceCandidate[] = [
  { relativePath: ".antigravity-plugin/marketplace.json", ecosystem: "antigravity" },
  { relativePath: ".gemini-plugin/marketplace.json", ecosystem: "antigravity" },
  { relativePath: "marketplace.json", ecosystem: "antigravity" },
];

const EXTERNAL_MARKETPLACE_CANDIDATES: readonly MarketplaceCandidate[] = [
  { relativePath: ".claude-plugin/marketplace.json", ecosystem: "claude" },
  { relativePath: ".cursor-plugin/marketplace.json", ecosystem: "cursor" },
];

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function failedCatalogResult(diagnostic: Diagnostic): CatalogNormalizationResult {
  return { ok: false, format: null, entries: [], diagnostics: [diagnostic] };
}

function invalidCatalogDiag(
  marketplaceId: MarketplaceId,
  filePath: AbsolutePath,
  reason: string,
  message: string,
  hint: string,
  severity: "error" | "warning" = "error",
  extraIdPart?: string,
): Diagnostic {
  return {
    id:
      extraIdPart !== undefined
        ? makeDiagnosticId("marketplace-manifest-invalid", marketplaceId, extraIdPart)
        : makeDiagnosticId("marketplace-manifest-invalid", marketplaceId),
    severity,
    subject: { kind: "marketplace", marketplaceId },
    detail: { kind: "marketplace-manifest-invalid", marketplaceId, filePath, reason },
    message,
    hint,
  };
}

function syntaxCatalogDiag(
  marketplaceId: MarketplaceId,
  filePath: AbsolutePath,
  parsed: {
    readonly line: number | null;
    readonly column: number | null;
    readonly hadUtf8Bom: boolean;
    readonly syntaxError: string;
  },
  message: string,
  hint: string,
): Diagnostic {
  return {
    id: makeDiagnosticId("marketplace-json-syntax", marketplaceId),
    severity: "error",
    subject: { kind: "marketplace", marketplaceId },
    detail: {
      kind: "manifest-json-syntax",
      filePath,
      line: parsed.line,
      column: parsed.column,
      hadUtf8Bom: parsed.hadUtf8Bom,
      syntaxError: parsed.syntaxError,
    },
    message,
    hint,
  };
}

function traversalCatalogDiag(
  marketplaceId: MarketplaceId,
  idTarget: string,
  offendingPath: string,
  resolvedOutsideRoot: string,
  message: string,
  hint: string,
): Diagnostic {
  return {
    id: makeDiagnosticId("path-traversal-rejected", marketplaceId, idTarget),
    severity: "error",
    subject: { kind: "marketplace", marketplaceId },
    detail: { kind: "path-traversal-rejected", offendingPath, resolvedOutsideRoot },
    message,
    hint,
  };
}

function buildMarketplacePathTraversalResult(
  marketplaceId: MarketplaceId,
  offendingPath: string,
  resolvedOutsideRoot: string,
): CatalogNormalizationResult {
  return failedCatalogResult(
    traversalCatalogDiag(
      marketplaceId,
      offendingPath,
      offendingPath,
      resolvedOutsideRoot,
      `Marketplace "${marketplaceId}" manifest "${offendingPath}" resolves outside marketplace root (${resolvedOutsideRoot}).`,
      "Remove the escaping symlink from the marketplace repository.",
    ),
  );
}

export async function normalizeJsonCatalog(
  marketplaceId: MarketplaceId,
  filePath: AbsolutePath,
  rawBytes: Uint8Array | string,
  options?: {
    readonly rootDir?: AbsolutePath;
    readonly defaultEcosystem?: ManifestEcosystem;
  },
): Promise<CatalogNormalizationResult> {
  const parsed = parseJsoncBomSafe(rawBytes, filePath);
  if (!parsed.ok) {
    return failedCatalogResult(
      syntaxCatalogDiag(
        marketplaceId,
        filePath,
        parsed,
        `Failed to parse marketplace catalog JSON for "${marketplaceId}": ${parsed.syntaxError}`,
        "Fix the JSON syntax error in the marketplace catalog file and re-sync.",
      ),
    );
  }

  const root = parsed.value;
  if (isRecord(root) && Array.isArray(root.listings)) {
    const entries = normalizeDirectoryCacheListings(marketplaceId, root.listings);
    return { ok: true, format: "claude", entries, diagnostics: [] };
  }

  const pluginList = Array.isArray(root)
    ? root
    : isRecord(root) && Array.isArray(root.plugins)
      ? root.plugins
      : null;

  if (pluginList === null) {
    return failedCatalogResult(
      invalidCatalogDiag(
        marketplaceId,
        filePath,
        'Expected a JSON object with a "plugins" or "listings" array.',
        `Marketplace "${marketplaceId}" manifest is missing a "plugins" or "listings" array.`,
        "Provide a valid Antigravity, Claude, or Cursor marketplace.json.",
      ),
    );
  }

  let ecosystem: ManifestEcosystem = options?.defaultEcosystem ?? "antigravity";
  if (isRecord(root) && typeof root.$schema === "string" && root.$schema.toLowerCase().includes("claude")) {
    ecosystem = "claude";
  }

  let pluginRootPrefix: RelativeSubpath | null = null;
  const rawPluginRoot =
    isRecord(root) && isRecord(root.metadata) && typeof root.metadata.pluginRoot === "string"
      ? root.metadata.pluginRoot
      : isRecord(root) && typeof root.pluginRoot === "string"
        ? root.pluginRoot
        : null;
  if (rawPluginRoot !== null) {
    const parsedRoot = parseRelativeSubpath(rawPluginRoot);
    if (parsedRoot.ok) {
      pluginRootPrefix = parsedRoot.value;
    }
  }

  const rootDir = options?.rootDir;
  let canonicalRootDir: string | null = null;
  if (rootDir !== undefined) {
    try {
      canonicalRootDir = await fs.realpath(rootDir);
    } catch {
      canonicalRootDir = null;
    }
  }

  const entries: CatalogEntry[] = [];
  const diagnostics: Diagnostic[] = [];
  const usedSlugs = new Set<string>();

  for (let i = 0; i < pluginList.length; i += 1) {
    const item = pluginList[i];
    if (!isRecord(item)) {
      continue;
    }

    const rawName = readTrimmedString(item.name) ?? "";
    if (rawName.length === 0) {
      diagnostics.push(
        invalidCatalogDiag(
          marketplaceId,
          filePath,
          `Plugin entry at index ${i} is missing a string "name".`,
          `Skipped unnamed plugin entry at index ${i} in marketplace "${marketplaceId}".`,
          "Add a non-empty string name to each plugin entry.",
          "warning",
          `entry-${i}`,
        ),
      );
      continue;
    }

    const resolvedSource = await resolveMarketplacePluginSource({
      rawSource: item.source,
      marketplaceId,
      pluginRootPrefix,
      rootDir,
      canonicalRootDir,
    });
    if (!resolvedSource.ok) {
      switch (resolvedSource.kind) {
        case "skip":
          break;
        case "path-traversal":
          diagnostics.push(
            traversalCatalogDiag(
              marketplaceId,
              rawName,
              resolvedSource.offendingPath,
              resolvedSource.resolvedOutsideRoot,
              `Rejected plugin "${rawName}" in marketplace "${marketplaceId}": ${resolvedSource.reason}`,
              "Plugin sources inside marketplace manifests must be relative paths contained inside the marketplace root or valid remote URLs.",
            ),
          );
          break;
        case "invalid":
          diagnostics.push(
            invalidCatalogDiag(
              marketplaceId,
              filePath,
              `Plugin "${rawName}": ${resolvedSource.reason}`,
              `Skipped plugin "${rawName}" in marketplace "${marketplaceId}": ${resolvedSource.reason}`,
              "Ensure plugin source paths are valid relative subpaths without '..' or valid remote URLs.",
              "warning",
              rawName,
            ),
          );
          break;
        default: {
          const _exhaustive: never = resolvedSource;
          return _exhaustive;
        }
      }
      continue;
    }

    const slug = allocateUniqueSlug(rawName, usedSlugs);
    const parsedName = parsePluginName(rawName);
    const safeName = parsedName.ok ? parsedName : parsePluginName(slug);
    if (!safeName.ok) {
      continue;
    }

    let displayName = readTrimmedString(item.displayName) ?? rawName;
    let description = typeof item.description === "string" ? item.description : "";
    let version = readTrimmedString(item.version);
    const authorRes = extractAuthorString(item.author);
    let author = authorRes.ok ? (authorRes.value ?? null) : null;
    let category = readTrimmedString(item.category);
    const tagSet = new Set<string>([
      ...extractStringArray(item.tags),
      ...extractStringArray(item.keywords),
    ]);
    let homepage = readTrimmedString(item.homepage);
    const repoRes = extractRepositoryString(item.repository);
    let repository = repoRes.ok ? (repoRes.value ?? null) : null;

    let componentCounts: ComponentCounts | null = null;
    let componentsPreview: ComponentInventory | null = null;

    if (
      rootDir !== undefined &&
      canonicalRootDir !== null &&
      (resolvedSource.source.kind === "marketplace-subdir" ||
        resolvedSource.source.kind === "marketplace-root")
    ) {
      const localPluginDir =
        resolvedSource.source.kind === "marketplace-root"
          ? rootDir
          : joinAbsolutePath(rootDir, resolvedSource.source.subdir);
      const dirOffendingLabel =
        resolvedSource.source.kind === "marketplace-root" ? "." : resolvedSource.source.subdir;
      const dirCheck = await checkContainedPath(localPluginDir, canonicalRootDir);
      if (dirCheck.kind === "escaped") {
        diagnostics.push(
          traversalCatalogDiag(
            marketplaceId,
            rawName,
            dirOffendingLabel,
            dirCheck.resolvedOutsideRoot,
            `Rejected plugin "${rawName}" in marketplace "${marketplaceId}": "${dirOffendingLabel}" resolves outside marketplace root (${dirCheck.resolvedOutsideRoot}).`,
            "Remove the escaping symlink from the marketplace repository.",
          ),
        );
        continue;
      }
      if (dirCheck.kind === "contained") {
        const canonicalPluginDir = dirCheck.realPath;
        const pluginManifest = await findPluginManifestFile(localPluginDir);
        if (pluginManifest !== null) {
          const manifestCheck = await checkContainedPath(pluginManifest.path, canonicalPluginDir);
          if (manifestCheck.kind === "escaped") {
            const manifestOffending =
              resolvedSource.source.kind === "marketplace-root"
                ? pluginManifest.relativePath
                : `${resolvedSource.source.subdir}/${pluginManifest.relativePath}`;
            diagnostics.push(
              traversalCatalogDiag(
                marketplaceId,
                rawName,
                manifestOffending,
                manifestCheck.resolvedOutsideRoot,
                `Rejected plugin "${rawName}" in marketplace "${marketplaceId}": manifest "${manifestOffending}" resolves outside plugin root (${manifestCheck.resolvedOutsideRoot}).`,
                "Remove the escaping symlink from the plugin manifest.",
              ),
            );
            continue;
          }
          if (manifestCheck.kind === "contained") {
            try {
              const manifestBytes = await fs.readFile(pluginManifest.path);
              const manifestParsed = parseJsoncBomSafe(manifestBytes, pluginManifest.path);
              if (manifestParsed.ok) {
                const norm = normalizeAntigravityManifest(manifestParsed.value, slug);
                if (norm.ok) {
                  version ??= norm.manifest.version ?? null;
                  if (description.length === 0 && norm.manifest.description !== undefined) {
                    description = norm.manifest.description;
                  }
                  if (displayName === rawName && norm.manifest.displayName !== undefined) {
                    displayName = norm.manifest.displayName;
                  }
                  author ??= norm.manifest.author ?? null;
                  homepage ??= norm.manifest.homepage ?? null;
                  repository ??= norm.manifest.repository ?? null;
                  category ??= norm.extras.category;
                  for (const tag of norm.extras.tags) {
                    tagSet.add(tag);
                  }
                }
              }
            } catch {
            }
          }
        }
        const preview = await previewPluginComponents(localPluginDir);
        if (preview !== null) {
          componentCounts = preview.counts;
          componentsPreview = preview.inventory;
        }
      }
    }

    if (
      repository === null &&
      (resolvedSource.source.kind === "git-repo" || resolvedSource.source.kind === "git-subdir")
    ) {
      repository = resolvedSource.source.repoUrl;
    }

    entries.push({
      id: makeCatalogEntryId(marketplaceId, slug),
      marketplaceId,
      slug,
      name: safeName.value,
      displayName,
      description,
      version,
      author,
      category,
      tags: [...tagSet],
      homepage,
      repository,
      sourceFormat: ecosystem,
      installSource: resolvedSource.source,
      componentCounts,
      componentsPreview,
    });
  }

  return { ok: true, format: ecosystem, entries, diagnostics };
}

type CandidateNormalizationOutcome =
  | { readonly kind: "missing" }
  | { readonly kind: "escaped"; readonly result: CatalogNormalizationResult }
  | { readonly kind: "loaded"; readonly result: CatalogNormalizationResult };

async function tryNormalizeMarketplaceCandidate(
  marketplaceId: MarketplaceId,
  rootDir: AbsolutePath,
  canonicalRootDir: string,
  candidate: MarketplaceCandidate,
): Promise<CandidateNormalizationOutcome> {
  const candidatePath = joinAbsolutePath(rootDir, makeRelativeSubpath(candidate.relativePath));
  const check = await checkContainedPath(candidatePath, canonicalRootDir);
  if (check.kind === "missing") {
    return { kind: "missing" };
  }
  if (check.kind === "escaped") {
    return {
      kind: "escaped",
      result: buildMarketplacePathTraversalResult(
        marketplaceId,
        candidate.relativePath,
        check.resolvedOutsideRoot,
      ),
    };
  }
  let rawBytes: Uint8Array;
  try {
    rawBytes = await fs.readFile(candidatePath);
  } catch {
    return { kind: "missing" };
  }
  const result = await normalizeJsonCatalog(marketplaceId, candidatePath, rawBytes, {
    rootDir,
    defaultEcosystem: candidate.ecosystem,
  });
  return { kind: "loaded", result };
}

async function normalizeSinglePluginMarketplace(
  marketplaceId: MarketplaceId,
  rootDir: AbsolutePath,
  manifestPath: AbsolutePath,
): Promise<CatalogNormalizationResult> {
  let rawBytes: Uint8Array;
  try {
    rawBytes = await fs.readFile(manifestPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return failedCatalogResult(
      invalidCatalogDiag(
        marketplaceId,
        manifestPath,
        reason,
        `Failed to read plugin manifest for "${marketplaceId}": ${reason}`,
        "Ensure the plugin manifest file is readable.",
      ),
    );
  }

  const parsed = parseJsoncBomSafe(rawBytes, manifestPath);
  if (!parsed.ok) {
    return failedCatalogResult(
      syntaxCatalogDiag(
        marketplaceId,
        manifestPath,
        parsed,
        `Failed to parse plugin.json for single-plugin marketplace "${marketplaceId}": ${parsed.syntaxError}`,
        "Fix the JSON syntax error in plugin.json.",
      ),
    );
  }

  const fallbackName = path.basename(rootDir);
  const normalized = normalizeAntigravityManifest(parsed.value, fallbackName);
  if (!normalized.ok) {
    const reason = normalized.fieldErrors.join(" ");
    return failedCatalogResult(
      invalidCatalogDiag(
        marketplaceId,
        manifestPath,
        reason,
        `Invalid plugin.json for "${marketplaceId}": ${reason}`,
        "Fix the manifest schema errors in plugin.json.",
      ),
    );
  }

  const slug = slugifyPluginDirName(normalized.manifest.name, fallbackName);
  const preview = await previewPluginComponents(rootDir);
  const entry: CatalogEntry = {
    id: makeCatalogEntryId(marketplaceId, slug),
    marketplaceId,
    slug,
    name: normalized.manifest.name,
    displayName: normalized.manifest.displayName ?? normalized.manifest.name,
    description: normalized.manifest.description ?? "",
    version: normalized.manifest.version ?? null,
    author: normalized.manifest.author ?? null,
    category: normalized.extras.category,
    tags: normalized.extras.tags,
    homepage: normalized.manifest.homepage ?? null,
    repository: normalized.manifest.repository ?? null,
    sourceFormat: "single-plugin",
    installSource: { kind: "marketplace-root", marketplaceId },
    componentCounts: preview?.counts ?? EMPTY_COMPONENT_COUNTS,
    componentsPreview: preview?.inventory ?? EMPTY_COMPONENT_INVENTORY,
  };

  return { ok: true, format: "single-plugin", entries: [entry], diagnostics: [] };
}

export async function normalizeMarketplaceRoot(
  marketplaceId: MarketplaceId,
  rootDir: AbsolutePath,
): Promise<CatalogNormalizationResult> {
  let canonicalRootDir: string;
  try {
    canonicalRootDir = await fs.realpath(rootDir);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return failedCatalogResult(
      invalidCatalogDiag(
        marketplaceId,
        rootDir,
        reason,
        `Failed to access marketplace directory "${rootDir}": ${reason}`,
        "Ensure the marketplace directory exists and is readable.",
      ),
    );
  }

  for (const candidate of NATIVE_MARKETPLACE_CANDIDATES) {
    const outcome = await tryNormalizeMarketplaceCandidate(
      marketplaceId,
      rootDir,
      canonicalRootDir,
      candidate,
    );
    if (outcome.kind !== "missing") {
      return outcome.result;
    }
  }

  // Dual-ecosystem repos (like cursor/plugins) may ship a small .claude-plugin shim alongside a full .cursor-plugin catalog; pick the richer valid catalog.
  let bestExternal: CatalogNormalizationResult | null = null;
  for (const candidate of EXTERNAL_MARKETPLACE_CANDIDATES) {
    const outcome = await tryNormalizeMarketplaceCandidate(
      marketplaceId,
      rootDir,
      canonicalRootDir,
      candidate,
    );
    if (outcome.kind === "missing") {
      continue;
    }
    if (outcome.kind === "escaped") {
      return outcome.result;
    }
    if (bestExternal === null) {
      bestExternal = outcome.result;
    } else if (
      outcome.result.ok &&
      (!bestExternal.ok || outcome.result.entries.length > bestExternal.entries.length)
    ) {
      bestExternal = outcome.result;
    }
  }
  if (bestExternal !== null) {
    return bestExternal;
  }

  const singleManifest = await findPluginManifestFile(rootDir);
  if (singleManifest !== null) {
    const manifestCheck = await checkContainedPath(singleManifest.path, canonicalRootDir);
    if (manifestCheck.kind === "escaped") {
      return buildMarketplacePathTraversalResult(
        marketplaceId,
        singleManifest.relativePath,
        manifestCheck.resolvedOutsideRoot,
      );
    }
    if (manifestCheck.kind === "contained") {
      return normalizeSinglePluginMarketplace(marketplaceId, rootDir, singleManifest.path);
    }
  }

  return failedCatalogResult(
    invalidCatalogDiag(
      marketplaceId,
      rootDir,
      "No marketplace.json or plugin.json manifest found in directory.",
      `Marketplace "${marketplaceId}" does not contain a marketplace.json or plugin.json manifest.`,
      "Add .antigravity-plugin/marketplace.json, .claude-plugin/marketplace.json, .cursor-plugin/marketplace.json, or a plugin.json.",
    ),
  );
}
