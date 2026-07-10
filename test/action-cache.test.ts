import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";
import { createBioObservationSchema, observationAsOfKey, observationsAsOf } from "../src/duckdb/observations.js";
import { actionCacheGet, actionCachePut, actionInputDigest, recallRunResult } from "../src/hosts/action-cache.js";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";
import type { CasStore } from "../src/core/cas.js";
import { MEMORY_NOW } from "../src/hosts/memory-store.js";

const conn = async (): Promise<SqlConn> => {
  const c = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await createBioObservationSchema(c);
  return c;
};

describe("run-store lean mode: run.json never points at an unwritten file", () => {
  test("serialize:false — the output artifact in run.json is the CAS uri, and result.json is NOT written", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const cwd = await fsp.mkdtemp(join(tmpdir(), "lean-run-"));
    const res = await runBioQueryFromManifest({
      cwd, dbPath: ":memory:", manifestPath: join(process.cwd(), "examples/variant-counts/manifest.json"),
      sql: "SELECT 1 AS x", store, author: "agent:A", cas, serialize: false,
    });
    assert.equal(res.ok, true);
    await assert.rejects(fsp.access(join(res.runDir, "result.json")), "result.json is NOT written in lean mode");
    const run = JSON.parse(await fsp.readFile(join(res.runDir, "run.json"), "utf8"));
    const outArt = (run.artifacts ?? []).find((a: { role?: string }) => a.role === "output");
    assert.match(outArt.path, /^cas:sha256:/, "the output artifact points at CAS, not the missing result.json");
  });
});

describe("run-store BigInt serialization: lossless, no silent >2^53 corruption", () => {
  test("a BIGINT beyond 2^53 persists as a lossless decimal string; a small one stays a number", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const cwd = await fsp.mkdtemp(join(tmpdir(), "bigint-run-"));
    const res = await runBioQueryFromManifest({
      cwd, dbPath: ":memory:", manifestPath: join(process.cwd(), "examples/variant-counts/manifest.json"),
      sql: "SELECT 9223372036854775807::BIGINT AS big, 42::BIGINT AS small", store, author: "agent:A", cas,
    });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    const parsed = JSON.parse(await fsp.readFile(join(res.runDir, "result.json"), "utf8"));
    const row = parsed.rows[0];
    assert.equal(row.big, "9223372036854775807", "a >2^53 value is a lossless string, not a rounded Number");
    assert.equal(row.small, 42, "a small value stays a natural JSON number");
    assert.deepEqual(res.result.rows[0], row, "the SDK result matches the persisted JSON-safe representation");
  });
});

describe("ActionCache: input CASID -> output CASID (LLVM CAS ActionCache in the ONE store)", () => {
  const base = { kind: "query" as const, manifest: { digest: "sha256:m", snapshot: {} as never, path: "x" }, sql: "SELECT 1", resources: ["a", "b"], bindings: undefined, sourceReceiptDigests: ["sha256:s1"] };

  test("the input digest is stable, resource-order-SENSITIVE, and sensitive to SQL/manifest", () => {
    assert.equal(actionInputDigest(base), actionInputDigest({ ...base }), "same inputs -> same key (stable)");
    // resources resolve in EXECUTION order and each resolver CREATE-OR-REPLACEs its table, so [a,b] and [b,a] can
    // yield different DB state -> different result. The key MUST differ (sorting them would serve a wrong cached hit).
    assert.notEqual(actionInputDigest(base), actionInputDigest({ ...base, resources: ["b", "a"] }), "resource order changes the key");
    assert.notEqual(actionInputDigest(base), actionInputDigest({ ...base, sql: "SELECT 2" }));
    assert.notEqual(actionInputDigest(base), actionInputDigest({ ...base, manifest: { ...base.manifest, digest: "sha256:other" } }));
  });

  test("bindings with a bigint don't crash the digest (tagged, stable, injective); a non-plain object fails closed", () => {
    const d1 = actionInputDigest({ ...base, bindings: { n: 10n } });
    assert.match(d1, /^sha256:[a-f0-9]{64}$/, "a bigint binding produces a digest, not a JSON.stringify throw");
    assert.equal(d1, actionInputDigest({ ...base, bindings: { n: 10n } }), "same bigint -> stable key");
    assert.notEqual(d1, actionInputDigest({ ...base, bindings: { n: 11n } }), "different bigint -> different key");
    assert.notEqual(d1, actionInputDigest({ ...base, bindings: { n: 10 } }), "bigint 10n and number 10 are tagged apart (no collision)");
    assert.notEqual(d1, actionInputDigest({ ...base, bindings: { n: "10" } }), "bigint 10n and the string '10' don't collide (injective typing)");
    // a string that mimics an old naive tag must NOT collide with any bigint (the injective-typing regression guard)
    assert.notEqual(actionInputDigest({ ...base, bindings: { n: "__bigint__:5" } }), actionInputDigest({ ...base, bindings: { n: 5n } }), "a string that looks like a bigint tag is still keyed apart");
    assert.throws(() => actionInputDigest({ ...base, bindings: { d: new Date() } }), /non-plain object/, "a Date (or other non-plain object) fails closed rather than mis-keying");
    // non-JSON PRIMITIVES: NaN/Infinity would both become JSON null (colliding with each other + a real null); an
    // undefined field would be dropped (colliding with a missing key); a function would silently vanish.
    const nan = actionInputDigest({ ...base, bindings: { n: NaN } });
    assert.notEqual(nan, actionInputDigest({ ...base, bindings: { n: Infinity } }), "NaN and Infinity are keyed apart");
    assert.notEqual(nan, actionInputDigest({ ...base, bindings: { n: null } }), "NaN and null are keyed apart");
    assert.notEqual(actionInputDigest({ ...base, bindings: { a: undefined, b: 1 } }), actionInputDigest({ ...base, bindings: { b: 1 } }), "an undefined field is not dropped (distinct from a missing key)");
    assert.throws(() => actionInputDigest({ ...base, bindings: { f: () => 1 } }), /function/, "a function binding fails closed");
  });

  test("content-addressed: a changed source (different sourceReceiptDigests) yields a DIFFERENT key — no stale dedup", () => {
    assert.notEqual(actionInputDigest(base), actionInputDigest({ ...base, sourceReceiptDigests: ["sha256:s2"] }));
  });

  test("compute facts: the input digest is STABLE across a replay.json round-trip (no undefined keys to be dropped)", () => {
    // resolvedComputeResources omits undefined optional fields, so the in-memory facts equal those recovered
    // from replay.json (JSON drops undefined keys). Same digest either way -> a compute.run run object recomputes.
    const proc = {
      resourceId: "r",
      command: ["Rscript", "fit.R"],
      resultTable: "artifacts" as const,
      outputs: [{ name: "plot", path: "plot.svg", kind: "file", mediaType: "image/svg+xml", semanticRole: "figure", attrs: { renderer: "R" } }],
    };
    assert.equal(
      actionInputDigest({ ...base, computeResources: [proc] }),
      actionInputDigest({ ...base, computeResources: JSON.parse(JSON.stringify([proc])) }),
      "digest is stable across serialization when there are no undefined keys",
    );
    // CONTRAST — the bug the omit-undefined fix avoids: an undefined-valued key is tagged in memory but DROPPED by
    // JSON.stringify, so the round-tripped digest would differ (not recomputable from the recorded replay).
    const withUndef = { resourceId: "r", command: ["Rscript", "fit.R"], resultTable: "artifacts" as const, table: undefined };
    assert.notEqual(
      actionInputDigest({ ...base, computeResources: [withUndef] }),
      actionInputDigest({ ...base, computeResources: JSON.parse(JSON.stringify([withUndef])) }),
      "an undefined key breaks round-trip stability — which is why resolvedComputeFacts must omit them",
    );
  });

  test("the key is sensitive to RESULT-AFFECTING execution facts (init SQL, config, host receipts, compute, env) — no wrong-result serving", () => {
    assert.notEqual(actionInputDigest(base), actionInputDigest({ ...base, duckdbInitSqlDigest: "sha256:init" }), "init SQL (via its digest) changes the key");
    assert.notEqual(actionInputDigest(base), actionInputDigest({ ...base, duckdbConfigDigest: "sha256:cfg" }), "config changes the key");
    assert.notEqual(actionInputDigest(base), actionInputDigest({ ...base, hostReceiptDigests: ["sha256:" + "1".repeat(64)] }), "host capability policy receipts change the key");
    assert.notEqual(actionInputDigest(base), actionInputDigest({ ...base, computeResources: [{ resourceId: "fit", command: ["Rscript", "fit.R"] }] }), "compute changes the key");
    assert.notEqual(
      actionInputDigest({ ...base, computeResources: [{ resourceId: "fit", command: ["Rscript", "fit.R"], outputs: [{ name: "plot", path: "plot.svg", mediaType: "image/svg+xml" }] }] }),
      actionInputDigest({ ...base, computeResources: [{ resourceId: "fit", command: ["Rscript", "fit.R"], outputs: [{ name: "plot", path: "plot.svg", mediaType: "text/plain" }] }] }),
      "declared output metadata is part of the compute/replay identity",
    );
    assert.notEqual(
      actionInputDigest({ ...base, computeResources: [{ resourceId: "fit", command: ["Rscript", "fit.R"], environment: { status: "matched", observedDigest: "sha256:a" } }] }),
      actionInputDigest({ ...base, computeResources: [{ resourceId: "fit", command: ["Rscript", "fit.R"], environment: { status: "drift", observedDigest: "sha256:b" } }] }),
      "a resource environment changes the key",
    );
  });

  test("put/get round-trips input -> output; a miss is null", async () => {
    const c = await conn();
    await actionCachePut(c, "sha256:in", "sha256:out", "2026-01-01T00:00:01Z", "agent:A");
    assert.equal(await actionCacheGet(c, "sha256:in"), "sha256:out");
    assert.equal(await actionCacheGet(c, "sha256:missing"), null);
  });

  test("two SAME-millisecond puts for one input resolve deterministically to the LATER output (monotonic slot)", async () => {
    const c = await conn();
    const SAME = "2026-01-01T00:00:01Z";
    await actionCachePut(c, "sha256:in", "sha256:out-old", SAME, "agent:A");
    await actionCachePut(c, "sha256:in", "sha256:out-new", SAME, "agent:B"); // same ms — must still win
    assert.equal(await actionCacheGet(c, "sha256:in"), "sha256:out-new", "the later put wins, not a hash-arbitrary tiebreak");
  });

  test("two identical runs dedup to the same result CASID, and the ActionCache records input -> that output", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const req = { cwd: process.cwd(), dbPath: ":memory:", manifestPath: "examples/variant-counts/manifest.json", sql: "SELECT count(*) AS n FROM variants", store, author: "agent:A", cas };
    const a = await runBioQueryFromManifest({ ...req });
    const b = await runBioQueryFromManifest({ ...req });
    const digestOf = async (runId: string) => JSON.parse((await observationAsOfKey(store, `run:${runId}`, MEMORY_NOW))!.value_json!).resultDigest as string;
    const ra = await digestOf(a.runId);
    assert.equal(ra, await digestOf(b.runId)); // identical inputs -> identical result CASID (dedup)
    const cached = (await observationsAsOf(store, MEMORY_NOW)).filter((r) => r.predicate === "action_output");
    assert.ok(cached.some((r) => JSON.parse(r.value_json!).output === ra), "the ActionCache maps this input's CASID to the result CASID");
  });

  test("recallRunResult replays a recorded run's result FROM CAS by its recorded inputs — no re-execution; miss is null", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const req = { cwd: process.cwd(), dbPath: ":memory:", manifestPath: "examples/variant-counts/manifest.json", sql: "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence", store, author: "agent:A", cas } as const;
    const res = await runBioQueryFromManifest({ ...req });
    assert.ok(res.ok);
    if (!res.ok) return;
    // the enriched replay (with sourceReceiptDigests) is what a caller has recorded; recall needs no re-resolution
    const replay = JSON.parse(await fsp.readFile(join(res.runDir, "replay.json"), "utf8"));
    const recalled = await recallRunResult(store, cas, replay);
    assert.ok(recalled, "hit: the prior run's result is recalled");
    assert.equal(recalled!.resultDigest, res.casRefs!.result);
    assert.equal(recalled!.rows.length, res.rowCount); // the actual result rows, fetched from CAS
    // a different input (different SQL) -> a miss, so the caller re-runs instead of serving something stale
    assert.equal(await recallRunResult(store, cas, { ...replay, sql: "SELECT 1" }), null);
  });

  test("CORRECTNESS: a LIVE-SOURCE run is NOT memoized — recall misses, so a changed source can't serve a stale cached result", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const cwd = await fsp.mkdtemp(join(tmpdir(), "pi-bio-live-"));
    const dataPath = join(cwd, "data.csv").replace(/\\/g, "/");
    await fsp.writeFile(dataPath, "x\n1\n2\n");
    const manifest = { schema: "pi-bio.manifest.v1", id: "live", version: "0.1.0", title: "live", description: "live", provides: {
      resolvers: [{ id: "duckdb.sql_materialize", version: "0.1.0", title: "m", description: "m", output: { mode: "table" } }],
      resources: [{ id: "live", title: "live", kind: "virtual", resolver: "duckdb.sql_materialize", params: { table: "live", sql: `SELECT * FROM read_csv_auto('${dataPath}')` } }],
    } };
    const mpath = join(cwd, "manifest.json");
    await fsp.writeFile(mpath, JSON.stringify(manifest));
    const res = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: mpath, sql: "SELECT count(*) AS n FROM live", resources: ["live"], store, author: "agent:A", cas });
    assert.ok(res.ok, res.ok ? "" : `run failed: ${(res as { error?: unknown }).error}`);
    if (!res.ok) return;
    const replay = JSON.parse(await fsp.readFile(join(res.runDir, "replay.json"), "utf8"));
    // the run produced a CAS resultDigest, but because a live source is blind to content it must NOT be memoized:
    assert.equal(await recallRunResult(store, cas, replay), null, "a live-source run is a recall MISS (re-run, never serve a stale cached result)");
  });

  test("HERMETICITY: a FILE-backed dbPath run is NOT memoized (ambient tables aren't receipt-pinned) — recall misses", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const dbFile = join(await fsp.mkdtemp(join(tmpdir(), "db-")), "run.duckdb");
    const res = await runBioQueryFromManifest({ cwd: process.cwd(), dbPath: dbFile, manifestPath: "examples/variant-counts/manifest.json", sql: "SELECT count(*) AS n FROM variants", store, author: "agent:A", cas });
    assert.ok(res.ok, res.ok ? "" : `run failed: ${(res as { error?: unknown }).error}`);
    if (!res.ok) return;
    const replay = JSON.parse(await fsp.readFile(join(res.runDir, "replay.json"), "utf8"));
    assert.equal(await recallRunResult(store, cas, replay), null, "a file-backed-db run is non-hermetic -> not memoized -> recall MISS");
  });

  test("HERMETICITY: ad-hoc SQL with an inline ambient reader (read_csv_auto) is NOT memoized — recall misses", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const cwd = await fsp.mkdtemp(join(tmpdir(), "pi-bio-ambient-"));
    const csv = join(cwd, "d.csv").replace(/\\/g, "/");
    await fsp.writeFile(csv, "x\n1\n2\n");
    const manifest = { schema: "pi-bio.manifest.v1", id: "m", version: "0.1.0", title: "m", description: "m", provides: {} };
    const mpath = join(cwd, "manifest.json");
    await fsp.writeFile(mpath, JSON.stringify(manifest));
    // :memory:, no declared resources — but the agent SQL reads a file INLINE, bypassing any receipt.
    const res = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: mpath, sql: `SELECT count(*) AS n FROM read_csv_auto('${csv}')`, resources: [], store, author: "agent:A", cas });
    assert.ok(res.ok, res.ok ? "" : `run failed: ${(res as { error?: unknown }).error}`);
    if (!res.ok) return;
    const replay = JSON.parse(await fsp.readFile(join(res.runDir, "replay.json"), "utf8"));
    assert.equal(await recallRunResult(store, cas, replay), null, "inline read_csv_auto is non-hermetic -> not memoized -> recall MISS");
  });

  test("HERMETICITY (plan-based): a benign quoted alias / comment IS memoized — the PLAN proves it reads only pinned tables (no text over-skip)", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    // A double-quoted ALIAS and a comment add NO data source; the physical plan proves the query scans only the
    // resolved `variants` table, so it IS memoized (the old text denylist wrongly skipped anything with a `"` or a
    // comment). A quoted/commented TABLE FUNCTION still shows as a table-function leaf in the plan -> not memoized
    // (covered by the read_csv_auto / replacement-scan tests above), so the evasion is closed at the plan, not the text.
    const res = await runBioQueryFromManifest({ cwd: process.cwd(), dbPath: ":memory:", manifestPath: "examples/variant-counts/manifest.json", sql: 'SELECT count(*) AS "n" /* a comment */ FROM variants', store, author: "agent:A", cas });
    assert.ok(res.ok, res.ok ? "" : `run failed: ${(res as { error?: unknown }).error}`);
    if (!res.ok) return;
    const replay = JSON.parse(await fsp.readFile(join(res.runDir, "replay.json"), "utf8"));
    assert.ok(await recallRunResult(store, cas, replay), "a provably-hermetic quoted/commented query is memoized (plan proof, not text)");
  });

  test("HERMETICITY: VOLATILE SQL (random()) is NOT memoized — the input CASID does not determine the output", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const cwd = await fsp.mkdtemp(join(tmpdir(), "pi-bio-vol-"));
    const manifest = { schema: "pi-bio.manifest.v1", id: "m", version: "0.1.0", title: "m", description: "m", provides: {} };
    const mpath = join(cwd, "manifest.json");
    await fsp.writeFile(mpath, JSON.stringify(manifest));
    const res = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: mpath, sql: "SELECT random() AS r", resources: [], store, author: "agent:A", cas });
    assert.ok(res.ok, res.ok ? "" : `run failed: ${(res as { error?: unknown }).error}`);
    if (!res.ok) return;
    const replay = JSON.parse(await fsp.readFile(join(res.runDir, "replay.json"), "utf8"));
    assert.equal(await recallRunResult(store, cas, replay), null, "random() is non-deterministic -> not memoized");
  });

  test("HERMETICITY: an ATTACH (or ambient read) in the host INIT SQL makes the run non-hermetic — NOT memoized", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    // ATTACH in init SQL brings in external/ambient tables the input CASID can't pin (its digest is pinned, but the
    // same init over CHANGED data reuses the key) — so the run must not be memoized even on :memory: with a clean SQL.
    const res = await runBioQueryFromManifest({ cwd: process.cwd(), dbPath: ":memory:", manifestPath: "examples/variant-counts/manifest.json", sql: "SELECT count(*) AS n FROM variants", duckdbInitSql: ["ATTACH ':memory:' AS aux"], store, author: "agent:A", cas });
    assert.ok(res.ok, res.ok ? "" : `run failed: ${(res as { error?: unknown }).error}`);
    if (!res.ok) return;
    const replay = JSON.parse(await fsp.readFile(join(res.runDir, "replay.json"), "utf8"));
    assert.equal(await recallRunResult(store, cas, replay), null, "init-SQL ATTACH -> non-hermetic -> not memoized");
  });

  test("HERMETICITY: ANY table function in FROM position is NOT memoized (generalizes past named readers — e.g. spatial ST_Read)", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const cwd = await fsp.mkdtemp(join(tmpdir(), "pi-bio-tf-"));
    const manifest = { schema: "pi-bio.manifest.v1", id: "m", version: "0.1.0", title: "m", description: "m", provides: {} };
    const mpath = join(cwd, "manifest.json");
    await fsp.writeFile(mpath, JSON.stringify(manifest));
    // generate_series is a built-in table function used as a stand-in for ANY FROM-position table function (ST_Read,
    // read_parquet, a future extension reader): the FROM-function pattern skips memoization for all of them (safely
    // over-skipping even a pure one), so a reader the named denylist would miss can't be memoized stale.
    const res = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: mpath, sql: "SELECT count(*) AS n FROM generate_series(1, 3)", resources: [], store, author: "agent:A", cas });
    assert.ok(res.ok, res.ok ? "" : `run failed: ${(res as { error?: unknown }).error}`);
    if (!res.ok) return;
    const replay = JSON.parse(await fsp.readFile(join(res.runDir, "replay.json"), "utf8"));
    assert.equal(await recallRunResult(store, cas, replay), null, "a FROM-position table function is treated as non-hermetic -> not memoized");
  });

  test("HERMETICITY: a REPLACEMENT SCAN (FROM '<file>') is NOT memoized — the denylist catches FROM-literal reads too", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    const cwd = await fsp.mkdtemp(join(tmpdir(), "pi-bio-repl-"));
    const csv = join(cwd, "d.csv").replace(/\\/g, "/");
    await fsp.writeFile(csv, "x\n1\n2\n");
    const manifest = { schema: "pi-bio.manifest.v1", id: "m", version: "0.1.0", title: "m", description: "m", provides: {} };
    const mpath = join(cwd, "manifest.json");
    await fsp.writeFile(mpath, JSON.stringify(manifest));
    // DuckDB auto-reads a file literal in FROM position (a replacement scan) — no read_csv_auto() call, but still ambient.
    const res = await runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: mpath, sql: `SELECT count(*) AS n FROM '${csv}'`, resources: [], store, author: "agent:A", cas });
    assert.ok(res.ok, res.ok ? "" : `run failed: ${(res as { error?: unknown }).error}`);
    if (!res.ok) return;
    const replay = JSON.parse(await fsp.readFile(join(res.runDir, "replay.json"), "utf8"));
    assert.equal(await recallRunResult(store, cas, replay), null, "a FROM-literal replacement scan is non-hermetic -> not memoized -> recall MISS");
  });

  test("TOCTOU: bytes deleted BETWEEN cas.has() and the read are a recall MISS (ENOENT), not a thrown error", async () => {
    const store = await conn();
    const replay = { kind: "query" as const, sql: "SELECT 1", sourceReceiptDigests: [] as string[] };
    const out = "sha256:" + "c".repeat(64);
    await actionCachePut(store, actionInputDigest(replay), out, "2026-01-01T00:00:00Z", "agent:A");
    // a cas whose has() reports present but whose file is gone at read time (the GC-between-check-and-read race)
    const racyCas = { has: async () => true, pathFor: () => join(tmpdir(), `gone-${Math.random()}`) } as unknown as CasStore;
    assert.equal(await recallRunResult(store, racyCas, replay), null, "an ENOENT during the read is a miss, not a throw");
  });

  test("a FRESH store (no schema) is a clean recall MISS; put provisions the schema and persists (no swallowed drop)", async () => {
    // a store the host injected but never provisioned: actionCacheGet must MISS (not throw on a missing table), and
    // actionCachePut must create the table so run-store's best-effort memoization isn't silently lost on first use.
    const c = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect()); // deliberately NO createBioObservationSchema
    const input = "sha256:" + "a".repeat(64);
    assert.equal(await actionCacheGet(c, input), null, "recall on a fresh store is a miss, not a throw");
    await actionCachePut(c, input, "sha256:" + "b".repeat(64), "2026-01-01T00:00:00Z", "agent:A");
    assert.equal(await actionCacheGet(c, input), "sha256:" + "b".repeat(64), "put created the schema and the mapping persisted");
  });

  test("CORRECTNESS: recall FAILS CLOSED when the memo DIVERGED from the run's recorded output (non-determinism)", async () => {
    const store = await conn();
    const cas = fsCasStore(await fsp.mkdtemp(join(tmpdir(), "cas-")));
    // a minimal replay with a STABLE input CASID; two runs with these same inputs produced DIFFERENT outputs (a bit
    // of non-determinism not flagged live_source, e.g. random()/now()), so the ActionCache slot has been superseded.
    const replay = { kind: "query" as const, sql: "SELECT random() AS r", sourceReceiptDigests: [] as string[] };
    const input = actionInputDigest(replay);
    const bytesO2 = Buffer.from(JSON.stringify([{ r: 2 }]));
    const o2hex = createHash("sha256").update(bytesO2).digest("hex");
    await cas.put({ algorithm: "sha256", digest: o2hex }, bytesO2); // the CURRENT (later) output's bytes live in CAS
    const o2 = `sha256:${o2hex}`;
    const o1 = "sha256:" + "1".repeat(64); // an earlier, now-superseded output (no bytes needed — recall must miss first)
    await actionCachePut(store, input, o1, "2026-01-01T00:00:01Z", "agent:A");
    await actionCachePut(store, input, o2, "2026-01-01T00:00:02Z", "agent:B"); // diverged: the latest memo maps to O2
    // recalling the run that RECORDED O1 must NOT silently serve O2's rows — a diverged memo is a MISS (fail closed)
    assert.equal(await recallRunResult(store, cas, { ...replay, resultDigest: o1 }), null, "diverged memo -> recall miss, never serve a different result than the run recorded");
    // recalling with the CURRENT output pin (or none) is a legitimate hit, serving O2's rows from CAS
    const hit = await recallRunResult(store, cas, { ...replay, resultDigest: o2 });
    assert.deepEqual(hit?.rows, [{ r: 2 }]);
    assert.equal(hit?.resultDigest, o2);
    assert.ok(await recallRunResult(store, cas, replay), "no pin -> plain memo hit (returns the current mapping)");
  });
});
