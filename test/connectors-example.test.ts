import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { validateBioManifest, type BioManifest } from "../src/core/manifest.js";

// The connector pack: a scientific-database connector is a MANIFEST, zero TypeScript — a duckdb.sql_materialize
// resource whose SQL is a ducknng_ncurl_table GET. This gate proves each is a valid PROGRAM (structural
// validation, no network); actual execution is host-gated (needs ducknng + egress), like the other networked examples.
const DIR = "examples/connectors";

describe("example: scientific-database connectors — each is a valid manifest (zero TS)", () => {
  test("every connector validates and declares one ncurl_table resource over sql_materialize", async () => {
    const files = (await fs.readdir(DIR)).filter((f) => f.endsWith(".json"));
    assert.ok(files.length >= 4, "the starter pack ships >= 4 connectors");
    for (const f of files) {
      const m = JSON.parse(await fs.readFile(join(DIR, f), "utf8")) as BioManifest;
      assert.deepEqual(validateBioManifest(m), [], `${f} is a valid manifest`);
      const res = m.provides.resources ?? [];
      assert.equal(res.length, 1, `${f} declares exactly one connector resource`);
      assert.equal(res[0].resolver, "duckdb.sql_materialize", `${f} resolves via sql_materialize`);
      assert.match(String(res[0].params.sql), /ducknng_ncurl_table/, `${f} calls the API as SQL (ncurl_table)`);
      assert.deepEqual(res[0].params.extensions, ["ducknng"], `${f} loads ducknng`);
    }
  });
});
