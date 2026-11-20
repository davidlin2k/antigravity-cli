import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import {
  parseInstallTarget,
  parseMarketplaceInput,
  queryCatalog,
} from "../src/domain/query.ts";
import {
  makeAbsolutePath,
  makeCatalogEntryId,
  makeHttpUrl,
  makeInstalledPluginId,
  makeMarketplaceId,
  makePluginDirName,
  makePluginName,
} from "../src/domain/types.ts";
import type { AbsolutePath } from "../src/domain/types.ts";
import { createPluginEngine } from "../src/engine/index.ts";

const execFileAsync = promisify(execFile);

const tempRoots: string[] = [];

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  return Object.fromEntries(Object.entries(parsed));
}

async function makeTempWorkspace(): Promise<{
  readonly root: AbsolutePath;
  readonly homeDir: AbsolutePath;
  readonly configDir: AbsolutePath;
  readonly workspaceDir: AbsolutePath;
}> {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "agy-engine-test-"));
  tempRoots.push(raw);
  const root = makeAbsolutePath(raw);
  const homeDir = makeAbsolutePath(path.join(root, "home"));
  const configDir = makeAbsolutePath(path.join(homeDir, ".gemini", "config"));
  const workspaceDir = makeAbsolutePath(path.join(root, "workspace"));
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  return { root, homeDir, configDir, workspaceDir };
}

async function writeText(filePath: string, content: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function runGitTest(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test Author",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout.trim();
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    if (dir !== undefined) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

describe("PluginEngine multi-format marketplaces and pstack-shaped bundle adaptation", () => {
  it("normalizes Antigravity, Claude, Cursor, dual-manifest, and single-plugin marketplaces and adapts BOM, hooks, MCP, skills, agents, and rules", async () => {
    const ws = await makeTempWorkspace();
    const engine = createPluginEngine({
      homeDir: ws.homeDir,
      configDir: ws.configDir,
      workspaceDir: ws.workspaceDir,
    });

    const cursorMktDir = makeAbsolutePath(path.join(ws.root, "cursor-plugins"));
    await writeText(
      path.join(cursorMktDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "cursor-plugins",
        plugins: [{ name: "shim-only", source: "pstack" }],
      }),
    );
    await writeText(
      path.join(cursorMktDir, ".cursor-plugin", "marketplace.json"),
      JSON.stringify({
        name: "cursor-plugins",
        plugins: [
          { name: "pstack", source: "pstack", description: "Rigorous agent workflows" },
          {
            name: "inline-mcp-tool",
            source: "inline-mcp-tool",
            description: "Inline MCP servers plugin",
          },
        ],
      }),
    );

    const pstackSrc = path.join(cursorMktDir, "pstack");
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const rawManifestJsonc = [
      "{",
      "  // Cursor plugin manifest with trailing comma and extra keys",
      '  "name": "pstack",',
      '  "displayName": "PStack Workflows",',
      '  "version": "0.15.46",',
      '  "description": "Parallel agent playbooks",',
      '  "author": { "name": "Lauren Tan", "email": "lauren@example.com" },',
      '  "repository": { "type": "git", "url": "https://github.com/cursor/plugins" },',
      '  "homepage": "https://github.com/cursor/plugins/tree/main/pstack",',
      '  "license": "MIT",',
      '  "keywords": ["workflow", "agents"],',
      '  "category": "developer-tools",',
      '  "strict": true,',
      "}",
    ].join("\n");
    await writeText(
      path.join(pstackSrc, ".cursor-plugin", "Plugin.json"),
      Buffer.concat([bom, Buffer.from(rawManifestJsonc, "utf8")]),
    );
    await writeText(
      path.join(pstackSrc, "skills", "poteto-mode", "SKILL.md"),
      [
        "---",
        "name: poteto-mode",
        "description: Deliberate subagents and verified work.",
        "---",
        "# Poteto Mode",
      ].join("\n"),
    );
    await writeText(
      path.join(pstackSrc, "skills", "fallback-skill", "SKILL.md"),
      "# No frontmatter here\n",
    );
    await writeText(
      path.join(pstackSrc, "agents", "poteto-agent.md"),
      [
        "---",
        "name: poteto-agent",
        "description: Executes focused coding tasks",
        "---",
        "Agent prompt.",
      ].join("\n"),
    );
    await writeText(
      path.join(pstackSrc, "agents.json"),
      JSON.stringify([{ name: "comment-sicko", description: "Reviews code comments" }]),
    );
    await writeText(path.join(pstackSrc, "rules", "AGENTS.md"), "# Always verify work\n");
    await writeText(
      path.join(pstackSrc, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh" }],
            },
          ],
        },
      }),
    );
    await writeText(path.join(pstackSrc, "hooks", "guard.sh"), "#!/bin/sh\nexit 0\n");
    await writeText(
      path.join(pstackSrc, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          pstackTool: {
            command: "node",
            args: ["${CLAUDE_PLUGIN_ROOT}/bin/server.js", "--root", "${PLUGIN_ROOT}"],
          },
        },
      }),
    );

    const inlineSrc = path.join(cursorMktDir, "inline-mcp-tool");
    await writeText(
      path.join(inlineSrc, "plugin.json"),
      JSON.stringify({
        name: "inline-mcp-tool",
        version: "0.1.0",
        mcpServers: {
          embedded: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/srv.js"] },
        },
      }),
    );

    const agyMktDir = makeAbsolutePath(path.join(ws.root, "agy-native"));
    await writeText(
      path.join(agyMktDir, ".antigravity-plugin", "marketplace.json"),
      JSON.stringify({
        plugins: [{ name: "native-helper", source: "native-helper", version: "1.0.0" }],
      }),
    );
    await writeText(
      path.join(agyMktDir, "native-helper", "plugin.json"),
      JSON.stringify({ name: "native-helper", version: "1.0.0" }),
    );

    const claudeMktDir = makeAbsolutePath(path.join(ws.root, "claude-mkt"));
    await writeText(
      path.join(claudeMktDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        plugins: [
          {
            name: "remote-tool",
            description: "Remote git-subdir tool",
            source: {
              source: "git-subdir",
              url: "https://github.com/example/plugins.git",
              path: "plugins/remote-tool",
              ref: "main",
              sha: "abc1234",
            },
          },
        ],
      }),
    );

    const singleDir = makeAbsolutePath(path.join(ws.root, "solo-plugin"));
    await writeText(
      path.join(singleDir, "Plugin.json"),
      JSON.stringify({ name: "solo", version: "0.2.0", description: "Single plugin fallback" }),
    );

    const addCursor = await engine.addMarketplace({
      source: { kind: "local-folder", path: cursorMktDir },
    });
    assert.equal(addCursor.ok, true);
    if (addCursor.ok) {
      assert.equal(addCursor.report.outcome.format, "cursor");
      assert.equal(addCursor.report.outcome.pluginCount, 2);
      const entry = addCursor.snapshot.catalogById.get(
        makeCatalogEntryId(makeMarketplaceId("cursor-plugins"), makePluginDirName("pstack")),
      );
      assert.ok(entry !== undefined);
      assert.equal(entry.version, "0.15.46");
      assert.equal(entry.author, "Lauren Tan");
      assert.deepEqual(entry.componentCounts, {
        skills: 2,
        agents: 2,
        rules: 1,
        hooks: 1,
        mcpServers: 1,
      });
      assert.ok(entry.componentsPreview !== null);
    }

    const addAgy = await engine.addMarketplace({
      source: { kind: "local-folder", path: agyMktDir },
    });
    assert.equal(addAgy.ok && addAgy.report.outcome.format, "antigravity");

    const addClaude = await engine.addMarketplace({
      source: { kind: "local-folder", path: claudeMktDir },
    });
    assert.equal(addClaude.ok && addClaude.report.outcome.format, "claude");

    const addSingle = await engine.addMarketplace({
      source: { kind: "local-folder", path: singleDir },
    });
    assert.equal(addSingle.ok && addSingle.report.outcome.format, "single-plugin");

    const parsedTarget = parseInstallTarget({
      raw: "cursor-plugins/pstack",
      cwd: ws.workspaceDir,
      homeDir: ws.homeDir,
    });
    assert.equal(parsedTarget.ok, true);
    assert.equal(parsedTarget.ok && parsedTarget.value.kind, "catalog-or-github");

    const installed = await engine.install({
      target: parsedTarget.ok
        ? parsedTarget.value
        : { kind: "catalog-name", name: makePluginName("pstack") },
      scope: "user",
    });
    assert.equal(installed.ok, true);
    if (installed.ok) {
      assert.equal(installed.report.outcome, "installed");
      assert.equal(installed.report.adaptedHooks, true);
      assert.equal(installed.report.adaptedMcp, true);
      assert.equal(installed.report.warnings.length, 1);
      assert.equal(installed.report.warnings[0]?.detail.kind, "skill-frontmatter-missing");

      const finalPath = installed.report.installPath;
      const manifestBytes = await fs.readFile(path.join(finalPath, "plugin.json"));
      assert.equal(
        manifestBytes[0] === 0xef && manifestBytes[1] === 0xbb && manifestBytes[2] === 0xbf,
        false,
        "adapted root plugin.json must not retain UTF-8 BOM",
      );
      const manifestObj = parseJsonObject(manifestBytes.toString("utf8"));
      assert.equal(manifestObj.name, "pstack");
      assert.equal(manifestObj.author, "Lauren Tan");
      assert.equal(manifestObj.repository, "https://github.com/cursor/plugins");
      assert.equal("license" in manifestObj, false);
      assert.equal("keywords" in manifestObj, false);
      assert.equal("strict" in manifestObj, false);

      const hooksText = await fs.readFile(path.join(finalPath, "hooks.json"), "utf8");
      const hooksObj = parseJsonObject(hooksText);
      assert.equal("hooks" in hooksObj, false, "hooks wrapper must be unwrapped at root");
      assert.equal(Array.isArray(hooksObj.PreToolUse), true);
      assert.equal(hooksText.includes(finalPath), true);
      assert.equal(hooksText.includes("${CLAUDE_PLUGIN_ROOT}"), false);
      assert.equal(hooksText.includes(".agy-stage-"), false);

      const mcpText = await fs.readFile(path.join(finalPath, "mcp_config.json"), "utf8");
      assert.equal(mcpText.includes(finalPath), true);
      assert.equal(mcpText.includes("${CLAUDE_PLUGIN_ROOT}"), false);
      assert.equal(mcpText.includes("${PLUGIN_ROOT}"), false);
      assert.equal(mcpText.includes(".agy-stage-"), false);

      const pluginRec = installed.snapshot.installedById.get(installed.report.pluginId);
      assert.ok(pluginRec !== undefined && pluginRec.kind === "valid");
      assert.deepEqual(pluginRec.components.counts, {
        skills: 2,
        agents: 2,
        rules: 1,
        hooks: 1,
        mcpServers: 1,
      });
      assert.ok(pluginRec.estimatedDescriptionTokens > 0);
      assert.ok(pluginRec.diskBytes > 0);
    }

    const inlineInstalled = await engine.install({
      target: {
        kind: "catalog-entry",
        entryId: makeCatalogEntryId(
          makeMarketplaceId("cursor-plugins"),
          makePluginDirName("inline-mcp-tool"),
        ),
      },
      scope: "user",
    });
    assert.equal(inlineInstalled.ok, true);
    if (inlineInstalled.ok) {
      assert.equal(inlineInstalled.report.adaptedMcp, true);
      const mcpText = await fs.readFile(
        path.join(inlineInstalled.report.installPath, "mcp_config.json"),
        "utf8",
      );
      assert.equal(mcpText.includes(inlineInstalled.report.installPath), true);
      assert.equal(mcpText.includes("${CLAUDE_PLUGIN_ROOT}"), false);
      const cleanedManifest = parseJsonObject(
        await fs.readFile(path.join(inlineInstalled.report.installPath, "plugin.json"), "utf8"),
      );
      assert.equal("mcpServers" in cleanedManifest, false);
    }

    const manualDir = path.join(ws.configDir, "plugins", "manual-claude");
    await writeText(
      path.join(manualDir, "plugin.json"),
      JSON.stringify({ name: "manual-claude", version: "1.0.0" }),
    );
    await writeText(
      path.join(manualDir, "hooks.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/stop.sh" }] }],
        },
      }),
    );
    await writeText(
      path.join(manualDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "${PLUGIN_ROOT}/mcp" } } }),
    );

    const beforeFix = await engine.snapshot();
    const manualId = makeInstalledPluginId("user", makePluginDirName("manual-claude"));
    const wrappedHooksDiag = beforeFix.diagnostics.find(
      (d) =>
        d.subject.kind === "installed" &&
        d.subject.pluginId === manualId &&
        d.detail.kind === "hooks-invalid",
    );
    assert.ok(wrappedHooksDiag !== undefined);
    assert.equal(wrappedHooksDiag.remediation?.kind, "readapt-bundle");

    assert.ok(wrappedHooksDiag.remediation !== undefined);
    const fixed = await engine.remediate({ plan: wrappedHooksDiag.remediation });
    assert.equal(fixed.ok, true);
    if (fixed.ok && fixed.report.kind === "readapted-bundle") {
      assert.equal(fixed.report.adaptedHooks, true);
      assert.equal(fixed.report.adaptedMcp, true);
      assert.equal(fixed.report.expandedPluginRoot, true);
    }
    const afterFix = await engine.snapshot();
    const remainingUnadapted = afterFix.diagnostics.filter(
      (d) =>
        d.subject.kind === "installed" &&
        d.subject.pluginId === manualId &&
        (d.detail.kind === "hooks-invalid" ||
          d.detail.kind === "unadapted-hooks-path" ||
          d.detail.kind === "unadapted-mcp-path" ||
          d.detail.kind === "unexpanded-plugin-root"),
    );
    assert.equal(remainingUnadapted.length, 0);

    const valInstalled = await engine.validate({
      kind: "installed",
      selector: { kind: "id", id: manualId },
    });
    assert.equal(valInstalled.valid, true);

    const valSource = await engine.validate({
      kind: "source",
      source: { kind: "local-folder", path: singleDir },
    });
    assert.equal(valSource.valid, true);
    assert.equal(valSource.manifest?.name, "solo");

    const valWorkspace = await engine.validate({ kind: "workspace" });
    assert.equal(valWorkspace.valid, true);

    assert.equal(
      await fs
        .stat(path.join(ws.configDir, "config.json"))
        .then(() => true)
        .catch(() => false),
      false,
      "engine must never create config.json when absent",
    );
  });
});

describe("PluginEngine real bare git repo marketplace sync, parallel bulk sync, and update", () => {
  it("clones a local bare git repo, picks up a new commit on sync, updates managed plugins while skipping unmanaged ones, and cleans mirror on remove", async () => {
    const ws = await makeTempWorkspace();
    const bareRepo = makeAbsolutePath(path.join(ws.root, "team-plugins.git"));
    const workRepo = path.join(ws.root, "work-repo");

    await fs.mkdir(bareRepo, { recursive: true });
    await runGitTest(["init", "--bare", "--initial-branch=main"], bareRepo);
    await runGitTest(["clone", bareRepo, workRepo], ws.root);

    await writeText(
      path.join(workRepo, ".antigravity-plugin", "marketplace.json"),
      JSON.stringify({
        plugins: [{ name: "git-helper", source: "git-helper" }],
      }),
    );
    await writeText(
      path.join(workRepo, "git-helper", "plugin.json"),
      JSON.stringify({ name: "git-helper", version: "1.0.0", description: "Initial release" }),
    );
    await runGitTest(["add", "."], workRepo);
    await runGitTest(["commit", "-m", "v1.0.0"], workRepo);
    await runGitTest(["push", "origin", "main"], workRepo);

    const secondMkt = makeAbsolutePath(path.join(ws.root, "second-mkt"));
    await writeText(
      path.join(secondMkt, "marketplace.json"),
      JSON.stringify({ plugins: [{ name: "extra", source: "extra" }] }),
    );
    await writeText(
      path.join(secondMkt, "extra", "plugin.json"),
      JSON.stringify({ name: "extra", version: "0.1.0" }),
    );

    const engine = createPluginEngine({
      homeDir: ws.homeDir,
      configDir: ws.configDir,
      workspaceDir: ws.workspaceDir,
    });

    const mktId = makeMarketplaceId("team-plugins");
    const secondId = makeMarketplaceId("second-mkt");
    const added = await engine.addMarketplace({
      source: { kind: "local-folder", path: bareRepo },
      id: mktId,
    });
    assert.equal(added.ok, true);
    if (added.ok) {
      const mktRec = added.snapshot.marketplacesById.get(mktId);
      assert.ok(mktRec !== undefined && mktRec.localMirrorPath !== null);
      assert.equal(mktRec.sync.kind, "synced");
    }
    const addedSecond = await engine.addMarketplace({
      source: { kind: "local-folder", path: secondMkt },
      id: secondId,
    });
    assert.equal(addedSecond.ok, true);

    const inst = await engine.install({
      target: {
        kind: "catalog-entry",
        entryId: makeCatalogEntryId(mktId, makePluginDirName("git-helper")),
      },
      scope: "user",
    });
    assert.equal(inst.ok, true);

    await writeText(
      path.join(ws.configDir, "plugins", "hand-crafted", "plugin.json"),
      JSON.stringify({ name: "hand-crafted", version: "0.5.0" }),
    );

    await writeText(
      path.join(workRepo, "git-helper", "plugin.json"),
      JSON.stringify({ name: "git-helper", version: "1.1.0", description: "Updated release" }),
    );
    await runGitTest(["add", "."], workRepo);
    await runGitTest(["commit", "-m", "v1.1.0"], workRepo);
    await runGitTest(["push", "origin", "main"], workRepo);

    await fs.rm(secondMkt, { recursive: true, force: true });
    const bulkSync = await engine.syncMarketplaces({ kind: "all" });
    assert.equal(bulkSync.ok, true);
    if (bulkSync.ok) {
      const teamOutcome = bulkSync.report.outcomes.find((o) => o.marketplaceId === mktId);
      const secondOutcome = bulkSync.report.outcomes.find((o) => o.marketplaceId === secondId);
      assert.equal(teamOutcome?.status, "synced");
      assert.equal(secondOutcome?.status, "failed");
      assert.equal(
        bulkSync.snapshot.catalogById.has(
          makeCatalogEntryId(secondId, makePluginDirName("extra")),
        ),
        true,
        "failed marketplace preserves last good catalog entries",
      );
      const plugin = bulkSync.snapshot.installedById.get(
        makeInstalledPluginId("user", makePluginDirName("git-helper")),
      );
      assert.ok(plugin !== undefined && plugin.kind === "valid");
      assert.equal(plugin.updateAvailable?.latestVersion, "1.1.0");
    }

    const updatedAll = await engine.update({ kind: "all", scope: "user" });
    assert.equal(updatedAll.ok, true);
    if (updatedAll.ok) {
      const gitOutcome = updatedAll.report.outcomes.find(
        (o) => o.pluginId === makeInstalledPluginId("user", makePluginDirName("git-helper")),
      );
      const unmanagedOutcome = updatedAll.report.outcomes.find(
        (o) => o.pluginId === makeInstalledPluginId("user", makePluginDirName("hand-crafted")),
      );
      assert.equal(gitOutcome?.status, "updated");
      assert.equal(gitOutcome?.fromVersion, "1.0.0");
      assert.equal(gitOutcome?.toVersion, "1.1.0");
      assert.equal(unmanagedOutcome?.status, "skipped-unmanaged");
    }

    const secondUpdate = await engine.update({
      kind: "single",
      selector: { kind: "id", id: makeInstalledPluginId("user", makePluginDirName("git-helper")) },
    });
    assert.equal(secondUpdate.ok, true);
    if (secondUpdate.ok) {
      assert.equal(secondUpdate.report.outcomes[0]?.status, "unchanged");
    }

    const removed = await engine.removeMarketplace({ id: mktId });
    assert.equal(removed.ok, true);
    if (removed.ok) {
      assert.equal(removed.report.removedMirror, true);
      assert.equal(
        removed.snapshot.installedById.has(
          makeInstalledPluginId("user", makePluginDirName("git-helper")),
        ),
        true,
      );
    }
    const bareStillExists = await fs
      .stat(bareRepo)
      .then((s) => s.isDirectory())
      .catch(() => false);
    assert.equal(bareStillExists, true);
  });
});

describe("PluginEngine real HTTP JSON marketplace and failure resilience", () => {
  it("resolves https-auto to https-json, syncs from local HTTP server, preserves last good catalog on failure, and recovers on retry", async () => {
    const ws = await makeTempWorkspace();
    let failServer = false;

    const server = http.createServer((_req, res) => {
      if (failServer) {
        res.statusCode = 500;
        res.end("server error");
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          plugins: [
            {
              name: "http-plugin",
              version: "2.0.0",
              description: "Served over local HTTP",
              source: {
                source: "url",
                url: "https://github.com/example/http-plugin.git",
              },
            },
          ],
        }),
      );
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    try {
      const addr = server.address();
      assert.ok(addr !== null && typeof addr !== "string");
      const url = makeHttpUrl(`http://127.0.0.1:${addr.port}/catalog`);

      const engine = createPluginEngine({
        homeDir: ws.homeDir,
        configDir: ws.configDir,
        workspaceDir: ws.workspaceDir,
        networkTimeoutMs: 5_000,
      });

      const parsed = parseMarketplaceInput({
        raw: url,
        cwd: ws.workspaceDir,
        homeDir: ws.homeDir,
      });
      assert.equal(parsed.ok, true);
      assert.equal(parsed.ok && parsed.value.kind, "https-auto");

      const mktId = makeMarketplaceId("local-http");
      const added = await engine.addMarketplace({
        source: parsed.ok ? parsed.value : { kind: "https-json", url },
        id: mktId,
      });
      assert.equal(added.ok, true);
      if (added.ok) {
        const record = added.snapshot.marketplacesById.get(mktId);
        assert.equal(record?.source.kind, "https-json");
        assert.equal(added.snapshot.catalog.length, 1);
      }

      failServer = true;
      const failedSync = await engine.syncMarketplaces({ kind: "single", id: mktId });
      assert.equal(failedSync.ok, false);
      if (!failedSync.ok) {
        assert.equal(failedSync.error.kind, "marketplace-sync-failed");
        const record = failedSync.snapshot.marketplacesById.get(mktId);
        assert.equal(record?.sync.kind, "sync-failed");
        if (record?.sync.kind === "sync-failed") {
          assert.ok(record.sync.lastGoodSyncAt !== null);
        }
        assert.equal(failedSync.snapshot.catalog.length, 1);
        const failDiag = failedSync.snapshot.diagnostics.find(
          (d) => d.detail.kind === "marketplace-sync-failed",
        );
        assert.ok(failDiag !== undefined && failDiag.remediation !== undefined);
        assert.equal(failDiag.remediation.kind, "retry-marketplace-sync");

        failServer = false;
        const retried = await engine.remediate({ plan: failDiag.remediation });
        assert.equal(retried.ok, true);
        if (retried.ok && retried.report.kind === "retried-marketplace-sync") {
          assert.equal(retried.report.outcome.status, "synced");
          assert.equal(retried.snapshot.marketplacesById.get(mktId)?.sync.kind, "synced");
        }
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("PluginEngine large Claude plugin-directory-cache-v2.json ingestion", () => {
  it("ingests 3,800 directory listings with deterministic collision suffixes for duplicate spaced titles", async () => {
    const ws = await makeTempWorkspace();
    const listings: Record<string, unknown>[] = [
      {
        id: "plugin_dup_1",
        name: "Small Business",
        summary: "First Small Business toolkit",
        release: { version: "1.0.0" },
        publisher: { name: "Acme" },
        links: { documentation: "https://example.com/sb-1" },
        source: {
          type: "directory",
          repository: {
            url: "https://github.com/acme/sb-1",
            reviewed_commit: "1111111111111111111111111111111111111111",
          },
        },
      },
      {
        id: "plugin_dup_2",
        name: "Small Business",
        summary: "Second Small Business toolkit",
        release: { version: "2.0.0" },
        source: {
          type: "directory",
          repository: {
            url: "https://github.com/other/sb-2",
            path: "plugins/small-business",
            reviewed_commit: "2222222222222222222222222222222222222222",
          },
        },
      },
      {
        id: "plugin_dup_3",
        name: "Small  Business!",
        summary: "Third colliding slug",
        release: { version: "3.0.0" },
        source: {
          type: "directory",
          repository: { url: "https://github.com/third/sb-3" },
        },
      },
    ];
    for (let i = 0; i < 3797; i += 1) {
      listings.push({
        id: `plugin_${i}`,
        name: `Catalog Item ${i}`,
        summary: `Automation plugin number ${i}`,
        release: { version: "1.0.0" },
        source: {
          type: "directory",
          repository: { url: `https://github.com/org/repo-${i}` },
        },
      });
    }

    const cacheFile = makeAbsolutePath(path.join(ws.root, "plugin-directory-cache-v2.json"));
    await writeText(
      cacheFile,
      JSON.stringify({ schemaVersion: 2, fetchedAt: "2026-11-20T00:00:00.000Z", listings }),
    );

    const engine = createPluginEngine({
      homeDir: ws.homeDir,
      configDir: ws.configDir,
      workspaceDir: ws.workspaceDir,
    });
    const mktId = makeMarketplaceId("claude-dir");
    const added = await engine.addMarketplace({
      source: { kind: "local-json", path: cacheFile },
      id: mktId,
    });
    assert.equal(added.ok, true);
    if (added.ok) {
      assert.equal(added.snapshot.catalog.length, 3800);
      assert.equal(added.report.outcome.format, "claude");

      const first = added.snapshot.catalogById.get(
        makeCatalogEntryId(mktId, makePluginDirName("small-business")),
      );
      const second = added.snapshot.catalogById.get(
        makeCatalogEntryId(mktId, makePluginDirName("small-business-2")),
      );
      const third = added.snapshot.catalogById.get(
        makeCatalogEntryId(mktId, makePluginDirName("small-business-3")),
      );
      assert.ok(first !== undefined && second !== undefined && third !== undefined);
      assert.equal(first.author, "Acme");
      assert.equal(first.installSource.kind, "git-repo");
      assert.equal(second.installSource.kind, "git-subdir");

      const matches = queryCatalog(added.snapshot, { text: "small business" });
      assert.equal(matches.length, 3);
    }
  });
});

describe("PluginEngine security: symlink escape, traversal rejection, and overwrite guard", () => {
  it("rejects symlink escapes and ../ paths leaving existing installs untouched and staging clean", async () => {
    const ws = await makeTempWorkspace();
    const engine = createPluginEngine({
      homeDir: ws.homeDir,
      configDir: ws.configDir,
      workspaceDir: ws.workspaceDir,
    });

    const outsideSecret = path.join(ws.root, "outside-secret.txt");
    await writeText(outsideSecret, "TOP SECRET");

    const goodSrc = makeAbsolutePath(path.join(ws.root, "good-src"));
    await writeText(
      path.join(goodSrc, "plugin.json"),
      JSON.stringify({ name: "safe-plugin", version: "1.0.0" }),
    );
    const firstInstall = await engine.install({
      target: { kind: "direct-source", source: { kind: "local-folder", path: goodSrc } },
      scope: "user",
    });
    assert.equal(firstInstall.ok, true);

    const evilSrc = makeAbsolutePath(path.join(ws.root, "evil-src"));
    await writeText(
      path.join(evilSrc, "plugin.json"),
      JSON.stringify({ name: "safe-plugin", version: "9.9.9" }),
    );
    await fs.symlink(outsideSecret, path.join(evilSrc, "stolen.txt"));

    const evilAttempt = await engine.install({
      target: { kind: "direct-source", source: { kind: "local-folder", path: evilSrc } },
      scope: "user",
      dirName: makePluginDirName("safe-plugin"),
      allowNameCollision: true,
    });
    assert.equal(evilAttempt.ok, false);
    if (!evilAttempt.ok) {
      assert.equal(evilAttempt.error.kind, "path-traversal");
      assert.equal(evilAttempt.snapshot.staleStagingPaths.length, 0);
      const existing = evilAttempt.snapshot.installedById.get(
        makeInstalledPluginId("user", makePluginDirName("safe-plugin")),
      );
      assert.ok(existing !== undefined && existing.kind === "valid");
      assert.equal(existing.manifest.version, "1.0.0");
    }

    const differentSrc = makeAbsolutePath(path.join(ws.root, "different-src"));
    await writeText(
      path.join(differentSrc, "plugin.json"),
      JSON.stringify({ name: "other-plugin", version: "1.0.0" }),
    );
    const overwriteBlocked = await engine.install({
      target: { kind: "direct-source", source: { kind: "local-folder", path: differentSrc } },
      scope: "user",
      dirName: makePluginDirName("safe-plugin"),
    });
    assert.equal(overwriteBlocked.ok, false);
    if (!overwriteBlocked.ok) {
      assert.equal(overwriteBlocked.error.kind, "name-collision");
    }

    const travMkt = makeAbsolutePath(path.join(ws.root, "trav-mkt"));
    await writeText(
      path.join(travMkt, "marketplace.json"),
      JSON.stringify({
        plugins: [{ name: "escape", source: "../../outside-secret" }],
      }),
    );
    const addedTrav = await engine.addMarketplace({
      source: { kind: "local-folder", path: travMkt },
    });
    assert.equal(addedTrav.ok, true);
    if (addedTrav.ok) {
      assert.equal(addedTrav.snapshot.catalog.length, 0);
      assert.ok(
        addedTrav.snapshot.diagnostics.some((d) => d.detail.kind === "marketplace-manifest-invalid"),
      );
    }

    const unsafePluginDir = path.join(ws.configDir, "plugins", "tainted");
    await writeText(
      path.join(unsafePluginDir, "plugin.json"),
      JSON.stringify({ name: "tainted", version: "1.0.0" }),
    );
    await fs.symlink(outsideSecret, path.join(unsafePluginDir, "escape.txt"));

    const taintedSnap = await engine.snapshot();
    const taintedId = makeInstalledPluginId("user", makePluginDirName("tainted"));
    assert.equal(taintedSnap.installedById.get(taintedId)?.kind, "broken");
    const travDiag = taintedSnap.diagnostics.find(
      (d) =>
        d.subject.kind === "installed" &&
        d.subject.pluginId === taintedId &&
        d.detail.kind === "path-traversal-rejected",
    );
    assert.ok(travDiag !== undefined && travDiag.remediation !== undefined);
    assert.equal(travDiag.remediation.kind, "remove-plugin");
    const cleaned = await engine.remediate({ plan: travDiag.remediation });
    assert.equal(cleaned.ok, true);
    assert.equal(cleaned.snapshot.installedById.has(taintedId), false);
  });
});

describe("PluginEngine global PluginName collisions and precedence", () => {
  it("enforces project > user and alphabetical within-scope precedence, blocks colliding installs by default, and resolves via remediate(disable-plugin)", async () => {
    const ws = await makeTempWorkspace();
    const engine = createPluginEngine({
      homeDir: ws.homeDir,
      configDir: ws.configDir,
      workspaceDir: ws.workspaceDir,
    });

    const userSrc = makeAbsolutePath(path.join(ws.root, "dup-user"));
    await writeText(
      path.join(userSrc, "plugin.json"),
      JSON.stringify({ name: "shared-name", version: "1.0.0" }),
    );
    const projSrc = makeAbsolutePath(path.join(ws.root, "dup-proj"));
    await writeText(
      path.join(projSrc, "plugin.json"),
      JSON.stringify({ name: "shared-name", version: "2.0.0" }),
    );

    const r1 = await engine.install({
      target: { kind: "direct-source", source: { kind: "local-folder", path: userSrc } },
      scope: "user",
      dirName: makePluginDirName("shared-name"),
    });
    assert.equal(r1.ok, true);

    const blocked = await engine.install({
      target: { kind: "direct-source", source: { kind: "local-folder", path: projSrc } },
      scope: "project",
      dirName: makePluginDirName("shared-name"),
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.error.kind, "name-collision");
      if (blocked.error.kind === "name-collision") {
        assert.equal(blocked.error.existingId, "user:shared-name");
        assert.equal(blocked.error.targetScope, "project");
      }
    }

    const forced = await engine.install({
      target: { kind: "direct-source", source: { kind: "local-folder", path: projSrc } },
      scope: "project",
      dirName: makePluginDirName("shared-name"),
      allowNameCollision: true,
    });
    assert.equal(forced.ok, true);
    if (forced.ok) {
      const projRec = forced.snapshot.installedById.get(
        makeInstalledPluginId("project", makePluginDirName("shared-name")),
      );
      const userRec = forced.snapshot.installedById.get(
        makeInstalledPluginId("user", makePluginDirName("shared-name")),
      );
      assert.ok(projRec !== undefined && projRec.kind === "valid");
      assert.ok(userRec !== undefined && userRec.kind === "valid");
      assert.deepEqual(projRec.activation, { kind: "active" });
      assert.deepEqual(userRec.activation, {
        kind: "shadowed",
        shadowedBy: makeInstalledPluginId("project", makePluginDirName("shared-name")),
      });

      const collisionDiag = forced.snapshot.diagnostics.find(
        (d) => d.detail.kind === "name-collision",
      );
      assert.ok(collisionDiag !== undefined && collisionDiag.remediation !== undefined);
      assert.equal(collisionDiag.severity, "error");
      assert.equal(collisionDiag.remediation.kind, "disable-plugin");

      const resolved = await engine.remediate({ plan: collisionDiag.remediation });
      assert.equal(resolved.ok, true);
      if (resolved.ok) {
        assert.equal(
          resolved.snapshot.diagnostics.some((d) => d.detail.kind === "name-collision"),
          false,
        );
        const disabledUser = resolved.snapshot.installedById.get(
          makeInstalledPluginId("user", makePluginDirName("shared-name")),
        );
        assert.ok(disabledUser !== undefined && disabledUser.kind === "valid");
        assert.deepEqual(disabledUser.activation, { kind: "disabled" });
      }
    }

    await writeText(
      path.join(ws.configDir, "plugins", "zeta-dir", "plugin.json"),
      JSON.stringify({ name: "tie-name", version: "1.0.0" }),
    );
    await writeText(
      path.join(ws.configDir, "plugins", "alpha-dir", "plugin.json"),
      JSON.stringify({ name: "tie-name", version: "1.0.0" }),
    );
    const tieSnap = await engine.snapshot();
    const alphaRec = tieSnap.installedById.get(
      makeInstalledPluginId("user", makePluginDirName("alpha-dir")),
    );
    const zetaRec = tieSnap.installedById.get(
      makeInstalledPluginId("user", makePluginDirName("zeta-dir")),
    );
    assert.ok(alphaRec !== undefined && alphaRec.kind === "valid");
    assert.ok(zetaRec !== undefined && zetaRec.kind === "valid");
    assert.deepEqual(alphaRec.activation, { kind: "active" });
    assert.deepEqual(zetaRec.activation, {
      kind: "shadowed",
      shadowedBy: makeInstalledPluginId("user", makePluginDirName("alpha-dir")),
    });
  });
});

describe("PluginEngine read-only snapshot purity, crash recovery, JSONC errors, and config.json isolation", () => {
  it("keeps snapshot() strictly read-only, recovers backups on clean-stale-staging, reclaims dead locks, and never writes config.json", async () => {
    const ws = await makeTempWorkspace();

    const configJsonPath = path.join(ws.configDir, "config.json");
    const sentinelBody = JSON.stringify({ theme: "dark", sentinel: true }, null, 2);
    await writeText(configJsonPath, sentinelBody);
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    await fs.utimes(configJsonPath, oldTime, oldTime);
    const initialStat = await fs.stat(configJsonPath);

    const userPluginsDir = path.join(ws.configDir, "plugins");
    const staleStage = makeAbsolutePath(path.join(userPluginsDir, ".agy-stage-demo-abcdef123456"));
    const staleBackup = makeAbsolutePath(
      path.join(userPluginsDir, ".agy-backup-recovered-abcdef123456"),
    );
    await writeText(path.join(staleStage, "partial.txt"), "incomplete");
    await writeText(
      path.join(staleBackup, "plugin.json"),
      JSON.stringify({ name: "recovered", version: "1.0.0" }),
    );

    const brokenDir = path.join(userPluginsDir, "syntax-bad");
    const badJson = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{\n  "name": "syntax-bad",\n  "version": "1.0.0",\n  "broken": \n}\n', "utf8"),
    ]);
    await writeText(path.join(brokenDir, "plugin.json"), badJson);

    const engine = createPluginEngine({
      homeDir: ws.homeDir,
      configDir: ws.configDir,
      workspaceDir: ws.workspaceDir,
    });

    const snap1 = await engine.snapshot();
    const snap2 = await engine.snapshot();
    assert.ok(snap2.revision > snap1.revision);

    assert.equal(snap1.staleStagingPaths.length, 2);
    assert.equal(await fs.stat(staleStage).then(() => true).catch(() => false), true);
    assert.equal(await fs.stat(staleBackup).then(() => true).catch(() => false), true);
    assert.equal(
      await fs
        .stat(path.join(ws.configDir, "plugin-manager", "catalog-cache.json"))
        .then(() => true)
        .catch(() => false),
      false,
      "snapshot() must not write derived catalog-cache.json",
    );

    const syntaxDiag = snap1.diagnostics.find((d) => d.detail.kind === "manifest-json-syntax");
    assert.ok(syntaxDiag !== undefined && syntaxDiag.detail.kind === "manifest-json-syntax");
    assert.equal(syntaxDiag.detail.hadUtf8Bom, true);
    assert.equal(syntaxDiag.detail.line, 5);
    assert.equal(syntaxDiag.detail.column, 1);

    const cleaned = await engine.remediate({
      plan: { kind: "clean-stale-staging", label: "Clean all stale artifacts" },
    });
    assert.equal(cleaned.ok, true);
    if (cleaned.ok && cleaned.report.kind === "cleaned-stale-staging") {
      assert.equal(cleaned.report.removedPaths.length, 2);
      assert.equal(cleaned.snapshot.staleStagingPaths.length, 0);
      assert.equal(await fs.stat(staleStage).then(() => true).catch(() => false), false);
      assert.equal(await fs.stat(staleBackup).then(() => true).catch(() => false), false);
      assert.equal(
        cleaned.snapshot.installedById.has(
          makeInstalledPluginId("user", makePluginDirName("recovered")),
        ),
        true,
        "missing plugin directory must be restored from backup",
      );
    }

    const deadLockPath = path.join(userPluginsDir, ".agy-lock-recovered");
    await writeText(deadLockPath, JSON.stringify({ pid: 999_999_999, createdAt: Date.now() }));
    const disabled = await engine.setEnabled({
      selector: { kind: "id", id: makeInstalledPluginId("user", makePluginDirName("recovered")) },
      enabled: false,
    });
    assert.equal(disabled.ok, true);
    if (disabled.ok) {
      assert.equal(disabled.report.outcome, "changed");
      assert.equal(disabled.report.enabled, false);
    }

    const mktDir = makeAbsolutePath(path.join(ws.root, "orphan-mkt"));
    await writeText(
      path.join(mktDir, "marketplace.json"),
      JSON.stringify({ plugins: [{ name: "ephemeral", source: "ephemeral" }] }),
    );
    await writeText(
      path.join(mktDir, "ephemeral", "plugin.json"),
      JSON.stringify({ name: "ephemeral", version: "1.0.0" }),
    );
    await engine.addMarketplace({ source: { kind: "local-folder", path: mktDir } });
    const instEph = await engine.install({
      target: { kind: "catalog-name", name: makePluginName("ephemeral") },
      scope: "user",
    });
    assert.equal(instEph.ok, true);
    if (instEph.ok) {
      await fs.rm(instEph.report.installPath, { recursive: true, force: true });
      const orphanSnap = await engine.snapshot();
      const orphanDiag = orphanSnap.diagnostics.find((d) => d.detail.kind === "orphaned-receipt");
      assert.ok(orphanDiag !== undefined);
      const cleanedOrphan = await engine.uninstall({
        selector: { kind: "id", id: instEph.report.pluginId },
      });
      assert.equal(cleanedOrphan.ok, true);
      if (cleanedOrphan.ok) {
        assert.equal(cleanedOrphan.report.outcome, "cleaned-orphan-receipt");
      }
    }

    const afterStat = await fs.stat(configJsonPath);
    const afterBody = await fs.readFile(configJsonPath, "utf8");
    assert.equal(afterBody, sentinelBody);
    assert.equal(afterStat.mtimeMs, initialStat.mtimeMs);
  });
});

describe("PluginEngine adversarial regression coverage (Round A)", () => {
  it("catches dangling symlink escapes behind deeper dir symlinks while copying valid sibling dir symlinks cleanly", async () => {
    const ws = await makeTempWorkspace();
    const engine = createPluginEngine({
      homeDir: ws.homeDir,
      configDir: ws.configDir,
      workspaceDir: ws.workspaceDir,
    });

    const escapeBundle = makeAbsolutePath(path.join(ws.root, "nested-escape-bundle"));
    await writeText(
      path.join(escapeBundle, "plugin.json"),
      JSON.stringify({ name: "nested-escape", version: "1.0.0" }),
    );
    await fs.mkdir(path.join(escapeBundle, "real"), { recursive: true });
    await fs.symlink("../../outside-nonexistent", path.join(escapeBundle, "real", "dangling"));
    await fs.mkdir(path.join(escapeBundle, "deep", "nested"), { recursive: true });
    await fs.symlink("../../real", path.join(escapeBundle, "deep", "nested", "alias"));

    const validation = await engine.validate({
      kind: "source",
      source: { kind: "local-folder", path: escapeBundle },
    });
    assert.equal(validation.valid, false);
    assert.ok(
      validation.diagnostics.some((d) => d.detail.kind === "path-traversal-rejected"),
      "inspector must catch dangling escape inside dir reached via deeper symlink",
    );

    const installEsc = await engine.install({
      target: { kind: "direct-source", source: { kind: "local-folder", path: escapeBundle } },
      scope: "user",
    });
    assert.equal(installEsc.ok, false);
    if (!installEsc.ok) {
      assert.equal(installEsc.error.kind, "path-traversal");
    }

    const validSymlinkBundle = makeAbsolutePath(path.join(ws.root, "valid-symlink-bundle"));
    await writeText(
      path.join(validSymlinkBundle, "plugin.json"),
      JSON.stringify({ name: "symlink-skills", version: "1.0.0" }),
    );
    await writeText(
      path.join(validSymlinkBundle, "a-src", "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Linked skill\n---\n# Demo\n",
    );
    await fs.symlink("a-src/skills", path.join(validSymlinkBundle, "skills"));
    await fs.mkdir(path.join(validSymlinkBundle, "sub"), { recursive: true });
    await fs.symlink("..", path.join(validSymlinkBundle, "sub", "loop"));

    const installOk = await engine.install({
      target: {
        kind: "direct-source",
        source: { kind: "local-folder", path: validSymlinkBundle },
      },
      scope: "user",
    });
    assert.equal(installOk.ok, true);
    if (installOk.ok) {
      const copiedSkill = await fs.readFile(
        path.join(installOk.report.installPath, "skills", "demo", "SKILL.md"),
        "utf8",
      );
      assert.match(copiedSkill, /Linked skill/);
      const installed = installOk.snapshot.installedById.get(installOk.report.pluginId);
      assert.ok(installed !== undefined && installed.kind === "valid");
      assert.equal(installed.components.counts.skills, 1);
    }
  });

  it("rejects symlinked marketplace.json and plugin.json escaping the marketplace root without reading external files", async () => {
    const ws = await makeTempWorkspace();
    const engine = createPluginEngine({
      homeDir: ws.homeDir,
      configDir: ws.configDir,
      workspaceDir: ws.workspaceDir,
    });

    const externalCatalog = path.join(ws.root, "external-marketplace.json");
    await writeText(
      externalCatalog,
      JSON.stringify({ plugins: [{ name: "leaked", source: "leaked" }] }),
    );
    const externalPluginManifest = path.join(ws.root, "external-plugin.json");
    await writeText(
      externalPluginManifest,
      JSON.stringify({ name: "leaked-plugin", version: "9.9.9", description: "SECRET_BODY" }),
    );

    const symlinkMktDir = makeAbsolutePath(path.join(ws.root, "symlink-mkt"));
    await fs.mkdir(symlinkMktDir, { recursive: true });
    await fs.symlink(externalCatalog, path.join(symlinkMktDir, "marketplace.json"));

    const addSymMkt = await engine.addMarketplace({
      source: { kind: "local-folder", path: symlinkMktDir },
      id: makeMarketplaceId("sym-mkt"),
    });
    assert.equal(addSymMkt.ok, false);
    assert.equal(addSymMkt.snapshot.catalog.length, 0);
    assert.ok(
      addSymMkt.snapshot.diagnostics.some((d) => d.detail.kind === "path-traversal-rejected"),
    );

    const symlinkSingleDir = makeAbsolutePath(path.join(ws.root, "symlink-single"));
    await fs.mkdir(symlinkSingleDir, { recursive: true });
    await fs.symlink(externalPluginManifest, path.join(symlinkSingleDir, "plugin.json"));

    const addSymSingle = await engine.addMarketplace({
      source: { kind: "local-folder", path: symlinkSingleDir },
      id: makeMarketplaceId("sym-single"),
    });
    assert.equal(addSymSingle.ok, false);
    assert.equal(addSymSingle.snapshot.catalog.length, 0);
    assert.ok(
      addSymSingle.snapshot.diagnostics.some(
        (d) =>
          d.subject.kind === "marketplace" &&
          d.subject.marketplaceId === "sym-single" &&
          d.detail.kind === "path-traversal-rejected",
      ),
    );

    const subdirEscapeMkt = makeAbsolutePath(path.join(ws.root, "subdir-escape-mkt"));
    await writeText(
      path.join(subdirEscapeMkt, "marketplace.json"),
      JSON.stringify({ plugins: [{ name: "sneaky", source: "sneaky" }] }),
    );
    await fs.mkdir(path.join(subdirEscapeMkt, "sneaky"), { recursive: true });
    await fs.symlink(externalPluginManifest, path.join(subdirEscapeMkt, "sneaky", "plugin.json"));

    const addSubEscape = await engine.addMarketplace({
      source: { kind: "local-folder", path: subdirEscapeMkt },
      id: makeMarketplaceId("sub-escape"),
    });
    assert.equal(addSubEscape.ok, true);
    assert.equal(
      addSubEscape.snapshot.catalog.some((e) => e.marketplaceId === "sub-escape"),
      false,
    );
    assert.ok(
      addSubEscape.snapshot.diagnostics.some(
        (d) =>
          d.subject.kind === "marketplace" &&
          d.subject.marketplaceId === "sub-escape" &&
          d.detail.kind === "path-traversal-rejected",
      ),
    );
  });

  it("preserves custom plugin.json fields during setEnabled and rejects escaping symlinked plugin.json", async () => {
    const ws = await makeTempWorkspace();
    const engine = createPluginEngine({
      homeDir: ws.homeDir,
      configDir: ws.configDir,
      workspaceDir: ws.workspaceDir,
    });

    const pluginDir = path.join(ws.configDir, "plugins", "rich-manifest");
    await writeText(
      path.join(pluginDir, "plugin.json"),
      JSON.stringify(
        {
          name: "rich-manifest",
          version: "1.0.0",
          license: "Apache-2.0",
          keywords: ["custom", "keep"],
          author: { name: "Ada Lovelace", email: "ada@example.com" },
          customNested: { flag: true },
        },
        null,
        2,
      ),
    );

    const richId = makeInstalledPluginId("user", makePluginDirName("rich-manifest"));
    const disabled = await engine.setEnabled({
      selector: { kind: "id", id: richId },
      enabled: false,
    });
    assert.equal(disabled.ok, true);
    const disabledObj = parseJsonObject(await fs.readFile(path.join(pluginDir, "plugin.json"), "utf8"));
    assert.equal(disabledObj.disabled, true);
    assert.equal(disabledObj.license, "Apache-2.0");
    assert.deepEqual(disabledObj.keywords, ["custom", "keep"]);
    assert.deepEqual(disabledObj.author, { name: "Ada Lovelace", email: "ada@example.com" });
    assert.deepEqual(disabledObj.customNested, { flag: true });

    const reenabled = await engine.setEnabled({
      selector: { kind: "id", id: richId },
      enabled: true,
    });
    assert.equal(reenabled.ok, true);
    const enabledObj = parseJsonObject(await fs.readFile(path.join(pluginDir, "plugin.json"), "utf8"));
    assert.equal("disabled" in enabledObj, false);
    assert.equal(enabledObj.license, "Apache-2.0");
    assert.deepEqual(enabledObj.author, { name: "Ada Lovelace", email: "ada@example.com" });

    const externalTarget = path.join(ws.root, "external-target.json");
    const externalOriginal = JSON.stringify({ name: "escaped", version: "1.0.0" });
    await writeText(externalTarget, externalOriginal);
    const symPluginDir = path.join(ws.configDir, "plugins", "sym-toggle");
    await fs.mkdir(symPluginDir, { recursive: true });
    await fs.symlink(externalTarget, path.join(symPluginDir, "plugin.json"));

    const toggleEscape = await engine.setEnabled({
      selector: { kind: "id", id: makeInstalledPluginId("user", makePluginDirName("sym-toggle")) },
      enabled: false,
    });
    assert.equal(toggleEscape.ok, false);
    if (!toggleEscape.ok) {
      assert.equal(toggleEscape.error.kind, "path-traversal");
    }
    assert.equal(await fs.readFile(externalTarget, "utf8"), externalOriginal);
  });

  it("isolates per-plugin staging cleanup during concurrent installs and skips live-locked staging during remediation", async () => {
    const ws = await makeTempWorkspace();
    const engine = createPluginEngine({
      homeDir: ws.homeDir,
      configDir: ws.configDir,
      workspaceDir: ws.workspaceDir,
    });

    const userPluginsDir = path.join(ws.configDir, "plugins");
    const activeOtherStage = makeAbsolutePath(
      path.join(userPluginsDir, ".agy-stage-other-plugin-abcdef123456"),
    );
    await writeText(path.join(activeOtherStage, "marker.txt"), "in-flight");

    const srcA = makeAbsolutePath(path.join(ws.root, "conc-a"));
    const srcB = makeAbsolutePath(path.join(ws.root, "conc-b"));
    const srcC = makeAbsolutePath(path.join(ws.root, "conc-c"));
    await writeText(path.join(srcA, "plugin.json"), JSON.stringify({ name: "conc-a", version: "1.0.0" }));
    await writeText(path.join(srcB, "plugin.json"), JSON.stringify({ name: "conc-b", version: "1.0.0" }));
    await writeText(path.join(srcC, "plugin.json"), JSON.stringify({ name: "conc-c", version: "1.0.0" }));

    const results = await Promise.all([
      engine.install({
        target: { kind: "direct-source", source: { kind: "local-folder", path: srcA } },
        scope: "user",
      }),
      engine.install({
        target: { kind: "direct-source", source: { kind: "local-folder", path: srcB } },
        scope: "user",
      }),
      engine.install({
        target: { kind: "direct-source", source: { kind: "local-folder", path: srcC } },
        scope: "user",
      }),
    ]);
    assert.ok(results.every((r) => r.ok));
    assert.equal(
      await fs
        .stat(activeOtherStage)
        .then(() => true)
        .catch(() => false),
      true,
      "installing other plugins must not delete an unrelated staging directory",
    );

    const abandonedStage = makeAbsolutePath(
      path.join(userPluginsDir, ".agy-stage-abandoned-abcdef123456"),
    );
    await writeText(path.join(abandonedStage, "stale.txt"), "old");
    await writeText(
      path.join(userPluginsDir, ".agy-lock-other-plugin"),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
    );

    const cleaned = await engine.remediate({
      plan: { kind: "clean-stale-staging", label: "Clean stale staging" },
    });
    assert.equal(cleaned.ok, true);
    assert.equal(
      await fs
        .stat(abandonedStage)
        .then(() => true)
        .catch(() => false),
      false,
    );
    assert.equal(
      await fs
        .stat(activeOtherStage)
        .then(() => true)
        .catch(() => false),
      true,
      "remediation must skip staging directories whose lock is held by a live PID",
    );
  });

  it("preserves disabled state across engine.update() so resolved collisions stay disabled", async () => {
    const ws = await makeTempWorkspace();
    const bareRepo = makeAbsolutePath(path.join(ws.root, "disabled-upd.git"));
    const workRepo = path.join(ws.root, "disabled-upd-work");
    await fs.mkdir(bareRepo, { recursive: true });
    await runGitTest(["init", "--bare", "--initial-branch=main"], bareRepo);
    await runGitTest(["clone", bareRepo, workRepo], ws.root);

    await writeText(
      path.join(workRepo, "marketplace.json"),
      JSON.stringify({ plugins: [{ name: "shared-upd", source: "shared-upd" }] }),
    );
    await writeText(
      path.join(workRepo, "shared-upd", "plugin.json"),
      JSON.stringify({ name: "shared-upd", version: "1.0.0" }),
    );
    await runGitTest(["add", "."], workRepo);
    await runGitTest(["commit", "-m", "v1.0.0"], workRepo);
    await runGitTest(["push", "origin", "main"], workRepo);

    const engine = createPluginEngine({
      homeDir: ws.homeDir,
      configDir: ws.configDir,
      workspaceDir: ws.workspaceDir,
    });
    const mktId = makeMarketplaceId("disabled-upd");
    await engine.addMarketplace({ source: { kind: "local-folder", path: bareRepo }, id: mktId });

    const entryTarget = {
      kind: "catalog-entry" as const,
      entryId: makeCatalogEntryId(mktId, makePluginDirName("shared-upd")),
    };
    const instUser = await engine.install({ target: entryTarget, scope: "user" });
    assert.equal(instUser.ok, true);
    const instProj = await engine.install({
      target: entryTarget,
      scope: "project",
      allowNameCollision: true,
    });
    assert.equal(instProj.ok, true);

    const userId = makeInstalledPluginId("user", makePluginDirName("shared-upd"));
    const disabled = await engine.setEnabled({
      selector: { kind: "id", id: userId },
      enabled: false,
    });
    assert.equal(disabled.ok, true);

    await writeText(
      path.join(workRepo, "shared-upd", "plugin.json"),
      JSON.stringify({ name: "shared-upd", version: "1.1.0" }),
    );
    await runGitTest(["add", "."], workRepo);
    await runGitTest(["commit", "-m", "v1.1.0"], workRepo);
    await runGitTest(["push", "origin", "main"], workRepo);

    const updated = await engine.update({ kind: "all" });
    assert.equal(updated.ok, true);
    if (updated.ok) {
      const userOutcome = updated.report.outcomes.find((o) => o.pluginId === userId);
      assert.equal(userOutcome?.status, "updated");
      assert.equal(userOutcome?.toVersion, "1.1.0");
      const userRec = updated.snapshot.installedById.get(userId);
      assert.ok(userRec !== undefined && userRec.kind === "valid");
      assert.equal(userRec.manifest.disabled, true);
      assert.deepEqual(userRec.activation, { kind: "disabled" });
      assert.equal(
        updated.snapshot.diagnostics.some((d) => d.detail.kind === "name-collision"),
        false,
      );
    }
  });

  it("propagates catalog-only version on install so updateAvailable starts null and tracks subsequent catalog bumps", async () => {
    const ws = await makeTempWorkspace();
    const mktDir = makeAbsolutePath(path.join(ws.root, "catalog-ver-mkt"));
    await writeText(
      path.join(mktDir, "marketplace.json"),
      JSON.stringify({
        plugins: [{ name: "catalog-ver", source: "catalog-ver", version: "1.2.3" }],
      }),
    );
    await writeText(
      path.join(mktDir, "catalog-ver", "plugin.json"),
      JSON.stringify({ name: "catalog-ver", description: "Version lives only in marketplace.json" }),
    );

    const engine = createPluginEngine({
      homeDir: ws.homeDir,
      configDir: ws.configDir,
      workspaceDir: ws.workspaceDir,
    });
    const mktId = makeMarketplaceId("catalog-ver-mkt");
    const added = await engine.addMarketplace({
      source: { kind: "local-folder", path: mktDir },
      id: mktId,
    });
    assert.equal(added.ok, true);

    const inst = await engine.install({
      target: {
        kind: "catalog-entry",
        entryId: makeCatalogEntryId(mktId, makePluginDirName("catalog-ver")),
      },
      scope: "user",
    });
    assert.equal(inst.ok, true);
    if (inst.ok) {
      const rec = inst.snapshot.installedById.get(inst.report.pluginId);
      assert.ok(rec !== undefined && rec.kind === "valid");
      assert.equal(rec.manifest.version, "1.2.3");
      assert.equal(rec.updateAvailable, null);
    }

    await writeText(
      path.join(mktDir, "marketplace.json"),
      JSON.stringify({
        plugins: [{ name: "catalog-ver", source: "catalog-ver", version: "1.3.0" }],
      }),
    );
    const synced = await engine.syncMarketplaces({ kind: "single", id: mktId });
    assert.equal(synced.ok, true);
    if (synced.ok) {
      const rec = synced.snapshot.installedById.get(
        makeInstalledPluginId("user", makePluginDirName("catalog-ver")),
      );
      assert.ok(rec !== undefined && rec.kind === "valid");
      assert.equal(rec.updateAvailable?.latestVersion, "1.3.0");
    }

    const updated = await engine.update({
      kind: "single",
      selector: {
        kind: "id",
        id: makeInstalledPluginId("user", makePluginDirName("catalog-ver")),
      },
    });
    assert.equal(updated.ok, true);
    if (updated.ok) {
      assert.equal(updated.report.outcomes[0]?.status, "updated");
      assert.equal(updated.report.outcomes[0]?.toVersion, "1.3.0");
      const rec = updated.snapshot.installedById.get(
        makeInstalledPluginId("user", makePluginDirName("catalog-ver")),
      );
      assert.ok(rec !== undefined && rec.kind === "valid");
      assert.equal(rec.updateAvailable, null);
    }
  });

  it("supports marketplace.json source '.' and './' via marketplace-root while rejecting absolute local source paths", async () => {
    const ws = await makeTempWorkspace();
    const engine = createPluginEngine({
      homeDir: ws.homeDir,
      configDir: ws.configDir,
      workspaceDir: ws.workspaceDir,
    });

    const rootMkt = makeAbsolutePath(path.join(ws.root, "root-plugin-mkt"));
    await writeText(
      path.join(rootMkt, ".antigravity-plugin", "marketplace.json"),
      JSON.stringify({
        plugins: [
          { name: "dot-plugin", source: "." },
          { name: "dot-slash-plugin", source: "./" },
          { name: "abs-local", source: { source: "local", path: "/etc" } },
          { name: "abs-dir", source: { source: "directory", path: "/tmp" } },
          { name: "rel-local", source: { source: "local", path: "./plugins/contained" } },
        ],
      }),
    );
    await writeText(
      path.join(rootMkt, "plugin.json"),
      JSON.stringify({ name: "dot-plugin", version: "2.1.0" }),
    );
    await writeText(
      path.join(rootMkt, "skills", "root-skill", "SKILL.md"),
      "---\nname: root-skill\ndescription: Lives at marketplace root\n---\n",
    );
    await writeText(
      path.join(rootMkt, "plugins", "contained", "plugin.json"),
      JSON.stringify({ name: "rel-local", version: "0.5.0" }),
    );

    const mktId = makeMarketplaceId("root-plugin-mkt");
    const added = await engine.addMarketplace({
      source: { kind: "local-folder", path: rootMkt },
      id: mktId,
    });
    assert.equal(added.ok, true);
    if (added.ok) {
      const dotEntry = added.snapshot.catalogById.get(
        makeCatalogEntryId(mktId, makePluginDirName("dot-plugin")),
      );
      const dotSlashEntry = added.snapshot.catalogById.get(
        makeCatalogEntryId(mktId, makePluginDirName("dot-slash-plugin")),
      );
      const relLocalEntry = added.snapshot.catalogById.get(
        makeCatalogEntryId(mktId, makePluginDirName("rel-local")),
      );
      assert.ok(dotEntry !== undefined);
      assert.deepEqual(dotEntry.installSource, { kind: "marketplace-root", marketplaceId: mktId });
      assert.equal(dotEntry.componentCounts?.skills, 1);
      assert.ok(dotSlashEntry !== undefined);
      assert.deepEqual(dotSlashEntry.installSource, { kind: "marketplace-root", marketplaceId: mktId });
      assert.ok(relLocalEntry !== undefined);
      assert.equal(relLocalEntry.installSource.kind, "marketplace-subdir");

      assert.equal(
        added.snapshot.catalog.some((e) => e.name === "abs-local" || e.name === "abs-dir"),
        false,
      );
      const travDiags = added.snapshot.diagnostics.filter(
        (d) => d.detail.kind === "path-traversal-rejected",
      );
      assert.equal(travDiags.length, 2);
    }

    const instRoot = await engine.install({
      target: {
        kind: "catalog-entry",
        entryId: makeCatalogEntryId(mktId, makePluginDirName("dot-plugin")),
      },
      scope: "user",
    });
    assert.equal(instRoot.ok, true);
    if (instRoot.ok) {
      const rec = instRoot.snapshot.installedById.get(instRoot.report.pluginId);
      assert.ok(rec !== undefined && rec.kind === "valid");
      assert.equal(rec.manifest.version, "2.1.0");
      assert.equal(rec.components.counts.skills, 1);
    }
  });

  it("ignores ${CLAUDE_PLUGIN_ROOT} and ${PLUGIN_ROOT} inside JSONC comments while flagging real unexpanded values", async () => {
    const ws = await makeTempWorkspace();
    const engine = createPluginEngine({
      homeDir: ws.homeDir,
      configDir: ws.configDir,
      workspaceDir: ws.workspaceDir,
    });

    const commentedDir = path.join(ws.configDir, "plugins", "commented-plugin");
    await writeText(
      path.join(commentedDir, "plugin.json"),
      JSON.stringify({ name: "commented-plugin", version: "1.0.0" }),
    );
    await writeText(
      path.join(commentedDir, "hooks.json"),
      [
        "{",
        "  // Expanded from ${CLAUDE_PLUGIN_ROOT} and ${PLUGIN_ROOT}",
        '  "PreToolUse": [{ "hooks": [{ "type": "command", "command": "/abs/guard.sh" }] }]',
        "}",
      ].join("\n"),
    );
    await writeText(
      path.join(commentedDir, "mcp_config.json"),
      [
        "{",
        "  /* Previously used ${CLAUDE_PLUGIN_ROOT}/srv.js */",
        '  "mcpServers": { "srv": { "command": "node", "args": ["/abs/srv.js"] } }',
        "}",
      ].join("\n"),
    );

    const realUnexpandedDir = path.join(ws.configDir, "plugins", "real-unexpanded");
    await writeText(
      path.join(realUnexpandedDir, "plugin.json"),
      JSON.stringify({ name: "real-unexpanded", version: "1.0.0" }),
    );
    await writeText(
      path.join(realUnexpandedDir, "hooks.json"),
      JSON.stringify({
        PreToolUse: [{ hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/guard.sh" }] }],
      }),
    );

    const snap = await engine.snapshot();
    const commentedId = makeInstalledPluginId("user", makePluginDirName("commented-plugin"));
    const realId = makeInstalledPluginId("user", makePluginDirName("real-unexpanded"));

    assert.equal(
      snap.diagnostics.some(
        (d) =>
          d.subject.kind === "installed" &&
          d.subject.pluginId === commentedId &&
          d.detail.kind === "unexpanded-plugin-root",
      ),
      false,
    );
    assert.equal(
      snap.diagnostics.some(
        (d) =>
          d.subject.kind === "installed" &&
          d.subject.pluginId === realId &&
          d.detail.kind === "unexpanded-plugin-root",
      ),
      true,
    );
  });
});

describe("Architecture boundary: engine/internal isolation", () => {
  it("forbids any file outside src/engine/ from importing src/engine/internal/*", async () => {
    const cliRoot = path.resolve(import.meta.dirname, "..");
    const rootsToScan = [path.join(cliRoot, "src"), path.join(cliRoot, "bin")];
    const engineDir = path.join(cliRoot, "src", "engine");
    const violations: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (full === engineDir || full.startsWith(`${engineDir}${path.sep}`)) {
            continue;
          }
          await walk(full);
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
          const content = await fs.readFile(full, "utf8");
          if (/(?:from|import)\s+["'][^"']*engine\/internal\//.test(content)) {
            violations.push(path.relative(cliRoot, full));
          }
        }
      }
    };

    for (const root of rootsToScan) {
      await walk(root);
    }
    assert.deepEqual(violations, []);
  });
});
