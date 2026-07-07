import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { validateReadOnlySelect } from "../src/core/sql-guard.js";
import { type SqlConn, wrapSqlConn } from "../src/core/ports.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";

// The host-control surface IS the injected ports — not a separate hook framework. The library guard is
// statement-class only (it now ACCEPTS external readers; egress is the host's call). A host that wants a
// strict no-external-I/O profile gets it by WRAPPING the SqlConn it already injects — composition, not a new
// ExecutionPolicy interface. This proves the "optional strict profile" the docs promise is real today: the
// ports are the hooks (validateSql = wrap conn.all/run; beforeResolve = wrap the bound impl; beforeRun/
// afterRun = orchestrate runOperation, which already returns run/result/receipts).

/** A host policy expressed as a port decorator: deny external readers / remote URIs in any executed SQL. */
function strictNoExternalIo(inner: SqlConn): SqlConn {
  const deny = /\bread_\w*\s*\(|\b(https?|s3|gs|gcs):\/\//i;
  const guard = (sql: string): void => { if (deny.test(sql)) throw new Error("host policy: external I/O denied"); };
  return wrapSqlConn(inner, ({ sql }) => guard(sql));
}

function walkJson(value: unknown, visit: (obj: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visit);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const obj = value as Record<string, unknown>;
  visit(obj);
  for (const child of Object.values(obj)) walkJson(child, visit);
}

async function tableReferences(inner: SqlConn, sql: string): Promise<string[]> {
  const escaped = sql.replace(/'/g, "''");
  const rows = await inner.all<{ ast?: unknown }>(`SELECT json_serialize_sql('${escaped}') AS ast`);
  const ast = JSON.parse(String(rows[0]?.ast ?? "{}")) as unknown;
  const refs = new Set<string>();
  walkJson(ast, (obj) => {
    if (obj.type !== "BASE_TABLE" || typeof obj.table_name !== "string" || obj.table_name.length === 0) return;
    const parts = [obj.catalog_name, obj.schema_name, obj.table_name].filter((x): x is string => typeof x === "string" && x.length > 0);
    refs.add(parts.join(".").toLowerCase());
  });
  return [...refs].sort();
}

function denyRelations(inner: SqlConn, deniedRelations: readonly string[]): SqlConn {
  const denied = new Set(deniedRelations.map((r) => r.toLowerCase()));
  const catalogFunctions = new Set(["duckdb_tables", "duckdb_columns", "duckdb_views", "duckdb_schemas"]);
  return wrapSqlConn(inner, async ({ sql }) => {
    const escaped = sql.replace(/'/g, "''");
    const astText = String((await inner.all<{ ast?: unknown }>(`SELECT json_serialize_sql('${escaped}') AS ast`))[0]?.ast ?? "{}");
    const ast = JSON.parse(astText) as unknown;
    let catalogHit: string | undefined;
    walkJson(ast, (obj) => {
      if (catalogHit) return;
      if (obj.type === "SHOW_REF" && obj.query == null) catalogHit = String(obj.show_type ?? "SHOW");
      if (obj.type === "BASE_TABLE" && obj.schema_name === "information_schema") catalogHit = `information_schema.${String(obj.table_name)}`;
      if (obj.class === "FUNCTION" && typeof obj.function_name === "string" && catalogFunctions.has(obj.function_name.toLowerCase())) {
        catalogHit = `${obj.function_name}()`;
      }
    });
    if (catalogHit) throw new Error(`host policy: catalog metadata '${catalogHit}' is not visible to this subject`);
    const refs = await tableReferences(inner, sql);
    const hit = refs.find((r) => denied.has(r) || denied.has(r.split(".").at(-1) ?? r));
    if (hit) throw new Error(`host policy: relation '${hit}' is not visible to this subject`);
  });
}

describe("host policy via port-wrapping (the ports are the hooks)", () => {
  test("the LIBRARY guard accepts an external reader — egress is not its concern", () => {
    const sql = "SELECT * FROM read_csv_auto('x.csv')";
    assert.equal(validateReadOnlySelect(sql), sql); // statement-class only; permissive by default
  });

  test("a HOST enforces a strict profile by wrapping the injected SqlConn — no hook framework needed", async () => {
    const raw = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    const strict = strictNoExternalIo(raw);

    // ordinary analytic SQL still runs through the host's strict connection
    const ok = await strict.all<{ n: number }>("SELECT 42 AS n");
    assert.equal(Number(ok[0]!.n), 42);

    // but the host's policy blocks an external read the LIBRARY would have allowed — strict mode is the host's,
    // layered over the same port the runner uses, with zero library API for it
    await assert.rejects(() => strict.all("SELECT * FROM read_csv_auto('/etc/passwd')"), /host policy: external I\/O denied/);
  });

  test("a HOST can hide relations, including DESCRIBE/SUMMARIZE introspection, by wrapping the same port", async () => {
    const raw = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    await raw.run("CREATE TABLE allowed(id INTEGER, label VARCHAR)");
    await raw.run("INSERT INTO allowed VALUES (1, 'ok')");
    await raw.run("CREATE TABLE secret(id INTEGER, token VARCHAR)");
    await raw.run("INSERT INTO secret VALUES (1, 'do-not-show')");
    const scoped = denyRelations(raw, ["secret"]);

    assert.deepEqual(await scoped.all<{ id: number }>("SELECT id FROM allowed"), [{ id: 1 }]);
    assert.ok((await scoped.all("DESCRIBE allowed")).length > 0);

    for (const sql of [
      "SELECT * FROM secret",
      "DESCRIBE secret",
      "SUMMARIZE SELECT token FROM secret",
      "WITH x AS (SELECT token FROM main.secret) SELECT count(*) n FROM x",
    ]) {
      await assert.rejects(() => scoped.all(sql), /host policy: relation '.*secret' is not visible/, sql);
    }

    assert.deepEqual(await raw.all<{ token: string }>("SELECT token FROM secret"), [{ token: "do-not-show" }], "the policy is scoped to the wrapped host port, not the database");
  });

  test("a relation-visibility policy must also close catalog disclosure channels", async () => {
    const raw = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
    await raw.run("CREATE TABLE secret(id INTEGER)");
    const scoped = denyRelations(raw, ["secret"]);

    for (const sql of [
      "SHOW TABLES",
      "SHOW SCHEMAS",
      "SELECT table_name FROM information_schema.tables",
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_name = 'secret'",
      "SELECT table_name FROM duckdb_tables()",
      "SELECT table_name, column_name FROM duckdb_columns()",
    ]) {
      await assert.rejects(() => scoped.all(sql), /host policy: catalog metadata .* is not visible/, sql);
    }
  });
});
