import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";
import { nodeProcessRunner } from "../src/process/node-process-runner.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";

// A FILES-ONLY process.compute op (resultTable="artifacts"): a tool that returns no rectangular value, only files.
// No input table, no out.arrow -> no Arrow codec is loaded at all. The table IS the captured-artifacts listing.
// R-free (a `sh` tool) so this runs deterministically everywhere — no skip.
const MANIFEST = resolve(process.cwd(), "examples", "process-files-only", "manifest.json");

describe("example: files-only process.compute — the table is the captured-artifacts listing (no Arrow)", () => {
  test("captures declared file outputs into CAS and exposes them as a queryable table", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-fo-"));
    const casDir = await fs.mkdtemp(join(tmpdir(), "pi-bio-fo-cas-"));
    const cas = fsCasStore(casDir);
    const out = await runBioQueryFromManifest({
      cwd, dbPath: ":memory:", manifestPath: MANIFEST,
      sql: "SELECT name, path, kind, digest, size FROM tracks ORDER BY name",
      process: { runner: nodeProcessRunner() }, cas,
      // NB: no duckdbInitSql / no nanoarrow INSTALL — a files-only op needs no Arrow codec.
      runId: "fo", now: "T1",
    });
    assert.equal(out.ok, true, out.ok ? "" : `run failed: ${(out as { error?: unknown }).error}`);
    if (!out.ok) return;

    // the resource's TABLE is the artifacts listing itself (one row per captured file)
    const rows = JSON.parse(await fs.readFile(join(out.runDir, "result.json"), "utf8")).rows as Array<{ name: string; path: string; kind: string; digest: string; size: number }>;
    assert.equal(rows.length, 2, "two declared file outputs -> two rows");
    assert.deepEqual(rows.map((r) => r.name), ["regions_bed", "summary"]);
    assert.deepEqual(rows.map((r) => r.kind), ["file", "table"]);
    for (const r of rows) {
      assert.match(r.digest, /^sha256:[0-9a-f]{64}$/, `${r.name} has a sha256 CAS address`);
      assert.ok(Number(r.size) > 0, `${r.name} has a non-zero size`);
      const digest = r.digest.replace("sha256:", "");
      assert.equal(await cas.has({ algorithm: "sha256", digest }), true, `${r.name} bytes are in CAS`);
    }

    // read the captured regions.bed back OUT of CAS by its digest — the bytes are the real file
    const bed = rows.find((r) => r.name === "regions_bed")!;
    const bedBytes = await fs.readFile(cas.pathFor({ algorithm: "sha256", digest: bed.digest.replace("sha256:", "") }), "utf8");
    assert.match(bedBytes, /chr22\t10510000\t10520000\tregion_a/, "the captured regions.bed has the real content");

    // the receipt carries the same artifacts as provenance (values-in-IPC/files-in-CAS split, here files-only)
    const receipts = JSON.parse(await fs.readFile(join(out.runDir, "receipts.json"), "utf8")) as Array<{ resourceId: string; provenance: Array<{ source: string; notes?: string[] }> }>;
    const tracks = receipts.find((r) => r.resourceId === "tracks")!;
    assert.equal(tracks.provenance.filter((p) => p.source.startsWith("artifact:")).length, 2);
    assert.ok(tracks.provenance.some((p) => p.notes?.includes("files-only")), "provenance marks the files-only mode");
  });

  test("resultTable 'artifacts' with no declared outputs fails closed", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-fo-"));
    const manifest = {
      schema: "pi-bio.domain_pack_manifest.v1", id: "fo-bad", version: "0.0.0", title: "x", description: "x", domains: ["statistics"],
      provides: {
        resolvers: [{ id: "process.compute", version: "0.1.0", title: "x", description: "x", output: { mode: "table" } }],
        resources: [{ id: "tracks", title: "x", kind: "virtual", resolver: "process.compute", params: { table: "tracks", command: ["sh", "-c", "true"], resultTable: "artifacts" } }],
      },
    };
    const mpath = join(cwd, "manifest.json");
    await fs.writeFile(mpath, JSON.stringify(manifest));
    const casDir = await fs.mkdtemp(join(tmpdir(), "pi-bio-fo-cas-"));
    const out = await runBioQueryFromManifest({
      cwd, dbPath: ":memory:", manifestPath: mpath, sql: "SELECT * FROM tracks",
      process: { runner: nodeProcessRunner() }, cas: fsCasStore(casDir), runId: "fo-bad", now: "T1",
    });
    assert.equal(out.ok, false, "artifacts mode requires at least one declared output -> fail closed");
  });

  test("a malformed params.extensions fails closed (not silently dropped)", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-fo-"));
    const manifest = {
      schema: "pi-bio.domain_pack_manifest.v1", id: "fo-ext", version: "0.0.0", title: "x", description: "x", domains: ["statistics"],
      provides: {
        resolvers: [{ id: "process.compute", version: "0.1.0", title: "x", description: "x", output: { mode: "table" } }],
        // extensions should be an array of strings; a bare string is a typo the resolver must reject
        resources: [{ id: "tracks", title: "x", kind: "virtual", resolver: "process.compute", params: { table: "tracks", command: ["sh", "-c", "true"], resultTable: "artifacts", outputs: [{ name: "o", path: "o.txt", kind: "file" }], extensions: "foo" } }],
      },
    };
    const mpath = join(cwd, "manifest.json");
    await fs.writeFile(mpath, JSON.stringify(manifest));
    const casDir = await fs.mkdtemp(join(tmpdir(), "pi-bio-fo-cas-"));
    const out = await runBioQueryFromManifest({
      cwd, dbPath: ":memory:", manifestPath: mpath, sql: "SELECT * FROM tracks",
      process: { runner: nodeProcessRunner() }, cas: fsCasStore(casDir), runId: "fo-ext", now: "T1",
    });
    assert.equal(out.ok, false, "params.extensions must be an array of strings -> fail closed");
  });
});
