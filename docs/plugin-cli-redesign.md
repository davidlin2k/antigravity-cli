# Antigravity CLI `/plugin` redesign specification

This document specifies the redesigned `/plugin` experience for Antigravity CLI and its standalone Node 24 TypeScript implementation under `plugin-cli/` (`agy-plugin`). It defines the filesystem contract, multi-source marketplace acquisition, multi-ecosystem bundle adaptation, atomic installation, the five-tab terminal UI, and non-interactive CLI commands.

## Problem statement and comparison with Claude Code

Antigravity CLI currently splits plugin workflows between narrow `agy plugin` subcommands and a minimal `/plugin` interface. Users migrating from Claude Code expect one workspace that discovers thousands of plugins across multiple marketplaces and installs skills, agents, rules, hooks, and MCP servers reliably. They also need diagnostics for silent load failures before starting a session.

| Capability | Claude Code (`~/.claude/plugins/`) | Antigravity current `/plugin` | Redesigned `/plugin` (`agy-plugin`) |
| :--- | :--- | :--- | :--- |
| Top-level navigation | 5 tabs (`Discover`, `Installed`, `Marketplaces`, `Errors`, `Stats`) | Basic listing and sign-in flow | 5 tabs via `TAB_REGISTRY` with live badge counts and ID-pinned cursors |
| Discovery catalog scale | `plugin-directory-cache-v2.json` (3,778 listings) plus custom repos | Single-source preview lacking unified search | Sub-millisecond `WeakMap` search across 4,000+ normalized entries |
| Marketplace sources | GitHub, SSH, HTTPS, local folder | Limited marketplace manifest rules | GitHub shorthand or URL, SSH git, HTTPS git or JSON, local folder or JSON |
| Cross-ecosystem bundles | Native `.claude-plugin/` layout | Drops `hooks/hooks.json`, `.mcp.json`, unknown fields | Automatic adaptation for Antigravity, Claude, Cursor, and single plugins |
| Collision visibility | Scoped keys (`plugin@marketplace`) | Global `name` namespace silently drops duplicates | Detects `project > user` winners, flags `shadowed` plugins, offers `f` fix |
| Manifest edge cases | Consistent `.claude-plugin/` root | Case-sensitive `Plugin.json` and UTF-8 BOM issues noted across releases | BOM-safe JSONC parser, case-insensitive `Plugin.json`, root `agents.json` support |
| Non-interactive automation | CLI flags with partial scriptability | `agy plugin list --json` and `validate --json` | Full subcommand suite with `--json` envelope and typed exit codes |

### Design goals and non-goals

The redesign targets read-only inspection safety, crash-safe atomic installs, zero external runtime dependencies on Node 24 (`>=24.0.0` with `erasableSyntaxOnly: true`), and flicker-free SSH rendering.

This package deliberately omits four behaviors:

- Mutating `<configDir>/config.json` (all manager state stays isolated under `<configDir>/plugin-manager/`).
- Executing plugin MCP servers, OAuth browser flows, or hook processes (runtime execution stays inside the `agy` host).
- Running a background file-watcher daemon.
- Providing a separate Claude import command, because `marketplace add` ingests Claude marketplaces and `plugin-directory-cache-v2.json` directly.

## Filesystem contract and isolation

`PluginEngine` separates real Antigravity runtime directories from manager metadata so manual edits on disk never desynchronize from Antigravity's loader.

```text
~/.gemini/config/                         # Overridable via AGY_CONFIG_DIR or --config-dir
├── config.json                           # Never opened for write by plugin-cli
├── plugins/                              # User scope (<configDir>/plugins/<dirName>/)
│   ├── gdrive/
│   └── pstack/
└── plugin-manager/                       # Isolated plugin-cli state
    ├── known_marketplaces.json           # Registered marketplace IDs and resolved sources
    ├── catalog-cache.json                # Coalesced index rebuilt on mutations
    ├── installed_plugins.json            # Coalesced install ledger rebuilt on mutations
    ├── marketplaces/                     # Local git clones or mirrors (<marketplaceId>/)
    └── cache/
        ├── sync/<marketplaceId>.json     # Isolated per-marketplace sync cache
        └── receipts/<scope>--<dirName>.json  # Isolated per-plugin provenance receipt

<workspace>/                              # Overridable via --workspace
└── .agents/
    └── plugins/                          # Project scope (<workspace>/.agents/plugins/<dirName>/)
        └── team-kit/
```

### Strictly read-only `snapshot()` invariant

`PluginEngine.snapshot()` inspects disk state without mutating any file. It reads `known_marketplaces.json`, loads per-marketplace sync caches under `cache/sync/<marketplaceId>.json`, and scans user and project plugin directories on disk as the source of truth. It then merges provenance from `cache/receipts/<scope>--<dirName>.json` to build `WorkspaceSnapshot`.

If a crashed install left `.agy-stage-<dirName>-<nonce>` or `.agy-backup-<dirName>-<nonce>` directories in a scope root, `snapshot()` leaves them untouched on disk. Instead, it emits a `stale-staging-artifact` diagnostic with an attached `RemediationPlan`. Rebuilding `catalog-cache.json` and `installed_plugins.json` or cleaning stale staging directories runs only inside mutating methods (`install`, `uninstall`, `setEnabled`, `update`, `addMarketplace`, `syncMarketplaces`, `removeMarketplace`, and `remediate`).

### Scope precedence and global `name` collisions

Antigravity keys installed plugins by directory `<dirName>`, while `plugin.json` `name` shares one global namespace at runtime. Duplicate enabled `name` values cause Antigravity to drop the lower-precedence plugin silently. Following Antigravity CLI configuration precedence (project settings overriding user settings), the reconciler resolves precedence deterministically:

1. **Project overrides user.** An enabled plugin under `<workspace>/.agents/plugins/<dirName>/` beats an enabled plugin with the same `plugin.json` `name` under `<configDir>/plugins/<dirName>/`.
2. **Alphabetical tie-breaker within scope.** When two enabled directories in the same scope share one `plugin.json` `name`, the directory whose `dirName` sorts earlier in ascending code-unit order wins.
3. **Disabled plugins excluded.** A plugin with `"disabled": true` in its manifest never participates in collisions and never enters the `shadowed` state.

Winning plugins report `activation: { kind: "active" }`. Losing plugins report `activation: { kind: "shadowed", shadowedBy: winnerId }` and emit an `error` diagnostic (`name-collision`) listing `AtLeastTwo<InstalledPluginId>` plus a one-key `disable-plugin` remediation plan. By default, `engine.install()` refuses an install that creates a collision unless the caller sets `allowNameCollision: true` (`--force`).

## Marketplace sources and catalog normalization

Both `agy-plugin marketplace add` and the TUI **Add Marketplace** modal call `parseMarketplaceInput({ raw, cwd, homeDir })` in `src/domain/query.ts`. The parser runs synchronously without network calls so the TUI renders a live source-type preview on every keystroke.

| Input form | Examples | Persisted `MarketplaceSource` kind | Notes |
| :--- | :--- | :--- | :--- |
| GitHub shorthand | `cursor/plugins`, `owner/repo@v1.2` | `github` | Expands `@ref` into branch or tag ref |
| GitHub web or tree URL | `https://github.com/cursor/plugins/tree/main/pstack` | `github` | Extracts `owner`, `repo`, `ref`, and `subdir` |
| SSH git remote | `git@github.com:org/repo.git`, `ssh://git@host/org/repo.git` | `ssh` | Supports optional `@ref`, `#ref`, and `?subdir=` |
| HTTPS git remote | `https://example.com/org/plugins.git` | `https-git` | Cloned shallowly into `marketplaces/<id>/` |
| HTTPS JSON catalog | `https://example.com/marketplace.json` | `https-json` | Downloaded via native `fetch()` with timeout |
| Ambiguous HTTPS URL | `https://example.com/team-plugins` | Resolved once at `addMarketplace` | Probes `git ls-remote` then HTTP `Content-Type` |
| Local folder | `/opt/plugins`, `~/dev/my-plugins`, `./local-mkt` | `local-folder` | Reads directly from disk without copying |
| Local JSON catalog | `~/.claude/plugins/plugin-directory-cache-v2.json` | `local-json` | Parses catalog JSON without cloning every listed repo |

### Multi-format catalog normalization

At sync time, `normalizer.ts` translates five external manifest ecosystems into `CatalogEntry` records identified by `CatalogEntryId` (`<marketplaceId>/<slug>`, for example `cursor-plugins/pstack`):

1. **Antigravity native.** Probes `.antigravity-plugin/marketplace.json`, `.gemini-plugin/marketplace.json`, and root `marketplace.json`.
2. **Claude Code marketplace.** Probes `.claude-plugin/marketplace.json` (verified against `claude-plugins-official` with 317 plugins). Normalizes relative paths (`"./plugins/..."` into `marketplace-subdir`), `{ source: "git-subdir", url, path, ref, sha }` objects, and `{ source: "url", url, sha }` objects, while indexing `renames` aliases.
3. **Claude directory cache.** Parses `plugin-directory-cache-v2.json` (`listings[]` with 3,778 entries carrying `id`, `name`, `summary`, `release.version`, and `source.repository`). Derives safe `<slug>` segments so titles with spaces such as `"Small Business"` produce valid `CatalogEntryId` values (`claude-dir/small-business`).
4. **Cursor marketplace.** Probes `.cursor-plugin/marketplace.json` (verified against `cursor-plugins` with 129 entries including `pstack`).
5. **Single-plugin fallback.** When no `marketplace.json` exists, probes `plugin.json` (case-insensitive `Plugin.json`), `.antigravity-plugin/plugin.json`, `.gemini-plugin/plugin.json`, `.claude-plugin/plugin.json`, and `.cursor-plugin/plugin.json` to expose the root directory as a single-entry marketplace.

### Sub-millisecond search across 4,000+ plugins

`queryCatalog(snapshot, query)` runs synchronously against immutable `WorkspaceSnapshot` instances. On the first query for a snapshot, it builds a pre-lowercased index inside a module-private `WeakMap<WorkspaceSnapshot, NormalizedCatalogIndex>` containing name, slug, marketplace ID, category, tags, and description text. Subsequent keystrokes scan in under 1 ms, rank exact matches above prefix and substring matches, and check install badges in O(1) via `snapshot.installedIdsByPluginName`. Old indexes garbage-collect once snapshots fall out of scope.

## Multi-ecosystem bundle adaptation and atomic install pipeline

`adapter.ts` converts bundles from `antigravity`, `claude`, `cursor`, and `single-plugin` sources into Antigravity's root layout during install and update.

### Adaptation rules

1. **BOM-safe JSONC parsing and case-insensitive manifests.** `parseJsoncBomSafe` strips any UTF-8 BOM (`0xEF 0xBB 0xBF`), `//` and `/* */` comments, and trailing commas, reporting exact line and column numbers on syntax errors. Manifest lookup matches `plugin.json` case-insensitively (`Plugin.json`) across root, `.antigravity-plugin/`, `.gemini-plugin/`, `.claude-plugin/`, and `.cursor-plugin/`.
2. **Whitelisted `plugin.json` normalization.** Because Antigravity drops unrecognized manifest keys silently, the adapter writes clean UTF-8 (no BOM) root `plugin.json` keeping only valid fields. Supported fields are `name`, `displayName`, `description`, `version`, `author` (string or `{"name", "url"}`), `category`, `homepage`, `repository`, `logo`, `suggestedPrompts`, `skills`, `extensions`, and `disabled`. The adapter omits Claude and Cursor fields (`keywords`, `license`, `commands`, `agents`, `hooks`, `mcpServers`, `strict`) after adapting their referenced files.
3. **Component directory preservation.** `skills/<name>/SKILL.md`, `agents/<name>.md`, root `agents.json`, `skills.json`, `rules.json`, `sidecars.json`, `rules/`, `assets/`, and `bin/` copy directly into the staged directory. Adapting `pstack` preserves all 58 skills and 2 agents (`poteto-agent.md` and `comment-sicko.md`) with clean `plugin.json` metadata.
4. **Root `hooks.json` promotion and unwrapping.** Antigravity ignores `hooks/hooks.json` and misreads a top-level `{ "hooks": { ... } }` object inside root `hooks.json` as a single hook named `hooks`. When root `hooks.json` is absent and `hooks/hooks.json` exists, the adapter promotes `hooks/hooks.json` to root `hooks.json` and unwraps any top-level `"hooks"` envelope. It also expands `${CLAUDE_PLUGIN_ROOT}` and `${PLUGIN_ROOT}` placeholders to the final `<scopeRoot>/<dirName>` path.
5. **Root `mcp_config.json` adaptation.** When `.mcp.json` (or inline `mcpServers` in a Claude manifest) exists and root `mcp_config.json` does not, the adapter writes root `mcp_config.json`. It preserves `mcpServers` entries (`command`, `args`, `env`, `url`, and request `headers`) and expands `${CLAUDE_PLUGIN_ROOT}` and `${PLUGIN_ROOT}` to the final `<scopeRoot>/<dirName>` path rather than the temporary staging path.

### Path traversal protection and atomic swap

```text
source bundle
  │
  ▼  1. Acquire short O_CREAT|O_EXCL lock (<scopeRoot>/.agy-lock-<dirName>)
  ▼  2. Copy into same-FS stage (<scopeRoot>/.agy-stage-<dirName>-<nonce>)
  │     ├─ Reject RelativeSubpath starting "/", containing "\", NUL, or ".."
  │     └─ Verify fs.realpath() containment (reject symlink escapes outside root)
  ▼  3. Adapt plugin.json, hooks.json, mcp_config.json using FINAL target path
  ▼  4. Inspect staged bundle. Abort and delete stage on error diagnostics
  ▼  5. Rename existing <scopeRoot>/<dirName> -> .agy-backup-<dirName>-<nonce>
  ▼  6. Rename stage -> <scopeRoot>/<dirName>
  │     └─ On rename error, restore backup -> <scopeRoot>/<dirName> and fail safely
  ▼  7. Write cache/receipts/<scope>--<dirName>.json, remove backup, release lock
```

Keeping `.agy-stage-*` and `.agy-backup-*` inside `<scopeRoot>` guarantees `fs.rename` stays on the same filesystem without partial cross-device copies. Every install and update converges to the same end state across retries.

## Five-tab interactive TUI specification

The TUI runs a pure Elm loop (`reduce` and `renderFrame`) paired with `diffFrames` wrapped in Synchronized Output Mode (`\x1b[?2026h` and `\x1b[?2026l`). Only modified terminal lines repaint per frame, keeping SSH sessions flicker-free.

`TAB_REGISTRY` registers all five tabs through `defineTab<TId, TRow>(spec)` (`src/tui/tab-registry.ts` and `src/tui/tabs.ts`). One `TypedTabSpec` defines the tab label, badge, columns, row selector, `rowKey`, optional `summaryCards`, optional `modeLabels`, and `actions` array. Because `renderFooterHints` and key dispatch both read `spec.actions`, footer hints never diverge from active bindings. `TableCursorState<TId>` pins selection by branded domain ID so live filtering and async syncs preserve row focus.

### Main workspace wireframe (**Discover** tab)

```text
+-----------------------------------------------------------------------------------------+
| Antigravity Plugins  [1 Discover]  2 Installed 2  3 Marketplaces 2  4 Errors 1  5 Stats |
+-----------------------------------------------------------------------------------------+
| Search [/]: pstack_                                           Filter [f]: All (3,907)   |
+-----------------------------------------------------------------------------------------+
| Name                   Marketplace        Components         Version   Status           |
|-----------------------------------------------------------------------------------------|
| > pstack               cursor-plugins     58S 2A 0R 0H 0M    0.15.46   user             |
|   poteto-kit           team-internal      12S 1A 2R 1H 0M    1.2.0     available        |
|   superpowers          claude-dir         -                  7.0.2     available        |
|   frontend-design      claude-official    -                  1.1.1     available        |
|   hookify              claude-official    0S 0A 0R 4H 0M     1.0.0     available        |
+-----------------------------------------------------------------------------------------+
| ←/→ switch tabs  ↑/↓ move  / search  f filter  i install  Enter open  Esc close         |
+-----------------------------------------------------------------------------------------+
```

### Modal workflows and explicit focus state

Modal dialogs store explicit action-bar focus state inside `OverlayState` so `Tab` and `←/→` move cleanly across buttons:

```text
+--------------------------------------------------------------------------+
| Plugin Details: pstack (cursor-plugins/pstack)                    [Esc]  |
|--------------------------------------------------------------------------|
| Version: 0.15.46   Author: Lauren Tan   Format: cursor                   |
| Summary: Rigorous agent workflows you can parallelize with confidence.   |
| Components: 58 skills, 2 agents (poteto-agent, comment-sicko)            |
| Skills: architect, arena, how, interrogate, poteto-mode, unslop, ...     |
|                                                                          |
| Target Scope: (*) user (~/.gemini/config/plugins/pstack)                 |
|               ( ) project (.agents/plugins/pstack)                       |
|--------------------------------------------------------------------------|
|   [ Install ]     [ Switch Scope ]     [ Close ]                         |
+--------------------------------------------------------------------------+
| Tab/←/→ focus button  s scope  Enter run focused action  Esc back        |
+--------------------------------------------------------------------------+
```

**Add Marketplace modal.** Typing into the source field runs `parseMarketplaceInput` on every keystroke and previews the detected kind (`github`, `ssh`, `https-git`, `https-json`, `https-auto`, `local-folder`, or `local-json`) alongside the derived `MarketplaceId`. `focusedField` cycles across `"source"`, `"id"`, `"submit"`, and `"cancel"`.

**Diagnostic Detail modal and one-key fix.** When a diagnostic carries a `RemediationPlan`, pressing `f` in the **Errors** tab table runs `engine.remediate(plan)` directly. Opening `diagnostic-detail` also offers `[ Fix ]` and `[ Close ]` via `focusedAction`.

### Tab-by-tab behavior specification

| Tab | Key | Columns | Modes (`f` or `m`) | Primary row and tab actions |
| :--- | :--- | :--- | :--- | :--- |
| **Discover** | `1` | `Name`, `Marketplace`, `Components`, `Version`, `Status` | `All`, `Available`, `Installed` | `/ search`, `f filter`, `i quick install`, `Enter open detail modal` |
| **Installed** | `2` | `Name`, `Scope`, `Version`, `State`, `S/A/R/H/M`, `Source` | `All Scopes`, `User`, `Project` | `/ search`, `f scope filter`, `Space enable/disable`, `u update`, `U update all`, `x uninstall`, `Enter inspect` |
| **Marketplaces** | `3` | `Name`, `Kind`, `Source`, `Plugins`, `Synced`, `Status` | None | `a add marketplace`, `u update`, `U update all`, `d remove`, `Enter inspect` |
| **Errors** | `4` | `Level`, `Code`, `Target`, `Summary` | `All`, `Errors`, `Warnings` | `/ search`, `f fix (when RemediationPlan exists)`, `r re-check`, `Enter inspect detail` |
| **Stats** | `5` | Summary cards plus `Entity`, `Components`, `Est. Tokens`, `Disk KB` | `By Plugin`, `By Marketplace`, `By Scope` | `m cycle breakdown`, `r refresh`, `↑/↓ scroll` |

### Diagnostics detected and remediated

`inspector.ts` and `reconciler.ts` report actionable issues in the **Errors** tab and `agy-plugin errors`:

| Diagnostic code | Severity | Trigger condition | Attached `RemediationPlan` |
| :--- | :--- | :--- | :--- |
| `name-collision` | `error` | Multiple enabled plugins share one `plugin.json` `name` | `disable-plugin` on shadowed loser |
| `manifest-json-syntax` | `error` | Malformed JSONC in `plugin.json`, `hooks.json`, `mcp_config.json`, or `agents.json` | Manual edit hint with line and column |
| `manifest-schema-invalid` | `error` | Missing required fields or invalid field types | Manual edit hint |
| `path-traversal-rejected` | `error` | Symlink escape or `..` traversal inside a plugin bundle | `remove-plugin` on unsafe directory |
| `skill-frontmatter-missing` | `warning` | `SKILL.md` lacks YAML frontmatter, `name`, or `description` | Diagnostic detail shows folder fallback |
| `hooks-invalid` | `warning` or `error` | Unadapted `hooks/hooks.json`, top-level `"hooks"` wrapper, or invalid regex matcher | `readapt-bundle` when auto-adaptable |
| `mcp-config-invalid` | `warning` or `error` | Unadapted `.mcp.json` or unexpanded `${CLAUDE_PLUGIN_ROOT}` or `${PLUGIN_ROOT}` | `readapt-bundle` when auto-adaptable |
| `manifest-bom-present` | `warning` | File begins with UTF-8 BOM (`0xEF 0xBB 0xBF`) | `readapt-bundle` strips BOM cleanly |
| `marketplace-sync-failed` | `error` | Network, auth, or git failure during marketplace sync (retains last good catalog) | `retry-marketplace-sync` |
| `orphaned-install-dir` | `warning` | Installed directory on disk has no manager receipt | `adopt-orphan` writes direct receipt |
| `orphaned-receipt` | `warning` | Receipt exists under `cache/receipts/` for a deleted directory | `remove-orphan-receipt` cleans receipt |
| `stale-staging-artifact` | `warning` | Interrupted `.agy-stage-*` or `.agy-backup-*` left by a crashed process | `recover-stale-staging` restores or cleans |

### Progressive-disclosure token estimation in **Stats**

The **Stats** tab computes summary KPI cards (`Discoverable`, `Installed enabled/total`, `Components`, `Desc Tokens`, `Disk KB`) and three breakdown views (`By Plugin`, `By Marketplace`, `By Scope`). Token estimation sums character counts across descriptions loaded upfront at session start (`SKILL.md` frontmatter `name` and `description`, `agents/*.md` and `agents.json` descriptions, and root `plugin.json` description). Dividing that total by 4 rounded up helps users spot context-heavy plugins early.

## Non-interactive CLI subcommand reference

The `agy-plugin` executable accepts global flags before or after any subcommand:

- `--config-dir <path>` overrides `AGY_CONFIG_DIR` and defaults to `~/.gemini/config`.
- `--workspace <path>` overrides the project workspace root and defaults to the current working directory.
- `--json` writes one JSON object to stdout (`{ "ok": true, "data": ... }` or `{ "ok": false, "error": ... }`) with no ANSI codes.
- `--help` and `--version` print usage or package version and exit with code `0`.

| Command | Arguments and flags | Underlying engine call | Behavior |
| :--- | :--- | :--- | :--- |
| `agy-plugin` or `tui` | None | `engine.snapshot()` + `runTui()` | Launches the interactive 5-tab TUI on alt-screen |
| `discover` | `[query] [--marketplace <id>] [--category <cat>] [--installed \| --available]` | `engine.snapshot()` + `queryCatalog()` | Searches all synced catalogs and prints matching plugins |
| `install` | `<mkt/slug \| slug@mkt \| name \| source> [--scope user\|project] [--dir-name <dir>] [--force]` | `engine.install()` | Installs and adapts a bundle atomically. Pass `--force` to allow collisions |
| `uninstall` | `<scope:dir \| name> [--scope user\|project]` | `engine.uninstall()` | Removes plugin directory and receipt cleanly |
| `enable` | `<scope:dir \| name> [--scope user\|project]` | `engine.setEnabled({ enabled: true })` | Clears `"disabled"` in root `plugin.json` atomically |
| `disable` | `<scope:dir \| name> [--scope user\|project]` | `engine.setEnabled({ enabled: false })` | Sets `"disabled": true` in root `plugin.json` atomically |
| `list` | `[--scope user\|project] [--state active\|disabled\|shadowed\|broken]` | `engine.snapshot()` + `queryInstalled()` | Lists installed plugins with scope, state, version, and components |
| `update` | `[<scope:dir \| name> \| --all] [--scope user\|project]` | `engine.update()` | Updates one managed plugin or all managed plugins from provenance |
| `validate` | `[<path-or-url> \| <selector>] [--strict]` | `engine.validate()` | Validates a local bundle, remote repo URL, installed plugin, or workspace. Pass `--strict` to fail on warnings |
| `errors` | `[text] [--severity error\|warning]` | `engine.snapshot()` + `queryDiagnostics()` | Lists active diagnostics with file paths, hints, and fix labels |
| `stats` | None | `engine.snapshot()` | Reports catalog counts, component totals, token footprint, and disk bytes |
| `marketplace add` | `<source> [--id <id>]` | `engine.addMarketplace()` | Registers GitHub, SSH, HTTPS git or JSON, or local source and syncs it |
| `marketplace list` | None | `engine.snapshot()` | Lists configured marketplaces with kind, count, last sync, and status |
| `marketplace update` | `[<id> \| --all]` | `engine.syncMarketplaces()` | Syncs one or all marketplaces in parallel using isolated caches |
| `marketplace remove` | `<id>` | `engine.removeMarketplace()` | Unregisters a marketplace and deletes its mirror while preserving installs |

### Exit codes

- `0` indicates success with zero errors (and zero warnings when `validate --strict` runs).
- `1` indicates a runtime, network, filesystem, collision, validation, or remediation failure (`EngineError` or failed `ValidationReport`).
- `2` indicates invalid CLI flags, unknown subcommands, or rejected boundary input (`ParseError`).
