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

  test("parseFlags: known-flag-aware, --key=value for flag-looking/literal values", () => {
    // a `--`-prefixed token is ALWAYS a flag in space form (so `--sql --db` is a usage error, not sql='--db');
    // the `--key=value` form carries any value, including one that starts with `--`.
    assert.deepEqual(parseFlags(["--sql=-- note\nSELECT 1", "--db=:memory:"]), { sql: "-- note\nSELECT 1", db: ":memory:" });
    assert.deepEqual(parseFlags(["--sql=SELECT 1", "--run-id=abc"]), { sql: "SELECT 1", "run-id": "abc" });
    assert.throws(() => parseFlags(["--sql", "--db"]), /requires a value/); // space-form flag-looking value is NOT swallowed
    assert.throws(() => parseFlags(["--db"]), /requires a value/);
    assert.throws(() => parseFlags(["pos"]), /unexpected argument/);
    assert.throws(() => parseFlags(["--=x"]), /empty flag name/);
    assert.throws(() => parseFlags(["--", "value"]), /empty flag name/);
  });

  test("empty flag values are usage errors (exit 2), not exit 1 / bad runs", async () => {
    const s = sink();
    assert.equal(await mainRun("query", [MANIFEST, "--db=", "--sql=SELECT 1"], s.deps), 2, "--db= empty");
    assert.match(s.err.join("\n"), /empty value/);
  });

  test("usage errors (exit 2): malformed binding key, unknown flag", async () => {
    const s = sink();
    assert.equal(await mainRun("query", [MANIFEST, "--sql", "SELECT 1", "--bindings", '{"bad-key":1}'], s.deps), 2, "invalid binding name");
    assert.match(s.err.join("\n"), /valid variable name/);
    const s2 = sink();
    assert.equal(await mainRun("query", [MANIFEST, "--sql", "SELECT 1", "--resource", "x"], s2.deps), 2, "unknown --resource typo");
    assert.match(s2.err.join("\n"), /unknown flag/);
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
    for (const name of ["runBioQueryFromManifest", "runBioOperationFromManifest", "validateBioManifest", "createBioRegistry", "fsCasStore", "duckdbNodeConn", "processComputeResolver"]) {
      assert.equal(typeof (sdk as Record<string, unknown>)[name], "function", `${name} exported from the SDK entry`);
    }
  });
});
