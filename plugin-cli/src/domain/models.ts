import type {
  AbsolutePath,
  AtLeastTwo,
  CatalogEntryId,
  DiagnosticId,
  HttpUrl,
  InstalledPluginId,
  InstallScope,
  IsoTimestamp,
  ManifestEcosystem,
  MarketplaceId,
  NonEmpty,
  PluginDirName,
  PluginName,
  RelativeSubpath,
  RemoteGitUrl,
  SnapshotRevision,
  SshGitUrl,
} from "./primitives.ts";

/**
 * Concrete persisted marketplace source. Ambiguous HTTPS URLs are resolved once at
 * the `addMarketplace` boundary into either `https-git` or `https-json`.
 */
export type MarketplaceSource =
  | {
      readonly kind: "github";
      readonly owner: string;
      readonly repo: string;
      readonly ref?: string;
      readonly subdir?: RelativeSubpath;
    }
  | {
      readonly kind: "ssh";
      readonly url: SshGitUrl;
      readonly ref?: string;
      readonly subdir?: RelativeSubpath;
    }
  | {
      readonly kind: "https-git";
      readonly url: HttpUrl;
      readonly ref?: string;
      readonly subdir?: RelativeSubpath;
    }
  | {
      readonly kind: "https-json";
      readonly url: HttpUrl;
    }
  | {
      readonly kind: "local-folder";
      readonly path: AbsolutePath;
    }
  | {
      readonly kind: "local-json";
      readonly path: AbsolutePath;
    };

export type GithubMarketplaceSource = Extract<MarketplaceSource, { readonly kind: "github" }>;

export type ParsedMarketplaceInput =
  | MarketplaceSource
  | {
      readonly kind: "https-auto";
      readonly url: HttpUrl;
      readonly ref?: string;
      readonly subdir?: RelativeSubpath;
    };

export type PluginInstallSource =
  | {
      readonly kind: "marketplace-root";
      readonly marketplaceId: MarketplaceId;
    }
  | {
      readonly kind: "marketplace-subdir";
      readonly marketplaceId: MarketplaceId;
      readonly subdir: RelativeSubpath;
    }
  | {
      readonly kind: "git-subdir";
      readonly repoUrl: RemoteGitUrl;
      readonly subdir: RelativeSubpath;
      readonly ref?: string;
      readonly sha?: string;
    }
  | {
      readonly kind: "git-repo";
      readonly repoUrl: RemoteGitUrl;
      readonly ref?: string;
      readonly sha?: string;
    }
  | {
      readonly kind: "archive-url";
      readonly url: HttpUrl;
      readonly sha256?: string;
    }
  | {
      readonly kind: "local-dir";
      readonly path: AbsolutePath;
    };

/**
 * Strictly valid Antigravity root `plugin.json` fields. Unknown fields from Claude or
 * Cursor manifests are stripped during adaptation because Antigravity drops them silently.
 */
export interface NormalizedPluginManifest {
  readonly name: PluginName;
  readonly displayName?: string;
  readonly description?: string;
  readonly version?: string;
  readonly author?: string;
  readonly homepage?: string;
  readonly repository?: string;
  readonly logo?: string;
  readonly suggestedPrompts?: readonly string[];
  readonly disabled?: boolean;
}

export interface ComponentCounts {
  readonly skills: number;
  readonly agents: number;
  readonly rules: number;
  readonly hooks: number;
  readonly mcpServers: number;
}

export const EMPTY_COMPONENT_COUNTS: ComponentCounts = {
  skills: 0,
  agents: 0,
  rules: 0,
  hooks: 0,
  mcpServers: 0,
};

export interface SkillSummary {
  readonly name: string;
  readonly folderName: string;
  readonly description: string;
  readonly frontmatterNamePresent: boolean;
  readonly estimatedTokens: number;
}

export interface AgentSummary {
  readonly name: string;
  readonly fileName: string;
  readonly description: string;
}

export interface RuleSummary {
  readonly name: string;
  readonly relativePath: RelativeSubpath;
}

export interface HookSummary {
  readonly event: string;
  readonly commandCount: number;
}

export interface McpServerSummary {
  readonly name: string;
  readonly transport: "stdio" | "http" | "unknown";
  readonly eager: boolean;
}

export interface ComponentInventory {
  readonly counts: ComponentCounts;
  readonly skills: readonly SkillSummary[];
  readonly agents: readonly AgentSummary[];
  readonly rules: readonly RuleSummary[];
  readonly hooks: readonly HookSummary[];
  readonly mcpServers: readonly McpServerSummary[];
}

export const EMPTY_COMPONENT_INVENTORY: ComponentInventory = {
  counts: EMPTY_COMPONENT_COUNTS,
  skills: [],
  agents: [],
  rules: [],
  hooks: [],
  mcpServers: [],
};

export interface CatalogEntry {
  readonly id: CatalogEntryId;
  readonly marketplaceId: MarketplaceId;
  readonly slug: PluginDirName;
  readonly name: PluginName;
  readonly displayName: string;
  readonly description: string;
  readonly version: string | null;
  readonly author: string | null;
  readonly category: string | null;
  readonly tags: readonly string[];
  readonly homepage: string | null;
  readonly repository: string | null;
  readonly sourceFormat: ManifestEcosystem;
  readonly installSource: PluginInstallSource;
  readonly componentCounts: ComponentCounts | null;
  readonly componentsPreview: ComponentInventory | null;
}

export type InstallProvenance =
  | {
      readonly kind: "marketplace";
      readonly marketplaceId: MarketplaceId;
      readonly entryId: CatalogEntryId;
      readonly installSource: PluginInstallSource;
      readonly installedVersion: string | null;
      readonly installedSha: string | null;
      readonly installedAt: IsoTimestamp;
    }
  | {
      readonly kind: "direct";
      readonly installSource: PluginInstallSource;
      readonly installedVersion: string | null;
      readonly installedSha: string | null;
      readonly installedAt: IsoTimestamp;
    }
  | {
      readonly kind: "unmanaged";
    };

/**
 * Effective runtime status in Antigravity. A disabled plugin cannot be shadowed,
 * making `{ disabled: true, shadowedBy: ... }` unrepresentable.
 */
export type PluginActivation =
  | { readonly kind: "active" }
  | { readonly kind: "disabled" }
  | { readonly kind: "shadowed"; readonly shadowedBy: InstalledPluginId };

export interface VersionUpdate {
  readonly latestVersion: string;
  readonly sourceEntryId: CatalogEntryId;
}

export interface ValidInstalledPlugin {
  readonly kind: "valid";
  readonly id: InstalledPluginId;
  readonly scope: InstallScope;
  readonly dirName: PluginDirName;
  readonly installPath: AbsolutePath;
  readonly manifest: NormalizedPluginManifest;
  readonly activation: PluginActivation;
  readonly provenance: InstallProvenance;
  readonly components: ComponentInventory;
  readonly diskBytes: number;
  readonly estimatedDescriptionTokens: number;
  readonly updateAvailable: VersionUpdate | null;
  readonly diagnosticIds: readonly DiagnosticId[];
}

export interface BrokenInstalledPlugin {
  readonly kind: "broken";
  readonly id: InstalledPluginId;
  readonly scope: InstallScope;
  readonly dirName: PluginDirName;
  readonly installPath: AbsolutePath;
  readonly provenance: InstallProvenance;
  readonly diskBytes: number;
  readonly diagnosticIds: NonEmpty<DiagnosticId>;
}

export type InstalledPlugin = ValidInstalledPlugin | BrokenInstalledPlugin;

export type MarketplaceSyncState =
  | {
      readonly kind: "synced";
      readonly syncedAt: IsoTimestamp;
      readonly resolvedRef: string | null;
      readonly resolvedSha: string | null;
      readonly format: ManifestEcosystem;
      readonly pluginCount: number;
    }
  | {
      readonly kind: "never-synced";
    }
  | {
      readonly kind: "sync-failed";
      readonly attemptedAt: IsoTimestamp;
      readonly lastGoodSyncAt: IsoTimestamp | null;
      readonly reason: string;
    };

export interface MarketplaceRecord {
  readonly id: MarketplaceId;
  readonly source: MarketplaceSource;
  readonly addedAt: IsoTimestamp;
  readonly sync: MarketplaceSyncState;
  readonly localMirrorPath: AbsolutePath | null;
}

export type RemediationPlan =
  | {
      readonly kind: "readapt-bundle";
      readonly pluginId: InstalledPluginId;
      readonly label: string;
    }
  | {
      readonly kind: "disable-plugin";
      readonly pluginId: InstalledPluginId;
      readonly label: string;
    }
  | {
      readonly kind: "remove-plugin";
      readonly pluginId: InstalledPluginId;
      readonly label: string;
    }
  | {
      readonly kind: "clean-stale-staging";
      readonly path?: AbsolutePath;
      readonly label: string;
    }
  | {
      readonly kind: "retry-marketplace-sync";
      readonly marketplaceId: MarketplaceId;
      readonly label: string;
    };

export type DiagnosticSeverity = "error" | "warning";

export type DiagnosticSubject =
  | { readonly kind: "installed"; readonly pluginId: InstalledPluginId }
  | { readonly kind: "marketplace"; readonly marketplaceId: MarketplaceId }
  | { readonly kind: "path"; readonly path: AbsolutePath };

export type DiagnosticDetail =
  | {
      readonly kind: "manifest-json-syntax";
      readonly filePath: AbsolutePath;
      readonly line: number | null;
      readonly column: number | null;
      readonly hadUtf8Bom: boolean;
      readonly syntaxError: string;
    }
  | {
      readonly kind: "manifest-schema-invalid";
      readonly filePath: AbsolutePath;
      readonly fieldErrors: NonEmpty<string>;
    }
  | {
      readonly kind: "name-collision";
      readonly collidingName: PluginName;
      readonly winnerId: InstalledPluginId;
      readonly participants: AtLeastTwo<InstalledPluginId>;
    }
  | {
      readonly kind: "skill-frontmatter-missing";
      readonly skillFilePath: AbsolutePath;
      readonly folderName: string;
      readonly missingFields: NonEmpty<"frontmatter" | "name" | "description">;
    }
  | {
      readonly kind: "path-traversal-rejected";
      readonly offendingPath: string;
      readonly resolvedOutsideRoot: string;
    }
  | {
      readonly kind: "hooks-invalid";
      readonly filePath: AbsolutePath;
      readonly reason: string;
    }
  | {
      readonly kind: "mcp-config-invalid";
      readonly filePath: AbsolutePath;
      readonly reason: string;
    }
  | {
      readonly kind: "unadapted-hooks-path";
      readonly sourcePath: AbsolutePath;
      readonly expectedPath: AbsolutePath;
    }
  | {
      readonly kind: "unadapted-mcp-path";
      readonly sourcePath: AbsolutePath;
      readonly expectedPath: AbsolutePath;
    }
  | {
      readonly kind: "unexpanded-plugin-root";
      readonly filePath: AbsolutePath;
      readonly variables: NonEmpty<string>;
    }
  | {
      readonly kind: "stale-staging-artifact";
      readonly artifactPath: AbsolutePath;
      readonly scope: InstallScope;
      readonly artifactKind: "staging" | "backup";
    }
  | {
      readonly kind: "marketplace-sync-failed";
      readonly marketplaceId: MarketplaceId;
      readonly reason: string;
    }
  | {
      readonly kind: "marketplace-manifest-invalid";
      readonly marketplaceId: MarketplaceId;
      readonly filePath: AbsolutePath;
      readonly reason: string;
    }
  | {
      readonly kind: "orphaned-install-dir";
      readonly dirPath: AbsolutePath;
      readonly reason: string;
    }
  | {
      readonly kind: "orphaned-receipt";
      readonly pluginId: InstalledPluginId;
      readonly expectedPath: AbsolutePath;
    };

export interface Diagnostic {
  readonly id: DiagnosticId;
  readonly severity: DiagnosticSeverity;
  readonly subject: DiagnosticSubject;
  readonly detail: DiagnosticDetail;
  readonly message: string;
  readonly hint: string;
  readonly remediation?: RemediationPlan;
}

export interface ScopeStats {
  readonly scope: InstallScope;
  readonly pluginsRoot: AbsolutePath;
  readonly installedCount: number;
  readonly activeCount: number;
  readonly disabledCount: number;
  readonly brokenCount: number;
  readonly diskBytes: number;
  readonly componentTotals: ComponentCounts;
}

export interface MarketplaceStats {
  readonly marketplaceId: MarketplaceId;
  readonly catalogCount: number;
  readonly installedFromCount: number;
  readonly syncStatus: MarketplaceSyncState["kind"];
}

export interface PluginFootprint {
  readonly pluginId: InstalledPluginId;
  readonly pluginName: PluginName;
  readonly scope: InstallScope;
  readonly estimatedDescriptionTokens: number;
  readonly diskBytes: number;
  readonly skillCount: number;
}

export interface WorkspaceStats {
  readonly discoverableCount: number;
  readonly installedCount: number;
  readonly activeCount: number;
  readonly disabledCount: number;
  readonly shadowedCount: number;
  readonly brokenCount: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly activeComponents: ComponentCounts;
  readonly installedComponents: ComponentCounts;
  readonly estimatedDescriptionTokens: number;
  readonly totalDiskBytes: number;
  readonly byScope: Readonly<Record<InstallScope, ScopeStats>>;
  readonly byMarketplace: readonly MarketplaceStats[];
  readonly topTokenConsumers: readonly PluginFootprint[];
}

export interface WorkspacePaths {
  readonly homeDir: AbsolutePath;
  readonly configDir: AbsolutePath;
  readonly workspaceDir: AbsolutePath;
  readonly userPluginsDir: AbsolutePath;
  readonly projectPluginsDir: AbsolutePath;
  readonly managerDir: AbsolutePath;
}

export interface WorkspaceSnapshot {
  readonly revision: SnapshotRevision;
  readonly projectedAt: IsoTimestamp;
  readonly paths: WorkspacePaths;
  readonly catalog: readonly CatalogEntry[];
  readonly installed: readonly InstalledPlugin[];
  readonly marketplaces: readonly MarketplaceRecord[];
  readonly diagnostics: readonly Diagnostic[];
  readonly staleStagingPaths: readonly AbsolutePath[];
  readonly stats: WorkspaceStats;
  readonly catalogById: ReadonlyMap<CatalogEntryId, CatalogEntry>;
  readonly installedById: ReadonlyMap<InstalledPluginId, InstalledPlugin>;
  readonly marketplacesById: ReadonlyMap<MarketplaceId, MarketplaceRecord>;
  readonly diagnosticsById: ReadonlyMap<DiagnosticId, Diagnostic>;
  readonly installedIdsByPluginName: ReadonlyMap<PluginName, readonly InstalledPluginId[]>;
}

export type InstallTarget =
  | { readonly kind: "catalog-entry"; readonly entryId: CatalogEntryId }
  | {
      readonly kind: "catalog-name";
      readonly name: PluginName;
      readonly marketplaceId?: MarketplaceId;
    }
  | {
      readonly kind: "catalog-or-github";
      readonly left: string;
      readonly right: string;
      readonly githubSource: GithubMarketplaceSource;
    }
  | { readonly kind: "direct-source"; readonly source: ParsedMarketplaceInput };

export type InstalledPluginSelector =
  | { readonly kind: "id"; readonly id: InstalledPluginId }
  | { readonly kind: "name"; readonly name: PluginName; readonly scope?: InstallScope };

export type EngineError =
  | { readonly kind: "marketplace-exists"; readonly id: MarketplaceId }
  | { readonly kind: "marketplace-not-found"; readonly id: MarketplaceId }
  | { readonly kind: "marketplace-sync-failed"; readonly id: MarketplaceId; readonly reason: string }
  | { readonly kind: "plugin-not-found"; readonly selector: string }
  | {
      readonly kind: "ambiguous-plugin-selector";
      readonly name: PluginName;
      readonly matches: AtLeastTwo<InstalledPluginId>;
    }
  | { readonly kind: "catalog-entry-not-found"; readonly target: string }
  | {
      readonly kind: "ambiguous-catalog-target";
      readonly name: PluginName;
      readonly candidates: AtLeastTwo<CatalogEntryId>;
    }
  | {
      readonly kind: "name-collision";
      readonly pluginName: PluginName;
      readonly existingId: InstalledPluginId;
      readonly targetScope: InstallScope;
    }
  | {
      readonly kind: "bundle-invalid";
      readonly diagnostics: NonEmpty<Diagnostic>;
    }
  | { readonly kind: "path-traversal"; readonly offendingPath: string }
  | { readonly kind: "lock-busy"; readonly target: string }
  | {
      readonly kind: "remediation-failed";
      readonly planKind: RemediationPlan["kind"];
      readonly reason: string;
    }
  | { readonly kind: "io-failed"; readonly operation: string; readonly reason: string };

/**
 * Every engine mutation returns a fresh WorkspaceSnapshot on both success and failure,
 * keeping callers synchronized with on-disk state and persisted sync failures.
 */
export type EngineResult<TReport> =
  | { readonly ok: true; readonly report: TReport; readonly snapshot: WorkspaceSnapshot }
  | { readonly ok: false; readonly error: EngineError; readonly snapshot: WorkspaceSnapshot };
