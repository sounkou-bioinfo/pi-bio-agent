import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { systemClock } from "../../core/clock.js";
import { validateReadOnlySelect } from "../../core/sql-guard.js";
import { captureDeclaredOutputsToCas } from "../artifact-capture.js";
import { collectComputeTask, type BioResolverImpl, type ComputeRunner } from "../../core/ports.js";
import { attestEnvironment, validateEnvDescriptor, ENV_ATTESTATION_SCHEMA, type EnvDescriptor } from "../../core/reproducibility.js";

// A declared process output is read whole into memory (hash -> CAS), so an unbounded artifact would OOM the Node
// host — the same class of risk the http byte-cap addresses. Cap it fail-closed at a generous default (checked
// against the file's stat size BEFORE reading it into a buffer). A huge legitimate output belongs in a streamed
// sink the host owns, not a materialized artifact.
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024; // 256 MiB

// The COMPUTE-pillar resolver: materialize a table by running an OUT-OF-PROCESS computation (R / Python / Go /
// shell) over a DuckDB input, exchanging Arrow IPC. The DATA contract stays in SQL/Arrow — this resolver does
// the marshalling, the injected ComputeRunner only spawns:
//   1. `COPY (inputSql) TO <in.arrow> (FORMAT arrow)`  — the input table handed to the process, as Arrow IPC
//      (SKIPPED when inputSql is absent: a FILES-ONLY op reads/writes its own files and gets no Arrow input)
//   2. run `command` with the Arrow paths APPENDED AS ARGV (… <in.arrow?> <out.arrow?>) — NOT env vars: argv is
//      explicit and does not leak down a process tree (a discipline that matters once children spawn their own
//      children). in.arrow is appended only with an input; out.arrow only in "arrow" resultTable mode.
//   3. arrow mode: `CREATE OR REPLACE TABLE <table> AS SELECT * FROM read_arrow(<out.arrow>)` — the rectangular
//      result back as a table. artifacts mode: the table IS the captured-artifacts listing (files-only tools).
// ERROR MODEL (two layers, both defined — not happy-path):
//   * CATASTROPHIC (the run crashed): no ComputeRunner bound, a non-zero exit, a timeout, or a missing output
//     file all THROW here -> the run is recorded as FAILED with a receipt, never a silent empty table. Out-of-
//     process, not FFI: a crash/OOM in the computation is contained in the child.
//   * PER-UNIT (the computation ran but a sub-result failed): that is ERRORS-AS-VALUES and lives in the OUTPUT
//     TABLE, by convention a `status` column ("ok" / "error: <msg>") the agent branches on in SQL — the COMPUTE
//     script's job, not the resolver's. So a partial failure (one tissue, one batch) is data, not a crash.
//
// params: { table, inputSql?, command, env?, timeoutMs?, extensions?, outputs?, resultTable?, maxOutputBytes? }
//   table       output table (its identity); a valid SQL identifier
//   inputSql    OPTIONAL — a single read-only SELECT/WITH producing the input handed to the process (validated).
//               Absent = a FILES-ONLY op with no Arrow input (the tool uses its own inputs / command args).
//   resultTable OPTIONAL — "arrow" (default): the table is read from the tool's out.arrow. "artifacts": a
//               files-only op — no out.arrow; the table IS the captured-outputs listing (name/path/kind/digest/
//               size). Requires at least one declared output. Lets samtools/bcftools/a plot be a first-class op.
//               artifacts mode MAY still declare inputSql: then the tool receives in.arrow (a table-fed tool)
//               but returns only files (e.g. plot a table -> a .svg). inputSql governs the input; resultTable
//               governs the output — the two are independent.
//   command     argv array [exe, ...args] (NOT a shell string) — e.g. ["Rscript", "/abs/coloc.R"]
//   env         extra environment for the child (merged over the host's) — tool knobs only; NOT the Arrow paths
//               (those are appended as argv)
//   timeoutMs   kill the child after this long (default 120000)
//   extensions  DuckDB extensions to LOAD first; nanoarrow (the Arrow-IPC codec) is loaded ONLY when Arrow I/O
//               is actually used (an input table, or an "arrow" result) — a pure files-only op loads no codec
//   outputs     OPTIONAL declared FILE outputs — the #3 artifact transport (file outputs ARE a thing in bioinfo):
//               [{ name, path, kind?: "file"|"table" }]. The child writes them into its WORK DIR (its cwd); after
//               a clean exit the resolver captures each into CAS (content-addressed) and records {name, path,
//               digest, size} in the receipt. Values come back via Arrow (the table); FILES go via CAS and NEVER
//               through the IPC — the nf-r-ipc/Nextflow split (Nextflow's content-addressed work dir = our CAS).
//               Requires a host-injected CAS (fails closed without one).
//   environment OPTIONAL declared EnvDescriptor (C1) — the reproduction CONTRACT (a conda/micromamba/renv lock, a
//               container digest, a duckdb+extensions set — runtime-agnostic layers). Validated fail-closed. The
//               runner's optional describeEnvironment probe gives the OBSERVED env; the receipt records a declared-
//               vs-observed attestation (env_status: matched/drift/declared_only/observed_only/unknown). Distinct
//               from `env` (child environment VARIABLES). Absent declaration + no probe => explicit 'unknown'.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function computeRunResolver(runner: ComputeRunner): BioResolverImpl {
  return async (resource, ctx) => {
    const p = resource.params as { table?: unknown; inputSql?: unknown; command?: unknown; env?: unknown; timeoutMs?: unknown; extensions?: unknown; outputs?: unknown; resultTable?: unknown; environment?: unknown; maxOutputBytes?: unknown };
    // Per-output byte cap: can only TIGHTEN the default (min), never raise it — a manifest can't opt OUT of the
    // OOM guard, only ask for a stricter one.
    if (p.maxOutputBytes !== undefined && (typeof p.maxOutputBytes !== "number" || !Number.isFinite(p.maxOutputBytes) || p.maxOutputBytes <= 0)) {
      throw new Error("compute.run: params.maxOutputBytes must be a positive number of bytes");
    }
    const maxOutputBytes = Math.min(typeof p.maxOutputBytes === "number" ? p.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES);
    if (typeof p.table !== "string" || !IDENT.test(p.table)) throw new Error("compute.run requires params.table to be a valid SQL identifier");
    // inputSql is OPTIONAL: absent = a FILES-ONLY op (the tool reads/writes its own files; no Arrow input handed in).
    // Present = the op gets its input table as Arrow IPC (in.arrow, appended to argv).
    if (p.inputSql !== undefined && (typeof p.inputSql !== "string" || !p.inputSql.trim())) throw new Error("compute.run: params.inputSql, when present, must be a non-empty read-only SELECT/WITH");
    const inner = typeof p.inputSql === "string" && p.inputSql.trim() ? validateReadOnlySelect(p.inputSql) : null;
    if (!Array.isArray(p.command) || p.command.length === 0 || !p.command.every((x) => typeof x === "string")) {
      throw new Error("compute.run requires params.command to be a non-empty array of strings (argv, not a shell string)");
    }
    const command = p.command as string[];
    // A non-positive timeoutMs (0 / negative) must NOT silently disable the timeout (0 is falsy -> the runner
    // would arm no timer -> an unbounded child). Reject it; absent falls back to the 120s default.
    if (p.timeoutMs !== undefined && (typeof p.timeoutMs !== "number" || !Number.isFinite(p.timeoutMs) || p.timeoutMs <= 0)) {
      throw new Error("compute.run: params.timeoutMs must be a positive number of milliseconds");
    }
    const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : 120000;
    // fail closed on a malformed `extensions` (a typo like "extensions":"foo" must NOT be silently dropped —
    // consistent with env/outputs/timeoutMs/resultTable, which all throw)
    let extraExt: string[] = [];
    if (p.extensions !== undefined) {
      if (!Array.isArray(p.extensions) || !p.extensions.every((x) => typeof x === "string")) throw new Error("compute.run: params.extensions must be an array of strings");
      extraExt = p.extensions as string[];
    }
    // SECRETS BOUNDARY: params.env is manifest data — it is persisted VERBATIM in the replay manifest snapshot
    // (replay.json / CAS), so it must hold ONLY non-secret knobs (e.g. OMP_NUM_THREADS, a locale). A credential
    // here (AWS_SECRET_ACCESS_KEY, a token) would leak in cleartext into replay/CAS — the same reason host
    // `duckdbInitSql` is digested, not stored verbatim. Host-owned SECRET env reaches the child through the
    // host-injected ComputeRunner (it merges its own protected env at spawn), NEVER a manifest param — mirroring the
    // network `withAuth` boundary. The resolver validates ownership boundary, not variable-name folklore.
    let env: Record<string, string> = {};
    if (p.env != null) {
      if (typeof p.env !== "object" || Array.isArray(p.env)) throw new Error("compute.run: params.env must be an object of string values");
      for (const [k, v] of Object.entries(p.env as Record<string, unknown>)) {
        if (typeof v !== "string") throw new Error(`compute.run: params.env.${k} must be a string (got ${typeof v})`);
      }
      env = p.env as Record<string, string>;
    }

    // Declared FILE outputs (#3 artifact transport). Paths are RELATIVE to the work dir (no '..' / absolute — the
    // child cannot smuggle a read of an arbitrary host file out through a "declared output").
    const outputs: Array<{ name: string; path: string; kind: "file" | "table" }> = [];
    if (p.outputs != null) {
      if (!Array.isArray(p.outputs)) throw new Error("compute.run: params.outputs must be an array of { name, path, kind? }");
      for (let i = 0; i < p.outputs.length; i++) {
        const o = p.outputs[i] as { name?: unknown; path?: unknown; kind?: unknown };
        if (typeof o.name !== "string" || !o.name) throw new Error(`compute.run: outputs[${i}].name (string) is required`);
        // Cross-platform path isolation (don't assume POSIX): reject absolute (incl. a Windows drive `C:\`) and any
        // `..` segment split on EITHER separator. A resolve-based containment re-check happens at read time too.
        if (typeof o.path !== "string" || !o.path || isAbsolute(o.path) || /^[A-Za-z]:/.test(o.path) || o.path.split(/[\\/]+/).includes("..")) {
          throw new Error(`compute.run: outputs[${i}].path must be a relative path within the work dir (no '..' / absolute)`);
        }
        if (o.kind !== undefined && o.kind !== "file" && o.kind !== "table") throw new Error(`compute.run: outputs[${i}].kind must be 'file' or 'table'`);
        outputs.push({ name: o.name, path: o.path, kind: (o.kind as "file" | "table") ?? "file" });
      }
      if (!ctx.cas) throw new Error("compute.run: params.outputs requires a host-injected CAS store (none bound) — fail closed");
    }

    // resultTable: how the resource's TABLE is produced. "arrow" (default) = read the tool's out.arrow (a
    // rectangular value). "artifacts" = a FILES-ONLY op (no out.arrow required); the table IS the captured artifacts
    // listing (name, path, kind, digest, size), so a tool that only writes files (BAM/VCF/plots) is still a
    // first-class resource — its outputs are CAS handles the agent queries + reads downstream.
    const resultTable: "arrow" | "artifacts" = p.resultTable === undefined ? "arrow" : p.resultTable as "arrow" | "artifacts";
    if (resultTable !== "arrow" && resultTable !== "artifacts") throw new Error("compute.run: params.resultTable must be 'arrow' or 'artifacts'");
    if (resultTable === "artifacts" && outputs.length === 0) throw new Error("compute.run: resultTable 'artifacts' requires at least one declared output (it IS the table)");

    // DECLARED environment (C1, optional): the reproduction CONTRACT — a runtime-agnostic EnvDescriptor (a conda/
    // micromamba/renv lock, a container digest, a duckdb+extensions set — all just layers). Validated fail-closed if
    // present. NB: this is distinct from params.env (the child's environment VARIABLES / tool knobs).
    let declaredEnv: EnvDescriptor | undefined;
    if (p.environment !== undefined) {
      declaredEnv = p.environment as EnvDescriptor;
      const errs = validateEnvDescriptor(declaredEnv);
      if (errs.length) throw new Error(`compute.run: params.environment is not a valid EnvDescriptor — ${errs.join("; ")}`);
    }

    // nanoarrow provides the Arrow-IPC COPY/read_arrow codec — LOADed only when Arrow IO is actually used (an input
    // table, or an "arrow" result). A pure files-only op (no input, artifacts result) exchanges no Arrow and needs
    // no codec, so it doesn't require nanoarrow at all. LOAD only (fail closed if the host hasn't INSTALLed it).
    const needsArrow = inner !== null || resultTable === "arrow";
    for (const ext of [...(needsArrow ? ["nanoarrow"] : []), ...extraExt]) {
      if (!IDENT.test(ext)) throw new Error(`compute.run: invalid extension name '${ext}'`);
      await ctx.conn.run(`LOAD ${ext}`);
    }

    const dir = await fs.mkdtemp(join(tmpdir(), "pi-bio-compute-"));
    const inFile = join(dir, "in.arrow");
    const outFile = join(dir, "out.arrow");
    const now = ctx.now ?? systemClock();
    try {
      // 1. input table -> Arrow IPC file (only when an input SQL was declared)
      if (inner) await ctx.conn.run(`COPY (${inner}) TO '${inFile.replace(/'/g, "''")}' (FORMAT arrow)`);

      // 2. run the out-of-process computation. The Arrow paths are APPENDED AS ARGV (not env vars) — explicit, and
      //    never inherited down a process tree: in.arrow only when there's an input table, out.arrow only when the
      //    tool returns a rectangular value (arrow mode). A files-only op gets neither and uses its own command args.
      const argvExtra: string[] = [];
      if (inner) argvExtra.push(inFile);
      if (resultTable === "arrow") argvExtra.push(outFile);
      const result = await collectComputeTask(runner, {
        command: [...command, ...argvExtra],
        env,
        cwd: dir, // the WORK DIR — declared output paths are relative to it (the Nextflow model)
        timeoutMs,
        signal: ctx.signal,
      });
      if (result.timedOut) throw new Error(`compute.run: '${command[0]}' timed out after ${timeoutMs}ms`);
      if (result.exitCode !== 0) {
        const tail = result.stderr.trim().split("\n").slice(-8).join("\n");
        // exitCode null + a signal = killed (OOM, external SIGTERM, abort), NOT a clean non-zero exit — say so.
        const how = result.exitCode === null ? `was killed by ${result.signal ?? "an unknown signal"}` : `exited ${result.exitCode}`;
        throw new Error(`compute.run: '${command[0]}' ${how}${tail ? `\n${tail}` : ""}`);
      }
      // 3. Arrow IPC result -> a DuckDB table (arrow mode only). A clean exit with no out.arrow is still a failure
      //    (fail closed). Files-only ops (resultTable "artifacts") produce no out.arrow — their table is built below.
      if (resultTable === "arrow") {
        try { await fs.access(outFile); } catch { throw new Error(`compute.run: '${command[0]}' exited 0 but wrote no Arrow output to its output path (argv)`); }
        await ctx.conn.run(`CREATE OR REPLACE TABLE ${p.table} AS SELECT * FROM read_arrow('${outFile.replace(/'/g, "''")}')`);
      }

      // 3b. FILE ARTIFACTS (#3): capture each declared output into CAS, content-addressed. In arrow mode VALUES came
      //     back via Arrow (step 3) while FILES go via CAS — never through the IPC (the nf-r-ipc/Nextflow split). The
      //     capture rules (relative-only, no symlink/non-regular, realpath containment, byte cap, sha256→put) are a
      //     SHARED host invariant, factored into captureDeclaredOutputsToCas so a future compute adapter reuses them.
      const artifacts = await captureDeclaredOutputsToCas({ workDir: dir, outputs, cas: ctx.cas!, maxOutputBytes });

      // 3c. FILES-ONLY result -> the table IS the artifacts listing (one row per captured output). The tool returned
      //     no rectangular value, but its files are now CAS handles the agent can query (digest) and read downstream.
      if (resultTable === "artifacts") {
        await ctx.conn.run(`CREATE OR REPLACE TABLE ${p.table} (name VARCHAR, path VARCHAR, kind VARCHAR, digest VARCHAR, size BIGINT)`);
        for (const a of artifacts) await ctx.conn.run(`INSERT INTO ${p.table} VALUES (?, ?, ?, ?, ?)`, [a.name, a.path, a.kind, a.digest, a.size]);
      }

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
      // input digest pins the SELECT that fed the child; files-only ops have no input, so the mode stands in for it.
      const sqlDigest = `sha256:${createHash("sha256").update(inner ?? `no-input:${resultTable}`).digest("hex")}`;

      // ENVIRONMENT ATTESTATION (C1): declared (the reproduction contract) vs OBSERVED (what actually ran, via the
      // runner's optional probe). An absent or failed probe => an explicit 'unknown' observation — NEVER a fake pin.
      // Recorded BESIDE the compute/artifact provenance (it doesn't disturb cmdDigest).
      let observedEnv: EnvDescriptor | undefined;
      const envNotes: string[] = [];
      if (runner.describeEnvironment) {
        try { observedEnv = await runner.describeEnvironment({ command, env, cwd: dir, timeoutMs, signal: ctx.signal }); }
        catch (e) { envNotes.push(`env probe failed: ${e instanceof Error ? e.message : String(e)}`); }
      }
      const envAttestation = attestEnvironment(
        declaredEnv ? { descriptor: declaredEnv, source: "manifest" } : undefined,
        observedEnv ? { descriptor: observedEnv, source: "process_runner" } : undefined,
        envNotes.length ? envNotes : undefined,
      );
      return {
        result: { mode: "reference", name: p.table, pointer: { uri: `table:${p.table}`, format: "table" } },
        sourceSnapshots: [{ source: `compute:${command[0]}`, version: cmdDigest, retrievedAt: now }],
        provenance: [
          // live_source: the receipt pins the command/input/env but NOT the output table's CONTENT, and a script
          // can be non-deterministic — so without a CAS resultDigest pinning the output, a re-run is not verifiable
          // (reproduce returns not_reproducible rather than a hollow match; roadmap C2 — never fake confidence).
          { source: "compute.run", retrievedAt: now, digest: sqlDigest, notes: ["compute.run", "live_source", `cmd:${command.join(" ")}`, resultTable === "arrow" ? "arrow-ipc" : "files-only"] },
          { source: "environment", retrievedAt: now, digest: envAttestation.declared?.digest ?? envAttestation.observed?.digest,
            notes: ["compute.run", `env_status:${envAttestation.status}`, `env_schema:${ENV_ATTESTATION_SCHEMA}`,
              ...(envAttestation.declared ? [`env_declared:${envAttestation.declared.digest}`] : []),
              ...(envAttestation.observed ? [`env_observed:${envAttestation.observed.digest}`] : []), ...envNotes] },
          // one provenance entry per captured FILE artifact (CAS digest = the receipt's "output digest")
          ...artifacts.map((a) => ({ source: `artifact:${a.name}`, retrievedAt: now, digest: a.digest, notes: ["compute.run", "artifact", a.kind, `path:${a.path}`, `size:${a.size}`] })),
        ],
      };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}
