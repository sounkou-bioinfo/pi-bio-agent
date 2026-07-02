
<!-- README.md is generated from README.Rmd — please edit that file, then `npm run readme:rmd`. -->
<!-- The `pi` chunks run a LIVE Pi agent; the `biocli` chunks run the built CLI. Rendering needs a built `dist/` and (for `pi`) a model. -->

# pi-bio-agent

[![CI](https://github.com/sounkou-bioinfo/pi-bio-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/sounkou-bioinfo/pi-bio-agent/actions/workflows/ci.yml)
[![License: GPL
v2+](https://img.shields.io/badge/License-GPL%20v2%2B-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

> **The entire “AI for science” workbench — reproducible artifacts,
> dozens of connected databases, on-demand *distributed* compute,
> grounded review — as an open, deterministic, SQL-native library you
> run on your own infrastructure. Not a hosted product. A substrate.**

Lean, provider-agnostic bioinformatics **substrate** for Pi agents — not
a pile of bespoke genomics scripts.

The bet: **manifests, SQL, resources, and ontology data are the PROGRAM;
TypeScript is only the interpreter.** Everything reduces to *data + an
injected effect port*, so every layer is just a plug:

- a new **question** is a *manifest* + SQL — never a new `.ts`;
- a new **data format** is a *DuckDB extension* (`duckhts`, `anndata`,
  `duckdb_zarr`, `plinking_duck`, …);
- a new **API** is an `ncurl_table` call over
  **[ducknng](https://github.com/sounkou-bioinfo/ducknng)** — our owned,
  community-signed, Arrow-native NNG transport: HTTP-as-SQL,
  cross-process shared-DB RPC, and **distributed worker pools**
  (push/pull, pub/sub, survey) with workers in R (`nanonext`/`mirai`),
  Python (`pynng`), or node;
- a new **compute backend** (SLURM, Modal, an NNG pool) is one injected
  `JobDispatch` — the library ships the primitive, you bring the
  backend;
- a new **model** is an injected judge. The interpreter stays thin; the
  agent writes the SQL.

## How it works

A **manifest** declares named *resources*; a **resolver** turns each
into a DuckDB table and stamps a *receipt* (resolver version, params
digest, source snapshot). An **operation** is a single read-only
`SELECT`/`WITH` over those tables — whatever it returns *is* the result;
there is no separate report layer. The bet stands on **four legs, all
SQL over one DuckDB substrate**:

### 1. Data — anything DuckDB can read

`duckdb.sql_materialize` is the one primitive: any read-only query over
everything DuckDB reaches — local files (csv/tsv/parquet/json), object
stores (httpfs/s3), other databases, lakes. `duckdb.file_scan` and
`duckhts.read_bcf` are just conveniences over it. **The format surface
is open**: a new format is a new DuckDB *extension*, not new library
code — HTS/VCF/BAM
([`duckhts`](https://duckdb.org/community_extensions/extensions/duckhts)),
single-cell AnnData
([`anndata`](https://duckdb.org/community_extensions/extensions/anndata)),
Zarr
([`duckdb_zarr`](https://duckdb.org/community_extensions/extensions/duckdb_zarr)),
PLINK
([`plinking_duck`](https://duckdb.org/community_extensions/extensions/plinking_duck))
— and the surface is not even bio: HTML/XML/web
([`duckdb_webbed`](https://github.com/teaguesterling/duckdb_webbed)),
Markdown
([`duckdb_markdown`](https://github.com/teaguesterling/duckdb_markdown)),
source-code ASTs across 27 languages
([`sitting_duck`](https://github.com/teaguesterling/sitting_duck)), and
git history
([`duck_tails`](https://github.com/teaguesterling/duck_tails)) all
become tables too. You bring the format; DuckDB’s full reach and its
(fast-growing) community-extension ecosystem *are* the data layer.
Source code **and** its edit history as SQL is, incidentally, a
*codebase knowledge graph over edits* — the same substrate pointed at
itself, one more resolver away.

### 2. Network — HTTP *as SQL*, via the owned **ducknng** extension

- `ducknng_ncurl_table` — an HTTP endpoint *is* a table function:
  URL/headers/body composed in SQL (`getvariable` + `url_encode`), JSON
  parsed straight into columns, **no bespoke TypeScript**.
- `ducknng_run_rpc` — a live DuckDB that many processes write through
  (shared mutable state).
- NNG topologies (push/pull, pub/sub, survey, bus, pair) — multi-agent
  coordination as transport.
- `http.get` (host-supplied `fetch`) is the fallback where a DuckDB
  build lacks ducknng; rate-limited multi-request fanout lives in one
  host helper — the single seam a DuckDB table-function limit forces out
  of pure SQL.

### 3. Compute — out-of-process, over Arrow IPC

`process.compute` runs an external computation (R/Python/Go/shell): a
table is exported as Arrow, the child computes what SQL is poor at (an
`lm()` fit, a model), and the result reads back as a table. Only the
*data contract* is SQL/Arrow — the computation is a contained child, not
FFI.

### 4. Knowledge + memory — one SQL graph

Ontologies **and** our own KG share one shape
([SemanticSQL](https://github.com/INCATools/semantic-sql)):
`bio_edges(from_id, predicate, to_id)` + its `entailed_edge` transitive
closure, so subsumption, descendants, and graph-walks are a single
indexed join. Grounding a term runs **deterministically first**
(exact/synonym match + closure, all SQL) and falls back to a model only
on a miss — which may propose a candidate but **never invents a CURIE**
and abstains below a confidence threshold. Ordered TermSets become a
`scale_members` rank table (ACMG, variant impact, clinical stage).
**Memory is machine studying** ([in this
sense](https://jacobxli.com/blog/2026/machine-studying/)): the agent
retains what it learns as *study notes* projected into the same graph —
addressable data it queries, distinct from *skills* (activated behavior)
and *facts* (measured, tool-derived, provenanced). Not prompt-stuffed
context that rots.

### The spine — one temporal graph, and a governance loop

Facts, memory, and compute status are not three systems — they are rows
in **one append-only observation ledger** (`bio_observations`), read *as
of* a time. A `variant:X:classification`, a coloc `PP.H4`, a
`job:<id>:status`, an activation are the same shape; ontologies and the
KG are the same graph (`bio_edges` + `entailed_edge`). So *“the current
fact,”* *“what did the agent learn,”* and *“what was this job’s status
at t”* are **one query over one DB**.

On that spine sits a **governance loop** for safely changing what the
agent can do: **declare → validate → test → record → activate →
rollback**, every step a temporal observation. Activation is **durable
and gated** — a candidate can be *parked* (`approval = pending`) and
decided later across a restart, the decision is terminal and
fail-closed, and the **approval itself, the one irreducible
human-or-model judgment, is *recorded and gated* by the substrate, never
computed by it**. Reproducibility (`reproduceRun()`), long-running jobs,
and this governance loop all ride the same temporal graph — the DB *is*
the audit trail.

### Runs & receipts

Capability resolvers are **host-injected by composition and fail
closed** when unbound: no `fetch` → `http.get` is off; no
`ProcessRunner` → `process.compute` is off. A run bundles the result
with its run record and the resolver receipts — *a failed run still
leaves an auditable receipt* — under `.pi/bio-agent/runs/<runId>/`.
Manifests pass a strict **key** allowlist (unknown keys are rejected;
each resolver validates its own opaque `params`), so cut surface can’t
ride back in as inert keys.

### Trust boundary

The substrate is deliberately thin: it enforces statement class
(read-only, no DDL), manifest shape, and receipt integrity, but it is
**not** a network or filesystem sandbox. DuckDB’s remote reads,
replacement scans, and extensions are features; whether egress is
possible is the host’s call (container, seccomp, the Pi runtime). **The
library records what ran; the host decides what may run.**

TypeScript is only the interpreter that binds these host effects — a new
bio question is a manifest and some SQL, not a new `.ts` file.

## Why a substrate, not a hosted workbench

The hosted “AI for science” workbenches (e.g. [Claude
Science](https://www.anthropic.com/news/claude-science-ai-workbench))
ship the same primitives we do — auditable/reproducible artifacts,
on-demand compute, dozens of connected databases, reviewer agents. We
arrived at that spine independently — convergent design on primitives
that are discovered, not invented. We owe them nothing; the overlap only
confirms the substrate is real. The difference is what it runs *on*:

|                      | a hosted AI-science workbench         | **pi-bio-agent**                                                                                                                                                                                                                                                                                                                                                                  |
|----------------------|---------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| the program          | agent-orchestrated code               | a **manifest + SQL** — data, not code; a new question is a new manifest, zero new `.ts`                                                                                                                                                                                                                                                                                           |
| reproducibility      | “keep the exact code + environment”   | **content-addressed receipts + a deterministic `receiptContentDigest` + an as-of temporal ledger** — a re-run *matches by content*, and counting is a `GROUP BY`, not re-executed code                                                                                                                                                                                            |
| where it runs        | a vendor’s cloud                      | **your** laptop / cluster / HPC — an importable library + CLI; the host owns effects and egress (“the library records what ran; the host decides what may run”)                                                                                                                                                                                                                   |
| compute distribution | SSH-to-HPC / Modal                    | a **topology over data-in-SQL** — ducknng NNG `push`/`pull`, with status flowing back into the same job ledger; workers in **R (`nanonext`/`mirai`), Python (`pynng`), or node**                                                                                                                                                                                                  |
| agent patterns       | one coordinating agent + actor-critic | **agent topologies** — push/pull, pub/sub, survey/debate as **tested** primitives (`test/`), plus proposer↔verifier `pair` and a multi-provider survey jury as runnable **demos** (`scripts/`); the whole NNG socket family (req/rep, bus, …) is reachable via ducknng; *closes over* Fugu (workflow-as-data + CAS shared memory) and RLM (SQL-REPL over context, no context rot) |
| trust model          | a model-based reviewer                | **fail-closed determinism** — strict-allowlist manifests, a read-only SQL guard, grounding that abstains and never invents a CURIE                                                                                                                                                                                                                                                |
| openness             | a closed product                      | **open, deterministic, inspectable** — each row above is shipped code with tests in `test/`, and a docs-conformance check keeps these docs matching the code                                                                                                                                                                                                                      |

Same destination; we own the road. A hosted product adds features on top
of an opaque runtime — we own the substrate those features are
approximations of. (And yes, a UI is just a thin client over the CLI/SDK
— the substrate is real without one.)

## Demonstration

Every block below is runnable, and the output is **real** — the same
literate-programming discipline that keeps [the example docs](examples/)
from drifting (each example records a verified run; `npm run check`
fails if one goes stale).

**The agent speaks.** Point a live Pi agent at a manifest and ask in
plain English — it does schema discovery, **writes its own read-only
SQL** (we never hand it the query), runs it through the substrate, and
answers. This is a real transcript, produced live when this README is
rendered:

``` sh
pi --model gpt-5.3-codex-spark -e extensions/pi-coding-agent/index.ts -p \
  "How many variants of each consequence are in " \
  "examples/variant-counts/manifest.json? Answer with a " \
  "short table."
```

> Here’s the count by consequence:
>
> | Consequence | Number of variants |
> |-------------|-------------------:|
> | missense    |                  2 |
> | stop_gained |                  2 |
> | synonymous  |                  1 |

**Going bigger — the agent over live ClinVar.** Point it at
[`clinvar-region.json`](examples/connectors/clinvar-region.json) and it
reads a **ClinVar VCF region straight over HTTP with `duckhts`** (an
htslib tabix range read — only the TP53 locus, not the whole file),
*discovers the schema*, finds `INFO_CLNSIG` is an array, and writes its
**own** `UNNEST` + `GROUP BY`. This is a **live agent run**, produced
when this README is rendered (a small fast model keeps it to ~20s, not
minutes — the reads are ~2s; the rest was model latency):

``` sh
pi --model gpt-5.3-codex-spark -e extensions/pi-coding-agent/index.ts -p \
  "Using examples/connectors/clinvar-region.json, how many " \
  "ClinVar variants are there of each clinical significance " \
  "in that region? Show the SQL you wrote and the top few " \
  "rows."
```

> Using `examples/connectors/clinvar-region.json` (ClinVar TP53 region),
> I ran:
>
> ``` sql
> SELECT
>   unnest_sig AS clinical_significance,
>   COUNT(*) AS variant_count
> FROM (
>   SELECT UNNEST(INFO_CLNSIG) AS unnest_sig
>   FROM clinvar
> ) s
> WHERE unnest_sig IS NOT NULL
> GROUP BY unnest_sig
> ORDER BY variant_count DESC, clinical_significance
> LIMIT 5;
> ```
>
> Top rows:
>
> | clinical_significance                        | variant_count |
> |----------------------------------------------|---------------|
> | Pathogenic                                   | 3593          |
> | Conflicting_classifications_of_pathogenicity | 2918          |
> | Likely_benign                                | 2891          |
> | Uncertain_significance                       | 2445          |
> | Benign                                       | 704           |
>
> (These are the top 5; there are 11 total clinical significance
> categories in this region.)

The **same run with no agent** — the deterministic CLI/SDK path, for
scripts and CI (the substrate runs and *receipts* the SQL; identical
numbers, no model in the loop):

``` sh
pi-bio-agent query examples/connectors/clinvar-region.json \
  --db :memory: \
  --init-sql "INSTALL duckhts FROM community; LOAD duckhts;" \
  --sql "WITH clnsig AS (SELECT unnest(INFO_CLNSIG) AS sig FROM clinvar) SELECT sig AS clinical_significance, COUNT(*) AS variant_count FROM clnsig WHERE sig IS NOT NULL GROUP BY sig ORDER BY variant_count DESC LIMIT 8"
```

``` json
{
  "ok": true,
  "runId": "query-1782975604736-02fcbee8",
  "status": "succeeded",
  "rowCount": 8,
  "artifacts": {
    "run": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1782975604736-02fcbee8/run.json",
    "result": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1782975604736-02fcbee8/result.json",
    "receipts": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1782975604736-02fcbee8/receipts.json"
  },
  "runDir": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1782975604736-02fcbee8",
  "rows": [
    {
      "clinical_significance": "Pathogenic",
      "variant_count": 3593
    },
    {
      "clinical_significance": "Conflicting_classifications_of_pathogenicity",
      "variant_count": 2918
    },
    {
      "clinical_significance": "Likely_benign",
      "variant_count": 2891
    },
    {
      "clinical_significance": "Uncertain_significance",
      "variant_count": 2445
    },
    {
      "clinical_significance": "Benign",
      "variant_count": 704
    },
    {
      "clinical_significance": "Likely_pathogenic",
      "variant_count": 263
    },
    {
      "clinical_significance": "Pathogenic/Likely_pathogenic",
      "variant_count": 226
    },
    {
      "clinical_significance": "Benign/Likely_benign",
      "variant_count": 94
    }
  ]
}
```

**Ask a question over a manifest — the agent writes the SQL, the
substrate runs it and receipts it:**

``` sh
pi-bio-agent query examples/variant-counts/manifest.json \
  --db :memory: \
  --sql "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence"
```

``` json
{
  "ok": true,
  "runId": "query-1782975607084-c6ac9d74",
  "status": "succeeded",
  "rowCount": 3,
  "artifacts": {
    "run": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1782975607084-c6ac9d74/run.json",
    "result": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1782975607084-c6ac9d74/result.json",
    "receipts": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1782975607084-c6ac9d74/receipts.json"
  },
  "runDir": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1782975607084-c6ac9d74",
  "rows": [
    {
      "consequence": "missense",
      "n": 2
    },
    {
      "consequence": "stop_gained",
      "n": 2
    },
    {
      "consequence": "synonymous",
      "n": 1
    }
  ]
}
```

**Where is all of this stored? The run graph is itself a table.** Every
run above persisted a record under `.pi/bio-agent/runs/<runId>/run.json`
— its spec, status, timestamps, event log, and resolution receipts.
[`run-ledger`](examples/run-ledger/manifest.json) reads those records
back with DuckDB `read_json`, so the substrate’s **own provenance is
queryable with the same SQL it uses for data** — no opaque runtime to
introspect. This is the live run graph produced *by this very render*:

``` sh
pi-bio-agent query examples/run-ledger/manifest.json \
  --db :memory: \
  --sql "SELECT tool, status, count(*) AS runs, min(createdAt) AS first_run FROM run_ledger GROUP BY 1, 2 ORDER BY runs DESC"
```

``` json
{
  "ok": true,
  "runId": "query-1782975607196-27c2c026",
  "status": "succeeded",
  "rowCount": 4,
  "artifacts": {
    "run": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1782975607196-27c2c026/run.json",
    "result": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1782975607196-27c2c026/result.json",
    "receipts": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1782975607196-27c2c026/receipts.json"
  },
  "runDir": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1782975607196-27c2c026",
  "rows": [
    {
      "tool": "ad-hoc.query",
      "status": "succeeded",
      "runs": 962,
      "first_run": {
        "micros": 1782757322953000
      }
    },
    {
      "tool": "ad-hoc.query",
      "status": "failed",
      "runs": 2,
      "first_run": {
        "micros": 1782932194696000
      }
    },
    {
      "tool": "counts.by_consequence",
      "status": "succeeded",
      "runs": 1,
      "first_run": {
        "micros": 1782756761953000
      }
    },
    {
      "tool": "rare_high_impact.report",
      "status": "succeeded",
      "runs": 1,
      "first_run": {
        "micros": 1782758451301000
      }
    }
  ]
}
```

Because the graph is a table, a UI is a thin SQL client and a chart is a
query: a grammar-of-graphics layer like posit’s
[**ggsql**](https://github.com/posit-dev/ggsql) draws the run timeline,
status breakdown, or a manifest→run→receipt DAG straight off
`run_ledger` — the plot *is* `ggplot(run_ledger) + ...` over SQL,
nothing bespoke. Agent conversations, jobs, and coloc results land in
the same ledger, so the whole workbench view is composed, not coded.

**A scientific-database connector is a manifest, not a client.** The
“60+ connected databases” a hosted workbench advertises are, here, one
file each — [`examples/connectors/`](examples/connectors/) ships
UniProt, RCSB PDB, MyGene/BioThings, and Reactome; a new one is a new
URL. The manifest declares **where** the data is; the agent does schema
discovery and composes **what** to pull — the query below is *one* the
agent might write over the resolved `uniprot_entry` table, not a
hardcoded answer (run live here):

``` sh
pi-bio-agent query examples/connectors/uniprot.json \
  --db :memory: \
  --init-sql "INSTALL ducknng FROM community; LOAD ducknng; SET VARIABLE tls = ducknng_tls_config_from_pem(NULL, NULL, NULL, '', 1)" \
  --bindings '{"uniprot_acc":"P04637"}' \
  --sql "SELECT primaryAccession, uniProtkbId, sequence.length AS aa FROM uniprot_entry"
```

``` json
{
  "ok": true,
  "runId": "query-1782975607402-da0ba53c",
  "status": "succeeded",
  "rowCount": 1,
  "artifacts": {
    "run": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1782975607402-da0ba53c/run.json",
    "result": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1782975607402-da0ba53c/result.json",
    "receipts": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1782975607402-da0ba53c/receipts.json"
  },
  "runDir": "/root/pi-bio-agent/.pi/bio-agent/runs/query-1782975607402-da0ba53c",
  "rows": [
    {
      "primaryAccession": "P04637",
      "uniProtkbId": "P53_HUMAN",
      "aa": 393
    }
  ]
}
```

This connector is pure SQL (`ncurl_table`), so the **host** provisions
ducknng + TLS (`--init-sql`) and grants egress. For the agent to resolve
a connector *itself* and compose the SQL with no host provisioning, use
the `http.get` form
([`uniprot-http.json`](examples/connectors/uniprot-http.json)) under the
networked entrypoint — the agent fetches the JSON, discovers the schema,
and writes the extraction. (`http.get` = the fetch the host binds;
`ncurl_table` = pure SQL the host provisions — same connector, two
levers.)

**We port the whole “AI for science” stack as an open substrate you run
— not a hosted product.** The `pi-coding-agent` extension exposes the
agent surface (query/run a manifest, list DuckDB format extensions,
validate SQL, and remember/recall/walk a temporal memory graph) over
host-injected effects. Compute (`process.compute`) and *distributed*
jobs (a `JobDispatch` over an NNG pool / SLURM / Modal) are wired by the
host in its own code (the SDK / an extension like this one, which injects
a `ProcessRunner`/`JobDispatch` into the run request) — the bundled
`pi-bio-agent` CLI is deliberately minimal and injects neither, so a
compute/networked manifest **fails closed** there. Those powerful effects
are granted deliberately, never ambiently. So reproducible
artifacts, connected databases, on-demand compute, and grounded review
run on **your** infra, provider-agnostic. Each [example](examples/)
carries a recorded, verified run; see [what the substrate closes
over](docs/closes-over.md) for the topology / Fugu / RLM argument.

**And the agent doesn’t just *run* these — it *reads and writes* them.**
The package ships its `examples/`, `docs/`, and every manifest, so a Pi
coding-agent that installs it has the whole corpus on disk: it reads a
connector to learn the pattern, then **authors a new one itself** — a
new database, a new MCP server, a new HTS source is a *file the agent
writes*, not a feature request. Manifests are data the agent composes,
validates (`bio_validate_select`, strict-allowlist admission), runs, and
— when a workflow stabilizes — promotes into a project-local skill.
Self-extension is the loop: read → compose → validate → run → keep.

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

The substrate is provider-agnostic — you don’t need Pi to use it.
`query`/`run` execute a manifest through the **same** host functions the
Pi extension uses; both are fail-closed by default — the `http.get`
fetch and the `process.compute` runner stay unbound unless the host
injects them. (DuckDB’s *own* remote reads via `httpfs`/`s3` are a
DuckDB capability, sandboxed by the host — container/seccomp — not gated
by the library; see the Trust boundary above.) Results print as JSON; a
failed run exits `1`, a usage error exits `2`.

``` sh
# run the agent's ad-hoc SQL over a manifest's declared resources
pi-bio-agent query examples/variant-counts/manifest.json --db :memory: \
  --sql "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence"

# run a declared, tested operation
pi-bio-agent run examples/rare-high-impact/manifest.json --db :memory: --operation rare_high_impact.report

# memory is append-only, as-of, attributed observations in the ONE store (agent:memory: in bio_observations)
pi-bio-agent memory list
pi-bio-agent memory show <slug> --as-of 2026-07-01T00:00:00Z   # time-travel: what memory said then
pi-bio-agent memory history <slug>                            # what changed, when, by whom (supersession + tombstones)
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

Host effects are injected by composition — a `fetch` for `http.get`, a
`ProcessRunner` for `process.compute`, a `JobDispatch` for a distributed
`JobRunner` — and each **fails closed** when unbound. The bin compiles
to `dist/` via `npm run build` (run by `prepare`); the package also
ships `src` for Pi to consume directly.

## Docs

New here? Start with the [user guide](docs/guide.md) — write a manifest,
run an operation. For the why, see the [design notes](docs/design.md)
and the [roadmap](docs/roadmap.md). The full [docs index](docs/INDEX.md)
is generated from each doc’s frontmatter (`npm run docs:index`;
`npm run check` fails if it is stale).

## References & lineage

The primitives here are discovered, not invented — [what the substrate
closes over](docs/closes-over.md) makes that argument with citations.
Prior art and lineage:

- **ClawBio** — the origin corpus this factors (“ClawBio for free”):
  <https://github.com/ClawBio/ClawBio>
- **Machine studying** (Li, Battle, Khattab, 2026) —
  <https://jacobxli.com/blog/2026/machine-studying/>
- **Sakana Fugu** (learned orchestration; we own the substrate it
  conducts) — <https://sakana.ai/fugu/>
- **Recursive Language Models / RLM** (REPL-over-context; `bio_query` is
  the SQL REPL) — <https://arxiv.org/abs/2512.24601>
- **ducknng** — our owned Arrow-native NNG transport (HTTP-as-SQL,
  shared-DB RPC, distributed worker pools):
  <https://github.com/sounkou-bioinfo/ducknng>
- **NNG** <https://nng.nanomsg.org/> · `nanonext`
  <https://github.com/r-lib/nanonext> · `mirai`
  <https://mirai.r-lib.org/> · `pynng`
  <https://github.com/codypiersall/pynng>
- **SemanticSQL** (the `bio_edges` + `entailed_edge` graph shape) —
  <https://github.com/INCATools/semantic-sql>
- Design thread (sounkou-bioinfo × Manuel) —
  [LinkedIn](https://www.linkedin.com/feed/update/urn:li:activity:7473824764575436800)

## Development

``` sh
npm install
npm run check     # typecheck + tests + docs-index staleness gate (the single gate)
```

`npm run provision:duckhts` installs the DuckHTS community extension for
the `duckhts.read_bcf` resolver (explicit; never auto-installed during
`check`). Runtime Pi APIs are peer dependencies supplied by Pi itself.

## Status & contributing

Pre-1.0 (`0.1.0`) — the substrate shape is settled (see the
[roadmap](docs/roadmap.md)) but the public API may still move. Issues
and PRs welcome; `npm run check` is the single gate (typecheck + tests +
docs/readme/examples staleness) and CI runs it on every push. Please
keep changes fail-closed and manifest/SQL-first — new capability should
enter as a manifest, a resolver adapter, or SQL, not as bespoke core
code.

## License

[GPL-2.0-or-later](LICENSE) © sounkou-bioinfo
