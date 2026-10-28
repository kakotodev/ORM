import type { SchemaIR } from "./ir.js";
import type { SchemaLimits } from "./limits.js";
import { parse } from "./parser.js";
import { buildSchema } from "./validator.js";

/** Parses and validates schema source into the IR. Throws SchemaError holding every diagnostic. */
export function loadSchema(source: string, options: { file?: string; limits?: Partial<SchemaLimits> } = {}): SchemaIR {
  const ast = parse(source, options);
  return buildSchema(ast, options.file);
}
