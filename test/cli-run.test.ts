import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mainRun, parseFlags } from "../src/cli/run.js";
import * as sdk from "../src/index.js";

// The `query`/`run` CLI engine wraps the SAME tested host functions the Pi extension uses. Exercised over the
// pure-SQL variant-counts example (no network, no process — the CLI's fail-closed default suffices).
const MANIFEST = "examples/variant-counts/manifest.json";

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { cwd: process.cwd(), out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe("cli: query/run over a manifest (provider-agnostic entry point)", () => {
  test("query runs the agent's ad-hoc SQL and prints the answer rows", async () => {
    const s = sink();
    const code = await mainRun("query", [MANIFEST, "--db", ":memory:", "--sql",
      "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence", "--run-id", "cli-q"], s.deps);
    assert.equal(code, 0, s.err.join("\n"));
    const printed = JSON.parse(s.out.join("\n")) as { ok: boolean; rowCount: number; rows: Array<{ consequence: string; n: number }> };
    assert.equal(printed.ok, true);
    assert.ok(printed.rowCount > 0, "produced rows");
    assert.deepEqual(printed.rows.map((r) => r.consequence), ["missense", "stop_gained", "synonymous"]);
  });

  test("missing required flags fail with usage (exit 2), not a crash", async () => {
    const s = sink();
    assert.equal(await mainRun("query", [MANIFEST, "--db", ":memory:"], s.deps), 2, "query without --sql");
    assert.match(s.err.join("\n"), /requires --sql/);
    const s2 = sink();
    assert.equal(await mainRun("run", [MANIFEST, "--db", ":memory:"], s2.deps), 2, "run without --operation");
    assert.match(s2.err.join("\n"), /requires --operation/);
    const s3 = sink();
    assert.equal(await mainRun("bogus", [MANIFEST], s3.deps), 2, "unknown subcommand");
  });

  test("a malformed --bindings JSON is a usage error (exit 2), not a crash", async () => {
    const s = sink();
    const code = await mainRun("query", [MANIFEST, "--db", ":memory:", "--sql", "SELECT 1", "--bindings", "not-json"], s.deps);
    assert.equal(code, 2, "malformed --bindings returns usage exit 2, not an unhandled throw");
    assert.match(s.err.join("\n"), /bindings must be a JSON object/);
  });

  test("parseFlags: captures a value that starts with -- (next-token) and supports --key=value", () => {
    // the pal's finding: a flag value can legitimately start with `--` (e.g. a SQL comment). Both forms must carry it.
    assert.deepEqual(parseFlags(["--sql", "-- note\nSELECT 1", "--db=:memory:"]), { sql: "-- note\nSELECT 1", db: ":memory:" });
    assert.deepEqual(parseFlags(["--sql=SELECT 1", "--run-id=abc"]), { sql: "SELECT 1", "run-id": "abc" });
    assert.throws(() => parseFlags(["--db"]), /requires a value/);
    assert.throws(() => parseFlags(["pos"]), /unexpected argument/);
  });

  test("--key=value runs end to end (equals form)", async () => {
    const s = sink();
    const code = await mainRun("query", [MANIFEST, "--db=:memory:",
      "--sql=SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence"], s.deps);
    assert.equal(code, 0, s.err.join("\n"));
    const printed = JSON.parse(s.out.join("\n")) as { ok: boolean; rows: Array<{ consequence: string }> };
    assert.equal(printed.ok, true);
    assert.deepEqual(printed.rows.map((r) => r.consequence), ["missense", "stop_gained", "synonymous"]);
  });
});

describe("sdk: the package entry point re-exports the substrate surface", () => {
  test("the key host + core symbols are importable from the top-level index", () => {
    for (const name of ["runBioQueryFromManifest", "runBioOperationFromManifest", "validateBioManifest", "createBioRegistry", "fsCasStore", "duckdbNodeConn"]) {
      assert.equal(typeof (sdk as Record<string, unknown>)[name], "function", `${name} exported from the SDK entry`);
    }
  });
});
