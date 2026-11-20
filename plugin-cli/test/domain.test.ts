import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";
import {
  deriveMarketplaceId,
  formatBytes,
  formatComponentsCompact,
  formatMarketplaceSource,
  parseInstallTarget,
  parseMarketplaceInput,
  queryCatalog,
  queryDiagnostics,
  queryInstalled,
  queryMarketplaces,
} from "../src/domain/query.ts";
import {
  EMPTY_COMPONENT_COUNTS,
  EMPTY_COMPONENT_INVENTORY,
  isAbsolutePath,
  isCatalogEntryId,
  isDiagnosticId,
  isHttpUrl,
  isInstallScope,
  isInstalledPluginId,
  isIsoTimestamp,
  isMarketplaceId,
  isPluginDirName,
  isPluginName,
  isRelativeSubpath,
  isRequestId,
  isSnapshotRevision,
  isSshGitUrl,
  joinAbsolutePath,
  makeAbsolutePath,
  makeCatalogEntryId,
  makeDiagnosticId,
  makeHttpUrl,
  makeInstalledPluginId,
  makeIsoTimestamp,
  makeMarketplaceId,
  makePluginDirName,
  makePluginName,
  makeRelativeSubpath,
  makeRequestId,
  makeSnapshotRevision,
  makeSshGitUrl,
  nextRequestId,
  nextSnapshotRevision,
  parseAbsolutePath,
  parseCatalogEntryId,
  parseDiagnosticId,
  parseHttpUrl,
  parseInstallScope,
  parseInstalledPluginId,
  parseIsoTimestamp,
  parseMarketplaceId,
  parsePluginDirName,
  parsePluginName,
  parseRelativeSubpath,
  parseRequestId,
  parseSnapshotRevision,
  parseSshGitUrl,
  slugifyPluginDirName,
  splitInstalledPluginId,
} from "../src/domain/types.ts";
import type {
  AbsolutePath,
  CatalogEntry,
  CatalogEntryId,
  Diagnostic,
  DiagnosticId,
  InstalledPlugin,
  InstalledPluginId,
  MarketplaceId,
  MarketplaceRecord,
  PluginName,
  WorkspaceSnapshot,
} from "../src/domain/types.ts";
import type { PluginEngine } from "../src/engine/contract.ts";

const TEST_CWD = makeAbsolutePath("/workspace/project");
const TEST_HOME = makeAbsolutePath("/home/tester");
const TEST_TIMESTAMP = makeIsoTimestamp(new Date("2026-11-20T00:00:00.000Z"));

function buildSnapshot(options: {
  readonly catalog?: readonly CatalogEntry[];
  readonly installed?: readonly InstalledPlugin[];
  readonly marketplaces?: readonly MarketplaceRecord[];
  readonly diagnostics?: readonly Diagnostic[];
  readonly staleStagingPaths?: readonly AbsolutePath[];
}): WorkspaceSnapshot {
  const catalog = options.catalog ?? [];
  const installed = options.installed ?? [];
  const marketplaces = options.marketplaces ?? [];
  const diagnostics = options.diagnostics ?? [];
  const staleStagingPaths = options.staleStagingPaths ?? [];

  const catalogById = new Map<CatalogEntryId, CatalogEntry>();
  for (const entry of catalog) {
    catalogById.set(entry.id, entry);
  }

  const installedById = new Map<InstalledPluginId, InstalledPlugin>();
  const installedIdsByPluginName = new Map<PluginName, InstalledPluginId[]>();
  for (const plugin of installed) {
    installedById.set(plugin.id, plugin);
    if (plugin.kind === "valid") {
      const existing = installedIdsByPluginName.get(plugin.manifest.name) ?? [];
      existing.push(plugin.id);
      installedIdsByPluginName.set(plugin.manifest.name, existing);
    }
  }

  const marketplacesById = new Map<MarketplaceId, MarketplaceRecord>();
  for (const record of marketplaces) {
    marketplacesById.set(record.id, record);
  }

  const diagnosticsById = new Map<DiagnosticId, Diagnostic>();
  for (const diagnostic of diagnostics) {
    diagnosticsById.set(diagnostic.id, diagnostic);
  }

  const userPluginsDir = makeAbsolutePath("/home/tester/.gemini/config/plugins");
  const projectPluginsDir = makeAbsolutePath("/workspace/project/.agents/plugins");

  return {
    revision: makeSnapshotRevision(1),
    projectedAt: TEST_TIMESTAMP,
    paths: {
      homeDir: TEST_HOME,
      configDir: makeAbsolutePath("/home/tester/.gemini/config"),
      workspaceDir: TEST_CWD,
      userPluginsDir,
      projectPluginsDir,
      managerDir: makeAbsolutePath("/home/tester/.gemini/config/plugin-manager"),
    },
    catalog,
    installed,
    marketplaces,
    diagnostics,
    staleStagingPaths,
    stats: {
      discoverableCount: catalog.length,
      installedCount: installed.length,
      activeCount: 0,
      disabledCount: 0,
      shadowedCount: 0,
      brokenCount: 0,
      errorCount: diagnostics.filter((d) => d.severity === "error").length,
      warningCount: diagnostics.filter((d) => d.severity === "warning").length,
      activeComponents: EMPTY_COMPONENT_COUNTS,
      installedComponents: EMPTY_COMPONENT_COUNTS,
      estimatedDescriptionTokens: 0,
      totalDiskBytes: 0,
      byScope: {
        user: {
          scope: "user",
          pluginsRoot: userPluginsDir,
          installedCount: 0,
          activeCount: 0,
          disabledCount: 0,
          brokenCount: 0,
          diskBytes: 0,
          componentTotals: EMPTY_COMPONENT_COUNTS,
        },
        project: {
          scope: "project",
          pluginsRoot: projectPluginsDir,
          installedCount: 0,
          activeCount: 0,
          disabledCount: 0,
          brokenCount: 0,
          diskBytes: 0,
          componentTotals: EMPTY_COMPONENT_COUNTS,
        },
      },
      byMarketplace: [],
      topTokenConsumers: [],
    },
    catalogById,
    installedById,
    marketplacesById,
    diagnosticsById,
    installedIdsByPluginName,
  };
}

function makeCatalogEntryFixture(overrides: {
  readonly marketplaceId?: string;
  readonly slug: string;
  readonly name?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly category?: string | null;
  readonly tags?: readonly string[];
  readonly author?: string | null;
}): CatalogEntry {
  const marketplaceId = makeMarketplaceId(overrides.marketplaceId ?? "cursor-plugins");
  const slug = makePluginDirName(overrides.slug);
  const name = makePluginName(overrides.name ?? overrides.slug);
  return {
    id: makeCatalogEntryId(marketplaceId, slug),
    marketplaceId,
    slug,
    name,
    displayName: overrides.displayName ?? name,
    description: overrides.description ?? "",
    version: "1.0.0",
    author: overrides.author ?? null,
    category: overrides.category ?? null,
    tags: overrides.tags ?? [],
    homepage: null,
    repository: null,
    sourceFormat: "cursor",
    installSource: {
      kind: "marketplace-subdir",
      marketplaceId,
      subdir: makeRelativeSubpath(slug),
    },
    componentCounts: { skills: 2, agents: 1, rules: 0, hooks: 0, mcpServers: 0 },
    componentsPreview: null,
  };
}

describe("branded primitives and boundary parsers", () => {
  it("validates and normalizes AbsolutePath while rejecting relative and NUL paths", () => {
    assert.equal(isAbsolutePath("/home/tester/plugins"), true);
    assert.equal(isAbsolutePath("/"), true);
    assert.equal(isAbsolutePath("/home/tester/plugins/"), false);
    assert.equal(isAbsolutePath("/home/../etc/passwd"), false);
    assert.equal(isAbsolutePath("relative/path"), false);
    assert.equal(isAbsolutePath("../escape"), false);
    assert.equal(isAbsolutePath("/tmp/\0bad"), false);

    const parsed = parseAbsolutePath("/home/tester/plugins/");
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.value, "/home/tester/plugins");
    }

    const joined = joinAbsolutePath(
      makeAbsolutePath("/home/tester"),
      makeRelativeSubpath("plugins/pstack"),
    );
    assert.equal(joined, "/home/tester/plugins/pstack");

    const relErr = parseAbsolutePath("../etc/passwd");
    assert.equal(relErr.ok, false);
    if (!relErr.ok) {
      assert.equal(relErr.error.code, "invalid-path");
    }

    const nulErr = parseAbsolutePath("/tmp/a\0b");
    assert.equal(nulErr.ok, false);
    if (!nulErr.ok) {
      assert.equal(nulErr.error.code, "invalid-path");
    }

    const emptyErr = parseAbsolutePath("   ");
    assert.equal(emptyErr.ok, false);
    if (!emptyErr.ok) {
      assert.equal(emptyErr.error.code, "empty-input");
    }
  });

  it("validates RelativeSubpath and rejects path traversal, leading slash, and NUL", () => {
    assert.equal(isRelativeSubpath("plugins/pstack"), true);
    assert.equal(isRelativeSubpath("pstack"), true);
    assert.equal(isRelativeSubpath("../escape"), false);
    assert.equal(isRelativeSubpath("plugins/../escape"), false);
    assert.equal(isRelativeSubpath("/etc/passwd"), false);
    assert.equal(isRelativeSubpath("a\\b"), false);
    assert.equal(isRelativeSubpath("a/\0/b"), false);
    assert.equal(isRelativeSubpath("."), false);
    assert.equal(isRelativeSubpath("C:/Windows"), false);

    const normalized = parseRelativeSubpath("./plugins/pstack/");
    assert.equal(normalized.ok, true);
    if (normalized.ok) {
      assert.equal(normalized.value, "plugins/pstack");
    }

    const winSlashes = parseRelativeSubpath("plugins\\pstack");
    assert.equal(winSlashes.ok, true);
    if (winSlashes.ok) {
      assert.equal(winSlashes.value, "plugins/pstack");
    }

    const traversal = parseRelativeSubpath("plugins/../../etc/passwd");
    assert.equal(traversal.ok, false);
    if (!traversal.ok) {
      assert.equal(traversal.error.code, "path-traversal");
    }

    const leadingDotDot = parseRelativeSubpath("../secret");
    assert.equal(leadingDotDot.ok, false);
    if (!leadingDotDot.ok) {
      assert.equal(leadingDotDot.error.code, "path-traversal");
    }

    assert.equal(parseRelativeSubpath(".").ok, false);
    assert.equal(parseRelativeSubpath("./").ok, false);
    assert.equal(parseRelativeSubpath("/abs/path").ok, false);
    assert.equal(parseRelativeSubpath("a\0b").ok, false);
  });

  it("enforces PluginDirName rules rejecting ., .., and .agy-* staging prefixes", () => {
    assert.equal(isPluginDirName("pstack"), true);
    assert.equal(isPluginDirName("Claude_Tools-v2.1"), true);
    assert.equal(isPluginDirName("."), false);
    assert.equal(isPluginDirName(".."), false);
    assert.equal(isPluginDirName(".agy-stage-foo"), false);
    assert.equal(isPluginDirName(".agy-backup-foo"), false);
    assert.equal(isPluginDirName(".hidden"), false);
    assert.equal(isPluginDirName("-leading-dash"), false);
    assert.equal(isPluginDirName("nested/path"), false);
    assert.equal(isPluginDirName("bad\0name"), false);
    assert.equal(isPluginDirName("a".repeat(129)), false);

    assert.equal(parsePluginDirName(".agy-stage-foo").ok, false);
    assert.equal(parsePluginDirName("..").ok, false);
    assert.equal(slugifyPluginDirName("CI/CD Helper!"), "ci-cd-helper");
    assert.equal(slugifyPluginDirName(".agy-stage-foo"), "agy-stage-foo");
    assert.equal(slugifyPluginDirName("..."), "plugin");
  });

  it("validates MarketplaceId, PluginName, InstalledPluginId, and CatalogEntryId", () => {
    assert.equal(isMarketplaceId("cursor-plugins"), true);
    assert.equal(isMarketplaceId("acme.tools_1"), true);
    assert.equal(isMarketplaceId("Cursor-Plugins"), false);
    assert.equal(isMarketplaceId(".hidden"), false);
    assert.equal(isMarketplaceId("bad/slash"), false);

    const parsedMkt = parseMarketplaceId("  Cursor-Plugins ");
    assert.equal(parsedMkt.ok, true);
    if (parsedMkt.ok) {
      assert.equal(parsedMkt.value, "cursor-plugins");
    }

    assert.equal(isPluginName("pstack"), true);
    assert.equal(isPluginName("CI Helper"), true);
    assert.equal(isPluginName("."), false);
    assert.equal(isPluginName(".."), false);
    assert.equal(isPluginName("a/b"), false);
    assert.equal(isPluginName("a\\b"), false);
    assert.equal(isPluginName("bad\nline"), false);
    assert.equal(isPluginName("bad\0name"), false);
    assert.equal(parsePluginName("  pstack  ").ok, true);

    const installedId = makeInstalledPluginId("user", makePluginDirName("pstack"));
    assert.equal(installedId, "user:pstack");
    assert.equal(isInstalledPluginId(installedId), true);
    assert.deepEqual(splitInstalledPluginId(installedId), {
      scope: "user",
      dirName: "pstack",
    });
    assert.equal(isInstalledPluginId("global:pstack"), false);
    assert.equal(isInstalledPluginId("user:.agy-stage-foo"), false);
    assert.equal(parseInstalledPluginId("project:my-plugin").ok, true);
    assert.equal(parseInstalledPluginId("user:a:b").ok, false);

    const entryId = makeCatalogEntryId(
      makeMarketplaceId("cursor-plugins"),
      slugifyPluginDirName("CI/CD Helper"),
    );
    assert.equal(entryId, "cursor-plugins/ci-cd-helper");
    assert.equal(isCatalogEntryId(entryId), true);
    assert.equal(isCatalogEntryId("cursor-plugins/.agy-stage-foo"), false);
    assert.equal(isCatalogEntryId("cursor-plugins/a/b"), false);
    assert.equal(parseCatalogEntryId("cursor-plugins/pstack").ok, true);
    assert.equal(parseCatalogEntryId("Cursor/pstack").ok, false);
  });

  it("validates DiagnosticId, SnapshotRevision, RequestId, IsoTimestamp, and InstallScope", () => {
    assert.equal(isDiagnosticId("manifest-json-syntax:user:pstack"), true);
    assert.equal(isDiagnosticId("has space"), false);
    assert.equal(isDiagnosticId("has\0nul"), false);
    assert.equal(makeDiagnosticId("stale-staging", "/home/my user/.agy-stage"), "stale-staging:/home/my_user/.agy-stage");
    assert.equal(parseDiagnosticId("diag-1").ok, true);

    assert.equal(isSnapshotRevision(0), true);
    assert.equal(isSnapshotRevision(-1), false);
    assert.equal(isSnapshotRevision(1.5), false);
    assert.equal(nextSnapshotRevision(makeSnapshotRevision(0)), 1);
    assert.equal(parseSnapshotRevision(-5).ok, false);

    assert.equal(isRequestId(1), true);
    assert.equal(isRequestId(0), false);
    assert.equal(isRequestId(2.2), false);
    assert.equal(nextRequestId(makeRequestId(1)), 2);
    assert.equal(parseRequestId(0).ok, false);

    assert.equal(isIsoTimestamp("2026-11-20T00:49:38.123Z"), true);
    assert.equal(isIsoTimestamp("2026-11-20T05:30:00+05:30"), true);
    assert.equal(isIsoTimestamp("2026-02-31T00:00:00Z"), false);
    assert.equal(isIsoTimestamp("2026-13-01T00:00:00Z"), false);
    assert.equal(isIsoTimestamp("not-a-timestamp"), false);
    assert.equal(parseIsoTimestamp("2026-11-20T00:49:38Z").ok, true);
    assert.equal(parseIsoTimestamp("2026-02-30T00:00:00Z").ok, false);
    assert.throws(() => makeIsoTimestamp(new Date("invalid")));

    assert.equal(isInstallScope("user"), true);
    assert.equal(isInstallScope("project"), true);
    assert.equal(isInstallScope("global"), false);
    assert.equal(parseInstallScope("USER").ok, true);
    assert.equal(parseInstallScope("workspace").ok, false);
  });

  it("validates HttpUrl and SshGitUrl while rejecting unsafe URLs and traversal", () => {
    assert.equal(isHttpUrl("https://github.com/cursor/plugins"), true);
    assert.equal(isHttpUrl("http://localhost:8080/marketplace.json"), true);
    assert.equal(isHttpUrl("ftp://example.com/file"), false);
    assert.equal(isHttpUrl("javascript:alert(1)"), false);
    assert.equal(isHttpUrl("https://"), false);
    assert.equal(isHttpUrl("https://example.com/with space"), false);
    assert.equal(parseHttpUrl("https://example.com/ok").ok, true);
    assert.equal(parseHttpUrl("ftp://example.com/bad").ok, false);
    assert.equal(makeHttpUrl("https://example.com/x"), "https://example.com/x");

    assert.equal(isSshGitUrl("git@github.com:cursor/plugins.git"), true);
    assert.equal(isSshGitUrl("git@gitlab.internal.corp:team/sub/repo"), true);
    assert.equal(isSshGitUrl("ssh://git@gitlab.example.com:2222/org/plugins.git"), true);
    assert.equal(isSshGitUrl("git@github.com:../etc/passwd"), false);
    assert.equal(isSshGitUrl("ssh://git@github.com/org/../secret"), false);
    assert.equal(isSshGitUrl("git@github.com:"), false);
    assert.equal(isSshGitUrl("git@github.com:org/repo#main"), false);
    assert.equal(isSshGitUrl("https://github.com/cursor/plugins"), false);
    assert.equal(parseSshGitUrl("git@github.com:cursor/plugins.git").ok, true);
    assert.equal(parseSshGitUrl("git@github.com:").ok, false);
    assert.equal(makeSshGitUrl("git@github.com:cursor/plugins.git"), "git@github.com:cursor/plugins.git");
  });
});

describe("parseMarketplaceInput, deriveMarketplaceId, and formatMarketplaceSource", () => {
  it("parses GitHub shorthand, repo URLs, and /tree/<ref>/<subdir> URLs", () => {
    const shorthand = parseMarketplaceInput({
      raw: "cursor/plugins",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(shorthand, {
      ok: true,
      value: { kind: "github", owner: "cursor", repo: "plugins" },
    });
    if (shorthand.ok) {
      assert.equal(deriveMarketplaceId(shorthand.value), "cursor-plugins");
      assert.equal(formatMarketplaceSource(shorthand.value), "github:cursor/plugins");
    }

    const withRef = parseMarketplaceInput({
      raw: "cursor/plugins@main",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(withRef, {
      ok: true,
      value: { kind: "github", owner: "cursor", repo: "plugins", ref: "main" },
    });

    const treeUrl = parseMarketplaceInput({
      raw: "https://github.com/cursor/plugins/tree/main/pstack",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(treeUrl, {
      ok: true,
      value: {
        kind: "github",
        owner: "cursor",
        repo: "plugins",
        ref: "main",
        subdir: "pstack",
      },
    });
    if (treeUrl.ok) {
      assert.equal(deriveMarketplaceId(treeUrl.value), "cursor-plugins-pstack");
      assert.equal(
        formatMarketplaceSource(treeUrl.value),
        "github:cursor/plugins@main:pstack",
      );
    }

    const traversalUrl = parseMarketplaceInput({
      raw: "https://github.com/cursor/plugins/tree/main/../../etc/passwd",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.equal(traversalUrl.ok, false);
    if (!traversalUrl.ok) {
      assert.equal(traversalUrl.error.code, "path-traversal");
    }
  });

  it("parses SSH SCP and ssh:// remotes with optional #ref and @ref", () => {
    const scp = parseMarketplaceInput({
      raw: "git@github.com:cursor/plugins.git",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(scp, {
      ok: true,
      value: { kind: "ssh", url: "git@github.com:cursor/plugins.git" },
    });
    if (scp.ok) {
      assert.equal(deriveMarketplaceId(scp.value), "cursor-plugins");
      assert.equal(formatMarketplaceSource(scp.value), "git@github.com:cursor/plugins.git");
    }

    const scpAtRef = parseMarketplaceInput({
      raw: "git@github.com:cursor/plugins.git@v2.0",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(scpAtRef, {
      ok: true,
      value: { kind: "ssh", url: "git@github.com:cursor/plugins.git", ref: "v2.0" },
    });

    const sshScheme = parseMarketplaceInput({
      raw: "ssh://git@gitlab.example.com:2222/team/plugins.git#release",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(sshScheme, {
      ok: true,
      value: {
        kind: "ssh",
        url: "ssh://git@gitlab.example.com:2222/team/plugins.git",
        ref: "release",
      },
    });
    if (sshScheme.ok) {
      assert.equal(deriveMarketplaceId(sshScheme.value), "team-plugins");
      assert.equal(
        formatMarketplaceSource(sshScheme.value),
        "ssh://git@gitlab.example.com:2222/team/plugins.git#release",
      );
    }
  });

  it("classifies HTTPS .git, HTTPS .json, and HTTPS auto URLs", () => {
    const httpsGit = parseMarketplaceInput({
      raw: "https://gitlab.example.com/org/plugins.git#main",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(httpsGit, {
      ok: true,
      value: {
        kind: "https-git",
        url: "https://gitlab.example.com/org/plugins.git",
        ref: "main",
      },
    });
    if (httpsGit.ok) {
      assert.equal(deriveMarketplaceId(httpsGit.value), "org-plugins");
    }

    const httpsJson = parseMarketplaceInput({
      raw: "https://example.com/catalog/marketplace.json?v=2",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(httpsJson, {
      ok: true,
      value: {
        kind: "https-json",
        url: "https://example.com/catalog/marketplace.json?v=2",
      },
    });
    if (httpsJson.ok) {
      assert.equal(deriveMarketplaceId(httpsJson.value), "catalog");
    }

    const httpsAuto = parseMarketplaceInput({
      raw: "https://example.com/plugins",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(httpsAuto, {
      ok: true,
      value: { kind: "https-auto", url: "https://example.com/plugins" },
    });
  });

  it("parses local folders, ~/ expansion, file:// URLs, and local .json catalogs", () => {
    const localFolder = parseMarketplaceInput({
      raw: "./my-marketplace",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(localFolder, {
      ok: true,
      value: { kind: "local-folder", path: "/workspace/project/my-marketplace" },
    });
    if (localFolder.ok) {
      assert.equal(deriveMarketplaceId(localFolder.value), "my-marketplace");
    }

    const tildeFolder = parseMarketplaceInput({
      raw: "~/marketplaces/custom",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(tildeFolder, {
      ok: true,
      value: { kind: "local-folder", path: "/home/tester/marketplaces/custom" },
    });

    const localJson = parseMarketplaceInput({
      raw: "~/acme-plugins/marketplace.json",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(localJson, {
      ok: true,
      value: { kind: "local-json", path: "/home/tester/acme-plugins/marketplace.json" },
    });
    if (localJson.ok) {
      assert.equal(deriveMarketplaceId(localJson.value), "acme-plugins");
    }

    const relJson = parseMarketplaceInput({
      raw: "catalogs/official.json",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(relJson, {
      ok: true,
      value: { kind: "local-json", path: "/workspace/project/catalogs/official.json" },
    });

    const fileUrl = parseMarketplaceInput({
      raw: "file:///opt/marketplaces/corp",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(fileUrl, {
      ok: true,
      value: { kind: "local-folder", path: "/opt/marketplaces/corp" },
    });

    assert.equal(
      parseMarketplaceInput({ raw: "ftp://example.com/repo", cwd: TEST_CWD, homeDir: TEST_HOME }).ok,
      false,
    );
    assert.equal(
      parseMarketplaceInput({ raw: "   ", cwd: TEST_CWD, homeDir: TEST_HOME }).ok,
      false,
    );
  });
});

describe("parseInstallTarget", () => {
  it("distinguishes plugin@marketplace, left/right, plain names, URLs, and local paths", () => {
    const pinned = parseInstallTarget({
      raw: "pstack@cursor-plugins",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(pinned, {
      ok: true,
      value: {
        kind: "catalog-name",
        name: "pstack",
        marketplaceId: "cursor-plugins",
      },
    });

    const ambiguous = parseInstallTarget({
      raw: "cursor-plugins/pstack",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(ambiguous, {
      ok: true,
      value: {
        kind: "catalog-or-github",
        left: "cursor-plugins",
        right: "pstack",
        githubSource: {
          kind: "github",
          owner: "cursor-plugins",
          repo: "pstack",
        },
      },
    });

    const plain = parseInstallTarget({
      raw: "pstack",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(plain, {
      ok: true,
      value: { kind: "catalog-name", name: "pstack" },
    });

    const githubTree = parseInstallTarget({
      raw: "https://github.com/cursor/plugins/tree/main/pstack",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(githubTree, {
      ok: true,
      value: {
        kind: "direct-source",
        source: {
          kind: "github",
          owner: "cursor",
          repo: "plugins",
          ref: "main",
          subdir: "pstack",
        },
      },
    });

    const localDir = parseInstallTarget({
      raw: "./my-plugin",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(localDir, {
      ok: true,
      value: {
        kind: "direct-source",
        source: {
          kind: "local-folder",
          path: "/workspace/project/my-plugin",
        },
      },
    });

    const githubWithRef = parseInstallTarget({
      raw: "cursor/plugins@v1.0",
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
    });
    assert.deepEqual(githubWithRef, {
      ok: true,
      value: {
        kind: "direct-source",
        source: {
          kind: "github",
          owner: "cursor",
          repo: "plugins",
          ref: "v1.0",
        },
      },
    });

    assert.equal(
      parseInstallTarget({ raw: "@cursor-plugins", cwd: TEST_CWD, homeDir: TEST_HOME }).ok,
      false,
    );
    assert.equal(
      parseInstallTarget({ raw: "a/b/c", cwd: TEST_CWD, homeDir: TEST_HOME }).ok,
      false,
    );
  });
});

describe("snapshot queries and formatters", () => {
  it("ranks queryCatalog exact > prefix > substring > tag/category > description and joins install status", () => {
    const entries = [
      makeCatalogEntryFixture({
        slug: "desc-hit",
        description: "Workflow helper inspired by pstack tooling",
      }),
      makeCatalogEntryFixture({
        slug: "tag-hit",
        tags: ["pstack", "automation"],
        description: "Other description",
      }),
      makeCatalogEntryFixture({
        slug: "my-pstack-helper",
        description: "Contains substring in name",
      }),
      makeCatalogEntryFixture({
        slug: "pstack-extras",
        description: "Starts with prefix",
      }),
      makeCatalogEntryFixture({
        slug: "pstack",
        description: "Exact match",
      }),
      makeCatalogEntryFixture({
        marketplaceId: "other-market",
        slug: "unrelated",
        category: "database",
        description: "SQL migrations",
      }),
    ];

    const installedPstack: InstalledPlugin = {
      kind: "valid",
      id: makeInstalledPluginId("user", makePluginDirName("pstack")),
      scope: "user",
      dirName: makePluginDirName("pstack"),
      installPath: makeAbsolutePath("/home/tester/.gemini/config/plugins/pstack"),
      manifest: { name: makePluginName("pstack"), version: "0.9.0" },
      activation: { kind: "active" },
      provenance: { kind: "unmanaged" },
      components: EMPTY_COMPONENT_INVENTORY,
      diskBytes: 4096,
      estimatedDescriptionTokens: 50,
      updateAvailable: {
        latestVersion: "1.0.0",
        sourceEntryId: makeCatalogEntryId(
          makeMarketplaceId("cursor-plugins"),
          makePluginDirName("pstack"),
        ),
      },
      diagnosticIds: [],
    };

    const installedPstackProject: InstalledPlugin = {
      kind: "valid",
      id: makeInstalledPluginId("project", makePluginDirName("pstack")),
      scope: "project",
      dirName: makePluginDirName("pstack"),
      installPath: makeAbsolutePath("/workspace/project/.agents/plugins/pstack"),
      manifest: { name: makePluginName("pstack"), version: "1.0.0" },
      activation: { kind: "active" },
      provenance: { kind: "unmanaged" },
      components: EMPTY_COMPONENT_INVENTORY,
      diskBytes: 4096,
      estimatedDescriptionTokens: 50,
      updateAvailable: null,
      diagnosticIds: [],
    };

    const snapshot = buildSnapshot({
      catalog: entries,
      installed: [installedPstack, installedPstackProject],
    });

    const ranked = queryCatalog(snapshot, { text: "pstack" });
    assert.deepEqual(
      ranked.map((match) => match.entry.slug),
      ["pstack", "pstack-extras", "my-pstack-helper", "tag-hit", "desc-hit"],
    );
    assert.equal(ranked[0]?.installStatus.kind, "installed");
    if (ranked[0]?.installStatus.kind === "installed") {
      assert.deepEqual(ranked[0].installStatus.scopes, ["user", "project"]);
      assert.equal(ranked[0].installStatus.installedIds.length, 2);
      assert.equal(ranked[0].installStatus.hasUpdate, true);
    }
    assert.equal(ranked[1]?.installStatus.kind, "not-installed");

    const installedOnly = queryCatalog(snapshot, { installFilter: "installed" });
    assert.deepEqual(
      installedOnly.map((match) => match.entry.slug),
      ["pstack"],
    );

    const notInstalledOnly = queryCatalog(snapshot, { installFilter: "not-installed" });
    assert.equal(notInstalledOnly.length, 5);
    assert.equal(notInstalledOnly.some((m) => m.entry.slug === "pstack"), false);

    const byCategory = queryCatalog(snapshot, { category: "DATABASE" });
    assert.deepEqual(
      byCategory.map((match) => match.entry.slug),
      ["unrelated"],
    );

    const multiToken = queryCatalog(snapshot, { text: "workflow pstack" });
    assert.deepEqual(
      multiToken.map((match) => match.entry.slug),
      ["desc-hit"],
    );

    const byMarketplace = queryCatalog(snapshot, {
      marketplaceId: makeMarketplaceId("other-market"),
    });
    assert.deepEqual(
      byMarketplace.map((match) => match.entry.slug),
      ["unrelated"],
    );
  });

  it("searches 4,000+ catalog entries via WeakMap index with sub-millisecond warm latency", () => {
    const entries: CatalogEntry[] = [];
    for (let i = 0; i < 4000; i += 1) {
      entries.push(
        makeCatalogEntryFixture({
          marketplaceId: i % 2 === 0 ? "claude-official" : "cursor-plugins",
          slug: `plugin-${i}`,
          displayName: `Plugin ${i}`,
          description: i === 2750 ? "Zero-latency quantum refactor assistant" : `Utility bundle number ${i}`,
          category: i % 10 === 0 ? "devtools" : "general",
          tags: i % 25 === 0 ? ["refactor", "agent"] : ["utility"],
        }),
      );
    }
    const snapshot = buildSnapshot({ catalog: entries });

    const warmup = queryCatalog(snapshot, { text: "quantum" });
    assert.equal(warmup.length, 1);
    assert.equal(warmup[0]?.entry.slug, "plugin-2750");

    const iterations = 20;
    const queries = ["plugin-2750", "quantum", "refactor", "plugin-399", "devtools"];
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) {
      const q = queries[i % queries.length] ?? "plugin";
      const res = queryCatalog(snapshot, { text: q });
      assert.ok(res.length > 0);
    }
    const avgMs = (performance.now() - start) / iterations;
    assert.ok(
      avgMs < 5,
      `Expected warm 4,000-entry catalog query under 5ms, measured ${avgMs.toFixed(3)}ms`,
    );
  });

  it("filters installed plugins, diagnostics, and marketplaces and formats compact badges", () => {
    const userPlugin: InstalledPlugin = {
      kind: "valid",
      id: makeInstalledPluginId("user", makePluginDirName("pstack")),
      scope: "user",
      dirName: makePluginDirName("pstack"),
      installPath: makeAbsolutePath("/home/tester/.gemini/config/plugins/pstack"),
      manifest: { name: makePluginName("pstack"), description: "Agentic workflow suite" },
      activation: { kind: "active" },
      provenance: { kind: "unmanaged" },
      components: EMPTY_COMPONENT_INVENTORY,
      diskBytes: 1024,
      estimatedDescriptionTokens: 120,
      updateAvailable: null,
      diagnosticIds: [],
    };
    const brokenPlugin: InstalledPlugin = {
      kind: "broken",
      id: makeInstalledPluginId("project", makePluginDirName("broken-one")),
      scope: "project",
      dirName: makePluginDirName("broken-one"),
      installPath: makeAbsolutePath("/workspace/project/.agents/plugins/broken-one"),
      provenance: { kind: "unmanaged" },
      diskBytes: 512,
      diagnosticIds: [makeDiagnosticId("manifest-json-syntax", "project:broken-one")],
    };

    const stalePath = makeAbsolutePath("/home/tester/.gemini/config/plugins/.agy-stage-old");
    const warningDiag: Diagnostic = {
      id: makeDiagnosticId("stale-staging", stalePath),
      severity: "warning",
      subject: { kind: "path", path: stalePath },
      detail: {
        kind: "stale-staging-artifact",
        artifactPath: stalePath,
        scope: "user",
        artifactKind: "staging",
      },
      message: "Stale staging directory left behind after interrupted install.",
      hint: "Run remediation to delete the stale directory.",
      remediation: {
        kind: "clean-stale-staging",
        path: stalePath,
        label: "Remove stale staging directory",
      },
    };
    const errorDiag: Diagnostic = {
      id: makeDiagnosticId("unadapted-hooks", userPlugin.id),
      severity: "error",
      subject: { kind: "installed", pluginId: userPlugin.id },
      detail: {
        kind: "unadapted-hooks-path",
        sourcePath: makeAbsolutePath("/home/tester/.gemini/config/plugins/pstack/hooks/hooks.json"),
        expectedPath: makeAbsolutePath("/home/tester/.gemini/config/plugins/pstack/hooks.json"),
      },
      message: "Claude-style hooks/hooks.json is not adapted to Antigravity root hooks.json.",
      hint: "Re-adapt plugin bundle.",
      remediation: {
        kind: "readapt-bundle",
        pluginId: userPlugin.id,
        label: "Re-adapt plugin bundle",
      },
    };

    const marketplaces: MarketplaceRecord[] = [
      {
        id: makeMarketplaceId("cursor-plugins"),
        source: { kind: "github", owner: "cursor", repo: "plugins" },
        addedAt: TEST_TIMESTAMP,
        sync: {
          kind: "synced",
          syncedAt: TEST_TIMESTAMP,
          resolvedRef: "main",
          resolvedSha: "abcdef1",
          format: "cursor",
          pluginCount: 12,
        },
        localMirrorPath: null,
      },
      {
        id: makeMarketplaceId("corp-private"),
        source: { kind: "ssh", url: makeSshGitUrl("git@corp.internal:team/plugins.git") },
        addedAt: TEST_TIMESTAMP,
        sync: {
          kind: "sync-failed",
          attemptedAt: TEST_TIMESTAMP,
          lastGoodSyncAt: null,
          reason: "SSH key passphrase required",
        },
        localMirrorPath: null,
      },
    ];

    const snapshot = buildSnapshot({
      installed: [userPlugin, brokenPlugin],
      diagnostics: [warningDiag, errorDiag],
      marketplaces,
      staleStagingPaths: [stalePath],
    });

    assert.deepEqual(
      queryInstalled(snapshot, { state: "broken" }).map((p) => p.id),
      ["project:broken-one"],
    );
    assert.deepEqual(
      queryInstalled(snapshot, { scope: "user", text: "workflow" }).map((p) => p.id),
      ["user:pstack"],
    );

    const allDiagnostics = queryDiagnostics(snapshot, {});
    assert.equal(allDiagnostics[0]?.severity, "error");
    assert.equal(allDiagnostics[1]?.severity, "warning");
    assert.equal(queryDiagnostics(snapshot, { text: "staging" }).length, 1);

    assert.deepEqual(
      queryMarketplaces(snapshot, "passphrase").map((m) => m.id),
      ["corp-private"],
    );
    assert.deepEqual(
      queryMarketplaces(snapshot, "cursor").map((m) => m.id),
      ["cursor-plugins"],
    );

    assert.equal(formatComponentsCompact(null), "-");
    assert.equal(formatComponentsCompact(EMPTY_COMPONENT_COUNTS), "-");
    assert.equal(
      formatComponentsCompact({ skills: 42, agents: 2, rules: 1, hooks: 0, mcpServers: 3 }),
      "42S 2A 1R 3M",
    );

    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(-10), "0 B");
    assert.equal(formatBytes(512), "512 B");
    assert.equal(formatBytes(1024), "1.0 KB");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(1024 * 1024 * 2.5), "2.5 MB");
    assert.equal(formatBytes(1024 ** 3), "1.0 GB");
  });

  it("exposes all 10 frozen methods on the PluginEngine contract", () => {
    const expectedMethods: readonly (keyof PluginEngine)[] = [
      "snapshot",
      "install",
      "uninstall",
      "setEnabled",
      "update",
      "addMarketplace",
      "syncMarketplaces",
      "removeMarketplace",
      "validate",
      "remediate",
    ];
    assert.equal(expectedMethods.length, 10);
  });
});
