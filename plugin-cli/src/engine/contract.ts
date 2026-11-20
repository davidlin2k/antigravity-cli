import type {
  AbsolutePath,
  ComponentInventory,
  Diagnostic,
  EngineResult,
  InstalledPluginId,
  InstalledPluginSelector,
  InstallScope,
  InstallTarget,
  ManifestEcosystem,
  MarketplaceId,
  NormalizedPluginManifest,
  ParsedMarketplaceInput,
  PluginDirName,
  PluginName,
  RemediationPlan,
  WorkspaceSnapshot,
} from "../domain/types.ts";

export type { InstalledPluginSelector, InstallTarget };

export interface PluginEngineConfig {
  readonly homeDir: AbsolutePath;
  readonly configDir: AbsolutePath;
  readonly workspaceDir: AbsolutePath;
  readonly networkTimeoutMs?: number;
}

export interface InstallPluginInput {
  readonly target: InstallTarget;
  readonly scope: InstallScope;
  readonly dirName?: PluginDirName;
  readonly allowNameCollision?: boolean;
}

export interface InstallReport {
  readonly pluginId: InstalledPluginId;
  readonly pluginName: PluginName;
  readonly scope: InstallScope;
  readonly installPath: AbsolutePath;
  readonly outcome: "installed" | "updated" | "unchanged";
  readonly adaptedHooks: boolean;
  readonly adaptedMcp: boolean;
  readonly warnings: readonly Diagnostic[];
}

export interface UninstallPluginInput {
  readonly selector: InstalledPluginSelector;
}

export interface UninstallReport {
  readonly pluginId: InstalledPluginId;
  readonly removedPath: AbsolutePath;
  readonly outcome: "removed" | "cleaned-orphan-receipt";
}

export interface SetPluginEnabledInput {
  readonly selector: InstalledPluginSelector;
  readonly enabled: boolean;
}

export interface ToggleReport {
  readonly pluginId: InstalledPluginId;
  readonly enabled: boolean;
  readonly outcome: "changed" | "unchanged";
}

export type UpdatePluginsInput =
  | { readonly kind: "single"; readonly selector: InstalledPluginSelector }
  | { readonly kind: "all"; readonly scope?: InstallScope };

export interface PluginUpdateOutcome {
  readonly pluginId: InstalledPluginId;
  readonly status: "updated" | "unchanged" | "skipped-unmanaged" | "failed";
  readonly fromVersion: string | null;
  readonly toVersion: string | null;
  readonly reason?: string;
}

export interface UpdateReport {
  readonly outcomes: readonly PluginUpdateOutcome[];
}

export interface AddMarketplaceInput {
  readonly source: ParsedMarketplaceInput;
  readonly id?: MarketplaceId;
}

export interface MarketplaceSyncOutcome {
  readonly marketplaceId: MarketplaceId;
  readonly status: "synced" | "failed";
  readonly pluginCount: number;
  readonly format: ManifestEcosystem | null;
  readonly reason?: string;
}

export interface MarketplaceSyncReport {
  readonly outcome: MarketplaceSyncOutcome;
}

export type SyncMarketplacesInput =
  | { readonly kind: "single"; readonly id: MarketplaceId }
  | { readonly kind: "all" };

export interface BulkSyncReport {
  readonly outcomes: readonly MarketplaceSyncOutcome[];
}

export interface RemoveMarketplaceInput {
  readonly id: MarketplaceId;
}

export interface RemoveMarketplaceReport {
  readonly id: MarketplaceId;
  readonly removedMirror: boolean;
}

export type ValidateTargetInput =
  | { readonly kind: "workspace" }
  | { readonly kind: "installed"; readonly selector: InstalledPluginSelector }
  | { readonly kind: "source"; readonly source: ParsedMarketplaceInput };

export interface ValidationReport {
  readonly valid: boolean;
  readonly targetLabel: string;
  readonly manifest: NormalizedPluginManifest | null;
  readonly components: ComponentInventory | null;
  readonly diagnostics: readonly Diagnostic[];
}

export interface RemediateInput {
  readonly plan: RemediationPlan;
}

export type RemediateReport =
  | {
      readonly kind: "readapted-bundle";
      readonly pluginId: InstalledPluginId;
      readonly adaptedHooks: boolean;
      readonly adaptedMcp: boolean;
      readonly expandedPluginRoot: boolean;
    }
  | {
      readonly kind: "disabled-plugin";
      readonly pluginId: InstalledPluginId;
      readonly outcome: "changed" | "unchanged";
    }
  | {
      readonly kind: "removed-plugin";
      readonly pluginId: InstalledPluginId;
      readonly removedPath: AbsolutePath;
    }
  | {
      readonly kind: "cleaned-stale-staging";
      readonly removedPaths: readonly AbsolutePath[];
    }
  | {
      readonly kind: "retried-marketplace-sync";
      readonly outcome: MarketplaceSyncOutcome;
    };

/**
 * Frozen public domain engine contract. Owns all disk reads/writes, marketplace syncing,
 * manifest normalization, atomic bundle adaptation, diagnostics, remediation, and snapshot
 * projection. Both CLI and TUI depend exclusively on this interface.
 */
export interface PluginEngine {
  /** Reads disk and mtime-validated per-marketplace caches to project an immutable WorkspaceSnapshot without network I/O. */
  snapshot(): Promise<WorkspaceSnapshot>;

  /** Installs or updates a plugin bundle atomically into user or project scope. */
  install(input: InstallPluginInput): Promise<EngineResult<InstallReport>>;

  /** Atomically removes an installed plugin directory and its provenance receipt. */
  uninstall(input: UninstallPluginInput): Promise<EngineResult<UninstallReport>>;

  /** Toggles `disabled` in the target plugin's root `plugin.json` atomically. */
  setEnabled(input: SetPluginEnabledInput): Promise<EngineResult<ToggleReport>>;

  /** Updates one or all managed installed plugins from their recorded provenance sources. */
  update(input: UpdatePluginsInput): Promise<EngineResult<UpdateReport>>;

  /** Registers a new marketplace (GitHub/SSH/HTTPS/local) and runs its initial sync. */
  addMarketplace(input: AddMarketplaceInput): Promise<EngineResult<MarketplaceSyncReport>>;

  /** Syncs one marketplace or all configured marketplaces in parallel using isolated per-marketplace caches. */
  syncMarketplaces(input: SyncMarketplacesInput): Promise<EngineResult<BulkSyncReport>>;

  /** Removes a marketplace registration and local mirror without deleting installed plugins. */
  removeMarketplace(input: RemoveMarketplaceInput): Promise<EngineResult<RemoveMarketplaceReport>>;

  /** Runs read-only validation on a candidate source, an installed plugin, or the whole workspace. */
  validate(input: ValidateTargetInput): Promise<ValidationReport>;

  /** Executes a typed RemediationPlan emitted on a workspace Diagnostic and returns a fresh snapshot. */
  remediate(input: RemediateInput): Promise<EngineResult<RemediateReport>>;
}
