const utf8Decoder = new TextDecoder("utf-8");

export const SYNC_START = "\x1b[?2026h";
export const SYNC_END = "\x1b[?2026l";
export const ALT_SCREEN_ENTER = "\x1b[?1049h";
export const ALT_SCREEN_LEAVE = "\x1b[?1049l";
export const CURSOR_HIDE = "\x1b[?25l";
export const CURSOR_SHOW = "\x1b[?25h";
export const CLEAR_SCREEN = "\x1b[2J";
export const CLEAR_LINE = "\x1b[2K";
export const RESET = "\x1b[0m";

export function moveTo(row1Based: number, col1Based: number): string {
  const row = Math.max(1, Math.floor(row1Based));
  const col = Math.max(1, Math.floor(col1Based));
  return `\x1b[${String(row)};${String(col)}H`;
}

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

const ANSI_ESCAPE_RE =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[P^_X][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]+[@-~]|[@-Z\\-_])|\x9b[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

export function sanitizeInlineText(text: string): string {
  return stripAnsi(text)
    .replaceAll("\x1b", "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

export function sanitizeInputText(text: string): string {
  return stripAnsi(text)
    .replaceAll("\x1b", "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, "");
}

function isZeroWidthCodePoint(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0xfeff ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x231a ||
    cp === 0x231b ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x23e9 && cp <= 0x23f3) ||
    (cp >= 0x23f8 && cp <= 0x23fa) ||
    cp === 0x25fd ||
    cp === 0x25fe ||
    cp === 0x2614 ||
    cp === 0x2615 ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f ||
    cp === 0x2693 ||
    cp === 0x26a1 ||
    cp === 0x26aa ||
    cp === 0x26ab ||
    cp === 0x26bd ||
    cp === 0x26be ||
    cp === 0x26c4 ||
    cp === 0x26c5 ||
    cp === 0x26ce ||
    cp === 0x26d4 ||
    cp === 0x26ea ||
    cp === 0x26f2 ||
    cp === 0x26f3 ||
    cp === 0x26f5 ||
    cp === 0x26fa ||
    cp === 0x26fd ||
    cp === 0x2705 ||
    cp === 0x270a ||
    cp === 0x270b ||
    cp === 0x2728 ||
    cp === 0x274c ||
    cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 ||
    cp === 0x27bf ||
    cp === 0x2b1b ||
    cp === 0x2b1c ||
    cp === 0x2b50 ||
    cp === 0x2b55 ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3040 && cp <= 0x3247) ||
    (cp >= 0x3250 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp === 0x1b000 ||
    cp === 0x1b001 ||
    cp === 0x1f004 ||
    cp === 0x1f0cf ||
    cp === 0x1f18e ||
    (cp >= 0x1f191 && cp <= 0x1f19a) ||
    (cp >= 0x1f200 && cp <= 0x1f251) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  );
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter("en", { granularity: "grapheme" });
const EMOJI_PRESENTATION_RE = /\p{Emoji_Presentation}/u;
const EXTENDED_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;

export function splitGraphemes(text: string): readonly string[] {
  const out: string[] = [];
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    out.push(segment);
  }
  return out;
}

export function graphemeDisplayWidth(grapheme: string): number {
  if (grapheme.length === 0) {
    return 0;
  }
  let firstVisibleCp: number | undefined;
  for (const ch of grapheme) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && !isZeroWidthCodePoint(cp)) {
      firstVisibleCp = cp;
      break;
    }
  }
  if (firstVisibleCp === undefined) {
    return 0;
  }
  if (
    (!grapheme.includes("\uFE0E") && EMOJI_PRESENTATION_RE.test(grapheme)) ||
    (grapheme.includes("\uFE0F") &&
      (EXTENDED_PICTOGRAPHIC_RE.test(grapheme) || grapheme.includes("\u20E3")))
  ) {
    return 2;
  }
  return isWideCodePoint(firstVisibleCp) ? 2 : 1;
}

export function displayWidth(text: string): number {
  const plain = stripAnsi(text);
  let width = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(plain)) {
    width += graphemeDisplayWidth(segment);
  }
  return width;
}

function tokenizeAnsiSegments(text: string): readonly (
  | { readonly kind: "ansi"; readonly raw: string }
  | { readonly kind: "char"; readonly ch: string; readonly width: number }
)[] {
  const tokens: (
    | { readonly kind: "ansi"; readonly raw: string }
    | { readonly kind: "char"; readonly ch: string; readonly width: number }
  )[] = [];
  ANSI_ESCAPE_RE.lastIndex = 0;
  let lastIndex = 0;
  let match = ANSI_ESCAPE_RE.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) {
      const plainChunk = text.slice(lastIndex, match.index);
      for (const { segment } of GRAPHEME_SEGMENTER.segment(plainChunk)) {
        tokens.push({ kind: "char", ch: segment, width: graphemeDisplayWidth(segment) });
      }
    }
    tokens.push({ kind: "ansi", raw: match[0] });
    lastIndex = match.index + match[0].length;
    match = ANSI_ESCAPE_RE.exec(text);
  }
  if (lastIndex < text.length) {
    const tail = text.slice(lastIndex);
    for (const { segment } of GRAPHEME_SEGMENTER.segment(tail)) {
      tokens.push({ kind: "char", ch: segment, width: graphemeDisplayWidth(segment) });
    }
  }
  return tokens;
}

export function truncateVisible(text: string, maxWidth: number, ellipsis = "…"): string {
  if (maxWidth <= 0) {
    return "";
  }
  if (displayWidth(text) <= maxWidth) {
    return text;
  }
  const ellipsisWidth = displayWidth(ellipsis);
  const targetWidth = ellipsisWidth <= maxWidth ? maxWidth - ellipsisWidth : maxWidth;
  const suffix = ellipsisWidth <= maxWidth ? ellipsis : "";

  const tokens = tokenizeAnsiSegments(text);
  let out = "";
  let currentWidth = 0;
  let sawAnsi = false;

  for (const token of tokens) {
    if (token.kind === "ansi") {
      out += token.raw;
      sawAnsi = true;
      continue;
    }
    if (currentWidth + token.width > targetWidth) {
      break;
    }
    out += token.ch;
    currentWidth += token.width;
  }

  if (sawAnsi && !out.endsWith(RESET)) {
    return `${out}${suffix}${RESET}`;
  }
  return `${out}${suffix}`;
}

export function padVisible(
  text: string,
  width: number,
  align: "left" | "right" | "center" = "left",
): string {
  if (width <= 0) {
    return "";
  }
  const clipped = truncateVisible(text, width);
  const visible = displayWidth(clipped);
  const gap = Math.max(0, width - visible);
  if (gap === 0) {
    return clipped;
  }
  if (align === "right") {
    return `${" ".repeat(gap)}${clipped}`;
  }
  if (align === "center") {
    const leftPad = Math.floor(gap / 2);
    const rightPad = gap - leftPad;
    return `${" ".repeat(leftPad)}${clipped}${" ".repeat(rightPad)}`;
  }
  return `${clipped}${" ".repeat(gap)}`;
}

/**
 * Replaces `[startCol, startCol + displayWidth(segment))` inside a plain background line
 * while keeping total visible width equal to `totalCols` even if wide characters cross the boundary.
 */
export function overlaySegmentOnLine(
  bgLine: string,
  startCol: number,
  segment: string,
  totalCols: number,
  dimBackground: boolean,
): string {
  const plainBg = stripAnsi(bgLine);
  const segWidth = displayWidth(segment);
  const endCol = startCol + segWidth;

  let left = "";
  let right = "";
  let col = 0;

  for (const { segment: grapheme } of GRAPHEME_SEGMENTER.segment(plainBg)) {
    const w = graphemeDisplayWidth(grapheme);
    if (w === 0) {
      continue;
    }
    const nextCol = col + w;
    if (nextCol <= startCol) {
      left += grapheme;
    } else if (col < startCol && nextCol > startCol) {
      left += " ".repeat(startCol - col);
    } else if (col >= endCol && nextCol <= totalCols) {
      right += grapheme;
    } else if (col < endCol && nextCol > endCol) {
      right += " ".repeat(Math.min(nextCol, totalCols) - endCol);
    }
    col = nextCol;
  }

  const leftPad = Math.max(0, startCol - displayWidth(left));
  const fullLeft = left + " ".repeat(leftPad);
  const rightNeeded = Math.max(0, totalCols - endCol - displayWidth(right));
  const fullRight = right + " ".repeat(rightNeeded);

  if (!dimBackground) {
    return truncateVisible(`${fullLeft}${segment}${fullRight}`, totalCols, "");
  }
  const styledLeft = fullLeft.length > 0 ? `\x1b[2m${fullLeft}${RESET}` : "";
  const styledRight = fullRight.length > 0 ? `\x1b[2m${fullRight}${RESET}` : "";
  return `${styledLeft}${segment}${styledRight}`;
}

export function wrapText(text: string, maxWidth: number): readonly string[] {
  if (maxWidth <= 0) {
    return [""];
  }
  const normalized = text.replace(/\r\n/g, "\n");
  const lines: string[] = [];

  for (const paragraph of normalized.split("\n")) {
    const cleaned = sanitizeInlineText(paragraph);
    if (cleaned.length === 0) {
      lines.push("");
      continue;
    }
    const words = cleaned.split(/\s+/);
    let current = "";
    for (const word of words) {
      if (current.length === 0) {
        if (displayWidth(word) <= maxWidth) {
          current = word;
        } else {
          lines.push(truncateVisible(word, maxWidth));
        }
        continue;
      }
      const candidate = `${current} ${word}`;
      if (displayWidth(candidate) <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = displayWidth(word) <= maxWidth ? word : truncateVisible(word, maxWidth);
      }
    }
    if (current.length > 0) {
      lines.push(current);
    }
  }

  return lines.length > 0 ? lines : [""];
}

export function isColorSupported(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return false;
  }
  if (env.FORCE_COLOR === "0") {
    return false;
  }
  if (env.TERM === "dumb") {
    return false;
  }
  return true;
}

export interface AnsiTheme {
  readonly colorEnabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  inverse(text: string): string;
  cyan(text: string): string;
  cyanBold(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  whiteBold(text: string): string;
  selectedRow(text: string): string;
  focusedButton(text: string): string;
}

function wrapSgr(enabled: boolean, code: string, text: string): string {
  if (!enabled || text.length === 0) {
    return text;
  }
  return `\x1b[${code}m${text}${RESET}`;
}

export function createTheme(colorEnabled: boolean): AnsiTheme {
  return {
    colorEnabled,
    bold: (text) => wrapSgr(colorEnabled, "1", text),
    dim: (text) => wrapSgr(colorEnabled, "2", text),
    inverse: (text) => wrapSgr(colorEnabled, "7", text),
    cyan: (text) => wrapSgr(colorEnabled, "36", text),
    cyanBold: (text) => wrapSgr(colorEnabled, "1;36", text),
    green: (text) => wrapSgr(colorEnabled, "32", text),
    yellow: (text) => wrapSgr(colorEnabled, "33", text),
    red: (text) => wrapSgr(colorEnabled, "31", text),
    whiteBold: (text) => wrapSgr(colorEnabled, "1;37", text),
    selectedRow: (text) => wrapSgr(colorEnabled, "7", text),
    focusedButton: (text) => wrapSgr(colorEnabled, "1;7;36", text),
  };
}
