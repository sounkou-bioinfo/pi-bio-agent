import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import {
  fsCasStore,
  nodeComputeRunner,
  openBioStore,
  runBioQueryFromManifest,
} from "pi-bio-agent";

test("the evidence-status figure is a recorded compute.run CAS artifact", async () => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "pi-bio-workbench-plot-"));
  const sourceRoot = resolve("examples/clinical-genomics");
  const manifestPath = join(workspace, "visualization-manifest.json");
  const scriptPath = join(workspace, "operations", "render-evidence-status.R");
  const packetPath = join(workspace, "packet.json");
  await fs.mkdir(dirname(scriptPath), { recursive: true });
  await Promise.all([
    fs.copyFile(join(sourceRoot, "visualization-manifest.json"), manifestPath),
    fs.copyFile(join(sourceRoot, "operations", "render-evidence-status.R"), scriptPath),
    fs.writeFile(packetPath, JSON.stringify({
      lanes: {
        direct: { rows: [
          { lane: "direct", evidence_status: "curated_plp_candidate" },
          { lane: "direct", evidence_status: "needs_frequency_evidence" },
        ] },
        inverted: { rows: [
          { lane: "inverted", evidence_status: "genotype_supports_hypothesis" },
        ] },
      },
    })),
  ]);

  const cas = fsCasStore(join(workspace, ".pi", "bio-agent", "cas"));
  const store = await openBioStore(workspace);
  try {
    const out = await runBioQueryFromManifest({
      cwd: workspace,
      dbPath: ":memory:",
      manifestPath,
      sql: "SELECT * FROM evidence_status_figure",
      resources: ["evidence_status_figure"],
      bindings: { packet_path: packetPath },
      runId: "evidence-status-figure-test",
      compute: { runner: nodeComputeRunner() },
      cas,
      store: store.conn,
      casMetadata: { conn: store.conn },
      author: "workbench-test",
    });
    assert.equal(out.ok, true);
    assert.equal(out.rowCount, 1);
    const row = out.result.rows[0] as Record<string, unknown>;
    assert.equal(row.media_type, "image/svg+xml");
    assert.equal(row.semantic_role, "figure");
    assert.match(String(row.digest), /^sha256:[0-9a-f]{64}$/);

    const digest = String(row.digest).slice("sha256:".length);
    const bytes = await fs.readFile(join(workspace, ".pi", "bio-agent", "cas", "sha256", digest));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest);
    assert.match(bytes.toString("utf8", 0, 200), /<svg/);

    const edge = await store.conn.all<{ n: bigint }>(
      `SELECT count(*) AS n FROM bio_observations
       WHERE subject_id = 'run:evidence-status-figure-test'
         AND predicate = 'produces'
         AND object_id = ?`,
      [`cas:sha256:${digest}`],
    );
    assert.equal(Number(edge[0]?.n ?? 0), 1);
  } finally {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
