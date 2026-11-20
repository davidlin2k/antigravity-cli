import type { PluginEngine, PluginEngineConfig } from "./contract.ts";

export * from "./contract.ts";

export function createPluginEngine(_config: PluginEngineConfig): PluginEngine {
  throw new Error("createPluginEngine not yet implemented");
}
