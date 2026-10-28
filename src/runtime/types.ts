/**
 * Generic types of the generated client. Every type is parameterized by a type map (`TM`) emitted by the
 * generator for one schema, and mirrors what the runtime validation accepts and what the runtime returns.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
/** A Json value accepted for a non-nullable Json field (the top level cannot be null). */
export type JsonInput = Exclude<JsonValue, null>;

export interface RelationDef {
  model: string;
  list: boolean;
  nullable: boolean;
}

export interface ModelDef {
  /** Result type of a record: one property per scalar or enum field. */
  scalars: object;
  relations: Record<string, RelationDef>;
  /** Filters on scalar and enum fields (Json fields cannot be filtered). */
  filters: object;
  /** Union of the unique criteria, one key each. */
  whereUnique: object;
  create: object;
  /** Like `create`, without `connect` (not supported by createMany). */
  createMany: object;
  update: object;
  /** Union of the fields that can be ordered by. */
  orderable: string;
}

export type TypeMap = Record<string, ModelDef>;

export type SortOrder = "asc" | "desc";

export interface BatchResult {
  count: number;
}

// ---------------------------------------------------------------------------------------------------------
// Scalar filters. `N` is `null` for nullable fields and `never` otherwise.

export interface EqualityFilter<T, N = never> {
  equals?: T | N;
  not?: T | N;
  in?: T[];
  notIn?: T[];
}

export interface ComparableFilter<T, N = never> extends EqualityFilter<T, N> {
  lt?: T;
  lte?: T;
  gt?: T;
  gte?: T;
}

/** Text filters are case-sensitive. */
export interface StringFilter<N = never> extends ComparableFilter<string, N> {
  contains?: string;
  startsWith?: string;
  endsWith?: string;
}

// ---------------------------------------------------------------------------------------------------------
// Model helpers.

type Scalars<TM extends TypeMap, M extends keyof TM> = TM[M]["scalars"];
type Relations<TM extends TypeMap, M extends keyof TM> = TM[M]["relations"];
type Target<TM extends TypeMap, R extends RelationDef> = Extract<R["model"], keyof TM>;

/** Flattens an intersection into a single object type (for readable hovers and exact comparisons). */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

// ---------------------------------------------------------------------------------------------------------
// Query arguments.

type RelationFilter<TM extends TypeMap, R extends RelationDef> = R["list"] extends true
  ? { some?: Where<TM, Target<TM, R>>; none?: Where<TM, Target<TM, R>>; every?: Where<TM, Target<TM, R>> }
  : {
      is?: Where<TM, Target<TM, R>> | (R["nullable"] extends true ? null : never);
      isNot?: Where<TM, Target<TM, R>> | (R["nullable"] extends true ? null : never);
    };

export type Where<TM extends TypeMap, M extends keyof TM> = TM[M]["filters"] & {
  [K in keyof Relations<TM, M>]?: RelationFilter<TM, Relations<TM, M>[K]>;
} & {
  AND?: Where<TM, M> | Where<TM, M>[];
  OR?: Where<TM, M> | Where<TM, M>[];
  NOT?: Where<TM, M> | Where<TM, M>[];
};

type OrderByItem<TM extends TypeMap, M extends keyof TM> = {
  [K in TM[M]["orderable"]]: { [P in K]: SortOrder };
}[TM[M]["orderable"]];

/** One field per object; several objects sort by each in turn. */
export type OrderBy<TM extends TypeMap, M extends keyof TM> = OrderByItem<TM, M> | OrderByItem<TM, M>[];

export type Select<TM extends TypeMap, M extends keyof TM> = { [K in keyof Scalars<TM, M>]?: true };

type IncludeOptions<TM extends TypeMap, R extends RelationDef> = (R["list"] extends true
  ? { where?: Where<TM, Target<TM, R>>; orderBy?: OrderBy<TM, Target<TM, R>> }
  : unknown) &
  Shape<TM, Target<TM, R>>;

export type Include<TM extends TypeMap, M extends keyof TM> = {
  [K in keyof Relations<TM, M>]?: true | IncludeOptions<TM, Relations<TM, M>[K]>;
};

/** `select` and `include` cannot be used together. */
export type Shape<TM extends TypeMap, M extends keyof TM> =
  | { select?: Select<TM, M>; include?: never }
  | { include?: Include<TM, M>; select?: never };

interface Window<TM extends TypeMap, M extends keyof TM> {
  where?: Where<TM, M>;
  orderBy?: OrderBy<TM, M>;
  take?: number;
  skip?: number;
}

export type FindManyArgs<TM extends TypeMap, M extends keyof TM> = Window<TM, M> & Shape<TM, M>;
export type FindFirstArgs<TM extends TypeMap, M extends keyof TM> = FindManyArgs<TM, M>;
export type FindUniqueArgs<TM extends TypeMap, M extends keyof TM> = { where: TM[M]["whereUnique"] } & Shape<TM, M>;
export type CountArgs<TM extends TypeMap, M extends keyof TM> = Window<TM, M>;
export type CreateArgs<TM extends TypeMap, M extends keyof TM> = { data: TM[M]["create"] } & Shape<TM, M>;
export interface CreateManyArgs<TM extends TypeMap, M extends keyof TM> {
  data: TM[M]["createMany"][];
}
export type UpdateArgs<TM extends TypeMap, M extends keyof TM> = {
  where: TM[M]["whereUnique"];
  data: TM[M]["update"];
} & Shape<TM, M>;
/** `where` is required: pass `{}` to target every row. */
export interface UpdateManyArgs<TM extends TypeMap, M extends keyof TM> {
  where: Where<TM, M>;
  data: TM[M]["update"];
}
export type UpsertArgs<TM extends TypeMap, M extends keyof TM> = {
  where: TM[M]["whereUnique"];
  create: TM[M]["create"];
  update: TM[M]["update"];
} & Shape<TM, M>;
export type DeleteArgs<TM extends TypeMap, M extends keyof TM> = { where: TM[M]["whereUnique"] } & Shape<TM, M>;
/** `where` is required: pass `{}` to target every row. */
export interface DeleteManyArgs<TM extends TypeMap, M extends keyof TM> {
  where: Where<TM, M>;
}

// ---------------------------------------------------------------------------------------------------------
// Exactness: object literals are checked for unknown keys at every depth, as the runtime rejects them.

type Leaf = string | number | boolean | bigint | symbol | null | undefined | Date | Uint8Array;

type ExactObject<A, S> = { [K in keyof A]: K extends keyof S ? Exact<A[K], S[K]> : never };

/**
 * `A` itself when it has no key unknown to the allowed shape `S` (at any depth), otherwise a type `A` is not
 * assignable to. Union members of `S` are matched separately, so a key valid in one member only stays valid there.
 */
export type Exact<A, S> = [JsonInput] extends [S]
  ? A // any Json value is allowed here: nothing to check (and no deep recursion into JsonValue)
  : A extends Leaf
    ? A
    : A extends readonly unknown[]
      ? { [I in keyof A]: Exact<A[I], Extract<S, readonly unknown[]>[number]> }
      : S extends unknown
        ? A extends S
          ? ExactObject<A, S>
          : never
        : never;

// ---------------------------------------------------------------------------------------------------------
// Results.

type Wrap<R extends RelationDef, T> = R["list"] extends true ? T[] : R["nullable"] extends true ? T | null : T;

type RelationPayload<TM extends TypeMap, R extends RelationDef, V> = Wrap<
  R,
  V extends true ? Scalars<TM, Target<TM, R>> : Payload<TM, Target<TM, R>, V>
>;

type Selected<TM extends TypeMap, M extends keyof TM, S> = {
  [K in keyof S & keyof Scalars<TM, M>]: Scalars<TM, M>[K];
};

type Included<TM extends TypeMap, M extends keyof TM, I> = {
  [K in keyof I & keyof Relations<TM, M>]: RelationPayload<TM, Relations<TM, M>[K], I[K]>;
};

/** The record returned for arguments `A`: the selected fields, or every scalar plus the included relations. */
export type Payload<TM extends TypeMap, M extends keyof TM, A> = A extends { select: infer S }
  ? Simplify<Selected<TM, M, S>>
  : A extends { include: infer I }
    ? Simplify<Scalars<TM, M> & Included<TM, M, I>>
    : Scalars<TM, M>;

// ---------------------------------------------------------------------------------------------------------
// Client.

export interface ModelDelegate<TM extends TypeMap, M extends keyof TM> {
  findMany<A extends FindManyArgs<TM, M>>(args?: Exact<A, FindManyArgs<TM, M>>): Promise<Payload<TM, M, A>[]>;
  findFirst<A extends FindFirstArgs<TM, M>>(args?: Exact<A, FindFirstArgs<TM, M>>): Promise<Payload<TM, M, A> | null>;
  findUnique<A extends FindUniqueArgs<TM, M>>(args: Exact<A, FindUniqueArgs<TM, M>>): Promise<Payload<TM, M, A> | null>;
  count<A extends CountArgs<TM, M>>(args?: Exact<A, CountArgs<TM, M>>): Promise<number>;
  create<A extends CreateArgs<TM, M>>(args: Exact<A, CreateArgs<TM, M>>): Promise<Payload<TM, M, A>>;
  createMany<A extends CreateManyArgs<TM, M>>(args: Exact<A, CreateManyArgs<TM, M>>): Promise<BatchResult>;
  update<A extends UpdateArgs<TM, M>>(args: Exact<A, UpdateArgs<TM, M>>): Promise<Payload<TM, M, A>>;
  updateMany<A extends UpdateManyArgs<TM, M>>(args: Exact<A, UpdateManyArgs<TM, M>>): Promise<BatchResult>;
  upsert<A extends UpsertArgs<TM, M>>(args: Exact<A, UpsertArgs<TM, M>>): Promise<Payload<TM, M, A>>;
  delete<A extends DeleteArgs<TM, M>>(args: Exact<A, DeleteArgs<TM, M>>): Promise<Payload<TM, M, A>>;
  deleteMany<A extends DeleteManyArgs<TM, M>>(args: Exact<A, DeleteManyArgs<TM, M>>): Promise<BatchResult>;
}

/** The delegates only: what a `$transaction` callback receives. */
export type TransactionClient<TM extends TypeMap, D extends Record<string, keyof TM>> = {
  readonly [K in keyof D]: ModelDelegate<TM, D[K]>;
};

export type Client<TM extends TypeMap, D extends Record<string, keyof TM>> = TransactionClient<TM, D> & {
  $transaction<T>(fn: (tx: TransactionClient<TM, D>) => Promise<T>): Promise<T>;
  $disconnect(): Promise<void>;
};
