import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../dist/duckdb/node-api.js";
import { createBioObservationSchema, recordObservation } from "../dist/duckdb/observations.js";
import { fsCasStore } from "../dist/hosts/fs-cas.js";
import { createDucknngSqlConn } from "../dist/hosts/ducknng-sql-conn.js";
import { resolveDucknngRuntime } from "./ducknng-runtime.mjs";

// PATTERN: distributed FILE I/O over the ledger + CAS. One agent PRODUCES a file (an R plot); a SEPARATE agent
// READS it back. The only thing that crosses the wire is the DIGEST: the coordinator's shared job ledger carries
// job:<id>:output = {digest,name,size} over ducknng RPC, and the file BYTES live in a content-addressed store both
// agents reach. ducknng-fs is NOT needed: a shared CAS dir covers the HPC shared-storage case; a no-shared-FS
// deployment ships the CAS bytes over the same RPC. This is the bioinformatics shape: jobs produce FILES (a plot,
// a VCF), not just scalars.
//
// Run:  npm run provision:ducknng-owned && npm run build && node scripts/nng-file-handoff.mjs

const SELF = fileURLToPath(import.meta.url);
const ADDR = process.env.HANDOFF_ADDR ?? "tcp://127.0.0.1:9882";
const CAS_ROOT = process.env.HANDOFF_CAS ?? join(tmpdir(), `pi-bio-handoff-cas-${process.pid}`); // a CAS both agents reach
const RUN_ID = "chr22-coverage-plot";
const SLOT = `job:${RUN_ID}:output`;
const { instanceConfig, loadSql } = await resolveDucknngRuntime();

async function serve() {
  const inst = await DuckDBInstance.create(":memory:", instanceConfig);
  const raw = await inst.connect();
  await raw.run(loadSql);
  await createBioObservationSchema(duckdbNodeConn(raw)); // the shared job ledger
  await raw.run(`SELECT ducknng_start_server('handoff', '${ADDR}', 1, 134217728, 300000, 0::UBIGINT)`);
  await raw.run("SELECT ducknng_register_exec_method(false)"); // exec opt-in: the host security boundary
  console.log(`  [coordinator pid ${process.pid}] job ledger + ducknng server up; shared CAS at ${CAS_ROOT}`);
  await new Promise((r) => setTimeout(r, 8000)); // let the producer + reader run
  await raw.run("SELECT ducknng_stop_server('handoff')");
  raw.closeSync(); inst.closeSync();
}

async function produce() {
  const cas = fsCasStore(CAS_ROOT);
  // an agent PRODUCES a plot FILE via R (the out-of-process compute shape)
  const out = join(tmpdir(), `plot-${randomUUID()}.png`);
  execFileSync("Rscript", ["-e",
    `png("${out}", width=420, height=300); ` +
    `barplot(c(region=2731, filtered=2048, rare_hi=6), col="steelblue", ylab="variants", main="chr22:23-24Mb"); ` +
    `dev.off()`], { stdio: "ignore" });
  const bytes = await fs.readFile(out);
  const digest = createHash("sha256").update(bytes).digest("hex");
  await cas.put({ algorithm: "sha256", digest, sizeBytes: bytes.length, mediaType: "image/png" }, bytes); // FILE bytes -> CAS
  await fs.rm(out, { force: true });
  // record the OUTPUT (its digest, NOT its bytes) into the shared ledger over ducknng RPC
  const meta = { digest, name: "coverage.png", size: bytes.length, mediaType: "image/png" };
  const clientInstance = await DuckDBInstance.create(":memory:", instanceConfig);
  const c = await clientInstance.connect();
  await c.run(loadSql);
  const remote = createDucknngSqlConn({ client: duckdbNodeConn(c), url: ADDR });
  await recordObservation(remote, {
    statementKey: SLOT,
    subjectId: `job:${RUN_ID}`,
    predicate: "job_output",
    value: meta,
    recordedAt: new Date().toISOString(),
    source: "agent:producer",
  });
  c.closeSync();
  clientInstance.closeSync();
  console.log(`  [agent:producer pid ${process.pid}] plotted coverage.png (${bytes.length} B) -> CAS sha256:${digest.slice(0, 12)}…; recorded the digest in the ledger`);
}

async function read() {
  const cas = fsCasStore(CAS_ROOT);
  const clientInstance = await DuckDBInstance.create(":memory:", instanceConfig);
  const c = await clientInstance.connect();
  await c.run(loadSql);
  const remote = createDucknngSqlConn({ client: duckdbNodeConn(c), url: ADDR });
  // read the output DIGEST from the shared ledger over ducknng RPC (never the bytes)
  const rows = await remote.all(
    "SELECT value_json FROM bio_observations WHERE statement_key = ? ORDER BY recorded_at DESC LIMIT 1",
    [SLOT],
  );
  c.closeSync();
  clientInstance.closeSync();
  const meta = JSON.parse(String(rows[0].value_json)); // {digest,name,size,mediaType}
  // fetch the FILE BYTES from CAS by digest
  const bytes = await fs.readFile(cas.pathFor({ algorithm: "sha256", digest: meta.digest }));
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47; // \x89PNG
  console.log(`  [agent:reader pid ${process.pid}] read the ledger, fetched '${meta.name}' from CAS by digest: ${bytes.length} B, PNG=${isPng}, sha256:${meta.digest.slice(0, 12)}…`);
  if (bytes.length !== meta.size || !isPng) { console.error("FAIL: bytes/type mismatch"); process.exit(1); }
}

const spawnChild = (args) => new Promise((resolve, reject) => {
  const ch = spawn(process.execPath, [SELF, ...args], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, HANDOFF_ADDR: ADDR, HANDOFF_CAS: CAS_ROOT } });
  ch.on("error", reject);
  ch.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${args[0]} exited ${code}`))));
});

async function orchestrate() {
  await fs.mkdir(CAS_ROOT, { recursive: true });
  console.log("Distributed file I/O over ducknng: one agent plots a file, another reads it back by digest\n");
  const server = spawnChild(["serve"]);
  await new Promise((r) => setTimeout(r, 1500)); // let the coordinator bind + register exec
  await spawnChild(["produce"]);
  await spawnChild(["read"]);
  await server;
  console.log("\nThe producer wrote a real PNG into a content-addressed store and recorded only its DIGEST in the");
  console.log("shared ledger over ducknng RPC. A SEPARATE reader process read that digest and fetched the exact bytes");
  console.log("from CAS. Files move by content address; the ledger moves the reference. No ducknng-fs needed: a shared");
  console.log("CAS covers the HPC case, and a no-shared-FS deployment ships the CAS bytes over the same transport.");
  await fs.rm(CAS_ROOT, { recursive: true, force: true });
}

const [mode] = process.argv.slice(2);
const run = mode === "serve" ? serve() : mode === "produce" ? produce() : mode === "read" ? read() : orchestrate();
run.catch((e) => { console.error(e); process.exit(1); });
