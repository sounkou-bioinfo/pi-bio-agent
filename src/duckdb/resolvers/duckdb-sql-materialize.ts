import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { validateReadOnlySelect } from "../../core/sql-guard.js";
import type { BioResolverImpl, ResolverOutput } from "../../core/ports.js";
import { memoLookup, memoStore } from "../resolution-memo.js";

// The general resolver: materialization is DECLARED SQL, not bespoke TypeScript. This is the anti-sprawl
// endpoint — a new source is a manifest with declared SQL + declaredSources, never a new .ts file. It
// subsumes file_scan / read_bcf / an httpfs read uniformly, because `params.sql` is just a read-only query
// over whatever DuckDB can reach: read_csv_auto / read_parquet / read_bcf over a LOCAL path OR an httpfs/s3
// URL. Egress is the host's decision (sandbox/seccomp/Pi), not ours; we run the SQL and record it.
//
// params: { table, sql, declaredSources?, extensions? }
//   table           the table this materializes (its identity); a valid SQL identifier
//   sql             a single read-only SELECT/WITH (validated); wrapped into CREATE OR REPLACE TABLE table AS sql
//   declaredSources URIs the SQL intends to read — recorded as source snapshots (the manifest declares them;
//                   core cannot reliably parse them out of arbitrary SQL)
//   extensions      DuckDB extensions to LOAD first (LOAD only, never INSTALL — fail closed if unprovisioned)
//
// The registry stamps paramsDigest over all of params, so the exact SQL is already pinned in the receipt.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const duckdbSqlMaterializeResolver: BioResolverImpl = async (resource, ctx) => {
  const p = resource.params as { table?: unknown; sql?: unknown; declaredSources?: unknown; extensions?: unknown };
  if (typeof p.table !== "string" || !IDENT.test(p.table)) throw new Error("duckdb.sql_materialize requires params.table to be a valid SQL identifier");
  if (typeof p.sql !== "string" || !p.sql.trim()) throw new Error("duckdb.sql_materialize requires params.sql (a single read-only SELECT/WITH)");
  const inner = validateReadOnlySelect(p.sql); // single read-only query; remote/httpfs reads are allowed (host controls egress)
  // Fail closed, not silently drop: a non-string entry would otherwise lose LOAD intent / provenance.
  const stringArray = (v: unknown, label: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`duckdb.sql_materialize: ${label} must be an array of strings`);
    return v;
  };
  const extensions = stringArray(p.extensions, "extensions");
  const declaredSources = stringArray(p.declaredSources, "declaredSources");

  // Memoization: only when EVERY declared source is a local statable file — then those files' freshness, plus
  // the SQL, fully determine the table, so an unchanged set is a safe cache hit. Empty or any remote/unstatable
  // source -> no token (always re-resolve), because we cannot cheaply validate freshness of what we did not see.
  let freshness: string | undefined;
  if (declaredSources.length > 0 && declaredSources.every((s) => !s.includes("://"))) {
    try {
      const parts = declaredSources.map((s) => {
        const path = s.startsWith("file:") ? s.slice(5) : s;
        const st = statSync(path);
        return `${path}:${st.mtimeMs}:${st.size}`;
      });
      freshness = `sql_materialize:${createHash("sha256").update(inner).digest("hex")}:${parts.sort().join("|")}`;
    } catch {
      freshness = undefined; // a declared source not statable -> no memo
    }
  }
  if (freshness !== undefined) {
    const hit = await memoLookup(ctx.conn, p.table, freshness);
    if (hit) return hit; // sources + SQL unchanged, table present: replay the receipt, skip LOAD + materialize
  }

  for (const ext of extensions) {
    if (!IDENT.test(ext)) throw new Error(`duckdb.sql_materialize: invalid extension name '${ext}'`);
    await ctx.conn.run(`LOAD ${ext}`); // LOAD only; fails closed if the host has not provisioned it
  }
  await ctx.conn.run(`CREATE OR REPLACE TABLE ${p.table} AS ${inner}`);

  const now = ctx.now ?? new Date().toISOString();
  const sqlDigest = `sha256:${createHash("sha256").update(inner).digest("hex")}`;
  const output: ResolverOutput = {
    // the handle identifies the materialized table; we have no byte digest (the SQL/sources are the provenance)
    result: { schema: "pi-bio.resource_handle.v1", mode: "reference", name: p.table, pointer: { uri: `table:${p.table}`, format: "table" } },
    sourceSnapshots: declaredSources.map((source) => ({ source, retrievedAt: now })),
    provenance: [{ source: "duckdb.sql_materialize", retrievedAt: now, digest: sqlDigest, notes: ["sql_materialize", ...extensions.map((e) => `ext:${e}`)] }],
  };
  if (freshness !== undefined) await memoStore(ctx.conn, p.table, freshness, output);
  return output;
};
