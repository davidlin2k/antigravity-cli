import type { AbsolutePath } from "../../domain/types.ts";

type JsoncParseResult =
  | { readonly ok: true; readonly value: unknown; readonly hadUtf8Bom: boolean }
  | {
      readonly ok: false;
      readonly hadUtf8Bom: boolean;
      readonly line: number | null;
      readonly column: number | null;
      readonly syntaxError: string;
    };

interface ParsedFrontmatter {
  readonly present: boolean;
  readonly fields: ReadonlyMap<string, string>;
}

function lineColAtOffset(text: string, offset: number): { readonly line: number; readonly column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let column = 1;
  for (let i = 0; i < clamped; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function stripJsoncCommentsAndTrailingCommas(
  text: string,
):
  | { readonly ok: true; readonly cleaned: string }
  | { readonly ok: false; readonly line: number; readonly column: number; readonly error: string } {
  const chars = Array.from(text);
  const len = chars.length;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < len; i += 1) {
    const ch = chars[i];
    const next = i + 1 < len ? chars[i + 1] : "";

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "/" && next === "/") {
      chars[i] = " ";
      chars[i + 1] = " ";
      i += 2;
      while (i < len && chars[i] !== "\n" && chars[i] !== "\r") {
        chars[i] = " ";
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      const startOffset = i;
      chars[i] = " ";
      chars[i + 1] = " ";
      i += 2;
      let closed = false;
      while (i < len) {
        if (chars[i] === "*" && i + 1 < len && chars[i + 1] === "/") {
          chars[i] = " ";
          chars[i + 1] = " ";
          i += 1;
          closed = true;
          break;
        }
        if (chars[i] !== "\n" && chars[i] !== "\r") {
          chars[i] = " ";
        }
        i += 1;
      }
      if (!closed) {
        const pos = lineColAtOffset(text, startOffset);
        return {
          ok: false,
          line: pos.line,
          column: pos.column,
          error: "Unterminated block comment in JSONC.",
        };
      }
    }
  }

  inString = false;
  escaped = false;
  for (let i = 0; i < len; i += 1) {
    const ch = chars[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < len && (chars[j] === " " || chars[j] === "\t" || chars[j] === "\n" || chars[j] === "\r")) {
        j += 1;
      }
      if (j < len && (chars[j] === "}" || chars[j] === "]")) {
        chars[i] = " ";
      }
    }
  }

  return { ok: true, cleaned: chars.join("") };
}

function locateJsonSyntaxError(text: string): number {
  let pos = 0;
  const len = text.length;

  const skipWs = (): void => {
    while (pos < len) {
      const code = text.charCodeAt(pos);
      if (code === 32 || code === 9 || code === 10 || code === 13) {
        pos += 1;
      } else {
        break;
      }
    }
  };

  const parseString = (): boolean => {
    if (text.charCodeAt(pos) !== 34) {
      return false;
    }
    pos += 1;
    while (pos < len) {
      const code = text.charCodeAt(pos);
      if (code === 34) {
        pos += 1;
        return true;
      }
      if (code === 92) {
        pos += 1;
        if (pos >= len) {
          return false;
        }
        const esc = text.charAt(pos);
        if (esc === "u") {
          if (!/^[0-9a-fA-F]{4}/.test(text.slice(pos + 1, pos + 5))) {
            return false;
          }
          pos += 5;
        } else if ('"\\/bfnrt'.includes(esc)) {
          pos += 1;
        } else {
          return false;
        }
        continue;
      }
      if (code < 0x20) {
        return false;
      }
      pos += 1;
    }
    return false;
  };

  const parseNumber = (): boolean => {
    const start = pos;
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(start));
    if (!match || match[0].length === 0) {
      return false;
    }
    pos += match[0].length;
    return true;
  };

  const parseValue = (): boolean => {
    skipWs();
    if (pos >= len) {
      return false;
    }
    const ch = text.charAt(pos);
    if (ch === "{") {
      pos += 1;
      skipWs();
      if (text.charAt(pos) === "}") {
        pos += 1;
        return true;
      }
      while (pos < len) {
        skipWs();
        if (!parseString()) {
          return false;
        }
        skipWs();
        if (text.charAt(pos) !== ":") {
          return false;
        }
        pos += 1;
        if (!parseValue()) {
          return false;
        }
        skipWs();
        if (text.charAt(pos) === ",") {
          pos += 1;
          continue;
        }
        if (text.charAt(pos) === "}") {
          pos += 1;
          return true;
        }
        return false;
      }
      return false;
    }
    if (ch === "[") {
      pos += 1;
      skipWs();
      if (text.charAt(pos) === "]") {
        pos += 1;
        return true;
      }
      while (pos < len) {
        if (!parseValue()) {
          return false;
        }
        skipWs();
        if (text.charAt(pos) === ",") {
          pos += 1;
          continue;
        }
        if (text.charAt(pos) === "]") {
          pos += 1;
          return true;
        }
        return false;
      }
      return false;
    }
    if (ch === '"') {
      return parseString();
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      return parseNumber();
    }
    if (text.startsWith("true", pos)) {
      pos += 4;
      return true;
    }
    if (text.startsWith("false", pos)) {
      pos += 5;
      return true;
    }
    if (text.startsWith("null", pos)) {
      pos += 4;
      return true;
    }
    return false;
  };

  if (!parseValue()) {
    return pos;
  }
  skipWs();
  return pos;
}

function extractJsonErrorPosition(
  message: string,
  cleaned: string,
): { readonly line: number | null; readonly column: number | null } {
  const lineColMatch = /\(line\s+(\d+)\s+column\s+(\d+)\)/i.exec(message);
  if (lineColMatch?.[1] !== undefined && lineColMatch[2] !== undefined) {
    return { line: Number(lineColMatch[1]), column: Number(lineColMatch[2]) };
  }
  const posMatch = /position\s+(\d+)/i.exec(message);
  if (posMatch?.[1] !== undefined) {
    return lineColAtOffset(cleaned, Number(posMatch[1]));
  }
  return lineColAtOffset(cleaned, locateJsonSyntaxError(cleaned));
}

export function parseJsoncBomSafe(
  rawBytes: Uint8Array | string,
  _filePath?: AbsolutePath,
): JsoncParseResult {
  let hadUtf8Bom = false;
  let text: string;

  if (typeof rawBytes === "string") {
    if (rawBytes.startsWith("\uFEFF")) {
      hadUtf8Bom = true;
      text = rawBytes.slice(1);
    } else {
      text = rawBytes;
    }
  } else {
    if (
      rawBytes.length >= 3 &&
      rawBytes[0] === 0xef &&
      rawBytes[1] === 0xbb &&
      rawBytes[2] === 0xbf
    ) {
      hadUtf8Bom = true;
      text = Buffer.from(rawBytes.subarray(3)).toString("utf8");
    } else {
      text = Buffer.from(rawBytes).toString("utf8");
    }
  }

  const stripped = stripJsoncCommentsAndTrailingCommas(text);
  if (!stripped.ok) {
    return {
      ok: false,
      hadUtf8Bom,
      line: stripped.line,
      column: stripped.column,
      syntaxError: stripped.error,
    };
  }

  try {
    const value: unknown = JSON.parse(stripped.cleaned);
    return { ok: true, value, hadUtf8Bom };
  } catch (err) {
    const syntaxError = err instanceof Error ? err.message : String(err);
    const pos = extractJsonErrorPosition(syntaxError, stripped.cleaned);
    return {
      ok: false,
      hadUtf8Bom,
      line: pos.line,
      column: pos.column,
      syntaxError,
    };
  }
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : trimmed.slice(1, -1);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

export function parseYamlFrontmatter(rawText: string): ParsedFrontmatter {
  const text = rawText.startsWith("\uFEFF") ? rawText.slice(1) : rawText;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { present: false, fields: new Map() };
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i]?.trim();
    if (trimmed === "---" || trimmed === "...") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return { present: false, fields: new Map() };
  }

  const fields = new Map<string, string>();
  let i = 1;
  while (i < endIdx) {
    const line = lines[i] ?? "";
    const match = /^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      i += 1;
      continue;
    }
    const key = (match[1] ?? "").toLowerCase();
    const rest = (match[2] ?? "").trim();

    if (rest === "|" || rest === "|-" || rest === ">" || rest === ">-") {
      const folded = rest.startsWith(">");
      const blockLines: string[] = [];
      let j = i + 1;
      while (j < endIdx) {
        const nextLine = lines[j] ?? "";
        if (nextLine.trim().length === 0) {
          blockLines.push("");
          j += 1;
          continue;
        }
        if (!/^\s+/.test(nextLine)) {
          break;
        }
        blockLines.push(nextLine.trim());
        j += 1;
      }
      const joined = folded ? blockLines.join(" ").replace(/\s+/g, " ").trim() : blockLines.join("\n").trim();
      fields.set(key, joined);
      i = j;
      continue;
    }

    fields.set(key, unquoteYamlScalar(rest));
    i += 1;
  }

  return { present: true, fields };
}
