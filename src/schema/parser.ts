import { SchemaError, type SchemaDiagnostic } from "../errors.js";
import type {
  AttributeArg,
  AttributeNode,
  BlockNode,
  Expr,
  FieldNode,
  Pos,
  PropertyNode,
  SchemaAst,
} from "./ast.js";
import { tokenize, type Token, type TokenKind } from "./lexer.js";
import { DEFAULT_SCHEMA_LIMITS, type SchemaLimits } from "./limits.js";

export interface ParseOptions {
  file?: string;
  limits?: Partial<SchemaLimits>;
}

/** Internal control-flow signal carrying one diagnostic; never escapes `parse`. */
class ParseFailure extends Error {
  readonly diagnostic: SchemaDiagnostic;
  constructor(message: string, at: Pos) {
    super(message);
    this.diagnostic = { message, line: at.line, column: at.column };
  }
}

/** Ignores undefined, non-finite and non-positive overrides so they can never disable a limit. */
function resolveLimits(overrides: Partial<SchemaLimits> | undefined): SchemaLimits {
  const resolved: SchemaLimits = { ...DEFAULT_SCHEMA_LIMITS };
  if (overrides === undefined) return resolved;
  for (const key of Object.keys(DEFAULT_SCHEMA_LIMITS) as (keyof SchemaLimits)[]) {
    const value = overrides[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) resolved[key] = value;
  }
  return resolved;
}

const BLOCK_KEYWORDS: ReadonlySet<string> = new Set(["model", "enum", "datasource", "generator"]);

/** Parses schema source into an AST. Throws one SchemaError holding every diagnostic found. */
export function parse(source: string, options: ParseOptions = {}): SchemaAst {
  const limits = resolveLimits(options.limits);
  let tokens: Token[];
  try {
    tokens = tokenize(source, limits);
  } catch (e) {
    if (e instanceof SchemaError) throw new SchemaError(e.diagnostics, options.file);
    throw e;
  }

  const diagnostics: SchemaDiagnostic[] = [];
  const blocks: BlockNode[] = [];
  let index = 0;

  const eofToken: Token = tokens[tokens.length - 1] ?? { kind: "eof", value: "", line: 1, column: 1 };
  const peek = (): Token => tokens[index] ?? eofToken;
  const posOf = (t: Token): Pos => ({ line: t.line, column: t.column });
  const next = (): Token => {
    const t = peek();
    if (t.kind !== "eof") index++;
    return t;
  };
  const is = (kind: TokenKind): boolean => peek().kind === kind;
  const fail = (message: string, t: Token = peek()): never => {
    throw new ParseFailure(message, posOf(t));
  };
  const expect = (kind: TokenKind, message: string): Token => {
    if (!is(kind)) fail(message);
    return next();
  };
  const skipNewlines = (): void => {
    while (is("newline")) index++;
  };

  function parseExpr(depth: number): Expr {
    const t = peek();
    const pos = posOf(t);
    switch (t.kind) {
      case "string":
        next();
        return { kind: "string", value: t.value, pos };
      case "number": {
        next();
        const value = Number(t.value);
        if (!Number.isFinite(value)) fail("Number is out of range", t);
        return { kind: "number", value, pos };
      }
      case "ident": {
        next();
        if (!is("lparen")) return { kind: "ident", name: t.value, pos };
        if (depth + 1 > limits.maxNestingDepth) fail("Nesting is too deep", t);
        next();
        const args = parseList("rparen", depth + 1);
        return { kind: "call", name: t.value, args, pos };
      }
      case "lbracket": {
        if (depth + 1 > limits.maxNestingDepth) fail("Nesting is too deep", t);
        next();
        const items = parseList("rbracket", depth + 1);
        return { kind: "array", items, pos };
      }
      default:
        return fail("Expected a value");
    }
  }

  /** Comma-separated expressions up to (and including) the closing token; newlines are insignificant. */
  function parseList(close: TokenKind, depth: number): Expr[] {
    const items: Expr[] = [];
    skipNewlines();
    while (!is(close)) {
      items.push(parseExpr(depth));
      skipNewlines();
      if (is("comma")) {
        next();
        skipNewlines();
      } else if (!is(close)) {
        fail("Expected ',' or closing bracket");
      }
    }
    next();
    return items;
  }

  function parseAttribute(): AttributeNode {
    const at = next(); // "@" or "@@"
    const name = expect("ident", "Expected attribute name");
    const args: AttributeArg[] = [];
    if (is("lparen")) {
      next();
      skipNewlines();
      while (!is("rparen")) {
        const first = peek();
        if (first.kind === "ident" && tokens[index + 1]?.kind === "colon") {
          next();
          next();
          skipNewlines();
          args.push({ name: first.value, value: parseExpr(0) });
        } else {
          args.push({ value: parseExpr(0) });
        }
        skipNewlines();
        if (is("comma")) {
          next();
          skipNewlines();
        } else if (!is("rparen")) {
          fail("Expected ',' or ')'");
        }
      }
      next();
    }
    return { name: name.value, args, pos: posOf(at) };
  }

  function endOfEntry(): void {
    if (is("newline")) next();
    else if (!is("rbrace")) fail("Expected end of line");
  }

  function parseField(): FieldNode {
    const name = next();
    const type = expect("ident", "Expected field type");
    let list = false;
    let optional = false;
    if (is("lbracket")) {
      next();
      expect("rbracket", "Expected ']'");
      list = true;
    }
    if (is("question")) {
      next();
      optional = true;
    }
    const attributes: AttributeNode[] = [];
    while (is("at")) attributes.push(parseAttribute());
    if (is("atat")) fail("Block attribute is not allowed on a field");
    endOfEntry();
    return { name: name.value, type: type.value, optional, list, attributes, pos: posOf(name) };
  }

  function parseModelBody(): { fields: FieldNode[]; attributes: AttributeNode[] } {
    const fields: FieldNode[] = [];
    const attributes: AttributeNode[] = [];
    for (;;) {
      skipNewlines();
      if (is("rbrace")) break;
      if (is("atat")) {
        attributes.push(parseAttribute());
        endOfEntry();
      } else if (is("ident")) {
        fields.push(parseField());
      } else {
        fail(is("eof") ? "Unexpected end of schema" : "Expected a field or attribute");
      }
    }
    return { fields, attributes };
  }

  function parseEnumBody(): { name: string; pos: Pos }[] {
    const values: { name: string; pos: Pos }[] = [];
    for (;;) {
      skipNewlines();
      if (is("rbrace")) break;
      const t = peek();
      if (t.kind !== "ident") fail(t.kind === "eof" ? "Unexpected end of schema" : "Expected an enum value");
      next();
      values.push({ name: t.value, pos: posOf(t) });
      endOfEntry();
    }
    return values;
  }

  function parsePropertiesBody(): PropertyNode[] {
    const properties: PropertyNode[] = [];
    for (;;) {
      skipNewlines();
      if (is("rbrace")) break;
      const key = peek();
      if (key.kind !== "ident") fail(key.kind === "eof" ? "Unexpected end of schema" : "Expected a property name");
      next();
      expect("equals", "Expected '='");
      properties.push({ key: key.value, value: parseExpr(0), pos: posOf(key) });
      endOfEntry();
    }
    return properties;
  }

  function parseBlock(): BlockNode {
    const keyword = next();
    const kind = keyword.value;
    if (!BLOCK_KEYWORDS.has(kind)) fail("Expected 'model', 'enum', 'datasource' or 'generator'", keyword);
    const name = expect("ident", "Expected block name");
    expect("lbrace", "Expected '{'");
    const pos = posOf(keyword);
    let block: BlockNode;
    if (kind === "model") {
      block = { kind, name: name.value, ...parseModelBody(), pos };
    } else if (kind === "enum") {
      block = { kind, name: name.value, values: parseEnumBody(), pos };
    } else {
      block = { kind: kind as "datasource" | "generator", name: name.value, properties: parsePropertiesBody(), pos };
    }
    next(); // closing "}"
    return block;
  }

  /** After a failure, skips to just past the next "}" (or to EOF) so parsing can continue. */
  function recover(): void {
    while (!is("rbrace") && !is("eof")) index++;
    if (is("rbrace")) index++;
  }

  for (;;) {
    skipNewlines();
    if (is("eof")) break;
    const start = index;
    try {
      if (!is("ident")) fail("Expected a block");
      blocks.push(parseBlock());
    } catch (e) {
      if (!(e instanceof ParseFailure)) throw e;
      diagnostics.push(e.diagnostic);
      recover();
      if (index === start) index++; // guarantee progress
    }
  }

  if (diagnostics.length > 0) throw new SchemaError(diagnostics, options.file);
  return { blocks };
}
