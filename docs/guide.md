---
type: Guide
title: User guide — write a manifest, run an operation
description: "Practical walkthrough: declare resources/operations as a manifest and run them; resolvers, ordinal scales, grounding, runs, and network."
tags: [guide, manifest, operations, usage]
---

# User guide

You do not write TypeScript to ask a bioinformatics question here. You write a **manifest** — a JSON file that
declares the data you want resolved into tables and the SQL that answers your question — and run an operation
from it. The substrate resolves the resources, runs your SQL, and writes the answer plus a provenance receipt.

## 1. A manifest declares data, not questions

Put a CSV somewhere, say `data/variants.csv`:

```csv
variant_key,consequence,allele_frequency
1:1000:C:T,stop_gained,0.0003
2:2000:G:A,missense,0.3
3:3000:A:G,stop_gained,
```

Then a manifest, `manifest.json`, that declares only **where the data is** — not how to query it:

```json
{
  "schema": "pi-bio.manifest.v1",
  "id": "variants",
  "version": "0.1.0",
  "title": "Variants",
  "description": "Declares a variants table; the agent writes the SQL.",
  "provides": {
    "resolvers": [
      { "id": "duckdb.file_scan", "version": "0.1.0", "title": "DuckDB file scan",
        "description": "Read a DuckDB-native file into a table.", "output": { "mode": "table" } }
    ],
    "resources": [
      { "id": "variants", "title": "Variants", "kind": "virtual", "resolver": "duckdb.file_scan",
        "params": { "path": "data/variants.csv", "table": "variants" } }
    ]
  }
}
```

A **resource** names some data and the **resolver** that turns it into a table; resource `path`s are resolved
relative to the manifest's directory. Note there is **no operation** — declaring one count, one filter, one
threshold per question is overfitting (it is ClawBio skill-sprawl in manifest form). The substrate's bet is
that the agent does schema discovery and writes the SQL.

## 2. Run a query (the agent writes the SQL)

Call the `bio_query` tool: it resolves the manifest's declared resources into tables and runs **your** read-only
SQL over them. First discover the schema, then ask the real question. From the library directly:

```ts
import { runBioQueryFromManifest } from "pi-bio-agent";

// 1. schema discovery — plain SQL over information_schema (the resource is resolved first)
await runBioQueryFromManifest({ cwd: process.cwd(), dbPath: ":memory:", manifestPath: "manifest.json",
  sql: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'variants'" });

// 2. the actual question, written from the discovered columns
const res = await runBioQueryFromManifest({ cwd: process.cwd(), dbPath: ":memory:", manifestPath: "manifest.json",
  sql: "SELECT consequence, count(*) AS n, avg(allele_frequency) AS avg_af FROM variants GROUP BY consequence ORDER BY consequence" });
// res: { ok: true, runId, status: "succeeded", rowCount, artifacts, runDir }
```

Each run is written under `.pi/bio-agent/runs/<runId>/`:

- `result.json` — the answer; `result.rows` is exactly what your SQL returned (there is no separate report).
- `run.json` — the run record (status, events, a digest of the SQL that ran).
- `receipts.json` — one resolution receipt per resolved resource (resolver version, params digest, source snapshot).

A query that fails at runtime (e.g. a missing column) returns `{ ok: false, error, runDir }` and still persists
`run.json` + `receipts.json` — the failure is auditable.

### When to declare an operation

An **operation** is a *pinned, named, versioned, tested* query — the special case worth saving when a query is
subtle, reused, or safety-critical (the flagship "rare high-impact variants" abstention is the canonical
example: getting "unknown frequency ≠ rare" right deserves a tested spec, not re-derivation each time). Declare
it under `provides.operations` and run it with `bio_run_operation` / `runBioOperationFromManifest({ …,
operationId })`. For everything exploratory, prefer `bio_query` — most manifests declare only resources.

## 3. Resolvers (how data becomes a table)

Declare one of the built-in resolvers on a resource and give it `params`. The point of the bet is that most of
these are **SQL all the way down** — even fetching a remote API is a SQL table function, not a `.ts` file:

- `duckdb.file_scan` — `{ path, table }`; reads csv/tsv/parquet/json natively.
- `duckdb.sql_materialize` — `{ table, sql, declaredSources?, extensions? }`; the general resolver:
  `sql` is a read-only query wrapped into a table. This is also the **SQL-native network path**: with the
  `ducknng` extension, `sql` can be `SELECT * FROM ducknng_ncurl_table(<url>, 'GET', …)` where the URL/headers/
  body compose in SQL (`getvariable('q') || url_encode(…)`) and the JSON parses straight into columns — no
  TypeScript at all (the `ols4-grounding` and `variant-annotation` examples are exactly this). A new source —
  local file, `httpfs`/`s3` read, OR an HTTP/JSON API — is usually just this, with no new code.
- `duckhts.read_bcf` — `{ path, region?, table }`; VCF/BCF (region-sliced) via the DuckHTS extension
  (`npm run provision:duckhts` first).
- `process.compute` — `{ table, inputSql, command, env?, timeoutMs? }`; the **compute** escape hatch for what
  SQL is poor at (an `lm()` fit, fine-mapping, a Python model). It exports `inputSql` as Arrow IPC, runs an
  out-of-process child (`["Rscript","./fit.R"]`), and reads its Arrow output back as a table — the *data
  contract* stays SQL/Arrow even though the computation is external. Needs the host to supply a `ProcessRunner`
  (`runBioQueryFromManifest({ …, process: { runner: nodeProcessRunner() } })`); absent, it fails closed.
- `http.get` — `{ url, table, format? }`; the **fallback** HTTP fetch (a TS resolver) for a DuckDB build with no
  `ducknng`, and the seam for the host-driven multi-request retry/fanout over a rate-limited API. Needs the host
  to supply `fetch` (`{ …, network: { fetch: globalThis.fetch } }`); absent, it fails closed.

So the bet holds end to end: **data** and **network** are SQL (table functions); **compute** is the one place
code runs out-of-process, and even there the boundary is SQL/Arrow. The two capability resolvers
(`http.get` ← `fetch`, `process.compute` ← `ProcessRunner`) are host-injected by composition and fail closed
when unbound.

The library is **not a network/filesystem sandbox** — whether a remote read or `httpfs` is possible is your
deployment's decision (container, sandbox, the Pi runtime). The substrate records what ran; the host governs
what may run. A strict "no external I/O" profile is a few lines wrapping the `SqlConn` you inject (see
[design notes](design.md#powerful-by-default-host-controlled-effects-provenance-aware-not-policy-obsessed)).

## 4. Ordinal scales

To threshold or compare on an ordered scale (ACMG, variant impact, clinical stage), declare an `ordered`
`TermSet` with a unique integer `rank` per member. The runner projects every ordered TermSet into a
`scale_members(scale_id, member_id, label, rank)` table your operation SQL can join:

```json
{ "id": "acmg", "title": "ACMG classification", "ordered": true, "members": [
  { "id": "benign", "rank": 0 }, { "id": "likely_benign", "rank": 1 }, { "id": "vus", "rank": 2 },
  { "id": "likely_pathogenic", "rank": 3 }, { "id": "pathogenic", "rank": 4 } ] }
```

```sql
SELECT v.* FROM calls v
JOIN scale_members s   ON s.scale_id = 'acmg' AND s.member_id = v.acmg
JOIN scale_members cut ON cut.scale_id = 'acmg' AND cut.member_id = 'likely_pathogenic'
WHERE s.rank >= cut.rank
```

No per-scale code — swap the TermSet and the same SQL pattern works for any ordered scale.

## 5. Ontologies and grounding

An ontology is the same shape as the knowledge graph: edges in `bio_edges(from_id, predicate, to_id)`, with
`entailed_edge` as their transitive closure, so descendants/subsumption are a single join. Map a term to a
CURIE by exact/synonym match in SQL first; on a miss, a model may propose a candidate from a registered
`TermSet` but never invent a CURIE and abstains below a confidence threshold (`decideGrounding`). See
[ontology and knowledge graphs](ontology-and-knowledge-graphs.md).

## 6. What the substrate refuses

A manifest is validated against a strict allowlist: unknown keys are rejected, not ignored, so cut surface
(`reportKind`, `requiredColumns`, `columnRoles`, …) cannot ride back in as inert config. A query — ad-hoc or a
declared operation — must be a single read-only `SELECT`/`WITH`. Resolvers fail closed when an implementation
is not bound. Everything a query reads, it reads through a resolved resource that leaves a receipt — so a run
is reproducible and every answer has a source path.

## 7. Memory (the CLI)

Memory (notes and skills) is append-only, as-of, attributed observations in the ONE temporal store
(`.pi/bio-agent/store.duckdb`, `agent:memory:<slug>` / `skill:<name>`). Read it provider-agnostically:

```sh
pi-bio-agent memory list                                      # current notes (as of now)
pi-bio-agent memory show <slug> --as-of 2026-07-01T00:00:00Z  # time-travel: what memory said then
pi-bio-agent memory history <slug>                            # what changed, when, by whom
```

Notes are mutable procedural memory and retrieval hooks — not authoritative facts. Measured facts live in
resources, tables, and provenance-bearing observations. (The prior `notes sync/report` command, which projected
file notes into a separate `graph.duckdb`, is superseded by memory-as-observations in the one store.)
