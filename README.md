# mini-orm

[![CI](https://github.com/kakotodev/ORM/actions/workflows/ci.yml/badge.svg)](https://github.com/kakotodev/ORM/actions/workflows/ci.yml)
[![CodeQL](https://github.com/kakotodev/ORM/actions/workflows/codeql.yml/badge.svg)](https://github.com/kakotodev/ORM/actions/workflows/codeql.yml)

A security-first, Prisma-like mini-ORM for TypeScript. You describe your data in a `schema.orm` file, generate a
fully typed client, and query SQLite through an API that will feel familiar if you have used Prisma. The library has
**zero runtime dependencies** (it uses the built-in `node:sqlite`), and every protection is documented and tested in
the [threat model](docs/threat-model.md).

This is a portfolio project (`"private": true`, not published to npm). Phase 1 targets SQLite; PostgreSQL is planned
for phase 2.

## Features

- Prisma-like schema language: models, enums, relations, `@id`, `@unique`, `@default`, `@updatedAt`, `@@index`, `@@unique`.
- Generated, fully typed client (`select` / `include` narrow the result types).
- Parameterized SQL only: values are never concatenated into SQL text.
- Runtime validation of every argument against the schema, even for untyped JS callers.
- Additive SQL migrations driven by a small CLI.
- Configurable runtime limits against denial of service.
- Errors that never leak SQL, parameters, connection URLs or absolute paths.
- Fuzz tests (fast-check) and a SQL injection corpus exercised at every key and value position.
- Requires Node.js >= 22.13.

## Quick start

```bash
git clone https://github.com/kakotodev/ORM.git
cd ORM
npm ci
npm run build
```

1. Write a schema (`examples/blog/schema.orm` is a complete example):

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  name  String?
  posts Post[]
}

model Post {
  id        Int     @id @default(autoincrement())
  title     String
  published Boolean @default(false)
  author    User    @relation(fields: [authorId], references: [id], onDelete: Cascade)
  authorId  Int
}
```

2. Generate the typed client, then create the tables:

```bash
export DATABASE_URL=file:./dev.db
npx mini-orm generate --schema ./schema.orm --out ./generated
npx mini-orm migrate --schema ./schema.orm --dir ./migrations
```

3. Query:

```ts
import { createClient } from "./generated/index.js";

const db = createClient(); // reads DATABASE_URL

try {
  const ada = await db.user.create({ data: { email: "ada@example.com", name: "Ada" } });
  await db.post.create({ data: { title: "Hello", author: { connect: { id: ada.id } } } });

  const users = await db.user.findMany({
    where: { email: { endsWith: "@example.com" } },
    include: { posts: { orderBy: { id: "asc" } } },
  });

  await db.$transaction(async (tx) => {
    await tx.post.updateMany({ where: { authorId: ada.id }, data: { published: true } });
  });
} finally {
  await db.$disconnect();
}
```

Run the complete blog example with `DATABASE_URL=file:./examples/blog/dev.db npm run example`.

### CLI

```text
mini-orm generate [--schema ./schema.orm] [--out ./generated] [--runtime-import mini-orm]
mini-orm migrate [--schema ./schema.orm] [--dir ./migrations] [--name <label>]
mini-orm migrate reset --force [--schema ./schema.orm] [--dir ./migrations]
Options: --debug, --help, --version
```

## Supported API

| Area | Supported |
|---|---|
| Reads | `findMany`, `findFirst`, `findUnique`, `count` |
| Writes | `create`, `createMany`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany` |
| Scalar filters | `equals`, `not`, `in`, `notIn`, `lt`, `lte`, `gt`, `gte`, `contains`, `startsWith`, `endsWith` (`null` matches NULL) |
| Logical filters | `AND`, `OR`, `NOT` |
| Relation filters | `some`, `none`, `every` (to-many); `is`, `isNot` (to-one) |
| Shaping | `select`, `include` (nested), `orderBy`, `take`, `skip` |
| Relations in writes | `connect` |
| Transactions | `db.$transaction(async (tx) => { ... })` |
| Lifecycle | `db.$disconnect()` |

`updateMany` and `deleteMany` require a `where` key (pass `{}` to target every row).

### Type mapping

| Schema type | TypeScript type | SQLite storage |
|---|---|---|
| `Int` | `number` | INTEGER |
| `BigInt` | `bigint` | INTEGER |
| `Float` | `number` | REAL |
| `Decimal` | `string` | TEXT |
| `String` | `string` | TEXT |
| `Boolean` | `boolean` | INTEGER (0/1) |
| `DateTime` | `Date` | TEXT (ISO 8601) |
| `Json` | `JsonValue` | TEXT |
| `Bytes` | `Uint8Array` | BLOB |
| `enum` | union of string literals | TEXT with a `CHECK` constraint |

## Security model

The ORM's arguments are assumed to be attacker-influenced (HTTP bodies, query strings, parsed JSON). The full
[threat model](docs/threat-model.md) lists each protection, the code that implements it and the tests that prove it.
In short:

- **Parameterized SQL.** Every value is a bound parameter; the query builder accepts no SQL text.
- **Schema whitelist.** Identifiers (tables, columns, sort keys) come only from the schema; unknown keys in
  `where`, `select`, `orderBy`, `include` and `data` are rejected.
- **Runtime validation.** Arguments are checked against the schema at runtime: wrong types, `NaN`, `undefined`,
  class instances, accessors and NUL characters are errors, never interpreted.
- **Prototype-pollution hardening.** `__proto__`, `constructor` and `prototype` are rejected as keys; arguments and
  options are read as own properties only; the client and its delegates have a null prototype.
- **Limits.** Configurable caps on `take`, `in` size, nesting depth, rows and string length (see below).
- **Non-leaking errors.** Typed errors with generic messages; SQL and driver causes only appear in a non-enumerable
  `debug` property when `debug: true`.
- **No dynamic code.** No `eval` or `new Function` in `src/`, enforced by lint and a test.
- **Fuzzing and an injection corpus.** Property-based tests (`tests/fuzz/`) and a corpus of hostile payloads
  (`tests/security/corpus.ts`) are exercised at every input position.
- **Supply chain.** No runtime dependency, `npm audit` in CI, Dependabot and CodeQL.

## Limits

Defaults, overridable per client with `createClient({ limits })`. Partial overrides are merged onto the defaults; an
invalid value such as `NaN`, `0` or a negative number throws instead of disabling a limit.

| Limit | Default | Meaning |
|---|---|---|
| `maxTake` | 1000 | Largest `take` |
| `maxRows` | 10000 | Rows returned by one read |
| `maxWhereDepth` | 5 | Nesting depth of `where` |
| `maxIncludeDepth` | 3 | Nesting depth of `include` |
| `maxInListSize` | 1000 | Elements of `in` / `notIn` |
| `maxCreateManyRows` | 1000 | Rows of one `createMany` |
| `maxStringLength` | 1000000 | Length of a string value |
| `maxWhereTerms` | 5000 | Field conditions in one call |
| `maxOrderBy` | 16 | `orderBy` entries per query or include |

```ts
const db = createClient({ limits: { maxTake: 100, maxRows: 500 } });
```

The schema parser has its own fixed limits (1 MiB of source, 63-character identifiers, 4096-character strings,
nesting depth 16).

## Known limitations

- Interactive transactions time out after 5 s by default; change it with `createClient({ transactionTimeoutMs })`.
  Inside `$transaction` you must use the `tx` client, not `db`.
- `every` is NULL-safe, which differs from Prisma when the related column contains NULLs.
- Text filters (`contains`, `startsWith`, `endsWith`) are case-sensitive.
- When `select` / `include` arguments are a widened variable (not a literal), result types widen to the full model.
- `undefined` in arguments is rejected at runtime, even where the types allow optional properties.
- With `--debug`, CLI errors may print driver messages that include file paths.
- Migrations are additive-only (new tables, columns and indexes). In development, use
  `mini-orm migrate reset --force` to start over.

### Out of scope

Many-to-many relations, nested `create` through relations, aggregations (`sum`, `groupBy`, ...) and any database
other than SQLite until phase 2.

## Roadmap

- **Phase 2:** PostgreSQL adapter and dialect, benchmarks, a `docker-compose` setup for integration tests.

## Development

```bash
npm run lint              # ESLint (with eslint-plugin-security)
npm run typecheck         # tsc --noEmit
npm run test:unit         # unit + security + fuzz suites
npm run test:integration  # SQLite end-to-end tests
npm run test:types        # type-level tests
npm run coverage          # all tests with coverage thresholds
FC_NUM_RUNS=2000 npm run test:unit   # deeper fuzz campaigns (default 200 runs per property)
```

Coverage gates: at least 90% for `src/runtime/**` and `src/dialects/**`, and 80% overall. CI runs lint, typecheck,
type tests, unit tests on Node 22 and 24 (with a coverage artifact), `npm audit`, the SQLite integration tests and
CodeQL.

Layout: `src/schema` (parser), `src/dialects` (SQL generation), `src/adapters` (drivers), `src/runtime`
(validation and execution), `src/generator` (typed client), `src/migrations`, `src/cli`; tests live under
`tests/{unit,integration,security,fuzz,types}`.
