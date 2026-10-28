import type { Adapter, Queryable } from "../adapters/adapter.js";
import { own } from "../own.js";
import { createSqliteAdapter } from "../adapters/sqlite.js";
import { ConfigError, safePath, TransactionError, ValidationError } from "../errors.js";
import type { SchemaIR } from "../schema/ir.js";
import { indexSchema } from "../schema/ir.js";
import type { Engine, Scope } from "./client/engine.js";
import { mapClientError } from "./client/errors.js";
import { OPERATIONS, runOperation } from "./client/operations.js";
import { resolveRuntimeLimits, type RuntimeLimits } from "./limits.js";
import type { Operation } from "./validation.js";

export interface ClientOptions {
  url?: string;
  provider?: "sqlite" | "postgresql";
  /** Attach SQL, parameters and driver causes to errors (as non-enumerable `debug`). Never enable in production. */
  debug?: boolean;
  limits?: Partial<RuntimeLimits>;
  /** An already-open adapter; `url` and `transactionTimeoutMs` are then ignored. `$disconnect` closes it. */
  adapter?: Adapter;
  env?: Record<string, string | undefined>;
  /** Interactive transaction timeout in ms for the adapter the client opens itself. */
  transactionTimeoutMs?: number;
}

/** The 11 operations of one model; each is a standalone function (no `this`). */
export type RuntimeDelegate = { readonly [op in Operation]: (args?: unknown) => Promise<unknown> };

export interface RuntimeClient {
  /** One RuntimeDelegate per model, keyed by its delegate name. */
  readonly [delegate: string]: unknown;
  $transaction<T>(fn: (tx: RuntimeClient) => Promise<T>): Promise<T>;
  $disconnect(): Promise<void>;
}

function databaseUrl(schema: SchemaIR, options: ClientOptions): string {
  const given = own(options, "url");
  if (given !== undefined) return given;
  const env = own(options, "env") ?? process.env;
  const value = Object.hasOwn(env, schema.urlEnv) ? env[schema.urlEnv] : undefined;
  if (value === undefined || value === "") throw new ConfigError(`Missing database URL (set ${safePath(schema.urlEnv)})`);
  return value;
}

function openAdapter(schema: SchemaIR, options: ClientOptions): Adapter {
  const open = own(options, "adapter");
  if (open !== undefined) return open;
  const url = databaseUrl(schema, options);
  const timeout = own(options, "transactionTimeoutMs");
  return createSqliteAdapter(timeout === undefined ? { url } : { url, transactionTimeoutMs: timeout });
}

/** A null-prototype object with one frozen delegate per model, bound to `scope`. */
function delegates(engine: Engine, scope: Scope): Record<string, unknown> {
  const client = Object.create(null) as Record<string, unknown>;
  for (const [name, model] of engine.index.byDelegate) {
    const delegate = Object.create(null) as Record<Operation, (args?: unknown) => Promise<unknown>>;
    for (const op of OPERATIONS) {
      delegate[op] = async (args?: unknown): Promise<unknown> => {
        try {
          return await runOperation(engine, model, op, scope, args);
        } catch (err) {
          throw mapClientError(engine, model.ir.name, err);
        }
      };
    }
    client[name] = Object.freeze(delegate);
  }
  return client;
}

/**
 * Creates a client for `schema`. Every call validates its arguments, builds and compiles the query, runs it
 * through the adapter and returns plain objects decoded from schema fields only.
 */
export function createRuntimeClient(schema: SchemaIR, options: ClientOptions = {}): RuntimeClient {
  const provider = own(options, "provider") ?? schema.provider;
  if (provider === "postgresql") throw new ConfigError("Provider postgresql is not supported yet");
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- options may come from untyped code
  if (provider !== "sqlite") throw new ConfigError("Unsupported provider");
  const limits = resolveRuntimeLimits(own(options, "limits"));
  const debug = own(options, "debug") === true;
  const index = indexSchema(schema);
  let adapter: Adapter;
  try {
    adapter = openAdapter(schema, options);
  } catch (err) {
    // The driver cause may hold a file path: keep it only in debug mode.
    if (!debug && err instanceof ConfigError && err.debug !== undefined) throw new ConfigError(err.message);
    throw err;
  }
  if (adapter.dialect.name !== provider) throw new ConfigError("Adapter does not match the schema provider");
  const engine: Engine = { index, dialect: adapter.dialect, limits, debug };

  const top: Scope = {
    q: adapter,
    atomic: (fn) => adapter.transaction(fn),
    assertActive: () => undefined,
  };

  const $transaction = async <T>(fn: (tx: RuntimeClient) => Promise<T>): Promise<T> => {
    if (typeof fn !== "function") throw new ValidationError("Expected a function", "$transaction");
    let active = true;
    try {
      return await adapter.transaction((q: Queryable) => {
        // Bound to the transaction's connection only: calling the outer adapter here would deadlock.
        const scope: Scope = {
          q,
          atomic: (step) => step(q),
          assertActive: () => {
            if (!active) throw new TransactionError("Transaction is no longer active");
          },
        };
        return fn(Object.freeze(delegates(engine, scope)) as RuntimeClient);
      });
    } catch (err) {
      throw mapClientError(engine, undefined, err);
    } finally {
      active = false;
    }
  };

  const client = delegates(engine, top);
  client.$transaction = $transaction;
  client.$disconnect = async (): Promise<void> => {
    try {
      await adapter.close();
    } catch (err) {
      throw mapClientError(engine, undefined, err);
    }
  };
  return Object.freeze(client) as RuntimeClient;
}
