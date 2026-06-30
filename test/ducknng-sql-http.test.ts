import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";

// The SQL-native HTTP path, DETERMINISTIC — because ducknng ships the SERVER too, the fixture is a local ducknng
// HTTP server (no external network, no injected fetch). The whole grounding skill is SQL: SET VARIABLE params,
// url composed with getvariable + url_encode, the fetch + JSON->table by ducknng_ncurl_table, the grounding one
// SQL line. This is what `http.get` (TS) + a mock fetch stands in for when DuckDB's version has no ducknng build.
const ducknngAvailable = await (async () => {
  try {
    const c = await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect();
    await c.run("INSTALL ducknng FROM community");
    await c.run("LOAD ducknng");
    return true;
  } catch { return false; }
})();

describe("SQL-native HTTP grounding via ducknng (a local ducknng server is the deterministic fixture)", { skip: ducknngAvailable ? false : "ducknng unavailable (provision: INSTALL ducknng FROM community on a matching DuckDB)" }, () => {
  test("server serves JSON -> ncurl_table fetches+parses -> agent grounds, all SQL, no external network", async () => {
    const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
    const conn = duckdbNodeConn(await inst.connect());
    await conn.run("LOAD ducknng");
    const PORT = 45577;

    // FIXTURE: a ducknng HTTP server serving a canned OLS4-shaped search response from a SQL route handler
    await conn.run(`SELECT ducknng_start_server('ols_fixture', 'http://127.0.0.1:${PORT}/_ducknng', 1, 134217728, 300000, 0::UBIGINT)`);
    await conn.run(`SELECT ducknng_register_http_route('ols_fixture', 'GET', '/search', 'SELECT * FROM ducknng_http_json(200, ''[{"obo_id":"MONDO:0004979","label":"asthma"},{"obo_id":"MONDO:0004784","label":"allergic asthma"}]'')')`);

    // the AGENT supplies the query as a session variable; the url composes it in SQL (getvariable + url_encode);
    // ncurl_table fetches the LOCAL server and parses the JSON to a table; the grounding is one SQL line.
    await conn.run("SET VARIABLE query = 'asthma'");
    const rows = await conn.all<{ obo_id: string; label: string }>(
      `SELECT obo_id, label FROM ducknng_ncurl_table('http://127.0.0.1:${PORT}/search?q=' || url_encode(getvariable('query')), 'GET', NULL, NULL, 5000, 0::UBIGINT) WHERE lower(label) = getvariable('query')`,
    );
    assert.deepEqual(rows, [{ obo_id: "MONDO:0004979", label: "asthma" }]); // exact-match grounding over the fetched table

    // a DIFFERENT query composes a different URL from the SAME route — it's SQL, not a hardcoded term
    await conn.run("SET VARIABLE query = 'allergic asthma'");
    const url2 = await conn.all<{ u: string }>("SELECT 'http://127.0.0.1:" + PORT + "/search?q=' || url_encode(getvariable('query')) AS u");
    assert.match(url2[0]!.u, /q=allergic%20asthma$/, "url_encode composed the new query in SQL");

    inst.closeSync(); // tears down the server
  });
});
