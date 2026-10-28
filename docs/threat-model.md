# Threat model

Every protection of the mini-ORM is listed here with the code that implements it and the tests that prove it.
Each protection was verified to be load-bearing: with it disabled locally, at least one of the listed tests fails
(mutation check, see the last column). Run everything with `npm run test:unit`; the attack suites live in
`tests/security/`.

Scope: the ORM is a library used by trusted application code, but its **arguments are assumed attacker-influenced**
(HTTP bodies, query strings, parsed JSON). The database file, the schema file and the process environment are
trusted inputs, yet the schema parser and the DDL generator are still hardened.

## Summary

| # | Threat | Protection | Where | Proving tests |
|---|---|---|---|---|
| 1 | SQL injection through a value | Every value is a bound parameter; the query builder accepts no SQL text | `src/dialects/sqlite.ts` (`Compiler.param`), `src/runtime/query-builder.ts` | `tests/security/injection.test.ts`: `payload N > is stored and matched literally as a value`, `... through update, upsert and a nested relation filter`, `values never reach the SQL text`; `tests/unit/dialects/sqlite.test.ts`: `compiles a parameterized select`, `text depends only on the query shape` |
| 2 | SQL injection through an identifier (column, table, sort key) | Identifiers come only from the schema IR; unknown keys in `where`/`select`/`orderBy`/`include`/`data` are rejected; strict quoting | `src/runtime/validation/{filters,query,data}.ts`, `src/dialects/sqlite.ts` (`quoteIdentifier`), `src/schema/validator.ts` | `injection.test.ts`: `payload N > is rejected as a key in {where, where filter operator, where relation filter, where relation operator, select, orderBy, include, include option, data, top-level option}`; `ddl.test.ts`: `rejects identifiers that are not plain identifiers`; `schema.test.ts`: `rejects names that could break out of a quoted SQL identifier`, `rejects reserved internal names`; `prototype.test.ts`: `do not make unknown field names valid` |
| 3 | Injection through pattern matching (`contains`, `startsWith`, `endsWith`) | SQLite `GLOB` is used (case sensitive); `*`, `?` and `[` are neutralised in a single pass. `%`, `_` and `\` are not special in GLOB, so they match literally | `src/dialects/sqlite.ts` (`globPattern`) | `injection.test.ts`: `string filters treat pattern metacharacters literally`; `tests/unit/dialects/sqlite.test.ts`: `globPattern escapes GLOB metacharacters` |
| 4 | Sort direction injection | Only `"asc"` / `"desc"` accepted at runtime; the dialect additionally re-derives the keyword from a literal | `src/runtime/validation/query.ts` (`parseOrderBy`), `src/dialects/sqlite.ts` (`Compiler.select`) | `injection.test.ts`: `payload N > is rejected as a sort direction (orderBy / orderBy in include)`; `ddl.test.ts`: `re-derives the sort direction from a literal` |
| 5 | Prototype pollution and prototype reads | `__proto__`, `constructor`, `prototype` rejected as keys (also inside Json values); arguments are read through `Map` / own data properties only; client and delegates have a null prototype; every optional property read from an internal object (validated args, query AST, schema IR `default`) and every optional option (client `url`, `env`, `adapter`, `provider`, `limits`, `debug`, `transactionTimeoutMs`; migration `force`/`env`/`name`/`now`; generator `runtimeImport`; `loadSchema`/`parse` `file` and `limits`) is read with `Object.hasOwn` (`own()`), and schema limit overrides (`maxSourceBytes`, `maxIdentifierLength`, `maxStringLength`, `maxNestingDepth`, in both the parser and the lexer) are taken from own properties only, so a polluted `Object.prototype` cannot inject a filter, limit, column list, default value, option or generated import | `src/runtime/validation/plain.ts` (`readObject`), `src/own.ts`, `src/runtime/client.ts`, `src/adapters/sqlite.ts`, `src/runtime/query-builder.ts`, `src/runtime/include.ts`, `src/runtime/validation/data.ts`, `src/dialects/sqlite.ts`, `src/generator/client.ts`, `src/migrations/runner.ts`, `src/schema/{index,parser,lexer,limits}.ts` (`resolveSchemaLimits`) | `tests/security/prototype.test.ts`: `forbidden key {__proto__,constructor,prototype} > {direct,chained} > is rejected in <position> and pollutes nothing`, `... is rejected as a key inside a Json value`, `... is rejected as a model or field name in a schema`, `polluting Object.prototype never changes what a query does`, `do not expose delegates or operations that do not exist`, `inherited generator and schema options > a polluted runtimeImport never changes the generated client`, `... > polluted limits, file or limit keys never change what loadSchema does`, `query results > are plain objects with schema fields only`; `tests/unit/schema/lexer.test.ts`: `ignores undefined, NaN, non-finite, non-positive and fractional limit overrides` |
| 6 | Wrong runtime type (untyped JS, JSON from a client) | Arguments are validated against the IR; an object where a scalar is expected (`{ email: { $ne: null } }`), accessors, class instances, `NaN`, `undefined`, etc. are errors and never interpreted. NUL characters are rejected | `src/runtime/validation/{scalars,filters,plain}.ts` | `tests/security/runtime-types.test.ts` (all); `injection.test.ts`: `NUL characters are rejected ...`, `payload N > is rejected as an enum value`, `... where a number is expected`; `tests/unit/runtime/validation.test.ts` |
| 7 | Denial of service by query shape | Configurable limits: `take`, `skip`, `in`/`notIn` size, `createMany` size, `where` depth, `include` depth, total where terms, `orderBy` entries, string length, rows per read; an invalid override (NaN, 0, negative, non-number) throws instead of disabling a limit | `src/runtime/limits.ts`, `src/runtime/validation/plain.ts` (`withinLimit`), `src/runtime/client/operations.ts` (`maxRows`) | `tests/security/limits.test.ts` (all); `tests/unit/runtime/validation.test.ts`: `enforces the take limit`, `fails closed on NaN or missing limits`; `tests/unit/runtime/client.test.ts`: `raises LimitExceededError when findMany exceeds maxRows` |
| 8 | Information leak through errors | Typed errors with generic messages; SQL, parameters and driver causes live in a non-enumerable `debug` property that is only populated with `debug: true`; connection URLs and absolute paths never appear | `src/errors.ts`, `src/runtime/client/errors.ts`, `src/runtime/client.ts`, `src/adapters/sqlite.ts`, `src/migrations/files.ts` | `tests/security/leaks.test.ts`: `<scenario> > exposes nothing sensitive by default` (validation, unique, foreign key, not found, driver failure, transaction, missing URL, invalid URL, unopenable database file, migration filesystem failure), `... exposes SQL only in err.debug when debug is on`, `connection URLs ...`; `tests/unit/errors.test.ts`: `never exposes debug info through message, JSON or inspect` |
| 9 | Dynamic code execution | No `eval`, `new Function`, `vm` or `child_process` in `src/`; ESLint rules `no-eval`, `no-implied-eval`, `no-new-func`; the generator embeds the schema only as a JSON literal and validates the runtime import specifier | `eslint.config.js`, `src/generator/client.ts` | `tests/security/static.test.ts`: `dynamic code > never appears in src/`, `... is forbidden by the lint configuration`; `tests/unit/generator/client.test.ts`: `embeds the schema only as JSON and never inlines raw schema text`, `rejects a suspicious runtimeImport` |
| 10 | Injection through the DDL (literal defaults, enum values) | Literal defaults and enum values are emitted with `quoteLiteral` (quote doubling, NUL rejected); identifiers are quoted and validated | `src/dialects/sqlite.ts` (`quoteLiteral`, `createTables`) | `tests/security/ddl.test.ts`: `keeps a hostile default as an inert string`, `stores the exact default text in the table definition`, `round-trips corpus payload N`, `emits enum CHECK values from the schema only, quoted`; `tests/unit/dialects/sqlite.test.ts`: `quotes DDL literals safely` |
| 11 | Hostile schema file (parser) | Maximum source size, identifier length, string length and nesting depth; identifier charset; reserved names; iterative lexing, no unbounded recursion; only typed `SchemaError` escapes | `src/schema/{lexer,parser,validator,limits}.ts` | `tests/security/schema.test.ts` (all); `tests/unit/schema/{lexer,parser,validator}.test.ts` |
| 12 | Dependencies | No runtime dependency; `npm audit --audit-level=high` in CI; Dependabot for npm and GitHub Actions; CodeQL | `package.json`, `.github/workflows/{ci,codeql}.yml`, `.github/dependabot.yml` | `tests/security/static.test.ts`: `supply chain > has no runtime dependency`, `... audits dependencies in CI and updates them with Dependabot` |

## The injection corpus

`tests/security/corpus.ts` exports `INJECTION_PAYLOADS`: classic tautologies, statement stacking, comment
terminators, nested quotes, a backslash-escaped quote, a `UNION SELECT`, a Unicode apostrophe, a right-to-left
override, an emoji payload and a string of 10 000 quotes. NUL is excluded on purpose (it is rejected by design and has
its own test). Every payload is exercised, with `describe.each`, at every position where input is accepted:

- as a **value** (create, update, upsert, `equals`, `not`, `in`, `contains`, `startsWith`, `endsWith`, relation filters):
  it must be stored and found literally, and no table may lose a row;
- as a **key** in `where` (field, operator, relation operator), `select`, `orderBy`, `include` (relation and option),
  `data` and the top-level options: `ValidationError`, database untouched;
- as a **sort direction**, **enum value** and **numeric value**: `ValidationError`;
- in a schema **default** literal: the DDL runs, both tables exist and the default reads back identically;
- against a recording adapter: the payload never appears in the SQL text, only in bound parameters.

A final test runs the whole corpus through every position against one shared database and checks `sqlite_master`
still lists `Post` and `User` with their rows.

## Protections verified by mutation

For each protection, the code was temporarily altered (never committed) and the suites were re-run. The test names
below are the first failures observed.

| Protection | Disabled by | Failing test (examples) |
|---|---|---|
| Bound parameters | inlining string values in `Compiler.param` | `injection.test.ts > values never reach the SQL text`, `sqlite.test.ts > compiles a parameterized select` |
| GLOB escaping | `globPattern` returns the raw value | `injection.test.ts > string filters treat pattern metacharacters literally` |
| Unknown key in `where` / `select` / `orderBy` / `include` / `data` | each lookup falls back to a real field | `injection.test.ts > payload N > is rejected as a key in <position>` |
| Sort direction (runtime) | removing the `asc`/`desc` check | `injection.test.ts > ... is rejected as a sort direction` |
| Sort direction (dialect) | emitting `o.direction` as is | `ddl.test.ts > re-derives the sort direction from a literal` |
| Identifier quoting | `quoteIdentifier` skips the regexp | `ddl.test.ts > rejects identifiers that are not plain identifiers` |
| Forbidden keys | removing the `FORBIDDEN_KEYS` check | `prototype.test.ts > ... is rejected as a key inside a Json value` |
| Own-property reads | reverting any one `own()` site (`default` x4, `debug`, `env`, `url`, `provider`, `limits`, `adapter`, `transactionTimeoutMs`, `force`, `where`, `select`, `take`...) to plain access | `prototype.test.ts > polluting Object.prototype never changes what a query does` (one equivalent mutation, `filled` in `buildInsert`, is masked by the `own()` in `runtimeDefault`) |
| Null-prototype client | `{}` instead of `Object.create(null)` | `prototype.test.ts > do not expose delegates or operations that do not exist` |
| Runtime type validation | coercing with `String(value)` / accepting any object | `runtime-types.test.ts > ... where a scalar is expected` |
| NUL rejection | removing the check | `injection.test.ts > NUL characters ...` |
| Limits | `withinLimit` always true; huge default `maxTake`; limit overrides unchecked; `maxRows` check removed | `limits.test.ts > caps take, skip, ...`, `refuses limit overrides ...`, `caps the rows a single read may return` |
| `debug` hidden | `enumerable: true` on `debug` | `leaks.test.ts > exposes nothing sensitive by default` |
| SQL in constraint errors only in debug | `violationDebug` always attaches SQL | `leaks.test.ts > unique constraint ... exposes nothing sensitive by default` |
| Driver cause stripped (database / config errors) | removing the stripping branches | `leaks.test.ts > driver failure ...`, `... database file that cannot be opened` |
| DDL literal quoting | `quoteLiteral` stops doubling quotes | `ddl.test.ts > keeps a hostile default as an inert string` |
| No dynamic code | adding `eval(...)` to `src/errors.ts`; switching off `no-eval` | `static.test.ts > never appears in src/`, `... is forbidden by the lint configuration` |
| Zero runtime dependencies | adding a `dependencies` entry | `static.test.ts > has no runtime dependency` |
| Schema size / nesting / identifiers / reserved names | removing each check | `schema.test.ts > rejects oversized sources, ...`, `rejects names that could break out ...`, `rejects reserved internal names` |
| Generator literal / import specifier | un-escaping the JSON literal; skipping the specifier check | `generator/client.test.ts > embeds the schema only as JSON ...`, `rejects a suspicious runtimeImport` (this row relies on `tests/unit/generator`, `tests/security` has no generator test) |

## Known limits and design notes

- **Key names in error paths.** A rejected key is reported in the error's key path (`where.<key>`) after stripping
  control characters and truncating to 63 characters. Values are never included. Applications that echo `err.message`
  to untrusted users should be aware that attacker-chosen key names can appear there.
- **Migration errors keep their filesystem cause** in the non-enumerable `debug` property regardless of the client's
  `debug` flag, because migrations run in the CLI, which prints it only with `--debug`. It never appears in `message`,
  `JSON.stringify` or `util.inspect`.
- **Pre-existing prototype pollution** elsewhere in the process is a defect of that other code. The ORM still ignores
  inherited values for the properties listed in row 5. The regression test pollutes `where`, `select`, `take`, `skip`,
  `limit`, `offset`, `returning`, `default` (four shapes), `debug`, `env`, `url`, `provider`, `limits`, `force`,
  `adapter`, `transactionTimeoutMs` and `now` while running 14 operations plus DDL, required-field, constraint-error,
  client-opening and `resetDatabase` checks, and compares them with an unpolluted run. Two further tests pollute the
  generator option `runtimeImport` and the schema options `file`, `limits`, `maxSourceBytes`, `maxIdentifierLength`,
  `maxStringLength` and `maxNestingDepth`, and compare `generateClient` / `loadSchema` output with an unpolluted run.
  Not exercised by any pollution test (but read through `own()`): migration `name` and `now`. The CLI builds its own `io`/option objects
  (`parseArgs` returns null-prototype values; env lookups use `Object.hasOwn`) and is out of scope. Reading a polluted
  `Object.prototype` elsewhere (user code, error `debug` checks that only ever strip data) is not defended further.
- **Not covered in phase 1:** multi-tenant authorization, row-level security, encryption at rest, PostgreSQL.
