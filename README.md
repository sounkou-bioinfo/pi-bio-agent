# pi-bio-agent

[![CI](https://github.com/sounkou-bioinfo/pi-bio-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/sounkou-bioinfo/pi-bio-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

> **The entire "AI for science" workbench — reproducible artifacts, dozens of connected databases, on-demand
> *distributed* compute, grounded review — as an open, deterministic, SQL-native library you run on your own
> infrastructure. Not a hosted product. A substrate.**

Lean, provider-agnostic bioinformatics **substrate** for Pi agents — not a pile of bespoke genomics scripts.

The bet: **manifests, SQL, resources, and ontology data are the PROGRAM; TypeScript is only the interpreter.**
Everything reduces to *data + an injected effect port*, so every layer is just a plug:

- a new **question** is a *manifest* + SQL — never a new `.ts`;
- a new **data format** is a *DuckDB extension* (`duckhts`, `anndata`, `duckdb_zarr`, `plinking_duck`, …);
- a new **API** is an `ncurl_table` call over **[ducknng](https://github.com/sounkou-bioinfo/ducknng)** — our
  owned, community-signed, Arrow-native NNG transport: HTTP-as-SQL, cross-process shared-DB RPC, and **distributed
  worker pools** (push/pull, pub/sub, survey) with workers in R (`nanonext`/`mirai`), Python (`pynng`), or node;
- a new **compute backend** (SLURM, Modal, an NNG pool) is one injected `JobDispatch` — the library ships the
  primitive, you bring the backend;
- a new **model** is an injected judge. The interpreter stays thin; the agent writes the SQL.

## How it works

A **manifest** declares named *resources*; a **resolver** turns each into a DuckDB table and stamps a *receipt*
(resolver version, params digest, source snapshot). An **operation** is a single read-only `SELECT`/`WITH` over
those tables — whatever it returns *is* the result; there is no separate report layer. The bet stands on **four
legs, all SQL over one DuckDB substrate**:

### 1. Data — anything DuckDB can read
`duckdb.sql_materialize` is the one primitive: any read-only query over everything DuckDB reaches — local files
(csv/tsv/parquet/json), object stores (httpfs/s3), other databases, lakes. `duckdb.file_scan` and
`duckhts.read_bcf` are just conveniences over it. **The format surface is open**: a new format is a new DuckDB
*extension*, not new library code — HTS/VCF/BAM ([`duckhts`](https://duckdb.org/community_extensions/extensions/duckhts)),
single-cell AnnData ([`anndata`](https://duckdb.org/community_extensions/extensions/anndata)),
Zarr ([`duckdb_zarr`](https://duckdb.org/community_extensions/extensions/duckdb_zarr)),
PLINK ([`plinking_duck`](https://duckdb.org/community_extensions/extensions/plinking_duck)), and whatever ships
next. You bring the format; DuckDB's full reach and its community-extension ecosystem *are* the data layer.

### 2. Network — HTTP *as SQL*, via the owned **ducknng** extension
- `ducknng_ncurl_table` — an HTTP endpoint *is* a table function: URL/headers/body composed in SQL
  (`getvariable` + `url_encode`), JSON parsed straight into columns, **no bespoke TypeScript**.
- `ducknng_run_rpc` — a live DuckDB that many processes write through (shared mutable state).
- NNG topologies (push/pull, pub/sub, survey, bus, pair) — multi-agent coordination as transport.
- `http.get` (host-supplied `fetch`) is the fallback where a DuckDB build lacks ducknng; rate-limited
  multi-request fanout lives in one host helper — the single seam a DuckDB table-function limit forces out of pure SQL.

### 3. Compute — out-of-process, over Arrow IPC
`process.compute` runs an external computation (R/Python/Go/shell): a table is exported as Arrow, the child
computes what SQL is poor at (an `lm()` fit, a model), and the result reads back as a table. Only the *data
contract* is SQL/Arrow — the computation is a contained child, not FFI.

### 4. Knowledge + memory — one SQL graph
Ontologies **and** our own KG share one shape ([SemanticSQL](https://github.com/INCATools/semantic-sql)):
`bio_edges(from_id, predicate, to_id)` + its `entailed_edge` transitive closure, so subsumption, descendants, and
graph-walks are a single indexed join. Grounding a term runs **deterministically first** (exact/synonym match +
closure, all SQL) and falls back to a model only on a miss — which may propose a candidate but **never invents a
CURIE** and abstains below a confidence threshold. Ordered TermSets become a `scale_members` rank table (ACMG,
variant impact, clinical stage). **Memory is machine studying** ([in this
sense](https://jacobxli.com/blog/2026/machine-studying/)): the agent retains what it learns as *study notes*
projected into the same graph — addressable data it queries, distinct from *skills* (activated behavior) and
*facts* (measured, tool-derived, provenanced). Not prompt-stuffed context that rots.

### Runs & receipts
Capability resolvers are **host-injected by composition and fail closed** when unbound: no `fetch` → `http.get`
is off; no `ProcessRunner` → `process.compute` is off. A run bundles the result with its run record and the
resolver receipts — *a failed run still leaves an auditable receipt* — under `.pi/bio-agent/runs/<runId>/`.
Manifests pass a strict allowlist, so cut surface can't ride back in as inert keys.

### Trust boundary
The substrate is deliberately thin: it enforces statement class (read-only, no DDL), manifest shape, and receipt
integrity, but it is **not** a network or filesystem sandbox. DuckDB's remote reads, replacement scans, and
extensions are features; whether egress is possible is the host's call (container, seccomp, the Pi runtime).
**The library records what ran; the host decides what may run.**

TypeScript is only the interpreter that binds these host effects — a new bio question is a manifest and some SQL,
not a new `.ts` file.

## Why a substrate, not a hosted workbench

The hosted "AI for science" workbenches (e.g. [Claude Science](https://www.anthropic.com/news/claude-science-ai-workbench))
ship the same primitives we do — auditable/reproducible artifacts, on-demand compute, dozens of connected
databases, reviewer agents. We arrived at that spine independently — convergent design on primitives that are
discovered, not invented. We owe them nothing; the overlap only confirms the substrate is real. The difference
is what it runs *on*:

| | a hosted AI-science workbench | **pi-bio-agent** |
|---|---|---|
| the program | agent-orchestrated code | a **manifest + SQL** — data, not code; a new question is a new manifest, zero new `.ts` |
| reproducibility | "keep the exact code + environment" | **content-addressed receipts + a deterministic `receiptContentDigest` + an as-of temporal ledger** — a re-run *matches by content*, and counting is a `GROUP BY`, not re-executed code |
| where it runs | a vendor's cloud | **your** laptop / cluster / HPC — an importable library + CLI; the host owns effects and egress ("the library records what ran; the host decides what may run") |
| compute distribution | SSH-to-HPC / Modal | a **topology over data-in-SQL** — ducknng NNG `push`/`pull`, with status flowing back into the same job ledger; workers in **R (`nanonext`/`mirai`), Python (`pynng`), or node** |
| agent patterns | one coordinating agent + actor-critic | **every NNG topology** (push/pull, pub/sub, survey/debate, bus, pair), and it *closes over* Fugu (workflow-as-data + CAS shared memory) and RLM (SQL-REPL over context, no context rot) |
| trust model | a model-based reviewer | **fail-closed determinism** — strict-allowlist manifests, a read-only SQL guard, grounding that abstains and never invents a CURIE |
| openness | a closed product | **open, deterministic, inspectable** — every claim above maps to code and a test in this repo |

Same destination; we own the road. A hosted product adds features on top of an opaque runtime — we own the
substrate those features are approximations of. (And yes, a UI is just a thin client over the CLI/SDK — the
substrate is real without one.)

## Demonstration

Every block below is runnable, and the output is **real** — the same literate-programming discipline that keeps
[the example docs](examples/) from drifting (each example records a verified run; `npm run check` fails if one
goes stale).

**The agent speaks.** Point a live Pi agent at a manifest and ask in plain English — it does schema discovery,
writes the read-only SQL, runs it through the substrate, and answers (this is a real transcript):

```sh
pi -e extensions/pi-coding-agent/index.ts -p \
  "Over examples/variant-counts/manifest.json: how many variants of each consequence are there?"
```
> | Consequence | Variants |
> |---|---:|
> | missense | 2 |
> | stop_gained | 2 |
> | synonymous | 1 |
>
> *Missense and stop-gained variants are tied as the most common consequences, with two variants each.*

Same run, no agent — the CLI/SDK path, for scripts and CI:

**Ask a question over a manifest — the agent writes the SQL, the substrate runs it and receipts it:**

```sh
pi-bio-agent query examples/variant-counts/manifest.json --db :memory: \
  --sql "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence"
```
```json
{ "ok": true, "rowCount": 3, "rows": [
  { "consequence": "missense",    "n": 2 },
  { "consequence": "stop_gained", "n": 2 },
  { "consequence": "synonymous",  "n": 1 } ] }
```

**A scientific-database connector is a manifest, not a client.** The "60+ connected databases" a hosted
workbench advertises are, here, one file each — [`examples/connectors/`](examples/connectors/) ships UniProt,
RCSB PDB, MyGene/BioThings, and Reactome, and a new one is a new URL:

```sh
pi-bio-agent query examples/connectors/uniprot.json --db :memory: \
  --bindings '{"uniprot_acc":"P04637"}' --sql "SELECT * FROM uniprot_entry"   # host provisions ducknng + egress
```

**We port the whole "AI for science" stack as one Pi extension — not a hosted product.** The `pi-coding-agent`
extension exposes the entire surface over this substrate (query/run a manifest, list DuckDB format extensions,
validate SQL, plan/read/write study notes), so reproducible artifacts, connected databases, on-demand and
*distributed* compute, and grounded review are a Pi extension **you** run, on **your** infra. Each
[example](examples/) carries a recorded, verified run; see [what the substrate closes over](docs/closes-over.md)
for the topology / Fugu / RLM argument.

## Install in Pi

```sh
pi install git:github.com/sounkou-bioinfo/pi-bio-agent
/reload
```

## Pi tools

This list is generated from the extension's `registerTool()` calls (`npm run readme`); `npm run check`
fails if it is stale.

<!-- BEGIN GENERATED:tools (scripts/generate-readme.mjs — do not edit by hand) -->
- `bio_create_skill` — Create bio skill
- `bio_delete_study_note` — Delete bio study note
- `bio_describe_model` — Describe Pi Bio model
- `bio_list_duckdb_extensions` — List bio DuckDB extensions
- `bio_list_study_notes` — List bio study notes
- `bio_query` — Run an ad-hoc bio query
- `bio_read_study_note` — Read bio study note
- `bio_run_operation` — Run a bio operation
- `bio_study_plan` — Plan bio study
- `bio_validate_select` — Validate bio SQL SELECT
- `bio_write_study_note` — Write bio study note
<!-- END GENERATED:tools -->

Generated project-local skills and study notes live under `.pi/bio-agent/` in the current project.

## CLI

The substrate is provider-agnostic — you don't need Pi to use it. `query`/`run` execute a manifest through the
**same** host functions the Pi extension uses; both are fail-closed by default (no network/compute unless the
host binds them). Results print as JSON; a failed run exits `1`, a usage error exits `2`.

```sh
# run the agent's ad-hoc SQL over a manifest's declared resources
pi-bio-agent query examples/variant-counts/manifest.json --db :memory: \
  --sql "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence"

# run a declared, tested operation
pi-bio-agent run examples/rare-high-impact/manifest.json --db :memory: --operation rare_high_impact.report

# study notes project into the DuckDB memory subgraph (bio_nodes/bio_edges); sync is a dry run unless --write
pi-bio-agent notes sync   --db graph.duckdb --write
pi-bio-agent notes report --db graph.duckdb --json
```

## As a library (SDK)

```ts
import { runBioQueryFromManifest } from "pi-bio-agent";          // whole surface
import { validateBioManifest } from "pi-bio-agent/core";         // core contracts
import { duckdbNodeConn } from "pi-bio-agent/duckdb";            // DuckDB adapters
import { fsCasStore, ledgerJobRunner } from "pi-bio-agent/hosts"; // host helpers

const out = await runBioQueryFromManifest({
  cwd: process.cwd(), dbPath: ":memory:", manifestPath: "manifest.json",
  sql: "SELECT * FROM variants LIMIT 5",
});
```

Host effects are injected by composition — a `fetch` for `http.get`, a `ProcessRunner` for `process.compute`, a
`JobDispatch` for a distributed `JobRunner` — and each **fails closed** when unbound. The bin compiles to `dist/`
via `npm run build` (run by `prepare`); the package also ships `src` for Pi to consume directly.

## Docs

New here? Start with the [user guide](docs/guide.md) — write a manifest, run an operation. For the why,
see the [design notes](docs/design.md) and the [roadmap](docs/roadmap.md). The full
[docs index](docs/INDEX.md) is generated from each doc's frontmatter (`npm run docs:index`; `npm run check`
fails if it is stale).

## References & lineage

The primitives here are discovered, not invented — [what the substrate closes over](docs/closes-over.md) makes
that argument with citations. Prior art and lineage:

- **ClawBio** — the origin corpus this factors ("ClawBio for free"): <https://github.com/ClawBio/ClawBio>
- **Machine studying** (Li, Battle, Khattab, 2026) — <https://jacobxli.com/blog/2026/machine-studying/>
- **Sakana Fugu** (learned orchestration; we own the substrate it conducts) — <https://sakana.ai/fugu/>
- **Recursive Language Models / RLM** (REPL-over-context; `bio_query` is the SQL REPL) — <https://arxiv.org/abs/2512.24601>
- **ducknng** — our owned Arrow-native NNG transport (HTTP-as-SQL, shared-DB RPC, distributed worker pools): <https://github.com/sounkou-bioinfo/ducknng>
- **NNG** <https://nng.nanomsg.org/> · `nanonext` <https://github.com/r-lib/nanonext> · `mirai` <https://mirai.r-lib.org/> · `pynng` <https://github.com/codypiersall/pynng>
- **SemanticSQL** (the `bio_edges` + `entailed_edge` graph shape) — <https://github.com/INCATools/semantic-sql>
- Design thread (sounkou-bioinfo × Manuel) — [LinkedIn](https://www.linkedin.com/feed/update/urn:li:activity:7473824764575436800)

## Development

```sh
npm install
npm run check     # typecheck + tests + docs-index staleness gate (the single gate)
```

`npm run provision:duckhts` installs the DuckHTS community extension for the `duckhts.read_bcf` resolver
(explicit; never auto-installed during `check`). Runtime Pi APIs are peer dependencies supplied by Pi itself.

## Status & contributing

Pre-1.0 (`0.1.0`) — the substrate shape is settled (see the [roadmap](docs/roadmap.md)) but the public API may
still move. Issues and PRs welcome; `npm run check` is the single gate (typecheck + tests + docs/readme/examples
staleness) and CI runs it on every push. Please keep changes fail-closed and manifest/SQL-first — new capability
should enter as a manifest, a resolver adapter, or SQL, not as bespoke core code.

## License

[MIT](LICENSE) © sounkou-bioinfo
