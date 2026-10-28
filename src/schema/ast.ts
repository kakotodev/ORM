export interface Pos {
  line: number;
  column: number;
}

export type Expr =
  | { kind: "string"; value: string; pos: Pos }
  | { kind: "number"; value: number; pos: Pos }
  | { kind: "ident"; name: string; pos: Pos }
  | { kind: "call"; name: string; args: Expr[]; pos: Pos }
  | { kind: "array"; items: Expr[]; pos: Pos };

export interface AttributeArg {
  name?: string;
  value: Expr;
}

export interface AttributeNode {
  name: string;
  args: AttributeArg[];
  pos: Pos;
}

export interface FieldNode {
  name: string;
  type: string;
  optional: boolean;
  list: boolean;
  attributes: AttributeNode[];
  pos: Pos;
}

export interface PropertyNode {
  key: string;
  value: Expr;
  pos: Pos;
}

export type BlockNode =
  | { kind: "model"; name: string; fields: FieldNode[]; attributes: AttributeNode[]; pos: Pos }
  | { kind: "enum"; name: string; values: { name: string; pos: Pos }[]; pos: Pos }
  | { kind: "datasource" | "generator"; name: string; properties: PropertyNode[]; pos: Pos };

export interface SchemaAst {
  blocks: BlockNode[];
}
