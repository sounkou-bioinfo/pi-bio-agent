import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { systemClock } from "../../core/clock.js";
import { validateReadOnlySelect } from "../../core/sql-guard.js";
import type { BioResolverImpl, ProcessRunner } from "../../core/ports.js";

// The COMPUTE-pillar resolver: materialize a table by running an OUT-OF-PROCESS computation (R / Python / Go /
// shell) over a DuckDB input, exchanging Arrow IPC. The DATA contract stays in SQL/Arrow — this resolver does
// the marshalling, the injected ProcessRunner only spawns:
//   1. `COPY (inputSql) TO <in.arrow> (FORMAT arrow)`  — the input table handed to the process, as Arrow IPC
//   2. run `command` with the in/out Arrow paths APPENDED AS THE LAST TWO ARGV entries (… <in.arrow> <out.arrow>)
//      — NOT env vars: argv is explicit and does not leak down a process tree (a discipline that matters once
//      children spawn their own children). The process reads the input path, writes the output path.
//   3. `CREATE OR REPLACE TABLE <table> AS SELECT * FROM read_arrow(<out.arrow>)`  — the result back as a table
// ERROR MODEL (two layers, both defined — not happy-path):
//   * CATASTROPHIC (the run crashed): no ProcessRunner bound, a non-zero exit, a timeout, or a missing output
//     file all THROW here -> the run is recorded as FAILED with a receipt, never a silent empty table. Out-of-
//     process, not FFI: a crash/OOM in the computation is contained in the child.
//   * PER-UNIT (the computation ran but a sub-result failed): that is ERRORS-AS-VALUES and lives in the OUTPUT
//     TABLE, by convention a `status` column ("ok" / "error: <msg>") the agent branches on in SQL — the COMPUTE
//     script's job, not the resolver's. So a partial failure (one tissue, one batch) is data, not a crash.
//
// params: { table, inputSql, command, env?, timeoutMs?, extensions? }
//   table       output table (its identity); a valid SQL identifier
//   inputSql    a single read-only SELECT/WITH producing the input handed to the process (validated)
//   command     argv array [exe, ...args] (NOT a shell string) — e.g. ["Rscript", "/abs/coloc.R"]
//   env         extra environment for the child (merged over the host's) — tool knobs only; NOT the Arrow paths
//               (those are appended as argv)
//   timeoutMs   kill the child after this long (default 120000)
//   extensions  DuckDB extensions to LOAD first; nanoarrow is always loaded (it provides the Arrow-IPC codec)

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function processComputeResolver(runner: ProcessRunner): BioResolverImpl {
  return async (resource, ctx) => {
    const p = resource.params as { table?: unknown; inputSql?: unknown; command?: unknown; env?: unknown; timeoutMs?: unknown; extensions?: unknown };
    if (typeof p.table !== "string" || !IDENT.test(p.table)) throw new Error("process.compute requires params.table to be a valid SQL identifier");
    if (typeof p.inputSql !== "string" || !p.inputSql.trim()) throw new Error("process.compute requires params.inputSql (a single read-only SELECT/WITH)");
    const inner = validateReadOnlySelect(p.inputSql); // input is a read-only query; the side effect is the child, not SQL
    if (!Array.isArray(p.command) || p.command.length === 0 || !p.command.every((x) => typeof x === "string")) {
      throw new Error("process.compute requires params.command to be a non-empty array of strings (argv, not a shell string)");
    }
    const command = p.command as string[];
    // A non-positive timeoutMs (0 / negative) must NOT silently disable the timeout (0 is falsy -> the runner
    // would arm no timer -> an unbounded child). Reject it; absent falls back to the 120s default.
    if (p.timeoutMs !== undefined && (typeof p.timeoutMs !== "number" || !Number.isFinite(p.timeoutMs) || p.timeoutMs <= 0)) {
      throw new Error("process.compute: params.timeoutMs must be a positive number of milliseconds");
    }
    const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : 120000;
    const extraExt = Array.isArray(p.extensions) && p.extensions.every((x) => typeof x === "string") ? (p.extensions as string[]) : [];
    let env: Record<string, string> = {};
    if (p.env != null) {
      if (typeof p.env !== "object" || Array.isArray(p.env)) throw new Error("process.compute: params.env must be an object of string values");
      for (const [k, v] of Object.entries(p.env as Record<string, unknown>)) {
        if (typeof v !== "string") throw new Error(`process.compute: params.env.${k} must be a string (got ${typeof v})`);
      }
      env = p.env as Record<string, string>;
    }

    // nanoarrow provides the Arrow-IPC COPY/read_arrow codec; LOAD only (fail closed if the host hasn't INSTALLed it)
    for (const ext of ["nanoarrow", ...extraExt]) {
      if (!IDENT.test(ext)) throw new Error(`process.compute: invalid extension name '${ext}'`);
      await ctx.conn.run(`LOAD ${ext}`);
    }

    const dir = await fs.mkdtemp(join(tmpdir(), "pi-bio-compute-"));
    const inFile = join(dir, "in.arrow");
    const outFile = join(dir, "out.arrow");
    const now = ctx.now ?? systemClock();
    try {
      // 1. input table -> Arrow IPC file (the process's stdin-equivalent, but a typed columnar contract)
      await ctx.conn.run(`COPY (${inner}) TO '${inFile.replace(/'/g, "''")}' (FORMAT arrow)`);

      // 2. run the out-of-process computation. The Arrow in/out paths are APPENDED AS THE LAST TWO ARGV entries
      //    (not env vars) — explicit, and never inherited down a process tree. `env` carries only the manifest's
      //    own child env (tool knobs), never the IO paths.
      const result = await runner.run({
        command: [...command, inFile, outFile],
        env,
        timeoutMs,
        signal: ctx.signal,
      });
      if (result.timedOut) throw new Error(`process.compute: '${command[0]}' timed out after ${timeoutMs}ms`);
      if (result.exitCode !== 0) {
        const tail = result.stderr.trim().split("\n").slice(-8).join("\n");
        // exitCode null + a signal = killed (OOM, external SIGTERM, abort), NOT a clean non-zero exit — say so.
        const how = result.exitCode === null ? `was killed by ${result.signal ?? "an unknown signal"}` : `exited ${result.exitCode}`;
        throw new Error(`process.compute: '${command[0]}' ${how}${tail ? `\n${tail}` : ""}`);
      }
      // the process MUST produce the output file; a clean exit with no output is still a failure (fail closed)
      try { await fs.access(outFile); } catch { throw new Error(`process.compute: '${command[0]}' exited 0 but wrote no Arrow output to its output path (argv)`); }

      // 3. Arrow IPC result -> a DuckDB table
      await ctx.conn.run(`CREATE OR REPLACE TABLE ${p.table} AS SELECT * FROM read_arrow('${outFile.replace(/'/g, "''")}')`);

      // Provenance digest that actually PINS THE COMPUTATION (not just the argv string): for each command entry
      // that resolves to a readable file (the script), hash its BYTES so editing the script changes the digest —
      // contributed as basename + content-hash, NOT the machine-specific absolute path, so the same run on another
      // host digests identically. Entries are NUL-delimited (["a b","c"] != ["a","b c"]) and the env (sorted, the
      // real compute knob) is folded in. The in/out Arrow paths (argv) are deliberately absent (machine-specific temp paths
      // added only at spawn) — excluding them keeps the digest portable.
      const parts: string[] = [];
      for (const c of command) {
        let entry = `arg:${c}`;
        try {
          const st = await fs.stat(c);
          if (st.isFile()) entry = `file:${basename(c)}:sha256:${createHash("sha256").update(await fs.readFile(c)).digest("hex")}`;
        } catch { /* not a readable file path — keep the literal arg */ }
        parts.push(entry);
      }
      parts.push(`env:${Object.keys(env).sort().map((k) => `${k}=${env[k]}`).join("\0")}`);
      const cmdDigest = `sha256:${createHash("sha256").update(parts.join("\0")).digest("hex")}`;
      const sqlDigest = `sha256:${createHash("sha256").update(inner).digest("hex")}`;
      return {
        result: { schema: "pi-bio.resource_handle.v1", mode: "reference", name: p.table, pointer: { uri: `table:${p.table}`, format: "table" } },
        sourceSnapshots: [{ source: `process:${command[0]}`, version: cmdDigest, retrievedAt: now }],
        provenance: [{ source: "process.compute", retrievedAt: now, digest: sqlDigest, notes: ["process.compute", `cmd:${command.join(" ")}`, "arrow-ipc"] }],
      };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}
