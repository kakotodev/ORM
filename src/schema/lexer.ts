import { SchemaError } from "../errors.js";
import { resolveSchemaLimits, type SchemaLimits } from "./limits.js";

export type TokenKind =
  | "ident"
  | "string"
  | "number"
  | "lbrace"
  | "rbrace"
  | "lparen"
  | "rparen"
  | "lbracket"
  | "rbracket"
  | "at"
  | "atat"
  | "equals"
  | "colon"
  | "comma"
  | "question"
  | "newline"
  | "eof";

export interface Token {
  kind: TokenKind;
  value: string;
  line: number; // 1-based
  column: number; // 1-based
}

const PUNCTUATION: ReadonlyMap<string, TokenKind> = new Map([
  ["{", "lbrace"],
  ["}", "rbrace"],
  ["(", "lparen"],
  [")", "rparen"],
  ["[", "lbracket"],
  ["]", "rbracket"],
  ["=", "equals"],
  [":", "colon"],
  [",", "comma"],
  ["?", "question"],
]);

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
const isIdentStart = (c: string | undefined): boolean =>
  c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_");
const isIdentPart = (c: string | undefined): boolean => isIdentStart(c) || isDigit(c);

/** Splits schema source into tokens. Throws a SchemaError (never echoing source content) on invalid input. */
export function tokenize(source: string, limits: Partial<SchemaLimits> = {}): Token[] {
  const { maxSourceBytes, maxIdentifierLength, maxStringLength } = resolveSchemaLimits(limits);

  let line = 1;
  let lineStart = 0; // index of the first character of the current line
  let pos = 0;

  const fail: (message: string, atLine?: number, atColumn?: number) => never = (
    message,
    atLine = line,
    atColumn = pos - lineStart + 1,
  ) => {
    throw new SchemaError([{ message, line: atLine, column: atColumn }]);
  };

  if (Buffer.byteLength(source, "utf8") > maxSourceBytes) {
    fail("Schema source is too large", 1, 1);
  }

  const nul = source.indexOf("\0");
  if (nul !== -1) {
    // Locate the NUL byte to report its position.
    for (; pos < nul; pos++) {
      const c = source[pos];
      if (c === "\n" || (c === "\r" && source[pos + 1] !== "\n")) {
        line++;
        lineStart = pos + 1;
      }
    }
    fail("NUL character is not allowed");
  }

  const tokens: Token[] = [];
  const push = (kind: TokenKind, value: string, atLine: number, atColumn: number): void => {
    tokens.push({ kind, value, line: atLine, column: atColumn });
  };

  while (pos < source.length) {
    const c = source.charAt(pos);
    const column = pos - lineStart + 1;

    if (c === " " || c === "\t") {
      pos++;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && source[pos + 1] === "\n") pos++;
      pos++;
      if (tokens[tokens.length - 1]?.kind !== "newline") push("newline", "\n", line, column);
      line++;
      lineStart = pos;
    } else if (c === "/") {
      if (source[pos + 1] !== "/") fail("Unexpected character");
      while (pos < source.length && source[pos] !== "\n" && source[pos] !== "\r") pos++;
    } else if (isIdentStart(c)) {
      const start = pos;
      while (isIdentPart(source[pos])) pos++;
      if (pos - start > maxIdentifierLength) fail("Identifier is too long", line, column);
      push("ident", source.slice(start, pos), line, column);
    } else if (isDigit(c) || (c === "-" && isDigit(source[pos + 1]))) {
      const start = pos;
      if (c === "-") pos++;
      while (isDigit(source[pos])) pos++;
      if (source[pos] === "." && isDigit(source[pos + 1])) {
        pos++;
        while (isDigit(source[pos])) pos++;
      }
      push("number", source.slice(start, pos), line, column);
    } else if (c === '"') {
      pos++;
      let value = "";
      for (;;) {
        const ch = source[pos];
        if (ch === undefined) fail("Unterminated string", line, column);
        if (ch === '"') {
          pos++;
          break;
        }
        if (ch === "\n" || ch === "\r") fail("Unterminated string", line, column);
        if (ch === "\\") {
          const esc = source[pos + 1];
          if (esc === '"' || esc === "\\") value += esc;
          else if (esc === "n") value += "\n";
          else if (esc === "t") value += "\t";
          else fail("Invalid escape sequence");
          pos += 2;
        } else {
          value += ch;
          pos++;
        }
        if (value.length > maxStringLength) fail("String is too long", line, column);
      }
      push("string", value, line, column);
    } else if (c === "@") {
      if (source[pos + 1] === "@") {
        pos += 2;
        push("atat", "@@", line, column);
      } else {
        pos++;
        push("at", "@", line, column);
      }
    } else {
      const kind = PUNCTUATION.get(c);
      if (kind === undefined) fail("Unexpected character");
      else {
        pos++;
        push(kind, c, line, column);
      }
    }
  }

  push("eof", "", line, pos - lineStart + 1);
  return tokens;
}
