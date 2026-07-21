import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fsp } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mainRun, parseFlags } from "../src/cli/run.js";
import { mainCatalog } from "../src/cli/catalog.js";
import { openBioStore } from "../src/hosts/bio-store.js";
import { observationAsOfKey } from "../src/duckdb/observations.js";
import * as sdk from "../src/index.js";

// The `query`/`run` CLI engine wraps the SAME tested host functions the Pi extension uses. Exercised over the
// pure-SQL variant-counts example (no network, no process — the CLI's fail-closed default suffices).
const MANIFEST = "examples/variant-counts/manifest.json";
const RHI_MANIFEST = "examples/rare-high-impact/manifest.json";

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { cwd: process.cwd(), out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

const PROFILE_MACROS = [
  "CREATE MACRO ducknng_register_http_profile(a,b,c,d,e,f,g,h,i,j,k) AS true",
  `CREATE MACRO ducknng_list_http_profiles() AS TABLE SELECT
    'cli-auth-profile'::VARCHAR profile_id,
    'https'::VARCHAR scheme,
    'api.example.test'::VARCHAR host,
    NULL::INTEGER port,
    false has_port,
    '/v1'::VARCHAR path_prefix,
    'GET'::VARCHAR "method",
    true tls_required,
    '["Authorization"]'::VARCHAR auth_header_names_json,
    1::UBIGINT "version",
    1::UBIGINT created_ms,
    1::UBIGINT updated_ms,
    0::UBIGINT expires_at_ms,
    '["case:alpha","case:beta"]'::VARCHAR allow_subjects_json`,
].join(";");

describe("cli: query/run over a manifest (provider-agnostic entry point)", () => {
  test("catalog lists manifest-backed sources before a host chooses one to describe/query", async () => {
    const s = sink();
    const code = await mainCatalog(["--root", "examples", "--query", "opentargets"], s.deps);
    assert.equal(code, 0, s.err.join("\n"));
    const printed = JSON.parse(s.out.join("\n")) as {
      schema: string;
      entries: Array<{ manifestPath: string; id: string; resources: Array<{ table?: string }>; operations: Array<{ id: string; requiredResources: string[] }>; requirements: string[] }>;
    };
    assert.equal(printed.schema, "pi-bio.manifest_catalog.v2");
    assert.deepEqual(printed.entries.map((entry) => entry.manifestPath), ["examples/connectors/opentargets-graphql.json"]);
    assert.equal(printed.entries[0]!.resources[0]!.table, "opentargets_target_associated_diseases");
    assert.deepEqual(printed.entries[0]!.operations, [{ id: "opentargets.associated_diseases", title: "OpenTargets associated diseases for one target", transport: "duckdb.sql", requiredResources: ["opentargets_target_associated_diseases"] }]);
    assert.ok(printed.entries[0]!.requirements.includes("duckdb.extension.ducknng"));
  });

  test("catalog usage errors are explicit", async () => {
    const s = sink();
    assert.equal(await mainCatalog(["--bogus", "x"], s.deps), 2);
    assert.match(s.err.join("\n"), /unknown flag\(s\) for 'catalog'.*--bogus/);
  });

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

  test("explicit CLI network grant materializes a generic http.get resource", async () => {
    const dir = await fsp.mkdtemp(join(tmpdir(), "cli-http-"));
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('[{"gene":"BRCA2","score":7}]');
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const manifestPath = join(dir, "manifest.json");
      await fsp.writeFile(manifestPath, JSON.stringify({
        schema: "pi-bio.manifest.v1",
        id: "cli-http",
        version: "0.1.0",
        title: "CLI HTTP",
        description: "Exercise the explicit CLI fetch grant.",
        provides: {
          resolvers: [{ id: "http.get", version: "0.1.0", title: "HTTP", description: "HTTP to table", output: { mode: "table" } }],
          resources: [{ id: "api", title: "API", kind: "virtual", resolver: "http.get", params: { url: `http://127.0.0.1:${address.port}/genes`, table: "api", format: "json" } }],
        },
      }));
      const s = sink();
      const code = await mainRun("query", [manifestPath, "--network", "fetch", "--db", ":memory:", "--sql", "SELECT gene, score FROM api"], { ...s.deps, cwd: dir });
      assert.equal(code, 0, s.err.join("\n"));
      const result = JSON.parse(s.out[0]!) as { rows: Array<{ gene: string; score: number }> };
      assert.deepEqual(result.rows, [{ gene: "BRCA2", score: 7 }]);
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });

  test("explicit CLI compute and CAS grants capture process artifacts", async () => {
    const cwd = await fsp.mkdtemp(join(tmpdir(), "cli-compute-"));
    const s = sink();
    const code = await mainRun("query", [
      resolve("examples/compute-files-only/manifest.json"),
      "--db", ":memory:",
      "--compute", "local",
      "--cas-root", join(cwd, "cas"),
      "--sql", "SELECT name, digest FROM tracks ORDER BY name",
    ], { ...s.deps, cwd });
    assert.equal(code, 0, s.err.join("\n"));
    const result = JSON.parse(s.out[0]!) as { rows: Array<{ name: string; digest: string }> };
    assert.deepEqual(result.rows.map((row) => row.name), ["regions_bed", "summary"]);
    assert.ok(result.rows.every((row) => /^sha256:[0-9a-f]{64}$/.test(row.digest)));

    const controller = new AbortController();
    controller.abort();
    const cancelled = sink();
    const cancelledCode = await mainRun("query", [
      resolve("examples/compute-files-only/manifest.json"),
      "--db", ":memory:", "--compute", "local", "--cas-root", join(cwd, "cancelled-cas"),
      "--sql", "SELECT name FROM tracks",
    ], { ...cancelled.deps, cwd, signal: controller.signal });
    assert.equal(cancelledCode, 1);
    assert.match(cancelled.err.join("\n"), /signal already aborted/, "CLI cancellation reaches the local async runner before spawn");
  });

  test("CLI host files supply protected state and DuckDB config without serializing values into replay", async () => {
    const cwd = await fsp.mkdtemp(join(tmpdir(), "cli-host-files-"));
    const manifestPath = join(cwd, "manifest.json");
    const protectedPath = join(cwd, "protected.json");
    const configPath = join(cwd, "duckdb.json");
    await fsp.writeFile(protectedPath, JSON.stringify({ api_token: "host-secret-value" }));
    await fsp.writeFile(configPath, JSON.stringify({ threads: "2" }));
    await fsp.writeFile(manifestPath, JSON.stringify({
      schema: "pi-bio.manifest.v1",
      id: "cli-protected",
      version: "0.1.0",
      title: "CLI protected state",
      description: "Declared operation over protected host state.",
      provides: { operations: [{
        id: "host.summary", version: "0.1.0", title: "Host summary", description: "Use protected state without returning it.",
        transport: "duckdb.sql", inputSchema: { type: "object" },
        sql: { sqlTemplate: "SELECT length(getvariable('api_token')) AS token_chars", readOnly: true },
      }] },
    }));
    const s = sink();
    const code = await mainRun("run", [
      manifestPath, "--db", ":memory:", "--operation", "host.summary",
      "--protected-bindings-file", protectedPath,
      "--duckdb-config-file", configPath,
    ], { ...s.deps, cwd });
    assert.equal(code, 0, s.err.join("\n"));
    const result = JSON.parse(s.out[0]!) as { rows: Array<{ token_chars: number }>; runDir: string };
    assert.deepEqual(result.rows, [{ token_chars: 17 }]);
    const replay = await fsp.readFile(join(result.runDir, "replay.json"), "utf8");
    assert.doesNotMatch(replay, /host-secret-value/);
    assert.match(replay, /protectedSessionBindingsDigest/);
    assert.match(replay, /duckdbConfigDigest/);
  });

  test("--ledger folds the CLI run into the shared store as an attributed run:<id> fact (thesis, from the CLI)", async () => {
    const s = sink();
    const ledgerPath = join(await fsp.mkdtemp(join(tmpdir(), "cli-ledger-")), "store.duckdb");
    const code = await mainRun("query", [MANIFEST, "--db", ":memory:", "--sql", "SELECT count(*) AS n FROM variants",
      "--run-id", "cli-led", "--ledger", ledgerPath, "--author", "agent:cli-test"], s.deps);
    assert.equal(code, 0, s.err.join("\n"));
    // the CLI CLOSED its store handle (DuckDB is a process-exclusive writer), so we can reopen and read the fact back
    const store = await openBioStore(process.cwd(), { path: ledgerPath });
    try {
      const row = await observationAsOfKey(store.conn, "run:cli-led", "9999-12-31T23:59:59.999Z");
      assert.ok(row, "the CLI recorded the run into the --ledger store");
      assert.equal(row!.source, "agent:cli-test"); // attributed to --author
      const v = JSON.parse(row!.value_json!);
      assert.equal(v.status, "succeeded");
      assert.equal(v.sql, "SELECT count(*) AS n FROM variants"); // the exact ad-hoc SQL is queryable in the ledger
    } finally { store.close(); }
  });

  test("--ledger rejects dangling file-symlink aliases before the shared target is created", async () => {
    const cwd = await fsp.mkdtemp(join(tmpdir(), "cli-ledger-alias-"));
    const realDir = join(cwd, "real");
    await fsp.mkdir(realDir);
    const target = join(realDir, "shared.duckdb");
    const scientificAlias = join(cwd, "scientific.duckdb");
    const ledgerAlias = join(cwd, "ledger.duckdb");
    await fsp.symlink(target, scientificAlias);
    await fsp.symlink(target, ledgerAlias);
    const s = sink();
    const code = await mainRun("query", [
      resolve(MANIFEST), "--db", scientificAlias, "--sql", "SELECT count(*) AS n FROM variants",
      "--ledger", ledgerAlias,
    ], { ...s.deps, cwd });
    assert.equal(code, 2);
    assert.match(s.err.join("\n"), /ledger must not refer to the scientific --db file/);
    await assert.rejects(() => fsp.stat(target), /ENOENT/, "validation happens before DuckDB creates the shared target");
  });

  test("--ledger defaults the author to 'cli' when --author is omitted; without --ledger nothing is recorded", async () => {
    const s = sink();
    const ledgerPath = join(await fsp.mkdtemp(join(tmpdir(), "cli-ledger-")), "store.duckdb");
    assert.equal(await mainRun("query", [MANIFEST, "--db", ":memory:", "--sql", "SELECT 1 AS x", "--run-id", "cli-def", "--ledger", ledgerPath], s.deps), 0, s.err.join("\n"));
    const store = await openBioStore(process.cwd(), { path: ledgerPath });
    try {
      const row = await observationAsOfKey(store.conn, "run:cli-def", "9999-12-31T23:59:59.999Z");
      assert.equal(row!.source, "cli", "default author is 'cli'");
    } finally { store.close(); }
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
    // a flag belonging to the OTHER subcommand is a usage error (exit 2), not silently ignored
    const s4 = sink();
    assert.equal(await mainRun("run", [MANIFEST, "--db", ":memory:", "--operation", "op", "--resources", "a,b"], s4.deps), 2, "run does not accept --resources");
    assert.match(s4.err.join("\n"), /unknown flag\(s\) for 'run'.*--resources/);
    const s5 = sink();
    assert.equal(await mainRun("query", [MANIFEST, "--db", ":memory:", "--sql", "SELECT 1", "--operation", "foo"], s5.deps), 2, "query does not accept --operation");
    assert.match(s5.err.join("\n"), /unknown flag\(s\) for 'query'.*--operation/);
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

  test("--ducknng-http-profile commissions a runtime profile and pins only its redacted receipt", async () => {
    const dir = await fsp.mkdtemp(join(tmpdir(), "cli-profile-"));
    const profilePath = join(dir, "profile.json");
    await fsp.writeFile(profilePath, JSON.stringify({
      profileId: "cli-auth-profile",
      scheme: "https",
      host: "api.example.test",
      pathPrefix: "/v1",
      method: "GET",
      tlsRequired: true,
      authHeaderName: "Authorization",
      authHeaderValueEnv: "PI_BIO_TEST_TOKEN",
      allowSubjects: ["case:beta", "case:alpha"],
    }), "utf8");
    const s = sink();
    const code = await mainRun("query", [
      MANIFEST,
      "--db", ":memory:",
      "--init-sql", PROFILE_MACROS,
      "--ducknng-http-profile", profilePath,
      "--sql", "SELECT count(*) AS n FROM variants",
      "--run-id", "cli-profile",
    ], { ...s.deps, env: { PI_BIO_TEST_TOKEN: "Bearer super-secret" } });
    assert.equal(code, 0, s.err.join("\n"));
    const printed = JSON.parse(s.out.join("\n")) as { runDir: string };
    const replay = JSON.parse(await fsp.readFile(join(printed.runDir, "replay.json"), "utf8")) as { hostReceiptDigests?: string[] };
    assert.equal(replay.hostReceiptDigests?.length, 1);
    assert.match(replay.hostReceiptDigests![0]!, /^sha256:[0-9a-f]{64}$/);
    const run = JSON.parse(await fsp.readFile(join(printed.runDir, "run.json"), "utf8"));
    const serialized = JSON.stringify({ replay, run });
    assert.match(serialized, /host\.capability:pi-bio\.ducknng_http_profile_receipt\.v1/);
    assert.doesNotMatch(serialized, /super-secret|Bearer|case:alpha|case:beta/);
  });

  test("--ducknng-http-profile refuses raw secret values in the profile file", async () => {
    const dir = await fsp.mkdtemp(join(tmpdir(), "cli-profile-"));
    const profilePath = join(dir, "profile.json");
    await fsp.writeFile(profilePath, JSON.stringify({
      profileId: "bad-profile",
      scheme: "https",
      host: "api.example.test",
      pathPrefix: "/",
      authHeaderName: "Authorization",
      authHeaderValue: "Bearer should-not-appear",
    }), "utf8");
    const s = sink();
    const code = await mainRun("query", [
      MANIFEST,
      "--db", ":memory:",
      "--ducknng-http-profile", profilePath,
      "--sql", "SELECT 1",
    ], s.deps);
    assert.equal(code, 2);
    assert.match(s.err.join("\n"), /must not contain authHeaderValue/);
    assert.doesNotMatch(s.err.join("\n"), /should-not-appear/);
  });

  test("--ducknng-http-profile does not read stdin before required command args validate", async () => {
    const dir = await fsp.mkdtemp(join(tmpdir(), "cli-profile-"));
    const profilePath = join(dir, "profile.json");
    await fsp.writeFile(profilePath, JSON.stringify({
      profileId: "cli-auth-profile",
      scheme: "https",
      host: "api.example.test",
      pathPrefix: "/v1",
      authHeaderName: "Authorization",
      authHeaderValueStdin: true,
    }), "utf8");
    let stdinReads = 0;
    const s = sink();
    const code = await mainRun("query", [
      MANIFEST,
      "--db", ":memory:",
      "--ducknng-http-profile", profilePath,
    ], { ...s.deps, readStdin: async () => { stdinReads++; return "Bearer should-not-read\n"; } });
    assert.equal(code, 2);
    assert.equal(stdinReads, 0);
    assert.match(s.err.join("\n"), /query requires --sql/);
  });

  test("--ducknng-http-profile works for declared operation runs with an stdin secret", async () => {
    const dir = await fsp.mkdtemp(join(tmpdir(), "cli-profile-"));
    const profilePath = join(dir, "profile.json");
    await fsp.writeFile(profilePath, JSON.stringify({
      profileId: "cli-auth-profile",
      scheme: "https",
      host: "api.example.test",
      pathPrefix: "/v1",
      method: "GET",
      tlsRequired: true,
      authHeaderName: "Authorization",
      authHeaderValueStdin: true,
      allowSubjects: ["case:alpha"],
    }), "utf8");
    let stdinReads = 0;
    const s = sink();
    const code = await mainRun("run", [
      RHI_MANIFEST,
      "--db", ":memory:",
      "--init-sql", PROFILE_MACROS,
      "--ducknng-http-profile", profilePath,
      "--operation", "rare_high_impact.report",
      "--run-id", "cli-profile-run",
    ], { ...s.deps, readStdin: async () => { stdinReads++; return "Bearer stdin-secret\n"; } });
    assert.equal(code, 0, s.err.join("\n"));
    assert.equal(stdinReads, 1);
    const printed = JSON.parse(s.out.join("\n")) as { runDir: string };
    const replay = JSON.parse(await fsp.readFile(join(printed.runDir, "replay.json"), "utf8")) as { hostReceiptDigests?: string[] };
    assert.equal(replay.hostReceiptDigests?.length, 1);
    const serialized = JSON.stringify({ replay, run: JSON.parse(await fsp.readFile(join(printed.runDir, "run.json"), "utf8")) });
    assert.match(serialized, /host\.capability:pi-bio\.ducknng_http_profile_receipt\.v1/);
    assert.doesNotMatch(serialized, /stdin-secret|Bearer|case:alpha/);
  });
});

describe("sdk: the package entry point re-exports the substrate surface", () => {
  test("the key host + core symbols are importable from the top-level index", () => {
    for (const name of ["runBioQueryFromManifest", "runBioOperationFromManifest", "recordHostEvent", "validateBioManifest", "createBioRegistry", "fsCasStore", "duckdbNodeConn", "createDucknngSqlConn", "computeRunResolver"]) {
      assert.equal(typeof (sdk as Record<string, unknown>)[name], "function", `${name} exported from the SDK entry`);
    }
  });
});

describe("cli: splitSqlStatements (--init-sql provisioning)", () => {
  test("splits on ; but not inside a single-quoted string literal", async () => {
    const { splitSqlStatements } = await import("../src/cli/run.js");
    assert.deepEqual(splitSqlStatements("INSTALL ducknng; LOAD ducknng"), ["INSTALL ducknng", "LOAD ducknng"]);
    assert.deepEqual(splitSqlStatements("SET VARIABLE x = fn('a;b'); LOAD y"), ["SET VARIABLE x = fn('a;b')", "LOAD y"]);
    assert.deepEqual(splitSqlStatements("SET x = 'it''s; ok'"), ["SET x = 'it''s; ok'"]);
    assert.deepEqual(splitSqlStatements("  ; ONE ;;  "), ["ONE"]);
  });
});
