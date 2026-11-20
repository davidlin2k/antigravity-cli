import { deriveMarketplaceId, parseMarketplaceInput } from "../domain/query.ts";
import { parseMarketplaceId } from "../domain/types.ts";
import type {
  AbsolutePath,
  CatalogEntry,
  InstalledPlugin,
  InstallScope,
  MarketplaceId,
  WorkspaceSnapshot,
} from "../domain/types.ts";
import type { KeyEvent } from "./keys.ts";
import { startMutation, withToast } from "./reduce-mutations.ts";
import { reduceTextInput } from "./state.ts";
import type {
  AddMarketplacePreview,
  OverlayState,
  TuiEffect,
  TuiState,
} from "./state.ts";
import type { KeyHint } from "./tab-registry.ts";

export interface ReduceEnv {
  readonly cwd: AbsolutePath;
  readonly homeDir: AbsolutePath;
}

export type ModalOverlayState = Exclude<
  OverlayState,
  { readonly kind: "none" | "search-input" }
>;

export function findInstalledForEntryInScope(
  snapshot: WorkspaceSnapshot,
  entry: CatalogEntry,
  scope: InstallScope,
): InstalledPlugin | undefined {
  for (const plugin of snapshot.installed) {
    if (
      plugin.scope === scope &&
      plugin.provenance.kind === "marketplace" &&
      plugin.provenance.entryId === entry.id
    ) {
      return plugin;
    }
  }
  return undefined;
}

export function findSameNameCollisionInScope(
  snapshot: WorkspaceSnapshot,
  entry: CatalogEntry,
  scope: InstallScope,
): InstalledPlugin | undefined {
  const ids = snapshot.installedIdsByPluginName.get(entry.name);
  if (ids === undefined) {
    return undefined;
  }
  for (const id of ids) {
    const plugin = snapshot.installedById.get(id);
    if (
      plugin !== undefined &&
      plugin.scope === scope &&
      !(plugin.provenance.kind === "marketplace" && plugin.provenance.entryId === entry.id)
    ) {
      return plugin;
    }
  }
  return undefined;
}

function computeAddMarketplacePreview(raw: string, env: ReduceEnv): AddMarketplacePreview {
  if (raw.trim().length === 0) {
    return { kind: "empty" };
  }
  const parsed = parseMarketplaceInput({
    raw,
    cwd: env.cwd,
    homeDir: env.homeDir,
  });
  if (!parsed.ok) {
    return { kind: "invalid", message: parsed.error.message };
  }
  return {
    kind: "valid",
    source: parsed.value,
    suggestedId: deriveMarketplaceId(parsed.value),
  };
}

function cycleFocus<T extends string>(
  items: readonly T[],
  current: T,
  delta: 1 | -1,
): T {
  const idx = items.indexOf(current);
  if (idx === -1) {
    return items[0] ?? current;
  }
  const nextIdx = (idx + delta + items.length) % items.length;
  return items[nextIdx] ?? current;
}

function submitAddMarketplace(
  state: TuiState,
  overlay: Extract<OverlayState, { readonly kind: "add-marketplace" }>,
): readonly [TuiState, readonly TuiEffect[]] {
  if (overlay.preview.kind === "empty") {
    return [
      withToast(
        { ...state, overlay: { ...overlay, focusedField: "source" } },
        "error",
        "Enter a GitHub repo, SSH URL, HTTPS URL, or local path.",
      ),
      [],
    ];
  }
  if (overlay.preview.kind === "invalid") {
    return [
      withToast(
        { ...state, overlay: { ...overlay, focusedField: "source" } },
        "error",
        overlay.preview.message,
      ),
      [],
    ];
  }

  let customId: MarketplaceId | undefined;
  if (overlay.idInput.value.trim().length > 0) {
    const parsedId = parseMarketplaceId(overlay.idInput.value);
    if (!parsedId.ok) {
      return [
        withToast(
          { ...state, overlay: { ...overlay, focusedField: "id" } },
          "error",
          parsedId.error.message,
        ),
        [],
      ];
    }
    customId = parsedId.value;
  }

  const targetId = customId ?? overlay.preview.suggestedId;
  return startMutation(state, {
    kind: "add-marketplace",
    input:
      customId !== undefined
        ? { source: overlay.preview.source, id: customId }
        : { source: overlay.preview.source },
    label: `Adding marketplace ${targetId}`,
  });
}

export function reduceModalKey(
  state: TuiState,
  overlay: ModalOverlayState,
  key: KeyEvent,
  env: ReduceEnv,
): readonly [TuiState, readonly TuiEffect[]] {
  switch (overlay.kind) {
    case "discover-detail": {
      const entry = state.snapshot.catalogById.get(overlay.entryId);
      if (entry === undefined) {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      if (key.kind === "escape" || (key.kind === "char" && key.ch === "q")) {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      if (key.kind === "tab" || key.kind === "right") {
        const nextBtn = cycleFocus(["primary", "scope", "close"] as const, overlay.focusedButton, 1);
        return [{ ...state, overlay: { ...overlay, focusedButton: nextBtn } }, []];
      }
      if (key.kind === "shift-tab" || key.kind === "left") {
        const prevBtn = cycleFocus(
          ["primary", "scope", "close"] as const,
          overlay.focusedButton,
          -1,
        );
        return [{ ...state, overlay: { ...overlay, focusedButton: prevBtn } }, []];
      }
      if (key.kind === "char" && key.ch === "s") {
        const nextScope: InstallScope = overlay.targetScope === "user" ? "project" : "user";
        return [{ ...state, overlay: { ...overlay, targetScope: nextScope } }, []];
      }
      if (key.kind === "enter") {
        if (overlay.focusedButton === "close") {
          return [{ ...state, overlay: { kind: "none" } }, []];
        }
        if (overlay.focusedButton === "scope") {
          const nextScope: InstallScope = overlay.targetScope === "user" ? "project" : "user";
          return [{ ...state, overlay: { ...overlay, targetScope: nextScope } }, []];
        }
        const installedInScope = findInstalledForEntryInScope(
          state.snapshot,
          entry,
          overlay.targetScope,
        );
        if (installedInScope !== undefined) {
          const name =
            installedInScope.kind === "valid"
              ? installedInScope.manifest.name
              : installedInScope.dirName;
          return [
            {
              ...state,
              overlay: {
                kind: "confirm",
                title: "Uninstall plugin",
                message: `Remove "${name}" (${installedInScope.id}) from ${installedInScope.installPath}?`,
                confirmLabel: "Uninstall",
                mutation: {
                  kind: "uninstall",
                  input: { selector: { kind: "id", id: installedInScope.id } },
                  label: `Uninstalling ${installedInScope.id}`,
                },
                returnOverlay: overlay,
                focusedChoice: "cancel",
              },
            },
            [],
          ];
        }
        return startMutation(state, {
          kind: "install",
          input: {
            target: { kind: "catalog-entry", entryId: entry.id },
            scope: overlay.targetScope,
          },
          label: `Installing ${entry.name} (${overlay.targetScope})`,
        });
      }
      return [state, []];
    }

    case "installed-detail": {
      const plugin = state.snapshot.installedById.get(overlay.pluginId);
      if (plugin === undefined) {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      if (key.kind === "escape" || (key.kind === "char" && key.ch === "q")) {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      const actions: readonly ("toggle" | "update" | "uninstall" | "close")[] =
        plugin.kind === "valid"
          ? plugin.provenance.kind !== "unmanaged"
            ? ["toggle", "update", "uninstall", "close"]
            : ["toggle", "uninstall", "close"]
          : ["uninstall", "close"];

      if (key.kind === "tab" || key.kind === "right") {
        const nextAction = cycleFocus(actions, overlay.focusedAction, 1);
        return [{ ...state, overlay: { ...overlay, focusedAction: nextAction } }, []];
      }
      if (key.kind === "shift-tab" || key.kind === "left") {
        const prevAction = cycleFocus(actions, overlay.focusedAction, -1);
        return [{ ...state, overlay: { ...overlay, focusedAction: prevAction } }, []];
      }

      const runAction = (
        action: "toggle" | "update" | "uninstall" | "close",
      ): readonly [TuiState, readonly TuiEffect[]] => {
        if (action === "close") {
          return [{ ...state, overlay: { kind: "none" } }, []];
        }
        if (action === "toggle" && plugin.kind === "valid") {
          const enable = plugin.activation.kind === "disabled";
          return startMutation(state, {
            kind: "set-enabled",
            input: { selector: { kind: "id", id: plugin.id }, enabled: enable },
            label: `${enable ? "Enabling" : "Disabling"} ${plugin.manifest.name}`,
          });
        }
        if (action === "update" && plugin.provenance.kind !== "unmanaged") {
          return startMutation(state, {
            kind: "update",
            input: { kind: "single", selector: { kind: "id", id: plugin.id } },
            label: `Updating ${plugin.id}`,
          });
        }
        if (action === "uninstall") {
          const name = plugin.kind === "valid" ? plugin.manifest.name : plugin.dirName;
          return [
            {
              ...state,
              overlay: {
                kind: "confirm",
                title: "Uninstall plugin",
                message: `Remove "${name}" (${plugin.id}) from ${plugin.installPath}?`,
                confirmLabel: "Uninstall",
                mutation: {
                  kind: "uninstall",
                  input: { selector: { kind: "id", id: plugin.id } },
                  label: `Uninstalling ${plugin.id}`,
                },
                returnOverlay: overlay,
                focusedChoice: "cancel",
              },
            },
            [],
          ];
        }
        return [state, []];
      };

      if (key.kind === "char" && key.ch === " ") {
        return runAction("toggle");
      }
      if (key.kind === "char" && key.ch === "u") {
        return runAction("update");
      }
      if (key.kind === "char" && key.ch === "x") {
        return runAction("uninstall");
      }
      if (key.kind === "enter") {
        return runAction(overlay.focusedAction);
      }
      return [state, []];
    }

    case "marketplace-detail": {
      const mkt = state.snapshot.marketplacesById.get(overlay.marketplaceId);
      if (mkt === undefined) {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      if (key.kind === "escape" || (key.kind === "char" && key.ch === "q")) {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      const actions = ["update", "remove", "close"] as const;
      if (key.kind === "tab" || key.kind === "right") {
        const nextAction = cycleFocus(actions, overlay.focusedAction, 1);
        return [{ ...state, overlay: { ...overlay, focusedAction: nextAction } }, []];
      }
      if (key.kind === "shift-tab" || key.kind === "left") {
        const prevAction = cycleFocus(actions, overlay.focusedAction, -1);
        return [{ ...state, overlay: { ...overlay, focusedAction: prevAction } }, []];
      }
      const runMktAction = (
        action: "update" | "remove" | "close",
      ): readonly [TuiState, readonly TuiEffect[]] => {
        if (action === "close") {
          return [{ ...state, overlay: { kind: "none" } }, []];
        }
        if (action === "update") {
          return startMutation(state, {
            kind: "sync-marketplaces",
            input: { kind: "single", id: mkt.id },
            label: `Syncing marketplace ${mkt.id}`,
          });
        }
        return [
          {
            ...state,
            overlay: {
              kind: "confirm",
              title: "Remove marketplace",
              message: `Remove marketplace "${mkt.id}" and its local mirror? Installed plugins remain untouched.`,
              confirmLabel: "Remove",
              mutation: {
                kind: "remove-marketplace",
                input: { id: mkt.id },
                label: `Removing marketplace ${mkt.id}`,
              },
              returnOverlay: overlay,
              focusedChoice: "cancel",
            },
          },
          [],
        ];
      };
      if (key.kind === "char" && key.ch === "u") {
        return runMktAction("update");
      }
      if (key.kind === "char" && key.ch === "d") {
        return runMktAction("remove");
      }
      if (key.kind === "enter") {
        return runMktAction(overlay.focusedAction);
      }
      return [state, []];
    }

    case "add-marketplace": {
      if (key.kind === "escape") {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      const fields = ["source", "id", "submit", "cancel"] as const;
      if (key.kind === "tab" || key.kind === "down") {
        const nextField = cycleFocus(fields, overlay.focusedField, 1);
        return [{ ...state, overlay: { ...overlay, focusedField: nextField } }, []];
      }
      if (key.kind === "shift-tab" || key.kind === "up") {
        const prevField = cycleFocus(fields, overlay.focusedField, -1);
        return [{ ...state, overlay: { ...overlay, focusedField: prevField } }, []];
      }

      if (overlay.focusedField === "source") {
        if (key.kind === "enter") {
          return submitAddMarketplace(state, overlay);
        }
        const edited = reduceTextInput(overlay.sourceInput, key);
        if (edited.handled) {
          const preview = computeAddMarketplacePreview(edited.next.value, env);
          return [
            {
              ...state,
              overlay: { ...overlay, sourceInput: edited.next, preview },
            },
            [],
          ];
        }
        return [state, []];
      }

      if (overlay.focusedField === "id") {
        if (key.kind === "enter") {
          return submitAddMarketplace(state, overlay);
        }
        const edited = reduceTextInput(overlay.idInput, key);
        if (edited.handled) {
          return [{ ...state, overlay: { ...overlay, idInput: edited.next } }, []];
        }
        return [state, []];
      }

      if (key.kind === "left" || key.kind === "right") {
        const toggled = overlay.focusedField === "submit" ? "cancel" : "submit";
        return [{ ...state, overlay: { ...overlay, focusedField: toggled } }, []];
      }

      if (key.kind === "enter" || (key.kind === "char" && key.ch === " ")) {
        if (overlay.focusedField === "cancel") {
          return [{ ...state, overlay: { kind: "none" } }, []];
        }
        return submitAddMarketplace(state, overlay);
      }

      return [state, []];
    }

    case "diagnostic-detail": {
      const diag = state.snapshot.diagnosticsById.get(overlay.diagnosticId);
      if (diag === undefined) {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      if (key.kind === "escape" || (key.kind === "char" && key.ch === "q")) {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      if (diag.remediation !== undefined) {
        if (
          key.kind === "tab" ||
          key.kind === "shift-tab" ||
          key.kind === "left" ||
          key.kind === "right"
        ) {
          const next = overlay.focusedAction === "fix" ? "close" : "fix";
          return [{ ...state, overlay: { ...overlay, focusedAction: next } }, []];
        }
        if (key.kind === "char" && key.ch === "f") {
          return startMutation(state, {
            kind: "remediate",
            input: { plan: diag.remediation },
            label: diag.remediation.label,
          });
        }
        if (key.kind === "enter" && overlay.focusedAction === "fix") {
          return startMutation(state, {
            kind: "remediate",
            input: { plan: diag.remediation },
            label: diag.remediation.label,
          });
        }
      }
      if (key.kind === "enter") {
        return [{ ...state, overlay: { kind: "none" } }, []];
      }
      return [state, []];
    }

    case "confirm": {
      if (key.kind === "escape" || (key.kind === "char" && (key.ch === "n" || key.ch === "N"))) {
        return [{ ...state, overlay: overlay.returnOverlay }, []];
      }
      if (
        key.kind === "tab" ||
        key.kind === "shift-tab" ||
        key.kind === "left" ||
        key.kind === "right"
      ) {
        const nextChoice = overlay.focusedChoice === "confirm" ? "cancel" : "confirm";
        return [{ ...state, overlay: { ...overlay, focusedChoice: nextChoice } }, []];
      }
      if (key.kind === "char" && (key.ch === "y" || key.ch === "Y")) {
        return startMutation(state, overlay.mutation, { kind: "none" });
      }
      if (key.kind === "enter") {
        if (overlay.focusedChoice === "confirm") {
          return startMutation(state, overlay.mutation, { kind: "none" });
        }
        return [{ ...state, overlay: overlay.returnOverlay }, []];
      }
      return [state, []];
    }

    case "help": {
      if (
        key.kind === "escape" ||
        key.kind === "enter" ||
        (key.kind === "char" && (key.ch === "q" || key.ch === "?"))
      ) {
        return [{ ...state, overlay: overlay.returnOverlay }, []];
      }
      return [state, []];
    }

    default: {
      const _exhaustive: never = overlay;
      return _exhaustive;
    }
  }
}

export function computeModalFooterHints(
  state: TuiState,
  overlay: ModalOverlayState,
): readonly KeyHint[] {
  switch (overlay.kind) {
    case "discover-detail":
      return [
        { keys: "Tab/←/→", label: "focus button" },
        { keys: "s", label: "scope" },
        { keys: "Enter", label: "run focused action" },
        { keys: "Esc", label: "back" },
      ];
    case "installed-detail": {
      const plugin = state.snapshot.installedById.get(overlay.pluginId);
      const hints: KeyHint[] = [{ keys: "Tab/←/→", label: "focus action" }];
      if (plugin?.kind === "valid") {
        hints.push({ keys: "Space", label: "toggle" });
      }
      hints.push({ keys: "Enter", label: "run focused action" });
      hints.push({ keys: "Esc", label: "back" });
      return hints;
    }
    case "marketplace-detail":
      return [
        { keys: "Tab/←/→", label: "focus action" },
        { keys: "u", label: "update" },
        { keys: "d", label: "remove" },
        { keys: "Enter", label: "run" },
        { keys: "Esc", label: "back" },
      ];
    case "add-marketplace":
      return [
        { keys: "Tab/↑/↓", label: "next field" },
        { keys: "Enter", label: "submit" },
        { keys: "Esc", label: "cancel" },
      ];
    case "diagnostic-detail": {
      const diag = state.snapshot.diagnosticsById.get(overlay.diagnosticId);
      const hints: KeyHint[] = [];
      if (diag?.remediation !== undefined) {
        hints.push({ keys: "Tab/←/→", label: "focus button" });
        hints.push({ keys: "f", label: "fix" });
      }
      hints.push({ keys: "Enter", label: "run" });
      hints.push({ keys: "Esc", label: "back" });
      return hints;
    }
    case "confirm":
      return [
        { keys: "Tab/←/→", label: "choose" },
        { keys: "y", label: "confirm" },
        { keys: "Enter", label: "run" },
        { keys: "Esc", label: "cancel" },
      ];
    case "help":
      return [{ keys: "Esc/Enter", label: "close help" }];
    default: {
      const _exhaustive: never = overlay;
      return _exhaustive;
    }
  }
}
