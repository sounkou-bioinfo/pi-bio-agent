import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { validateBioManifest, type BioManifest } from "../src/core/manifest.js";

// The connector pack: a scientific-database connector is a manifest over a host-provisioned DuckDB or fetch surface,
// not a source-specific TypeScript client. This gate is structural; actual network execution remains host-gated.
const DIR = "examples/connectors";

describe("example: scientific-database connectors — each is a valid manifest (zero TS)", () => {
  test("every connector validates and declares one remote resource", async () => {
    const files = (await fs.readdir(DIR)).filter((f) => f.endsWith(".json"));
    assert.ok(files.length >= 4, "the starter pack ships >= 4 connectors");
    for (const f of files) {
      const m = JSON.parse(await fs.readFile(join(DIR, f), "utf8")) as BioManifest;
      assert.deepEqual(validateBioManifest(m), [], `${f} is a valid manifest`);
      const res = m.provides.resources ?? [];
      assert.equal(res.length, 1, `${f} declares exactly one connector resource`);
      const r = res[0];
      if (r.resolver === "duckdb.sql_materialize") {
        const sql = String(r.params.sql ?? "");
        assert.ok(sql.length > 0, `${f} declares materialization SQL`);
        assert.ok(Array.isArray(r.params.extensions) && r.params.extensions.length > 0, `${f} declares required extensions`);
        const declaredSources = r.params.declaredSources;
        if (declaredSources !== undefined) {
          assert.ok(
            Array.isArray(declaredSources) && declaredSources.length > 0 && declaredSources.every((source) => typeof source === "string"),
            `${f} declares remote sources as non-empty strings`,
          );
        } else {
          assert.match(sql, /https?:|getvariable\s*\(/i, `${f} receives its remote source through SQL or a runtime binding`);
        }
      } else if (r.resolver === "http.get") {
        // agent-drivable form: host-supplied fetch resolves it; the agent composes the SQL over the resulting table
        assert.match(String(r.params.url), /https?:|getvariable/, `${f} declares an http(s) url (or a SQL expression that composes one)`);
      } else if (r.resolver === "duckhts.read_bcf") {
        // htslib form: a remote HTS file (VCF/BCF) read by region over http; the agent summarizes the resulting table
        assert.match(String(r.params.path), /^https?:|getvariable/, `${f} declares a remote HTS url`);
      } else {
        assert.fail(`${f} uses an unexpected connector resolver '${r.resolver}'`);
      }
    }
  });
});
