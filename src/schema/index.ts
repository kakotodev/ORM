import { own } from "../own.js";
import type { SchemaIR } from "./ir.js";
import type { SchemaLimits } from "./limits.js";
import { parse } from "./parser.js";
import { buildSchema } from "./validator.js";

/** Parses and validates schema source into the IR. Throws SchemaError holding every diagnostic. */
export function loadSchema(source: string, options: { file?: string; limits?: Partial<SchemaLimits> } = {}): SchemaIR {
  const file = own(options, "file");
  const limits = own(options, "limits");
  const ast = parse(source, { ...(file === undefined ? {} : { file }), ...(limits === undefined ? {} : { limits }) });
  return buildSchema(ast, file);
}
