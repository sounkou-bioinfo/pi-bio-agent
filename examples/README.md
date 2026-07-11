# Examples — what the substrate demonstrates

One substrate — **data lives addressably outside the prompt (DuckDB tables + CAS + receipts), navigated by
bounded queries + content-addressed memory** — reproduces ClawBio-style skills *and* closes over RLM, Fugu, and
multi-agent execution. Each item below says what it proves and how to run it. Deterministic ones are unit tests
(`npm test`); **live** ones spawn real agents / processes and are dogfoods you run by hand.

## 1. ClawBio skills as manifests (the baseline)
A ClawBio skill = a manifest + SQL, with **zero per-skill TypeScript**. Tags are verified against the real source.

| Example | Reproduces (named concrete) | Proof |
|---|---|---|
| [`rare-high-impact/`](rare-high-impact/) | ClawBio **`rhi_01`** | flagship abstention — `test/flagship-rare-high-impact.test.ts` |
| [`variant-annotation/`](variant-annotation/) | ClawBio **Variant Annotation** (VEP REST / ClinVar / gnomAD) | nested-VEP unnest + rare∧high-impact∧pathogenic filter — `test/variant-annotation-example.test.ts` |
| [`ols4-grounding/`](ols4-grounding/) | **metacurator** `disambiguate` (term → one CURIE or abstain) | `test/ols4-grounding-example.test.ts` |
| [`variant-counts/`](variant-counts/) | generic resource-only manifest | the agent writes the SQL |

The honest boundary (most of "fits neither" collapses to http-resolver generalization; only the LM's semantic
judgment is irreducible) is in [`docs/refinments.md`](../docs/refinments.md).

## 1b. Foreign KGs as SemanticSQL projections
A KGX/SemanticSQL edge table = DuckDB data + a graph projection profile, not a new graph subsystem.

| Example | Proof |
|---|---|
| [`monarch-kg-http/`](monarch-kg-http/) | Monarch KGX disease→phenotype TSV over HTTP (`httpfs`) -> canonical `edge(subject,predicate,object,attrs,trust)` -> `bio_edges` projection — `test/monarch-kg-http-example.test.ts` |
| [`graph-window/`](graph-window/) | Portable CLI graph window over an existing DuckDB edge table — shown live in the top-level README and covered by `test/graph-window-cli.test.ts` |

## 2. RLM — recursion / unbounded context, as SQL
`bio_query` over DuckDB *is* RLM's REPL-over-context (context as tables, not a prompt; no context rot).

| Example | Proof |
|---|---|
| [`long-context-aggregate/`](long-context-aggregate/) | RLM's OOLONG "among these user IDs, how many label X" = a deterministic `GROUP BY` (the *deterministic half*; labels pre-given) — `test/long-context-aggregate-example.test.ts` |
| `test/map-reduce-labeling.test.ts` | the **honest full shape**: rows arrive UNLABELED → a worker **infers** labels over partitions (the judgment boundary, the part RLM recurses on) → the **host single-writer** merges labels → deterministic aggregate |

## 3. Fugu — orchestration-as-data + a real multi-agent run
Fugu piece 2 (workflow-as-data with access lists) + piece 3 (shared memory = the note index/CAS). No learned
orchestrator (piece 1); the agent conducts.

| Example | Proof |
|---|---|
| `test/study-scaffold.test.ts` | `StudyScaffold` = a DAG of `(subtask, produces, accessList)`; fail-closed validation (access refs only to earlier steps → acyclic); Kahn topo-order |
| `test/study-exec.test.ts` | the **executor** runs workers in topo order with per-step **access-list isolation** + downstream **shared memory**; includes a **TREE** and a **SURVEY/DEBATE** topology (N isolated respondents + an aggregator that fans them in — Fugu's signature) |
| **live:** [`scripts/live-multi-agent.ts`](dogfood/live-multi-agent.md) | **real multi-agent run** (chain): each step spawns a *separate `pi` process*; they communicate only via access-list artifacts the host threads — no shared db, so the process lock is never touched. `npx tsx scripts/live-multi-agent.ts` |
| **live:** [`scripts/live-debate.ts`](dogfood/live-debate.md) | **real best-of-N debate** (survey topology): two agents answer the same question independently, an aggregator synthesizes both. `npx tsx scripts/live-debate.ts` |

| `test/blackboard.test.ts` | **pub/sub blackboard** (`src/core/blackboard.ts`): DECENTRALIZED — steps launched concurrently, each awaits its deps from a shared blackboard and publishes its note; order emerges from data deps, **no coordinator** (stigmergy) |
| `test/pipeline.test.ts` | **push/pull pipeline** (`src/core/pipeline.ts`): N-worker load-balanced pool — the RLM labeling map as a self-balancing queue |

Topologies are a **scaffold choice, not an executor change** — `req/rep` star (the coordinator), `survey`
(debate), `pub/sub` (decentralized blackboard), `push/pull` (pipeline) are all built; `bus` (mesh) is noted. The
DuckDB-native transport for the real cross-machine versions is [`ducknng`](https://github.com/sounkou-bioinfo/ducknng) (NNG +
Arrow + manifest methods + mTLS), which also ships `ducknng_ncurl` (an HTTP client) — so the http-resolver
generalization and the agent topologies converge in one extension.

## 4. The process boundary — sharing state across agent processes
DuckDB's file lock is **process-exclusive-writer** (verified). So state-sharing across agent processes is either
immutable (CAS) or via a single owner (a **ducknng** server; quack was dropped for the mutable shared-state demos). See the
boundary analysis in [`docs/refinments.md`](../docs/refinments.md).

| Example | Proof |
|---|---|
| `test/http-cas-reuse.test.ts` | **CAS** — a second db with an empty memo 304s from the shared content store and materializes with **no re-download** (immutable cross-db reuse) |
| `test/run-store-init-sql.test.ts` | the host **connection-init hook** (`duckdbInitSql`) — where the **host** (never the agent) runs `INSTALL/LOAD` extensions before resolution; it is host-owned and not exposed through any agent tool |
| **live:** [`scripts/ducknng-rpc-mutate.mjs`](dogfood/ducknng-rpc-mutate.md) | **ducknng RPC** — separate processes **mutate** one shared table in place (`UPDATE`/`DELETE`/upsert) via `ducknng_run_rpc` against a server running native DuckDB, exec opt-in. The mutate-in-place quack can't do; a fact-superseding KG needs it. |
| **live:** [`scripts/blackboard-shared.mjs`](dogfood/blackboard-shared.md) | **ducknng RPC blackboard** — a decentralized pub/sub diamond DAG across separate processes (publish = `run_rpc` INSERT, await = poll `query_rpc`); order emerges from shared writes, no coordinator. |

## 5. The COMPUTE pillar & the two-pillar flagship
SQL is poor at some things (an `lm()` fit, a Bayesian colocalization); those run **out-of-process** over Arrow IPC,
with the DATA contract staying SQL/Arrow.

| Example | Proof |
|---|---|
| [`compute-run/`](compute-run/) | the **COMPUTE pillar** itself — a DuckDB table → Arrow IPC → real spawned R `lm()` → Arrow IPC → table; fail-closed without a `ComputeRunner` — `test/compute-run-example.test.ts` |
| [`compute-artifacts/`](compute-artifacts/) | **FILE outputs (#3)** — a compute op returns a table (Arrow) AND captures declared file outputs into **CAS** (content-addressed, recorded in the receipt); values in the IPC, files beside it (the `nf-r-ipc`/Nextflow split) — `test/compute-artifacts-example.test.ts` |
| [`wgs-chr22-annotation/`](wgs-chr22-annotation/) | **NETWORK + COMPUTE on real WGS data** — `duckhts` region read → chunked VEP fanout (`ncurl-fanout`) → ClinVar → rare/high-impact — `test/ncurl-fanout.test.ts` |
| [`coloc/`](coloc/) | **the two-pillar flagship** — post-GWAS colocalization (`PostGWAS`/`coloclize` shape): SQL allele **harmonization** (DATA) → out-of-process R **`coloc.abf`** over Arrow IPC (COMPUTE) → `PP.H4` posteriors. `test/coloc-example.test.ts` (real `coloc::coloc.abf`, `PP.H4 ≈ 1.0` on a shared-causal locus) |

---
Run all deterministic examples: `npm test`. The **live** dogfoods need the `pi` CLI (multi-agent) / a free
local port (ducknng) and are run by hand; their recorded outputs are in the linked `.md` files.
