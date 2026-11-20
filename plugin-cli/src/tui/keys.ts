const utf8Decoder = new TextDecoder("utf-8");

export type KeyEvent =
  | { readonly kind: "up" }
  | { readonly kind: "down" }
  | { readonly kind: "left" }
  | { readonly kind: "right" }
  | { readonly kind: "home" }
  | { readonly kind: "end" }
  | { readonly kind: "page-up" }
  | { readonly kind: "page-down" }
  | { readonly kind: "delete" }
  | { readonly kind: "backspace" }
  | { readonly kind: "enter" }
  | { readonly kind: "tab" }
  | { readonly kind: "shift-tab" }
  | { readonly kind: "escape" }
  | { readonly kind: "ctrl-c" }
  | { readonly kind: "ctrl-u" }
  | { readonly kind: "ctrl-w" }
  | { readonly kind: "char"; readonly ch: string };

export interface KeyDecoder {
  push(chunk: Uint8Array): readonly KeyEvent[];
  hasPendingEscape(): boolean;
  flush(): readonly KeyEvent[];
}

function mapCsiSequence(params: string, finalByte: number): KeyEvent | null {
  const finalChar = String.fromCharCode(finalByte);
  switch (finalChar) {
    case "A":
      return { kind: "up" };
    case "B":
      return { kind: "down" };
    case "C":
      return { kind: "right" };
    case "D":
      return { kind: "left" };
    case "H":
      return { kind: "home" };
    case "F":
      return { kind: "end" };
    case "Z":
      return { kind: "shift-tab" };
    case "~": {
      const firstParam = params.split(";")[0];
      switch (firstParam) {
        case "1":
        case "7":
          return { kind: "home" };
        case "3":
          return { kind: "delete" };
        case "4":
        case "8":
          return { kind: "end" };
        case "5":
          return { kind: "page-up" };
        case "6":
          return { kind: "page-down" };
        default:
          return null;
      }
    }
    default:
      return null;
  }
}

function mapSs3Sequence(finalByte: number): KeyEvent | null {
  switch (String.fromCharCode(finalByte)) {
    case "A":
      return { kind: "up" };
    case "B":
      return { kind: "down" };
    case "C":
      return { kind: "right" };
    case "D":
      return { kind: "left" };
    case "H":
      return { kind: "home" };
    case "F":
      return { kind: "end" };
    default:
      return null;
  }
}

function expectedUtf8Length(leadByte: number): number {
  if (leadByte >= 0xc2 && leadByte <= 0xdf) return 2;
  if (leadByte >= 0xe0 && leadByte <= 0xef) return 3;
  if (leadByte >= 0xf0 && leadByte <= 0xf4) return 4;
  return 1;
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/**
 * Creates a stateful TTY byte decoder that handles split CSI/SS3 escape
 * sequences and multi-byte UTF-8 characters across chunk boundaries.
 */
export function createKeyDecoder(): KeyDecoder {
  let pending: number[] = [];

  function decodeBuffer(flushEnd: boolean): readonly KeyEvent[] {
    const events: KeyEvent[] = [];
    let i = 0;

    while (i < pending.length) {
      const byte = pending[i];
      if (byte === undefined) {
        i += 1;
        continue;
      }

      if (byte === 0x1b) {
        if (i + 1 >= pending.length) {
          if (!flushEnd) {
            break;
          }
          events.push({ kind: "escape" });
          i += 1;
          continue;
        }
        const next = pending[i + 1];
        if (next === 0x5b) {
          let j = i + 2;
          while (j < pending.length) {
            const c = pending[j];
            if (c !== undefined && c >= 0x40 && c <= 0x7e) {
              break;
            }
            if (c !== undefined && (c < 0x20 || c > 0x3f)) {
              break;
            }
            j += 1;
          }
          if (j >= pending.length) {
            if (!flushEnd) {
              break;
            }
            i = j;
            continue;
          }
          const finalByte = pending[j];
          if (finalByte !== undefined && finalByte >= 0x40 && finalByte <= 0x7e) {
            const params = String.fromCharCode(...pending.slice(i + 2, j));
            const mapped = mapCsiSequence(params, finalByte);
            if (mapped !== null) {
              events.push(mapped);
            }
            i = j + 1;
            continue;
          }
          i = j;
          continue;
        }
        if (next === 0x4f) {
          if (i + 2 >= pending.length) {
            if (!flushEnd) {
              break;
            }
            i += 2;
            continue;
          }
          const finalByte = pending[i + 2];
          if (finalByte !== undefined) {
            const mapped = mapSs3Sequence(finalByte);
            if (mapped !== null) {
              events.push(mapped);
            }
          }
          i += 3;
          continue;
        }
        events.push({ kind: "escape" });
        i += 1;
        continue;
      }

      if (byte === 0x0d) {
        events.push({ kind: "enter" });
        if (pending[i + 1] === 0x0a) {
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      if (byte === 0x0a) {
        events.push({ kind: "enter" });
        i += 1;
        continue;
      }
      if (byte === 0x09) {
        events.push({ kind: "tab" });
        i += 1;
        continue;
      }
      if (byte === 0x7f || byte === 0x08) {
        events.push({ kind: "backspace" });
        i += 1;
        continue;
      }
      if (byte === 0x03) {
        events.push({ kind: "ctrl-c" });
        i += 1;
        continue;
      }
      if (byte === 0x15) {
        events.push({ kind: "ctrl-u" });
        i += 1;
        continue;
      }
      if (byte === 0x17) {
        events.push({ kind: "ctrl-w" });
        i += 1;
        continue;
      }
      if (byte >= 0x20 && byte <= 0x7e) {
        events.push({ kind: "char", ch: String.fromCharCode(byte) });
        i += 1;
        continue;
      }
      if (byte >= 0xc2 && byte <= 0xf4) {
        const expectedLen = expectedUtf8Length(byte);
        if (i + expectedLen > pending.length) {
          if (!flushEnd) {
            break;
          }
          i += 1;
          continue;
        }
        let valid = true;
        for (let k = 1; k < expectedLen; k += 1) {
          const cont = pending[i + k];
          if (cont === undefined || !isUtf8Continuation(cont)) {
            valid = false;
            break;
          }
        }
        if (!valid) {
          i += 1;
          continue;
        }
        const slice = Uint8Array.from(pending.slice(i, i + expectedLen));
        const decoded = utf8Decoder.decode(slice);
        if (decoded.length > 0 && !decoded.includes("\uFFFD")) {
          const cp = decoded.codePointAt(0);
          if (cp !== undefined && !(cp >= 0x80 && cp <= 0x9f)) {
            events.push({ kind: "char", ch: decoded });
          }
        }
        i += expectedLen;
        continue;
      }

      i += 1;
    }

    pending = pending.slice(i);
    return events;
  }

  return {
    push(chunk: Uint8Array): readonly KeyEvent[] {
      for (let i = 0; i < chunk.length; i += 1) {
        const b = chunk[i];
        if (b !== undefined) {
          pending.push(b);
        }
      }
      return decodeBuffer(false);
    },
    hasPendingEscape(): boolean {
      return pending.length > 0 && pending[0] === 0x1b;
    },
    flush(): readonly KeyEvent[] {
      return decodeBuffer(true);
    },
  };
}

export function parseKeyBytes(chunk: Uint8Array): readonly KeyEvent[] {
  const decoder = createKeyDecoder();
  const initial = decoder.push(chunk);
  const flushed = decoder.flush();
  return flushed.length === 0 ? initial : [...initial, ...flushed];
}
