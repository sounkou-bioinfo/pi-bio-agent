import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DomainPackManifest } from "../src/core/manifest.js";
import type { FetchLike } from "../src/duckdb/resolvers/http-table-scan.js";
import { persistRun, runBioOperationFromManifest, runBioQueryFromManifest, runsRoot } from "../src/hosts/run-store.js";

// End-to-end through the host: a manifest JSON on disk -> validated registry -> built-in resolvers -> a
// duckdb.sql operation -> persisted run/result/receipts. Both resources use duckdb.file_scan (a
// built-in), so nothing test-only is bound; this is what a real host run looks like.

const RARE_HIGH_IMPACT_SQL = [
  "WITH classified AS (",
  "  SELECT variant_key,",
  "    CASE",
  "      WHEN allele_frequency IS NULL THEN 'no_frequency'",
  "      WHEN consequence NOT IN (SELECT id FROM so_loss_of_function) THEN 'not_high_impact'",
  "      WHEN clinical_significance = 'Benign' THEN 'benign'",
  "      WHEN allele_frequency >= 0.01 THEN 'not_rare'",
  "      ELSE 'included'",
  "    END AS bucket",
  "  FROM annotated_variants",
  ")",
  "SELECT bucket, CAST(count(*) AS INTEGER) AS n FROM classified GROUP BY bucket ORDER BY bucket",
].join("\n");

const manifest: DomainPackManifest = {
  schema: "pi-bio.domain_pack_manifest.v1",
  id: "rare-high-impact-host",
  version: "0.1.0",
  title: "Rare high-impact (host)",
  description: "Rare LoF variants over CSV providers, run through the host.",
  domains: ["genomics"],
  provides: {
    resolvers: [{ id: "duckdb.file_scan", version: "0.1.0", title: "DuckDB file scan", description: "Read a DuckDB-native file into a table.", output: { mode: "table" } }],
    resources: [
      // project-relative paths — resolved against the manifest's directory, not the process cwd
      { id: "annotated_variants", title: "Annotated variants", kind: "virtual", resolver: "duckdb.file_scan", params: { path: "data/annotated_variants.csv", table: "annotated_variants" } },
      { id: "so_loss_of_function", title: "LoF SO terms", kind: "virtual", resolver: "duckdb.file_scan", params: { path: "data/so_loss_of_function.csv", table: "so_loss_of_function" } },
    ],
    operations: [{
      schema: "pi-bio.operation_spec.v1", id: "rare_high_impact.report", version: "0.1.0",
      title: "Rare high-impact variant classification", description: "Classify variants, abstaining on unknown frequency.",
      domains: ["genomics"], transport: "duckdb.sql", inputSchema: { type: "object" },
      sql: { sqlTemplate: RARE_HIGH_IMPACT_SQL, readOnly: true, singleStatement: true, requiredResources: ["annotated_variants", "so_loss_of_function"] },
    }],
  },
};

async function tmpProject(m: DomainPackManifest): Promise<string> {
  const cwd = await fs.mkdtemp(join(tmpdir(), "biorun-"));
  await fs.mkdir(join(cwd, "data"), { recursive: true });
  await fs.copyFile("test/fixtures/annotated_variants.csv", join(cwd, "data", "annotated_variants.csv"));
  await fs.copyFile("test/fixtures/so_loss_of_function.csv", join(cwd, "data", "so_loss_of_function.csv"));
  await fs.writeFile(join(cwd, "manifest.json"), JSON.stringify(m), "utf8");
  return cwd;
}
const run = (cwd: string, runId = "run-1") =>
  runBioOperationFromManifest({ cwd, dbPath: ":memory:", manifestPath: "manifest.json", operationId: "rare_high_impact.report", runId, now: "2026-06-28T00:00:00Z" });

describe("host: bio_run_operation end-to-end", () => {
  test("runs a manifest operation and persists run/result/receipts", async () => {
    const cwd = await tmpProject(manifest);
    const res = await run(cwd);
    assert.equal(res.ok, true);
    assert.equal(res.status, "succeeded");

    // the three artifacts exist, parse, and carry the right content; result.json IS the answer (SQL counts)
    const dir = join(runsRoot(cwd), "run-1");
    assert.equal(res.runDir, dir);
    const run_ = JSON.parse(await fs.readFile(join(dir, "run.json"), "utf8"));
    const result = JSON.parse(await fs.readFile(join(dir, "result.json"), "utf8"));
    const receipts = JSON.parse(await fs.readFile(join(dir, "receipts.json"), "utf8"));
    assert.equal(run_.status, "succeeded");
    // the run record's output artifact points at the file the host actually persisted (result.json), not a
    // phantom <operationId>.json — run provenance must reference a file that exists on disk
    const outArtifact = run_.artifacts.find((a: { role: string }) => a.role === "output");
    assert.equal(outArtifact.path, "runs/run-1/result.json");
    await fs.access(join(dir, "result.json")); // the path the artifact names actually exists
    const included = result.rows.find((r: { bucket: string }) => r.bucket === "included");
    assert.equal(Number(included.n), 1); // ClawBio rhi_01 ground truth, via the host — counts come from SQL
    const avReceipt = receipts.find((r: { resourceId: string }) => r.resourceId === "annotated_variants");
    assert.equal(avReceipt.resolverId, "duckdb.file_scan");
    // the relative manifest path was resolved to an absolute file under the project, not the process cwd
    assert.ok(avReceipt.sourceSnapshots.some((s: { source: string }) => s.source === `file:${join(cwd, "data", "annotated_variants.csv")}`));

    // the receipts ARE the provenance footprint: exactly the operation's requiredResources, no more, no less
    const receiptIds = receipts.map((r: { resourceId: string }) => r.resourceId).sort();
    assert.deepEqual(receiptIds, ["annotated_variants", "so_loss_of_function"]);

    // exactly three artifacts — the result IS the report; there is no report.json (deleted) and no extras
    const onDisk = (await fs.readdir(dir)).sort();
    assert.deepEqual(onDisk, ["receipts.json", "result.json", "run.json"]);
  });

  test("a run that fails at runtime persists a failed-run receipt and returns ok:false", async () => {
    // SQL that resolves its resource but references a missing column — the run STARTS, then the binder fails.
    const badManifest: DomainPackManifest = {
      ...manifest,
      provides: {
        ...manifest.provides,
        operations: [{
          schema: "pi-bio.operation_spec.v1", id: "bad.op", version: "0.1.0",
          title: "Bad op", description: "References a column that does not exist.",
          domains: ["genomics"], transport: "duckdb.sql", inputSchema: { type: "object" },
          sql: { sqlTemplate: "SELECT no_such_column FROM annotated_variants", readOnly: true, requiredResources: ["annotated_variants"] },
        }],
      },
    };
    const cwd = await tmpProject(badManifest);
    const res = await runBioOperationFromManifest({ cwd, dbPath: ":memory:", manifestPath: "manifest.json", operationId: "bad.op", runId: "fail-1", now: "2026-06-28T00:00:00Z" });
    assert.equal(res.ok, false);
    assert.equal(res.status, "failed");
    if (res.ok) throw new Error("unreachable"); // narrow the union for the failure-only fields
    assert.match(res.error, /no_such_column/i);

    const dir = join(runsRoot(cwd), "fail-1");
    assert.equal(res.runDir, dir);
    // run.json + receipts.json persisted; NO result.json — there is no answer, but the failure is auditable
    assert.deepEqual((await fs.readdir(dir)).sort(), ["receipts.json", "run.json"]);
    const run_ = JSON.parse(await fs.readFile(join(dir, "run.json"), "utf8"));
    assert.equal(run_.status, "failed");
    assert.match(run_.error, /no_such_column/i);
    assert.ok(run_.events.some((e: { type: string }) => e.type === "failed"));
    // the resource that DID resolve before the failure still carries a receipt
    const receipts = JSON.parse(await fs.readFile(join(dir, "receipts.json"), "utf8"));
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].resourceId, "annotated_variants");
  });

  test("network is opt-in: http.get fails closed without a fetch, runs when one is injected", async () => {
    const netManifest: DomainPackManifest = {
      schema: "pi-bio.domain_pack_manifest.v1", id: "net-host", version: "0.1.0",
      title: "Net", description: "An HTTP-sourced operation.", domains: ["genomics"],
      provides: {
        resolvers: [{ id: "http.get", version: "0.1.0", title: "HTTP get", description: "Fetch a URL into a table.", output: { mode: "table" } }],
        resources: [{ id: "candidates", title: "Candidates", kind: "virtual", resolver: "http.get", params: { url: "https://example.org/api?q=asthma", table: "candidates", format: "json" } }],
        operations: [{
          schema: "pi-bio.operation_spec.v1", id: "list.candidates", version: "0.1.0", title: "List", description: "List candidates.",
          domains: ["genomics"], transport: "duckdb.sql", inputSchema: { type: "object" },
          sql: { sqlTemplate: "SELECT obo_id FROM candidates ORDER BY obo_id", readOnly: true, requiredResources: ["candidates"] },
        }],
      },
    };
    const cwd = await tmpProject(netManifest);
    const base = { cwd, dbPath: ":memory:", manifestPath: "manifest.json", operationId: "list.candidates", now: "2026-06-28T00:00:00Z" };
    // no network -> http.get is unbound -> fails closed (pre-flight), no ambient network
    await assert.rejects(() => runBioOperationFromManifest({ ...base, runId: "net-1" }), /no implementation is bound/);
    // inject a fetch -> the network opt-in -> the run succeeds over the fetched rows
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify([{ obo_id: "MONDO:0004979" }, { obo_id: "MONDO:0004784" }]) });
    const res = await runBioOperationFromManifest({ ...base, runId: "net-2", network: { fetch: fetchImpl } });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    assert.equal(res.rowCount, 2);
  });

  test("fails closed on an invalid manifest", async () => {
    const cwd = await tmpProject({ ...manifest, schema: "nope" as never });
    await assert.rejects(() => run(cwd), /invalid manifest/);
  });

  test("bio_query: resolve declared resources and run the AGENT's SQL — no declared operation needed", async () => {
    // a resource-only manifest: it declares WHERE the data is, not HOW to count it. The agent writes the SQL.
    const resourceOnly: DomainPackManifest = {
      schema: "pi-bio.domain_pack_manifest.v1", id: "ad-hoc-pack", version: "0.1.0",
      title: "Ad-hoc", description: "Resource-only manifest; the agent writes the SQL after schema discovery.", domains: ["genomics"],
      provides: {
        resolvers: [{ id: "duckdb.file_scan", version: "0.1.0", title: "DuckDB file scan", description: "Read a file.", output: { mode: "table" } }],
        resources: [{ id: "annotated_variants", title: "AV", kind: "virtual", resolver: "duckdb.file_scan", params: { path: "data/annotated_variants.csv", table: "annotated_variants" } }],
      },
    };
    const cwd = await tmpProject(resourceOnly);
    const q = (sql: string, runId: string) => runBioQueryFromManifest({ cwd, dbPath: ":memory:", manifestPath: "manifest.json", sql, runId, now: "2026-06-28T00:00:00Z" });

    // 1. schema discovery — the agent inspects the resolved table's columns via plain SQL
    const schema = await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'annotated_variants' ORDER BY column_name", "q-schema");
    assert.equal(schema.ok, true);
    const schemaRows = JSON.parse(await fs.readFile(join(schema.runDir, "result.json"), "utf8")).rows.map((r: { column_name: string }) => r.column_name);
    assert.ok(schemaRows.includes("consequence") && schemaRows.includes("allele_frequency"));

    // 2. the agent then writes the SQL that answers the actual question — counts as a BigInt persist fine
    const res = await q("SELECT consequence, count(*) AS n FROM annotated_variants GROUP BY consequence ORDER BY consequence", "q-1");
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("unreachable");
    const result = JSON.parse(await fs.readFile(join(res.runDir, "result.json"), "utf8"));
    assert.equal(result.operationId, "ad-hoc.query");
    assert.ok(result.rows.length >= 1 && result.rows.every((r: { n: number }) => Number(r.n) >= 1));
    // the run still carries the resolver receipt + a digest of the ad-hoc SQL (provenance, no operation declared)
    const run_ = JSON.parse(await fs.readFile(join(res.runDir, "run.json"), "utf8"));
    const prov = run_.artifacts[0].provenance;
    assert.ok(prov.some((p: { source: string }) => p.source === "ad-hoc.query"));
    assert.match(prov.find((p: { source: string }) => p.source === "ad-hoc.query").digest, /^sha256:/);

    // 3. a failed ad-hoc query (missing column) still persists a failed run, returns ok:false
    const bad = await q("SELECT nope FROM annotated_variants", "q-bad");
    assert.equal(bad.ok, false);
  });

  test("persistRun refuses a runId that would escape the runs directory (path-safe even called directly)", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "biorun-"));
    await assert.rejects(
      () => persistRun(cwd, "../../etc/evil", { run: {} as never, result: {} as never, receipts: [] }),
      /no path separators/,
    );
  });

  test("fails closed when a declared resolver is not a host built-in", async () => {
    const m: DomainPackManifest = {
      ...manifest,
      provides: {
        ...manifest.provides,
        resolvers: [{ id: "mystery.scan", version: "0.1.0", title: "Mystery", description: "Not a built-in.", output: { mode: "table" } }],
        resources: [{ id: "annotated_variants", title: "AV", kind: "virtual", resolver: "mystery.scan", params: { path: "x" } }],
        operations: [{
          schema: "pi-bio.operation_spec.v1", id: "rare_high_impact.report", version: "0.1.0", title: "T", description: "t", domains: ["genomics"],
          transport: "duckdb.sql", inputSchema: { type: "object" },
          sql: { sqlTemplate: "SELECT 1 AS variant_key FROM annotated_variants", readOnly: true, requiredResources: ["annotated_variants"] },
        }],
      },
    };
    const cwd = await tmpProject(m);
    await assert.rejects(() => run(cwd), /no implementation is bound/);
  });
});
