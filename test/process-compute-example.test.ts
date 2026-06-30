import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBioQueryFromManifest } from "../src/hosts/run-store.js";
import { nodeProcessRunner } from "../src/process/node-process-runner.js";

// The COMPUTE pillar end to end: a manifest hands a DuckDB table to an OUT-OF-PROCESS R computation (lm) over
// Arrow IPC and reads the result back as a table — through the real host runner + a real spawned Rscript. No
// mock: nodeProcessRunner actually spawns R. Gated on R + the R `arrow` package being present.
const MANIFEST = resolve(process.cwd(), "examples", "process-compute", "manifest.json");
const PROVISION = ["INSTALL nanoarrow FROM community", "LOAD nanoarrow"]; // nanoarrow = the Arrow-IPC codec

const rArrowAvailable = (() => {
  try {
    execFileSync("Rscript", ["-e", 'if(!requireNamespace("nanoarrow",quietly=TRUE)) quit(status=1)'], { stdio: "ignore" });
    return true;
  } catch { return false; }
})();

describe("example: out-of-process compute (R lm over Arrow IPC) is a manifest — the COMPUTE pillar", { skip: rArrowAvailable ? false : "Rscript + R 'nanoarrow' package not available" }, () => {
  test("DuckDB table -> Arrow IPC -> R lm() -> Arrow IPC -> table; the agent reads the fitted coefficients", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-compute-"));
    const out = await runBioQueryFromManifest({
      cwd, dbPath: ":memory:", manifestPath: MANIFEST,
      sql: "SELECT n, slope, intercept, r_squared FROM lm_fit",
      process: { runner: nodeProcessRunner() }, // host GRANTS out-of-process compute by composition
      duckdbInitSql: PROVISION,
      runId: "c1", now: "T1",
    });
    assert.equal(out.ok, true);
    if (!out.ok) return;
    const result = JSON.parse(await fs.readFile(join(out.runDir, "result.json"), "utf8")) as { rows: Array<{ n: number; slope: number; intercept: number; r_squared: number }> };
    assert.equal(result.rows.length, 1);
    const fit = result.rows[0];
    assert.equal(Number(fit.n), 10);            // all input rows reached R
    assert.ok(Math.abs(fit.slope - 2) < 0.1, `slope ~2 (got ${fit.slope})`);       // points are ~ y = 2x + 1
    assert.ok(Math.abs(fit.intercept - 1) < 0.3, `intercept ~1 (got ${fit.intercept})`);
    assert.ok(fit.r_squared > 0.99, `near-perfect fit (got ${fit.r_squared})`);
  });

  test("fails closed with NO process runner bound — process.compute cannot resolve without the host's opt-in", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-compute-"));
    await assert.rejects(
      () => runBioQueryFromManifest({
        cwd, dbPath: ":memory:", manifestPath: MANIFEST, sql: "SELECT * FROM lm_fit",
        duckdbInitSql: PROVISION,
        runId: "c2", now: "T1", // no `process` -> process.compute stays unbound
      }),
      /process\.compute' is declared but no implementation is bound/,
    );
  });
});
