
<!-- README.md is generated from README.Rmd — please edit that file, then `npm run readme:rmd`. -->
<!-- The `pi` chunks run a LIVE Pi agent; the `biocli` chunks run the built CLI. Rendering needs a built `dist/` and (for `pi`) a model. -->

# pi-bio-agent

[![CI](https://github.com/sounkou-bioinfo/pi-bio-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/sounkou-bioinfo/pi-bio-agent/actions/workflows/ci.yml)
[![License: GPL
v2+](https://img.shields.io/badge/License-GPL%20v2%2B-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

A lean, provider-agnostic **bioinformatics substrate for Pi agents**.
You point an agent at a manifest; it does schema discovery, writes its
own read-only SQL over your data, and answers. Every run is recorded and
reproducible, and the whole thing runs on your own infrastructure. Not a
hosted product. A substrate.

## See it

Point a live Pi agent at a manifest and ask in plain English. It writes
the SQL itself (we never hand it the query), runs it through the
substrate, and answers. A real transcript, produced live when this
README renders:

``` sh
pi --model gpt-5.3-codex-spark -e extensions/pi-coding-agent/index.ts -p \
  "How many variants of each consequence are in " \
  "examples/variant-counts/manifest.json? Answer with a " \
  "short table."
```

> Here are the variant counts by consequence in
> `examples/variant-counts/manifest.json`:
>
> | consequence | variants |
> |-------------|----------|
> | missense    | 2        |
> | stop_gained | 2        |
> | synonymous  | 1        |

That is the agent doing schema discovery and composing a `GROUP BY`, not
returning a canned answer.

## The bet

**Manifests, SQL, resources, and ontology data are the PROGRAM;
TypeScript is only the interpreter.** Everything reduces to *data plus
an injected effect port*, so every layer is a plug:

- a new **question** is a manifest and SQL, never a new `.ts`;
- a new **data format** is a *DuckDB extension* (`duckhts`, `anndata`,
  `duckdb_zarr`, `plinking_duck`, …);
- a new **API** is an `ncurl_table` call over
  **[ducknng](https://github.com/sounkou-bioinfo/ducknng)**, our owned,
  community-signed, Arrow-native NNG transport;
- a new **compute backend** (SLURM, Modal, an NNG pool) is one injected
  `JobDispatch`;
- a new **model** is an injected judge.

The interpreter stays thin; the agent writes the SQL.

## How it works

A manifest declares named **resources**; a **resolver** turns each into
a DuckDB table and stamps a **receipt** (resolver version, params
digest, source snapshot). An **operation** is a single read-only
`SELECT`/`WITH` over those tables, and whatever it returns *is* the
result. There is no separate report layer. Four legs, all SQL over one
DuckDB:

| leg                    | one primitive, open surface                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Data**               | `duckdb.sql_materialize`: any read-only query over everything DuckDB reaches (local files, object stores, other DBs, lakes). A new format is a DuckDB *extension*, not new code: VCF/BAM ([`duckhts`](https://duckdb.org/community_extensions/extensions/duckhts)), single-cell ([`anndata`](https://duckdb.org/community_extensions/extensions/anndata)), [`duckdb_zarr`](https://duckdb.org/community_extensions/extensions/duckdb_zarr), [`plinking_duck`](https://duckdb.org/community_extensions/extensions/plinking_duck), even HTML or git history. |
| **Network**            | `ducknng_ncurl_table`: an HTTP endpoint *is* a table function, URL/headers/body composed in SQL and JSON parsed into columns, no TypeScript. Plus `ducknng_run_rpc` (a live DB many processes write through) and NNG worker pools (push/pull, pub/sub, survey). `http.get` is the fallback where a build lacks ducknng.                                                                                                                                                                                                                                    |
| **Compute**            | `process.compute`: what SQL is poor at (an `lm()` fit, a model) runs out-of-process over Arrow IPC. Only the data contract is SQL/Arrow; the computation is a contained child, not FFI.                                                                                                                                                                                                                                                                                                                                                                    |
| **Knowledge + memory** | one SemanticSQL graph (`bio_edges` + its `entailed_edge` closure), so subsumption and graph-walks are one indexed join. Grounding runs deterministically first, abstains below threshold, and never invents a CURIE. Memory is *study notes* projected into the same graph, not prompt-stuffed context that rots.                                                                                                                                                                                                                                          |

**The spine.** Facts, memory, `job:<id>:status`, and runs are not
separate systems. They are rows in one append-only `bio_observations`
ledger, read *as of* a time, over the same graph. So “the current fact,”
“what did the agent learn,” and “what was this job’s status at t” are
one query over one DB. On that spine sits a **governance loop**
(`declare → validate → test → record → activate → rollback`) with a
durable, fail-closed approval gate: the substrate *records and gates*
the one irreducible human-or-model judgment, it never computes it.

**The boundary.** Capability resolvers are host-injected and **fail
closed** when unbound: no `fetch` means `http.get` is off, no
`ProcessRunner` means `process.compute` is off. The substrate enforces
statement class (read-only, no DDL), manifest shape, and receipt
integrity, but it is *not* a network or filesystem sandbox. **The
library records what ran; the host decides what may run.** The [design
notes](docs/design.md) go deeper.

## More, live

**The agent over live ClinVar.** Point it at
[`clinvar-region.json`](examples/connectors/clinvar-region.json) and it
reads a ClinVar VCF region straight over HTTP with `duckhts` (an htslib
tabix range read of just the TP53 locus, not the whole file), discovers
that `INFO_CLNSIG` is an array, and writes its own `UNNEST` +
`GROUP BY`. Live when this README renders. Unlike the zero-config block
above, this one is **host-provisioned**: it needs
`npm run provision:duckhts` and a host that permits `duckhts`’s HTTP
range reads (DuckDB-native egress, the host’s boundary):

``` sh
pi --model gpt-5.3-codex-spark -e extensions/pi-coding-agent/index.ts -p \
  "Using examples/connectors/clinvar-region.json, how many " \
  "ClinVar variants are there of each clinical significance " \
  "in that region? Show the SQL you wrote and the top few " \
  "rows."
```

> Used `examples/connectors/clinvar-region.json` and queried `clinvar`
> like this:
>
> ``` sql
> SELECT
>   sig AS clinical_significance,
>   COUNT(*) AS variant_count
> FROM clinvar
> CROSS JOIN UNNEST(INFO_CLNSIG) AS u(sig)
> GROUP BY sig
> ORDER BY variant_count DESC;
> ```
>
> **Top few rows (descending):**
>
> | clinical_significance                        | variant_count |
> |----------------------------------------------|--------------:|
> | Pathogenic                                   |          3593 |
> | Conflicting_classifications_of_pathogenicity |          2918 |
> | Likely_benign                                |          2891 |
> | Uncertain_significance                       |          2445 |
> | Benign                                       |           704 |
>
> **Full counts:**
>
> - Pathogenic: 3593  
> - Conflicting_classifications_of_pathogenicity: 2918  
> - Likely_benign: 2891  
> - Uncertain_significance: 2445  
> - Benign: 704  
> - Likely_pathogenic: 263  
> - Pathogenic/Likely_pathogenic: 226  
> - Benign/Likely_benign: 94  
> - not_provided: 49  
> - no_classification_for_the_single_variant: 2  
> - no_classifications_from_unflagged_records: 1

The **same query with no agent**, the deterministic CLI path for scripts
and CI. Identical numbers, no model in the loop:

``` sh
pi-bio-agent query examples/connectors/clinvar-region.json \
  --db :memory: \
  --init-sql "LOAD duckhts;" \
  --sql "SELECT sig, count(*) n FROM (SELECT unnest(INFO_CLNSIG) sig FROM clinvar) WHERE sig IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 8"
```

``` json
{
  "ok": true,
  "runId": "query-1783033188008-35a6d042",
  "status": "succeeded",
  "rowCount": 8,
  "artifacts": {
    "run": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1783033188008-35a6d042/run.json",
    "result": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1783033188008-35a6d042/result.json",
    "receipts": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1783033188008-35a6d042/receipts.json"
  },
  "runDir": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1783033188008-35a6d042",
  "rows": [
    {
      "sig": "Pathogenic",
      "n": 3593
    },
    {
      "sig": "Conflicting_classifications_of_pathogenicity",
      "n": 2918
    },
    {
      "sig": "Likely_benign",
      "n": 2891
    },
    {
      "sig": "Uncertain_significance",
      "n": 2445
    },
    {
      "sig": "Benign",
      "n": 704
    },
    {
      "sig": "Likely_pathogenic",
      "n": 263
    },
    {
      "sig": "Pathogenic/Likely_pathogenic",
      "n": 226
    },
    {
      "sig": "Benign/Likely_benign",
      "n": 94
    }
  ]
}
```

**The run graph is itself a table.** Every run above was recorded. When
a host wires in the temporal store, the authoritative record is a
`run:<id>` fact in `bio_observations` that references the result,
receipts, and replay by digest (bytes in CAS); the per-run `run.json` /
`receipts.json` / `result.json` are its always-written legible *view*.
[`run-ledger`](examples/run-ledger/manifest.json) reads that view back
with DuckDB `read_json`, so the substrate’s own provenance is queryable
with the same SQL it uses for data. This is the live run graph produced
*by this very render*:

``` sh
pi-bio-agent query examples/run-ledger/manifest.json \
  --db :memory: \
  --sql "SELECT tool, status, count(*) n FROM run_ledger GROUP BY 1, 2 ORDER BY n DESC"
```

``` json
{
  "ok": true,
  "runId": "query-1783033190574-c41d3f55",
  "status": "succeeded",
  "rowCount": 4,
  "artifacts": {
    "run": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1783033190574-c41d3f55/run.json",
    "result": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1783033190574-c41d3f55/result.json",
    "receipts": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1783033190574-c41d3f55/receipts.json"
  },
  "runDir": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1783033190574-c41d3f55",
  "rows": [
    {
      "tool": "ad-hoc.query",
      "status": "succeeded",
      "n": 3009
    },
    {
      "tool": "ad-hoc.query",
      "status": "failed",
      "n": 139
    },
    {
      "tool": "rare_high_impact.report",
      "status": "succeeded",
      "n": 65
    },
    {
      "tool": "counts.by_consequence",
      "status": "succeeded",
      "n": 1
    }
  ]
}
```

Because the graph is a table, a chart is a query and a UI is a thin SQL
client: a grammar-of-graphics layer like posit’s
[ggsql](https://github.com/posit-dev/ggsql) draws the run timeline
straight off `run_ledger`.

**Distributed compute is a topology over that same ledger.** Multi-agent
coordination is transport, not a framework: a coordinator owns the
shared job ledger, and a *separate worker process* runs the job and
reports each phase (`running` → `succeeded`) over `ducknng_run_rpc` into
the `job:<id>:status` slot the coordinator polls, which reads it back
with the same `observationAsOfKey`. The worker can be any language that
speaks NNG (Node here, or R via `nanonext`/`mirai`). This is the
“AI-for-science” distributed backend as a *topology over data-in-SQL* on
our owned transport, with status as inspectable data rather than opaque
runtime state. Real separate processes, live when this README renders
(the push/pull, pub/sub, and survey topologies are exercised the same
way in [`scripts/`](scripts/) and [`test/`](test/)):

``` sh
node scripts/nng-job-runner.mjs
```

    === JobRunner NNG compute profile: a remote worker reports job status over ducknng RPC into the L1 slot ===

      [coordinator pid 2995474] shared job ledger up; wgs-annotate-chr22 recorded queued
      [worker nng-worker-1 pid 2995553] reported running over ducknng RPC
      [worker nng-worker-1 pid 2995553] reported succeeded over ducknng RPC
      [coordinator] wgs-annotate-chr22 FINAL status (reported by a SEPARATE worker process over ducknng RPC): "succeeded"

    What it proves: a long-running job's status (running -> succeeded) was written by a SEPARATE worker
    process into the coordinator's job:<runId>:status slot over ducknng RPC — and read back by the SAME
    L1 observationAsOfKey. The job-store did not change; the worker is language-agnostic (node/R/python).
    This is the native distributed-compute backend for the JobRunner over our owned NNG transport.

**A database connector is a manifest, not a client.** The “60+ connected
databases” a hosted workbench advertises are, here, one file each:
[`examples/connectors/`](examples/connectors/) ships UniProt, RCSB PDB,
MyGene, and Reactome, and a new one is a new URL. The manifest declares
*where* the data is; the agent discovers the schema and composes *what*
to pull:

``` sh
pi-bio-agent query examples/connectors/uniprot.json \
  --db :memory: \
  --init-sql "LOAD ducknng; SET VARIABLE tls = ducknng_tls_config_from_pem(NULL, NULL, NULL, '', 1)" \
  --bindings '{"uniprot_acc":"P04637"}' \
  --sql "SELECT primaryAccession, uniProtkbId, sequence.length aa FROM uniprot_entry"
```

``` json
{
  "ok": true,
  "runId": "query-1783033197243-18d14610",
  "status": "succeeded",
  "rowCount": 1,
  "artifacts": {
    "run": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1783033197243-18d14610/run.json",
    "result": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1783033197243-18d14610/result.json",
    "receipts": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1783033197243-18d14610/receipts.json"
  },
  "runDir": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1783033197243-18d14610",
  "rows": [
    {
      "primaryAccession": "P04637",
      "uniProtkbId": "P53_HUMAN",
      "aa": 393
    }
  ]
}
```

Every [example](examples/) carries a recorded, verified run, and
`npm run check` fails if one drifts.

## Why a substrate, not a hosted product

The hosted “AI for science” workbenches (e.g. [Claude
Science](https://www.anthropic.com/news/claude-science-ai-workbench))
ship the same primitives: auditable, reproducible artifacts, on-demand
compute, dozens of connected databases, reviewer agents. We arrived at
that spine independently. The difference is what it runs *on*:

|                 | a hosted workbench                    | **pi-bio-agent**                                                                                                                 |
|-----------------|---------------------------------------|----------------------------------------------------------------------------------------------------------------------------------|
| the program     | agent-orchestrated code               | a **manifest + SQL**; a new question is a new manifest, zero new `.ts`                                                           |
| reproducibility | “keep the exact code and environment” | content-addressed receipts + an as-of ledger; a re-run **matches by content**, and a count is a `GROUP BY`, not re-executed code |
| where it runs   | a vendor’s cloud                      | **your** laptop, cluster, or HPC; an importable library + CLI where the host owns effects and egress                             |
| trust model     | a model-based reviewer                | **fail-closed determinism**: strict-allowlist manifests, a read-only SQL guard, grounding that abstains                          |

Same destination; we own the road. A UI is a thin client over the
CLI/SDK. See [what the substrate closes over](docs/closes-over.md) for
the agent-topology, Fugu, and RLM argument.

**And the agent reads and writes these too.** The package ships its
`examples/`, `docs/`, and every manifest, so an installed agent has the
whole corpus on disk: it reads a connector to learn the pattern, then
authors a new one itself. A new database, MCP server, or HTS source is a
*file the agent writes*, not a feature request. Read → compose →
validate → run → keep.

## Install in Pi

``` sh
pi install git:github.com/sounkou-bioinfo/pi-bio-agent
/reload
```

## Pi tools

The `pi-coding-agent` extension registers these tools over the
substrate. This list is generated from the extension’s `registerTool()`
calls (`npm run readme:tools`); `npm run check` fails if it drifts.

<!-- BEGIN GENERATED:tools (scripts/generate-readme-tools.mjs — do not edit by hand) -->
- `bio_describe_model` — Describe Pi Bio model
- `bio_run_operation` — Run a bio operation
- `bio_query` — Run an ad-hoc bio query
- `bio_list_duckdb_extensions` — List bio DuckDB extensions
- `bio_validate_select` — Validate bio SQL SELECT
- `bio_create_skill` — Create bio skill
- `bio_study_plan` — Plan bio study
- `bio_remember` — Remember (memory note)
- `bio_list_memory` — List memory
- `bio_walk_memory` — Walk bio memory graph
- `bio_recall` — Recall memory note
- `bio_forget` — Forget memory note
<!-- END GENERATED:tools -->

Project-local skills and the memory store live under `.pi/bio-agent/` in
the current project.

## CLI

The substrate is provider-agnostic; you do not need Pi to use it.
`query` and `run` execute a manifest through the **same** host functions
the Pi extension uses, and both are fail-closed by default (the
`http.get` fetch and the `process.compute` runner stay unbound unless
the host injects them). Results print as JSON; a failed run exits `1`, a
usage error exits `2`.

``` sh
# run the agent's ad-hoc SQL over a manifest's declared resources
pi-bio-agent query examples/variant-counts/manifest.json --db :memory: \
  --sql "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence"

# run a declared, tested operation
pi-bio-agent run examples/rare-high-impact/manifest.json --db :memory: --operation rare_high_impact.report

# memory is append-only, as-of, attributed observations in the ONE store (agent:memory: in bio_observations)
pi-bio-agent memory list
pi-bio-agent memory show <slug> --as-of 2026-07-01T00:00:00Z   # time-travel: what memory said then
pi-bio-agent memory history <slug>                            # what changed, when, by whom
```

## As a library (SDK)

``` ts
import { runBioQueryFromManifest } from "pi-bio-agent";          // whole surface
import { validateBioManifest } from "pi-bio-agent/core";         // core contracts
import { duckdbNodeConn } from "pi-bio-agent/duckdb";            // DuckDB adapters
import { fsCasStore, ledgerJobRunner } from "pi-bio-agent/hosts"; // host helpers

const out = await runBioQueryFromManifest({
  cwd: process.cwd(), dbPath: ":memory:", manifestPath: "manifest.json",
  sql: "SELECT * FROM variants LIMIT 5",
});
```

Host effects are injected by composition (a `fetch` for `http.get`, a
`ProcessRunner` for `process.compute`, a `JobDispatch` for a distributed
`JobRunner`), and each **fails closed** when unbound. The bin compiles
to `dist/` via `npm run build`; the package also ships `src` for Pi to
consume directly.

## Docs

New here? Start with the [user guide](docs/guide.md): write a manifest,
run an operation. For the why, see the [design notes](docs/design.md)
and the [roadmap](docs/roadmap.md). The full [docs index](docs/INDEX.md)
is generated from each doc’s frontmatter (`npm run docs:index`).

## References & lineage

The primitives here are discovered, not invented; [what the substrate
closes over](docs/closes-over.md) makes that argument with citations.
Prior art and lineage:

- **ClawBio**, the origin corpus this factors (“ClawBio for free”):
  <https://github.com/ClawBio/ClawBio>
- **Machine studying** (Li, Battle, Khattab, 2026):
  <https://jacobxli.com/blog/2026/machine-studying/>
- **Sakana Fugu** (learned orchestration; we own the substrate it
  conducts): <https://sakana.ai/fugu/>
- **Recursive Language Models / RLM** (REPL-over-context; `bio_query` is
  the SQL REPL): <https://arxiv.org/abs/2512.24601>
- **ducknng**, our owned Arrow-native NNG transport, in the lineage of
  R’s `nanonext` + `mirai`: <https://github.com/sounkou-bioinfo/ducknng>
  · [NNG](https://nng.nanomsg.org/) ·
  [`nanonext`](https://github.com/r-lib/nanonext) ·
  [`mirai`](https://mirai.r-lib.org/)
- **SemanticSQL** (the `bio_edges` + `entailed_edge` graph shape):
  <https://github.com/INCATools/semantic-sql>
- Design thread (sounkou-bioinfo × Manuel):
  [LinkedIn](https://www.linkedin.com/feed/update/urn:li:activity:7473824764575436800)

## Development

``` sh
npm install
npm run check     # typecheck + tests + docs/readme/examples staleness gates (the single gate)
```

`npm run provision:duckhts` installs the DuckHTS community extension for
the `duckhts.read_bcf` resolver (explicit; never auto-installed during
`check`). Runtime Pi APIs are peer dependencies supplied by Pi itself.

## Status & contributing

Pre-1.0 (`0.1.0`). The substrate shape is settled (see the
[roadmap](docs/roadmap.md)) but the public API may still move. Issues
and PRs welcome; `npm run check` is the single gate and CI runs it on
every push. Please keep changes fail-closed and manifest/SQL-first: new
capability should enter as a manifest, a resolver adapter, or SQL, not
as bespoke core code.

## License

[GPL-2.0-or-later](LICENSE) © sounkou-bioinfo
