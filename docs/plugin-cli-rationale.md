# Rationale for Antigravity `/plugin` redesign

## Problem

Antigravity CLI needs a standalone, zero-runtime-dependency Node 24 TypeScript `/plugin` CLI and interactive TUI under `plugin-cli/` that matches and exceeds Claude Code's multi-marketplace workflow. Five grounded constraints set the design shape. First, Antigravity reads installed plugins from `<configDir>/plugins/<dir>/` (user scope) and `<workspaceDir>/.agents/plugins/<dir>/` (project scope). Manager registries must stay under `<configDir>/plugin-manager/`, and `plugin-cli/` must never edit `<configDir>/config.json`.

Second, Antigravity keys installed identity on `<dir>` while sharing one global runtime namespace for `plugin.json` `name`. Project scope overrides user scope, and alphabetical `dirName` breaks ties within a scope. Antigravity strips unknown `plugin.json` fields, reads root `hooks.json`, `mcp_config.json`, and `agents.json`, and loads `Plugin.json` case-insensitively.

Third, custom marketplaces span GitHub, SSH git, HTTPS git or JSON, and local folders or JSON catalogs. Formats span Antigravity, Claude Code (`claude-plugins-official` with 317 entries and `plugin-directory-cache-v2.json` with 3,778 entries), Cursor (`pstack` with 58 skills and 2 agents), and single-plugin repositories.

Fourth, installs and updates must strip UTF-8 BOMs and expand `${CLAUDE_PLUGIN_ROOT}` and `${PLUGIN_ROOT}` to the final install path. Adaptation must also block symlink escapes and `..` traversal, then swap directories atomically with crash recovery.

Fifth, the TUI needs five tabs (**Discover**, **Installed**, **Marketplaces**, **Errors**, **Stats**) running on Node 24 with `erasableSyntaxOnly: true`. It must keep live search across 4,000+ entries, modal action bars, one-key error remediation, and footer hints in sync with active keybindings.

## Usage (caller's view)

End users launch the interactive TUI or script every workflow with `--json`:

```bash
agy-plugin
agy-plugin marketplace add cursor/plugins
agy-plugin marketplace add git@github.com:my-org/internal-plugins.git
agy-plugin marketplace add https://example.com/marketplace.json
agy-plugin marketplace add ~/.claude/plugins/plugin-directory-cache-v2.json --id claude-dir
agy-plugin discover pstack
agy-plugin install cursor-plugins/pstack --scope project
agy-plugin validate https://github.com/cursor/plugins/tree/main/pstack
agy-plugin errors --json
agy-plugin stats
```

Call site 1 shows the CLI dispatcher (`src/cli/index.ts`), where argument parsing validates once at the boundary and routes each subcommand to `PluginEngine`:

```ts
const parsed = parseCliArgs({ argv, env: io.env, cwd: io.cwd, homeDir: io.homeDir });
if (!parsed.ok) {
  io.writeStderr(`${parsed.error.message}\n`);
  return 2;
}

const engine = createPluginEngine(parsed.value.engineConfig);
const command = parsed.value.command;

if (command.kind === "tui") {
  await runTui(engine, io.createTerminal());
  return 0;
}

if (command.kind === "install") {
  const result = await engine.install(command.input);
  io.writeStdout(formatCliOutput({ kind: "install", result }, command.outputMode));
  return result.ok ? 0 : 1;
}
```

Call site 2 shows the pure Elm TUI loop (`src/tui/terminal.ts`) paired with `TAB_REGISTRY`, keeping state transitions and ANSI frame diffing decoupled from TTY handles:

```ts
const initialSnapshot = await engine.snapshot();
let state = createInitialTuiState(initialSnapshot, terminal.viewport());
let prevFrame: RenderedFrame | null = null;

const paint = (viewport: Viewport): void => {
  const nextFrame = renderFrame(state, viewport);
  terminal.write(diffFrames(prevFrame, nextFrame));
  prevFrame = nextFrame;
};

const dispatch = (event: TuiEvent): void => {
  const [nextState, effects] = reduce(state, event);
  state = nextState;
  paint(terminal.viewport());
  for (const effect of effects) {
    executeTuiEffect(effect, engine, terminal, dispatch);
  }
};
```

Call site 3 shows end-to-end remediation and catalog search (`test/engine.test.ts`) against temporary directories and a local bare git repository:

```ts
const engine = createPluginEngine({ homeDir, configDir, workspaceDir });
const added = await engine.addMarketplace({ source: localRepoSource });
assert.equal(added.ok, true);

const matches = queryCatalog(added.snapshot, { text: "pstack" });
assert.ok(matches[0]);
assert.equal(matches[0].entry.id, "local-repo/pstack");

const installed = await engine.install({
  target: { kind: "catalog-entry", entryId: matches[0].entry.id },
  scope: "project",
});
assert.equal(installed.ok, true);

for (const diag of installed.snapshot.diagnostics) {
  if (diag.remediation !== undefined) {
    const fixed = await engine.remediate(diag.remediation);
    assert.equal(fixed.ok, true);
  }
}
```

## Shape

One deep domain facade (`PluginEngine`) owns reads, writes, external format normalization, atomic bundle adaptation, diagnostics, remediation, and projection into one immutable `WorkspaceSnapshot` (`per model-the-domain`, `per minimize-reader-load`). Both the CLI and the TUI read only `WorkspaceSnapshot` and request state changes through `PluginEngine`.

Data structures lead the design (`per foundational-thinking`). `WorkspaceSnapshot` holds five domain collections (`catalog`, `installed`, `marketplaces`, `diagnostics`, `stats`), five O(1) lookup maps (`catalogById`, `installedById`, `marketplacesById`, `diagnosticsById`, `installedIdsByPluginName`), and a monotonic `SnapshotRevision`:

- **Sub-millisecond search across 4,000+ entries.** `queryCatalog(snapshot, query)` runs synchronously and memoizes a pre-lowercased index in a module-private `WeakMap<WorkspaceSnapshot, NormalizedCatalogIndex>`. Old indexes garbage-collect with superseded snapshots, and status badges resolve in O(1) via `installedIdsByPluginName`.
- **Read-only filesystem reconciliation.** `PluginEngine.snapshot()` scans `<configDir>/plugins/*` and `<workspaceDir>/.agents/plugins/*`, merges provenance receipts and per-marketplace sync caches, and parses case-insensitive `Plugin.json` plus `agents.json` with UTF-8 BOM tolerance. It computes `project > user` collision winners using ascending `dirName` within a scope, and never writes files, deletes staging directories, or rewrites indexes.
- **Stable ID cursors and declarative tabs.** `TableCursorState<TId>` pins TUI selection by branded ID rather than row offset (`per experience-first`). `TAB_REGISTRY` compiles each tab through `defineTab<TId, TRow>(spec)` with zero `any` or `as` casts (`per encode-lessons-in-structure`, `per laziness-protocol`). Column definitions, row rendering, key dispatch, and footer hints all read from one spec.

Invariants live in types (`per type-system-discipline`). Zero-`as` verifying type guards (`is*`) and total `ParseResult<T>` parsers construct every branded type (`AbsolutePath`, `RelativeSubpath`, `MarketplaceId`, `PluginName`, `PluginDirName`, `InstalledPluginId`, `CatalogEntryId`, `DiagnosticId`, `SnapshotRevision`, `IsoTimestamp`, `HttpUrl`, `SshGitUrl`, `RequestId`). `CatalogEntryId` encodes `<marketplaceId>/<slug>` so catalog titles with spaces never leak into install paths. `InstalledPlugin` splits into `ValidInstalledPlugin | BrokenInstalledPlugin` with `NonEmpty<DiagnosticId>`. `PluginActivation` splits into `active | disabled | shadowed` so a disabled plugin cannot appear shadowed. `name-collision` diagnostics require `AtLeastTwo<InstalledPluginId>`. `OverlayState` encodes explicit action-bar focus (`focusedButton`, `focusedAction`, `focusedChoice`, `focusedField`) inside each modal variant. `package.json` `"exports"` exposes only `.`, `./domain`, `./query`, `./engine`, `./cli`, and `./tui`, blocking external imports of `src/engine/internal/*`.

Validation happens once at boundaries (`per boundary-discipline`). `parseCliArgs` and `parseMarketplaceInput` narrow untrusted flags, environment variables, and URLs into domain types at the edge. Inside the engine, `addMarketplace` resolves `https-auto` once into `https-git` or `https-json`. `normalizer.ts` strips BOMs and translates Antigravity, Claude, Cursor, and single-plugin schemas before returning `CatalogEntry` and `NormalizedPluginManifest`, keeping vendor schemas out of the public API.

Concurrency and crash recovery isolate writes before locking (`per separate-before-serializing-shared-state`, `per make-operations-idempotent`). Parallel marketplace syncs write only to `cache/sync/<marketplaceId>.json` and `marketplaces/<marketplaceId>/`. Plugin installs write only to `cache/receipts/<scope>--<dirName>.json`. Mutating operations stage bundles into `<scopeRoot>/.agy-stage-<dirName>-<nonce>` on the same filesystem, verify `fs.realpath` containment, reject `..` segments, and expand `${CLAUDE_PLUGIN_ROOT}` and `${PLUGIN_ROOT}` to the final install path. After pre-swap validation passes, the adapter renames any prior directory to `.agy-backup-<dirName>-<nonce>`, swaps via `rename`, and restores the backup on error. Coalesced `catalog-cache.json` and `installed_plugins.json` indexes update only during mutating calls, while `snapshot()` reports stale `.agy-stage-*` and `.agy-backup-*` artifacts as diagnostics carrying a typed `RemediationPlan`.

`PluginEngine` compresses this policy behind 10 methods (`snapshot`, `install`, `uninstall`, `setEnabled`, `update`, `addMarketplace`, `syncMarketplaces`, `removeMarketplace`, `validate`, `remediate`). Each mutation returns `EngineResult<TReport>` containing a fresh `WorkspaceSnapshot` on both success and failure. The system omits edits to `<configDir>/config.json`, runtime execution of plugin MCP servers or hooks, background file-watcher daemons, and separate Claude import commands because `addMarketplace` ingests Claude catalogs directly.

## Synthesis decision

- **Base.** Candidate 1 (`Unified Snapshot and Reconciler`, scored 23/25 by cross-judge versus 14/25 for Candidate 2) is the base. Its single `PluginEngine` facade, immutable `WorkspaceSnapshot`, `WeakMap` search cache, pure Elm state machine, and isolated per-marketplace caches plus per-plugin receipts deliver clean interface depth and lock-free parallel syncs.
- **Grafted from Candidate 2.** First, compile-time-checked `TAB_REGISTRY` with `defineTab<TId, TRow>` drives tab headers, columns, row rendering, key dispatch, and footer hints from one definition inside the Elm loop. Second, typed `RemediationPlan` intents attach to `Diagnostic` records and run through `engine.remediate(plan)` for one-key fixes (`f`) in the **Errors** tab. Third, modal states carry explicit action-bar focus fields (`focusedButton`, `focusedAction`, `focusedChoice`, `focusedField`) paired with concrete zero-`as` verifying boundary guards.
- **Rejected from Candidate 2.** We rejected four separate public slice ports (`MarketplaceStore`, `PluginInstaller`, `HealthAuditor`, `StatsProjector`) backed by four independent persisted snapshot JSON files. Splitting ownership widens the public API, forces callers to coordinate across slices, and risks drift between persisted audit and stats files.
- **Hardenings applied.** First, `PluginEngine.snapshot()` is strictly read-only and never deletes staging directories, restores backups, or rewrites index caches during reads. Second, `CatalogEntryId` uses `<marketplaceId>/<slug>` instead of `<marketplaceId>/<pluginName>` so display titles with spaces or uppercase characters remain valid. Third, the reconciler enforces verified Antigravity precedence where `project` scope overrides `user` scope, breaking ties alphabetically by `dirName` within a scope. Fourth, inspection and adaptation support root `agents.json`, case-insensitive `Plugin.json` resolution, and UTF-8 BOM detection with diagnostic surfacing.

## Tradeoffs accepted

- We accept full local directory scanning in `snapshot()` in exchange for read-only purity, zero stale-state drift, and immediate visibility of manual edits under `~/.gemini/config/plugins/` and `<workspace>/.agents/plugins/`.
- We accept expanding `PluginEngine` from 9 to 10 methods (`remediate`) in exchange for type-safe one-key diagnostic fixes in the **Errors** tab that preserve the single-engine mutation invariant.
- We accept maintaining per-marketplace sync caches and per-plugin receipts alongside derived `catalog-cache.json` and `installed_plugins.json` indexes in exchange for lock-free parallel marketplace updates and isolated per-plugin installs.
- We accept building a custom line-diffed ANSI renderer (`renderFrame` and `diffFrames`) in exchange for zero runtime dependencies, flicker-free SSH rendering, and deterministic string-level tests.
- We accept blocking installs that introduce a global `PluginName` collision unless `allowNameCollision` is true in exchange for protecting users from Antigravity's silent duplicate-drop behavior.

## Alternatives considered

- **Four decoupled domain slice ports with separate JSON state files.** Exposing `MarketplaceStore`, `PluginInstaller`, `HealthAuditor`, and `StatsProjector` separately simplifies slice unit tests. It lost on interface depth because callers must coordinate cross-slice transactions and reconcile skew across `installs.json`, `health-audit.json`, and `stats-snapshot.json`.
- **Append-only WAL or SQLite catalog database.** Persisting every marketplace and plugin mutation in a database avoids rescanning plugin directories on `snapshot()`. It lost because users still edit `~/.gemini/config/plugins/` directly, turning the database into a second source of truth that drifts from disk.
- **Imperative per-tab widget classes.** Letting five tab classes manage local cursor state, direct engine calls, and ANSI output avoids an Elm reducer. It lost because keyboard focus, modal routing, and async snapshot race guards scatter across five files.

## Open questions and risks

- Should `plugin-cli` enforce Antigravity's managed admin settings (`pluginControls.pluginsDisabled` and `pluginControls.marketplaceDisabled`) when callers pass an optional `--policy-file` path, or stay strictly user-space?
- Should remote `archive-url` entries (`.zip` plugins referenced by `agy plugin validate` or `claude-plugins-official`) extract through a minimal pure-TypeScript ZIP reader using `node:zlib` instead of invoking system `unzip` or `tar`?
- What is the measured cold-start parse latency and V8 heap footprint when loading 3,778 entries from `plugin-directory-cache-v2.json` alongside two full git marketplace caches?
- Should `catalog-cache.json` cap stored description lengths so cold startup stays fast across multiple large catalogs?
- Should `agy-plugin` offer on first run to import existing `~/.claude/plugins/known_marketplaces.json` and `plugin-directory-cache-v2.json` files when `known_marketplaces.json` is empty, or keep marketplace registration explicit via `marketplace add`?

## Next implementation step

Implement `plugin-cli/src/domain/types.ts` and `plugin-cli/src/domain/query.ts` with zero-`as` verifying boundary parsers, `CatalogEntryId` (`<marketplaceId>/<slug>`), `RemediationPlan`, and `node --test` unit tests covering every guard and invalid-state rejection.
