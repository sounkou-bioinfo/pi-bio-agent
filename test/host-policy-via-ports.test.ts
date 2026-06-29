import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { validateReadOnlySelect } from "../src/core/sql-guard.js";
import type { SqlConn } from "../src/core/ports.js";
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
  return {
    all: async (sql, params) => { guard(sql); return inner.all(sql, params); },
    run: async (sql, params) => { guard(sql); return inner.run(sql, params); },
  };
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
});
