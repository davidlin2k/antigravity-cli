import type { InstallScope } from "../domain/types.ts";
import type { PluginEngine } from "../engine/contract.ts";
import { createKeyDecoder } from "./ansi.ts";
import type { ReduceEnv } from "./reduce.ts";
import { reduce } from "./reduce.ts";
import { diffFrames, renderFrame } from "./render.ts";
import { createInitialTuiState } from "./state.ts";
import type {
  MutationOutcome,
  PendingMutationSpec,
  RenderedFrame,
  TabId,
  TuiEffect,
  TuiEvent,
  TuiState,
} from "./state.ts";
import type { TerminalPort } from "./terminal.ts";

export * from "./ansi.ts";
export * from "./state.ts";
export * from "./tab-registry.ts";
export * from "./tabs.ts";
export * from "./reduce.ts";
export * from "./render.ts";
export * from "./terminal.ts";

export interface RunTuiOptions {
  readonly initialTab?: TabId;
  readonly defaultInstallScope?: InstallScope;
  readonly escapeFlushMs?: number;
  readonly spinnerIntervalMs?: number;
  readonly toastDurationMs?: number;
}

async function executeMutation(
  engine: PluginEngine,
  mutation: PendingMutationSpec,
): Promise<MutationOutcome> {
  switch (mutation.kind) {
    case "install":
      return { kind: "install", result: await engine.install(mutation.input) };
    case "uninstall":
      return { kind: "uninstall", result: await engine.uninstall(mutation.input) };
    case "set-enabled":
      return { kind: "set-enabled", result: await engine.setEnabled(mutation.input) };
    case "update":
      return { kind: "update", result: await engine.update(mutation.input) };
    case "add-marketplace":
      return { kind: "add-marketplace", result: await engine.addMarketplace(mutation.input) };
    case "sync-marketplaces":
      return { kind: "sync-marketplaces", result: await engine.syncMarketplaces(mutation.input) };
    case "remove-marketplace":
      return { kind: "remove-marketplace", result: await engine.removeMarketplace(mutation.input) };
    case "remediate":
      return { kind: "remediate", result: await engine.remediate(mutation.input) };
    default: {
      const _exhaustive: never = mutation;
      return _exhaustive;
    }
  }
}

/**
 * Runs the interactive 5-tab TUI loop against a PluginEngine and TerminalPort.
 */
export async function runTui(
  engine: PluginEngine,
  terminal: TerminalPort,
  options: RunTuiOptions = {},
): Promise<number> {
  const initialSnapshot = await engine.snapshot();
  const env: ReduceEnv = {
    cwd: initialSnapshot.paths.workspaceDir,
    homeDir: initialSnapshot.paths.homeDir,
  };
  let state: TuiState = createInitialTuiState(initialSnapshot, {
    initialTab: options.initialTab,
    defaultInstallScope: options.defaultInstallScope,
    colorEnabled: terminal.colorEnabled,
  });

  const escapeFlushMs = options.escapeFlushMs ?? 35;
  const spinnerIntervalMs = options.spinnerIntervalMs ?? 90;
  const toastDurationMs = options.toastDurationMs ?? 4500;
  const keyDecoder = createKeyDecoder();

  let viewport = terminal.getViewport();
  let lastFrame: RenderedFrame | null = null;
  let closed = false;
  let escapeTimer: ReturnType<typeof setTimeout> | null = null;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let lastToastIdSeen = 0;

  let resolveExit: ((code: number) => void) | null = null;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  function clearTimers(): void {
    if (escapeTimer !== null) {
      clearTimeout(escapeTimer);
      escapeTimer = null;
    }
    if (spinnerTimer !== null) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  }

  function finish(code: number): void {
    if (closed) {
      return;
    }
    closed = true;
    clearTimers();
    resolveExit?.(code);
  }

  function syncTimers(): void {
    if (state.pending.kind === "running" && spinnerTimer === null) {
      spinnerTimer = setInterval(() => {
        dispatch({ kind: "spinner-tick" });
      }, spinnerIntervalMs);
    } else if (state.pending.kind !== "running" && spinnerTimer !== null) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }

    if (state.toast !== null && state.toast.id !== lastToastIdSeen) {
      lastToastIdSeen = state.toast.id;
      if (toastTimer !== null) {
        clearTimeout(toastTimer);
      }
      const scheduledToastId = state.toast.id;
      toastTimer = setTimeout(() => {
        if (state.toast !== null && state.toast.id === scheduledToastId) {
          dispatch({ kind: "dismiss-toast" });
        }
      }, toastDurationMs);
    }
  }

  function paint(): void {
    const nextFrame = renderFrame(state, viewport);
    const patch = diffFrames(lastFrame, nextFrame);
    if (patch.length > 0) {
      terminal.write(patch);
    }
    lastFrame = nextFrame;
  }

  function runEffect(effect: TuiEffect): void {
    switch (effect.kind) {
      case "exit":
        finish(effect.code);
        return;

      case "run-rescan":
        void engine
          .snapshot()
          .then((snapshot) => {
            dispatch({
              kind: "rescan-finished",
              requestId: effect.requestId,
              snapshot,
            });
          })
          .catch((error: unknown) => {
            dispatch({
              kind: "rescan-failed",
              requestId: effect.requestId,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        return;

      case "run-mutation":
        void executeMutation(engine, effect.mutation)
          .then((outcome) => {
            dispatch({
              kind: "mutation-finished",
              requestId: effect.requestId,
              label: effect.mutation.label,
              outcome,
            });
          })
          .catch(async (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            let latestSnapshot = state.snapshot;
            try {
              latestSnapshot = await engine.snapshot();
            } catch {
              // Keep current snapshot when recovery read also fails.
            }
            dispatch({
              kind: "mutation-finished",
              requestId: effect.requestId,
              label: effect.mutation.label,
              outcome: {
                kind: "remediate",
                result: {
                  ok: false,
                  error: {
                    kind: "io-failed",
                    operation: effect.mutation.label,
                    reason: message,
                  },
                  snapshot: latestSnapshot,
                },
              },
            });
          });
        return;

      default: {
        const _exhaustive: never = effect;
        return _exhaustive;
      }
    }
  }

  function dispatch(event: TuiEvent): void {
    if (closed) {
      return;
    }
    const [nextState, effects] = reduce(state, event, env);
    state = nextState;
    for (const effect of effects) {
      runEffect(effect);
      if (closed) {
        return;
      }
    }
    syncTimers();
    paint();
  }

  terminal.enterRawAltScreen();
  const stopData = terminal.onData((chunk) => {
    if (escapeTimer !== null) {
      clearTimeout(escapeTimer);
      escapeTimer = null;
    }
    const keys = keyDecoder.push(chunk);
    for (const key of keys) {
      dispatch({ kind: "key", key });
      if (closed) {
        return;
      }
    }
    if (keyDecoder.hasPendingEscape()) {
      escapeTimer = setTimeout(() => {
        escapeTimer = null;
        for (const key of keyDecoder.flush()) {
          dispatch({ kind: "key", key });
          if (closed) {
            return;
          }
        }
      }, escapeFlushMs);
    }
  });

  const stopResize = terminal.onResize((nextViewport) => {
    viewport = nextViewport;
    dispatch({ kind: "resize", viewport: nextViewport });
  });

  const stopSignal = terminal.onSignal(() => {
    finish(0);
  });

  try {
    paint();
    return await exitPromise;
  } finally {
    clearTimers();
    stopData();
    stopResize();
    stopSignal();
    terminal.leaveRawAltScreen();
  }
}
