import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { SqlConn } from "../src/core/ports.js";
import type { VirtualResourceSpec } from "../src/core/resources.js";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";
import { httpTableResolver, type FetchLike } from "../src/duckdb/resolvers/http-table-scan.js";

// The chimp's payoff: cross-db reuse of remote bytes. Two SEPARATE in-memory dbs share ONE CAS root. The first
// fetch (200) snapshots the body into CAS and records the url->ETag index. The second db has an EMPTY per-db
// memo, but the shared CAS supplies the ETag -> conditional GET -> 304 -> the table is materialized FROM the
// CAS bytes with NO body re-download.
async function memoryConn(): Promise<SqlConn> {
  return duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
}
const resource = (params: Record<string, unknown>): VirtualResourceSpec => ({ id: "r", title: "R", kind: "virtual", resolver: "http.get", params });

describe("CAS-of-bytes: cross-db remote reuse (http.get)", () => {
  test("a second db with an empty memo gets a 304 from the shared CAS and never re-downloads the body", async () => {
    const casRoot = await fs.mkdtemp(join(tmpdir(), "pi-bio-cas-"));
    const cas = fsCasStore(casRoot);
    const url = "https://www.ebi.ac.uk/ols4/api/search?q=asthma";
    const params = { url, table: "candidates", format: "json" };

    let bodyDownloads = 0;
    const fetchImpl: FetchLike = async (_u, init) => {
      const h = { get: (n: string) => (n.toLowerCase() === "etag" ? "etag-1" : null) };
      if (init?.headers?.["If-None-Match"] === "etag-1") return { ok: false, status: 304, text: async () => "", headers: h };
      bodyDownloads++;
      return { ok: true, status: 200, text: async () => JSON.stringify([{ obo_id: "MONDO:0004979" }]), headers: h };
    };

    // db1: cold — 200, body downloaded once, bytes snapshotted into CAS + url->ETag index seeded
    const db1 = await memoryConn();
    await httpTableResolver(fetchImpl)(resource(params), { conn: db1, now: "T1", cas });
    assert.equal(bodyDownloads, 1);

    // db2: brand-new db, empty per-db memo. The SHARED CAS supplies the ETag -> 304 -> materialize from CAS.
    const db2 = await memoryConn();
    const out2 = await httpTableResolver(fetchImpl)(resource(params), { conn: db2, now: "T2", cas });
    assert.equal(bodyDownloads, 1, "no second body download — db2 materialized from CAS after a 304");
    // the table really exists in db2 with the CAS bytes
    const rows = await db2.all<{ obo_id: string }>("SELECT obo_id FROM candidates");
    assert.deepEqual(rows, [{ obo_id: "MONDO:0004979" }]);
    // the receipt addresses the same content and is tagged as a CAS resolution
    assert.equal(out2.provenance[0]!.notes?.includes("cas"), true);
    assert.match(out2.sourceSnapshots[0]!.version ?? "", /^sha256:[0-9a-f]{64}$/);
  });

  test("fast mode (no CAS) still works — body is materialized from a temp file, nothing snapshotted", async () => {
    const url = "https://example.org/data.json";
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify([{ a: 1 }]) });
    const conn = await memoryConn();
    const out = await httpTableResolver(fetchImpl)(resource({ url, table: "t", format: "json" }), { conn, now: "T1" });
    assert.equal(out.provenance[0]!.notes?.includes("cas"), false);
    assert.deepEqual(await conn.all("SELECT a FROM t"), [{ a: 1n }]); // DuckDB returns integers as BigInt
  });
});
