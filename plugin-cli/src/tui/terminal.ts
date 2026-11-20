import {
  ALT_SCREEN_ENTER,
  ALT_SCREEN_LEAVE,
  CURSOR_HIDE,
  CURSOR_SHOW,
  isColorSupported,
} from "./ansi.ts";
import type { Viewport } from "./state.ts";
import { clampViewport } from "./render.ts";

export interface TerminalPort {
  readonly isTTY: boolean;
  readonly colorEnabled: boolean;
  getViewport(): Viewport;
  enterRawAltScreen(): void;
  leaveRawAltScreen(): void;
  write(text: string): void;
  onData(listener: (chunk: Uint8Array) => void): () => void;
  onResize(listener: (viewport: Viewport) => void): () => void;
  onSignal(listener: (signal: "SIGINT" | "SIGTERM") => void): () => void;
}

export interface NodeTerminalOptions {
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export function createNodeTerminal(options: NodeTerminalOptions = {}): TerminalPort {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  const isTTY = Boolean(stdin.isTTY && stdout.isTTY);
  const colorEnabled = isTTY && isColorSupported(env);
  let active = false;

  function readViewport(): Viewport {
    return clampViewport(stdout.columns || 80, stdout.rows || 24);
  }

  return {
    isTTY,
    colorEnabled,
    getViewport: readViewport,
    enterRawAltScreen(): void {
      if (active) {
        return;
      }
      active = true;
      if (typeof stdin.setRawMode === "function") {
        stdin.setRawMode(true);
      }
      stdin.resume();
      stdout.write(`${ALT_SCREEN_ENTER}${CURSOR_HIDE}`);
    },
    leaveRawAltScreen(): void {
      if (!active) {
        return;
      }
      active = false;
      stdout.write(`${CURSOR_SHOW}${ALT_SCREEN_LEAVE}`);
      if (typeof stdin.setRawMode === "function") {
        stdin.setRawMode(false);
      }
      stdin.pause();
    },
    write(text: string): void {
      if (text.length > 0) {
        stdout.write(text);
      }
    },
    onData(listener: (chunk: Uint8Array) => void): () => void {
      const handler = (chunk: Buffer | string): void => {
        if (typeof chunk === "string") {
          listener(Buffer.from(chunk, "utf8"));
        } else {
          listener(chunk);
        }
      };
      stdin.on("data", handler);
      return () => {
        stdin.off("data", handler);
      };
    },
    onResize(listener: (viewport: Viewport) => void): () => void {
      const handler = (): void => {
        listener(readViewport());
      };
      stdout.on("resize", handler);
      return () => {
        stdout.off("resize", handler);
      };
    },
    onSignal(listener: (signal: "SIGINT" | "SIGTERM") => void): () => void {
      const onSigint = (): void => listener("SIGINT");
      const onSigterm = (): void => listener("SIGTERM");
      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigterm);
      return () => {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigterm);
      };
    },
  };
}
