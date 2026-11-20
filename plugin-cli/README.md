# `agy-plugin`

Local multi-marketplace plugin CLI and five-tab interactive TUI for Antigravity.

## Requirements

- Node.js 24 or newer (runs native TypeScript directly with zero runtime dependencies).
- `git` on `PATH` for GitHub, SSH, and HTTPS git marketplaces.

## Quick start

Launch the five-tab interactive TUI (**Discover**, **Installed**, **Marketplaces**, **Errors**, **Stats**):

```bash
node plugin-cli/bin/agy-plugin.ts
```

Add custom marketplaces from GitHub, SSH, HTTPS git or JSON feeds, or local folders and JSON catalogs:

```bash
node plugin-cli/bin/agy-plugin.ts marketplace add cursor/plugins
node plugin-cli/bin/agy-plugin.ts marketplace add git@github.com:anthropics/claude-plugins-official.git
node plugin-cli/bin/agy-plugin.ts marketplace add https://example.com/marketplace.json
node plugin-cli/bin/agy-plugin.ts marketplace add ~/dev/team-plugins
node plugin-cli/bin/agy-plugin.ts marketplace add ~/.claude/plugins/plugin-directory-cache-v2.json --id claude-dir
```

Discover, inspect, install, and audit plugins non-interactively:

```bash
node plugin-cli/bin/agy-plugin.ts discover pstack
node plugin-cli/bin/agy-plugin.ts install pstack@cursor-plugins --scope user
node plugin-cli/bin/agy-plugin.ts list
node plugin-cli/bin/agy-plugin.ts errors
node plugin-cli/bin/agy-plugin.ts stats
```

Add `--json` to any non-interactive subcommand for machine-readable output. Pass `--config-dir <path>` (or set `AGY_CONFIG_DIR`) and `--workspace <path>` to target custom scopes.

## Verification

Run the typechecker, behavioral test suite, and live Linux PTY verifier:

```bash
cd plugin-cli
npm run typecheck
npm test
python3 scripts/verify-tui-pty.py
```

See [docs/plugin-cli-redesign.md](../docs/plugin-cli-redesign.md) for the full design specification and [docs/plugin-cli-rationale.md](../docs/plugin-cli-rationale.md) for architectural decisions.
