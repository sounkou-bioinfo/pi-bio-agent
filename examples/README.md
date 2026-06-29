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
| **live:** [`scripts/live-multi-agent.ts`](../scripts/live-multi-agent.md) | **real multi-agent run** (chain): each step spawns a *separate `pi` process*; they communicate only via access-list artifacts the host threads — no shared db, so the process lock is never touched. `npx tsx scripts/live-multi-agent.ts` |
| **live:** [`scripts/live-debate.ts`](../scripts/live-debate.md) | **real best-of-N debate** (survey topology): two agents answer the same question independently, an aggregator synthesizes both. `npx tsx scripts/live-debate.ts` |

Topologies are a **scaffold choice, not an executor change** — `req/rep` star (the coordinator), `pub/sub`
(blackboard), `push/pull` (pipeline), `survey` (debate, above), `bus` (mesh). The DuckDB-native transport for
all of these is [`~/ducknng`](https://nng.nanomsg.org/) (NNG + Arrow + manifest methods + mTLS policy).

## 4. The process boundary — sharing state across agent processes
DuckDB's file lock is **process-exclusive-writer** (verified). So state-sharing across agent processes is either
immutable (CAS) or via a single owner (quack). See the boundary analysis in [`docs/refinments.md`](../docs/refinments.md).

| Example | Proof |
|---|---|
| `test/http-cas-reuse.test.ts` | **CAS** — a second db with an empty memo 304s from the shared content store and materializes with **no re-download** (immutable cross-db reuse) |
| `test/run-store-init-sql.test.ts` | the host **connection-init hook** (`duckdbInitSql`) — where an agent runs `LOAD quack; ATTACH 'quack:host'` |
| **live:** [`scripts/quack-shared-db.mjs`](../scripts/quack-shared-db.md) | **quack** — three processes; two client agents (own `:memory:` dbs) both **write** one shared mutable db via a single server, no lock; the second observes the first's write. `node scripts/quack-shared-db.mjs serve` + `... client A`. quack = live shared **mutable** db; CAS = immutable cross-host. |

---
Run all deterministic examples: `npm test`. The two **live** dogfoods need the `pi` CLI (multi-agent) / a free
local port (quack) and are run by hand; their recorded outputs are in the linked `.md` files.
