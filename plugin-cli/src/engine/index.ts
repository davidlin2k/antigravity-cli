import type { PluginEngine, PluginEngineConfig } from "./contract.ts";
import { createEngineRuntime } from "./internal/engine-context.ts";
import { opInstall } from "./internal/ops-install.ts";
import { opSetEnabled, opUninstall, opUpdate } from "./internal/ops-lifecycle.ts";
import {
  opAddMarketplace,
  opRemoveMarketplace,
  opSyncMarketplaces,
} from "./internal/ops-marketplace.ts";
import { opRemediate, opValidate } from "./internal/ops-validate.ts";

export * from "./contract.ts";

/**
 * Creates a `PluginEngine` bound to explicit home, config, and workspace directories.
 * Never opens `<configDir>/config.json` for write; all manager metadata stays under
 * `<configDir>/plugin-manager/`.
 */
export function createPluginEngine(config: PluginEngineConfig): PluginEngine {
  const ctx = createEngineRuntime(config);

  return {
    snapshot: () => ctx.projectSnapshot(),
    install: (input) => opInstall(ctx, input),
    uninstall: (input) => opUninstall(ctx, input),
    setEnabled: (input) => opSetEnabled(ctx, input),
    update: (input) => opUpdate(ctx, input),
    addMarketplace: (input) => opAddMarketplace(ctx, input),
    syncMarketplaces: (input) => opSyncMarketplaces(ctx, input),
    removeMarketplace: (input) => opRemoveMarketplace(ctx, input),
    validate: (input) => opValidate(ctx, input),
    remediate: (input) => opRemediate(ctx, input),
  };
}
