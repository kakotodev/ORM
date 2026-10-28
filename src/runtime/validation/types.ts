export type Operation =
  | "findMany"
  | "findFirst"
  | "findUnique"
  | "count"
  | "create"
  | "createMany"
  | "update"
  | "updateMany"
  | "upsert"
  | "delete"
  | "deleteMany";

export type ScalarOp =
  | "equals"
  | "not"
  | "in"
  | "notIn"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "contains"
  | "startsWith"
  | "endsWith";

export type FilterNode =
  | { kind: "and" | "or"; items: FilterNode[] }
  | { kind: "not"; item: FilterNode }
  | { kind: "field"; field: string; op: ScalarOp; value: unknown }
  | { kind: "relation"; field: string; op: "some" | "none" | "every" | "is" | "isNot"; filter: FilterNode | null };

export interface OrderByItem {
  field: string;
  direction: "asc" | "desc";
}

export interface IncludeNode {
  relation: string;
  where?: FilterNode;
  orderBy: OrderByItem[];
  select?: string[];
  include: IncludeNode[];
}

export interface ValidatedFind {
  where?: FilterNode;
  select?: string[];
  include: IncludeNode[];
  orderBy: OrderByItem[];
  take?: number;
  skip?: number;
}

/** `values` holds validated (not yet encoded) values by field name; `connects` maps an n-1 relation to a unique filter on its target. */
export interface ValidatedData {
  values: Map<string, unknown>;
  connects: Map<string, FilterNode>;
}

export type ValidatedArgs =
  | ({ op: "findMany" | "findFirst" | "count" } & ValidatedFind)
  | ({ op: "findUnique" } & ValidatedFind & { where: FilterNode })
  | { op: "create"; data: ValidatedData; select?: string[]; include: IncludeNode[] }
  | { op: "createMany"; data: ValidatedData[] }
  | { op: "update"; where: FilterNode; data: ValidatedData; select?: string[]; include: IncludeNode[] }
  | { op: "updateMany"; where?: FilterNode; data: ValidatedData }
  | {
      op: "upsert";
      where: FilterNode;
      create: ValidatedData;
      update: ValidatedData;
      select?: string[];
      include: IncludeNode[];
    }
  | { op: "delete"; where: FilterNode; select?: string[]; include: IncludeNode[] }
  | { op: "deleteMany"; where?: FilterNode };
