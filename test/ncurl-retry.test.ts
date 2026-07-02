import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import http from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { buildNcurlRetrySql, ncurlRetry, ncurlRowAvailable } from "../src/duckdb/ncurl-retry.js";

// ncurl-retry: single-endpoint rate-limited retry. The recursive-CTE path needs the OWNED ducknng build (the
// volatile-scalar fix) loaded; the host-loop fallback works on the default community build. Both must reach 200
// in 3 attempts against a 503,503,200 fixture. The pure SQL builder is tested without any network.

// --- pure: the SQL builder (no DB, no network) ---
describe("ncurl-retry: the recursive-CTE SQL builder", () => {
  test("passes the URL UNCHANGED — row-correlation for the CTE re-fire rides on the TIMEOUT, not the URL", () => {
    const sql = buildNcurlRetrySql({ url: "http://x/y", maxAttempts: 4 });
    assert.match(sql, /WITH RECURSIVE attempts/);
    assert.doesNotMatch(sql, /attempt=/, "the URL must NOT be mutated with an attempt param (would break signed/strict URLs)");
    assert.match(sql, /ducknng_ncurl\('http:\/\/x\/y', 'GET'/, "the exact requested URL is passed to both arms");
    assert.match(sql, /\+ \(a\.attempt \+ 1\)/, "the recursive arm is row-correlated (forces per-iteration re-fire) via the timeout");
    assert.match(sql, /attempt < 4/, "honors maxAttempts (the recursion bound)");
    assert.match(sql, /status IS NULL OR status = 429 OR status >= 500/, "default transient predicate");
  });
  test("preserves an existing query string verbatim and escapes quotes (no appended param)", () => {
    const sql = buildNcurlRetrySql({ url: "http://x/y?q=1'2" });
    assert.match(sql, /'http:\/\/x\/y\?q=1''2'/, "the query string is preserved and the single quote is escaped; nothing appended");
    assert.doesNotMatch(sql, /attempt=/, "no attempt param appended to the URL");
  });
});

// --- integration: a 503,503,200 counting fixture ---
const ducknngAvailable = await (async () => {
  try {
    const c = await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect();
    await c.run("INSTALL ducknng FROM community");
    await c.run("LOAD ducknng");
    return true;
  } catch { return false; }
})();

// the owned (backported) build, if provision:ducknng-owned ran
const ownedExt = (() => {
  try {
    const ver = (createRequire(import.meta.url)("@duckdb/node-api/package.json").version as string).replace(/-.*$/, "");
    const p = join(process.cwd(), ".pi", "ducknng", `duckdb-${ver}`, "ducknng.duckdb_extension");
    return existsSync(p) ? p : null;
  } catch { return null; }
})();

function fixture(): { port: number; calls: () => number; close: () => Promise<void> } {
  let calls = 0;
  const server = http.createServer((_req, res) => {
    calls++;
    const status = calls <= 2 ? 503 : 200;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ call: calls }));
  });
  server.listen(0);
  const port = (server.address() as { port: number }).port;
  return { port, calls: () => calls, close: () => new Promise((r) => server.close(() => r())) };
}

describe("ncurl-retry: host-loop fallback (default community build)", { skip: ducknngAvailable ? false : "ducknng unavailable" }, () => {
  let fx: ReturnType<typeof fixture>;
  before(() => { fx = fixture(); });
  after(() => fx.close());
  test("retries 503,503 -> 200 in 3 real calls via the host loop", async () => {
    const c = duckdbNodeConn(await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect());
    await c.run("LOAD ducknng"); // community build: no ducknng__ncurl_row -> host-loop path
    assert.equal(await ncurlRowAvailable(c), false, "community build lacks the volatile fix");
    const r = await ncurlRetry(c, { url: `http://127.0.0.1:${fx.port}/retry`, maxAttempts: 5 });
    assert.equal(r.via, "host-loop");
    assert.equal(r.status, 200);
    assert.equal(r.attempts, 3);
    assert.equal(fx.calls(), 3, "exactly 3 server-side calls (re-fired by the host loop)");
  });
});

describe("ncurl-retry: SQL-native recursive-CTE (owned/backported build)", { skip: ownedExt ? false : "owned ducknng build not provisioned (run: npm run provision:ducknng-owned)" }, () => {
  let fx: ReturnType<typeof fixture>;
  before(() => { fx = fixture(); });
  after(() => fx.close());
  test("retries 503,503 -> 200 in ONE recursive-CTE statement, 3 real calls", async () => {
    const c = duckdbNodeConn(await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect());
    await c.run(`LOAD '${ownedExt}'`); // the owned build -> ducknng__ncurl_row VOLATILE
    assert.equal(await ncurlRowAvailable(c), true, "owned build has the volatile fix");
    const r = await ncurlRetry(c, { url: `http://127.0.0.1:${fx.port}/retry`, maxAttempts: 5 });
    assert.equal(r.via, "recursive-cte");
    assert.equal(r.status, 200);
    assert.equal(r.attempts, 3);
    assert.equal(fx.calls(), 3, "the recursive CTE re-fired exactly 3 real calls (no speculative extra)");
  });
});
