import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { mainDescribe } from "../src/cli/describe.js";

function sink(cwd = process.cwd()) {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { cwd, out: (line: string) => out.push(line), err: (line: string) => err.push(line) } };
}

test("CLI describe validates an authored manifest and reports explicit host admission", async () => {
  const local = sink();
  const localCode = await mainDescribe(["examples/compute-files-only/manifest.json"], local.deps);
  assert.equal(localCode, 0, local.err.join("\n"));
  const blocked = JSON.parse(local.out[0]!) as { valid: boolean; host: { resources: Array<{ admission: string; reasons: string[] }> } };
  assert.equal(blocked.valid, true);
  assert.equal(blocked.host.resources[0]!.admission, "blocked");
  assert.match(blocked.host.resources[0]!.reasons.join("\n"), /no host binding/);

  const granted = sink();
  const grantedCode = await mainDescribe(["examples/compute-files-only/manifest.json", "--compute", "local"], granted.deps);
  assert.equal(grantedCode, 0, granted.err.join("\n"));
  const ready = JSON.parse(granted.out[0]!) as { host: { resources: Array<{ admission: string }> } };
  assert.equal(ready.host.resources[0]!.admission, "ready");
});

test("CLI describe accepts explicit extension/egress attestations without executing the resource", async () => {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-describe-"));
  const capabilities = join(cwd, "capabilities.json");
  await fs.writeFile(capabilities, JSON.stringify({
    "duckdb.extension.duckhts": "available",
    "network.egress": "available",
  }));
  const s = sink(cwd);
  const code = await mainDescribe([
    resolve("examples/connectors/clinvar-region.json"),
    "--capabilities-file", capabilities,
  ], s.deps);
  assert.equal(code, 0, s.err.join("\n"));
  const result = JSON.parse(s.out[0]!) as { host: { resources: Array<{ admission: string }> } };
  assert.equal(result.host.resources[0]!.admission, "ready");
});
