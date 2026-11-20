import { nextRequestId } from "../domain/types.ts";
import type { RequestId } from "../domain/types.ts";
import { formatEngineError } from "./state.ts";
import type {
  MutationOutcome,
  OverlayState,
  PendingMutationSpec,
  TuiEffect,
  TuiState,
} from "./state.ts";

export function withToast(
  state: TuiState,
  tone: "info" | "success" | "warning" | "error",
  text: string,
): TuiState {
  return {
    ...state,
    toast: { tone, text, id: state.nextToastId },
    nextToastId: state.nextToastId + 1,
  };
}

export function attachOverlayRequestId(
  overlay: OverlayState,
  requestId: RequestId,
): OverlayState {
  switch (overlay.kind) {
    case "discover-detail":
    case "installed-detail":
    case "marketplace-detail":
    case "add-marketplace":
    case "diagnostic-detail":
      return { ...overlay, pendingRequestId: requestId };
    case "none":
    case "search-input":
    case "confirm":
    case "help":
      return overlay;
    default: {
      const _exhaustive: never = overlay;
      return _exhaustive;
    }
  }
}

export function hasMatchingOverlayRequestId(
  overlay: OverlayState,
  requestId: RequestId,
): boolean {
  switch (overlay.kind) {
    case "discover-detail":
    case "installed-detail":
    case "marketplace-detail":
    case "add-marketplace":
    case "diagnostic-detail":
      return overlay.pendingRequestId === requestId;
    case "none":
    case "search-input":
    case "confirm":
    case "help":
      return false;
    default: {
      const _exhaustive: never = overlay;
      return _exhaustive;
    }
  }
}

export function clearOverlayRequestId(
  overlay: OverlayState,
  requestId: RequestId,
): OverlayState {
  switch (overlay.kind) {
    case "discover-detail":
    case "installed-detail":
    case "marketplace-detail":
    case "add-marketplace":
    case "diagnostic-detail":
      return overlay.pendingRequestId === requestId
        ? { ...overlay, pendingRequestId: undefined }
        : overlay;
    case "none":
    case "search-input":
    case "confirm":
    case "help":
      return overlay;
    default: {
      const _exhaustive: never = overlay;
      return _exhaustive;
    }
  }
}

export function startMutation(
  state: TuiState,
  mutation: PendingMutationSpec,
  nextOverlay?: OverlayState,
): readonly [TuiState, readonly TuiEffect[]] {
  if (state.pending.kind === "running") {
    return [withToast(state, "warning", `Busy: ${state.pending.label}`), []];
  }
  const requestId = state.nextRequestId;
  const targetOverlay = nextOverlay ?? attachOverlayRequestId(state.overlay, requestId);
  const nextState: TuiState = {
    ...state,
    overlay: targetOverlay,
    pending: { kind: "running", requestId, label: mutation.label },
    nextRequestId: nextRequestId(requestId),
    spinnerTick: 0,
  };
  return [nextState, [{ kind: "run-mutation", requestId, mutation }]];
}

export function startRescan(state: TuiState): readonly [TuiState, readonly TuiEffect[]] {
  if (state.pending.kind === "running") {
    return [withToast(state, "warning", `Busy: ${state.pending.label}`), []];
  }
  const requestId = state.nextRequestId;
  const nextState: TuiState = {
    ...state,
    pending: { kind: "running", requestId, label: "Rescanning workspace" },
    nextRequestId: nextRequestId(requestId),
    spinnerTick: 0,
  };
  return [nextState, [{ kind: "run-rescan", requestId }]];
}

export function summarizeMutationOutcome(outcome: MutationOutcome): {
  readonly tone: "success" | "warning" | "error";
  readonly text: string;
} {
  switch (outcome.kind) {
    case "install": {
      if (!outcome.result.ok) {
        return { tone: "error", text: formatEngineError(outcome.result.error) };
      }
      const { report } = outcome.result;
      const warnSuffix =
        report.warnings.length > 0 ? ` (${report.warnings.length} warning(s))` : "";
      return {
        tone: report.warnings.length > 0 ? "warning" : "success",
        text: `${report.outcome === "installed" ? "Installed" : "Updated"} ${report.pluginName} (${report.scope})${warnSuffix}.`,
      };
    }
    case "uninstall": {
      if (!outcome.result.ok) {
        return { tone: "error", text: formatEngineError(outcome.result.error) };
      }
      return {
        tone: "success",
        text: `Removed ${outcome.result.report.pluginId}.`,
      };
    }
    case "set-enabled": {
      if (!outcome.result.ok) {
        return { tone: "error", text: formatEngineError(outcome.result.error) };
      }
      const { report } = outcome.result;
      return {
        tone: "success",
        text: `${report.enabled ? "Enabled" : "Disabled"} ${report.pluginId}.`,
      };
    }
    case "update": {
      if (!outcome.result.ok) {
        return { tone: "error", text: formatEngineError(outcome.result.error) };
      }
      const outcomes = outcome.result.report.outcomes;
      const updated = outcomes.filter((o) => o.status === "updated").length;
      const failed = outcomes.filter((o) => o.status === "failed").length;
      if (failed > 0) {
        return {
          tone: "warning",
          text: `Updated ${updated}, failed ${failed} plugin(s).`,
        };
      }
      return {
        tone: "success",
        text:
          updated > 0
            ? `Updated ${updated} plugin(s).`
            : "All targeted plugins are up to date.",
      };
    }
    case "add-marketplace": {
      if (!outcome.result.ok) {
        return { tone: "error", text: formatEngineError(outcome.result.error) };
      }
      const sync = outcome.result.report.outcome;
      if (sync.status === "failed") {
        return {
          tone: "error",
          text: `Added ${sync.marketplaceId} but sync failed: ${sync.reason ?? "unknown error"}`,
        };
      }
      return {
        tone: "success",
        text: `Added marketplace ${sync.marketplaceId} (${sync.pluginCount} plugins).`,
      };
    }
    case "sync-marketplaces": {
      if (!outcome.result.ok) {
        return { tone: "error", text: formatEngineError(outcome.result.error) };
      }
      const outcomes = outcome.result.report.outcomes;
      const synced = outcomes.filter((o) => o.status === "synced").length;
      const failed = outcomes.filter((o) => o.status === "failed").length;
      if (failed > 0) {
        return {
          tone: "warning",
          text: `Synced ${synced} marketplace(s), ${failed} failed.`,
        };
      }
      return {
        tone: "success",
        text: `Synced ${synced} marketplace(s).`,
      };
    }
    case "remove-marketplace": {
      if (!outcome.result.ok) {
        return { tone: "error", text: formatEngineError(outcome.result.error) };
      }
      return {
        tone: "success",
        text: `Removed marketplace ${outcome.result.report.id}.`,
      };
    }
    case "remediate": {
      if (!outcome.result.ok) {
        return { tone: "error", text: formatEngineError(outcome.result.error) };
      }
      const { report } = outcome.result;
      switch (report.kind) {
        case "readapted-bundle":
          return { tone: "success", text: `Re-adapted bundle ${report.pluginId}.` };
        case "disabled-plugin":
          return { tone: "success", text: `Disabled colliding plugin ${report.pluginId}.` };
        case "removed-plugin":
          return { tone: "success", text: `Removed unsafe plugin ${report.pluginId}.` };
        case "cleaned-stale-staging":
          return {
            tone: "success",
            text: `Cleaned ${report.removedPaths.length} stale staging path(s).`,
          };
        case "retried-marketplace-sync":
          return report.outcome.status === "synced"
            ? {
                tone: "success",
                text: `Synced ${report.outcome.marketplaceId} (${report.outcome.pluginCount} plugins).`,
              }
            : {
                tone: "error",
                text: `Sync retry failed for ${report.outcome.marketplaceId}: ${report.outcome.reason ?? "error"}`,
              };
        default: {
          const _exhaustive: never = report;
          return _exhaustive;
        }
      }
    }
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}
