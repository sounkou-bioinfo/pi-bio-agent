---
type: Reference
title: What the substrate closes over
description: "How the manifest/SQL/DuckDB substrate subsumes agent topologies, learned orchestration (Fugu), and REPL-over-context (RLM) — with references."
tags: [topologies, fugu, rlm, machine-studying, positioning]
---

# What the substrate closes over

Several frontier ideas in agent research, learned orchestration, REPL-over-context, multi-agent topologies, and studying-before-the-task are usually shipped as separate systems. In this substrate they are consequences of one property: **addressable data + SQL + DuckDB-native transport**. We do not claim to implement those papers directly; the claim is that the substrate exposes the lower-level machinery they rely on.

Read this argument in this order:

1. **Machine studying**: a corpus becomes harness expertise before the downstream task is known.
2. **Fugu**: learned orchestration needs access lists, isolated workers, shared memory, and tool-call state.
3. **RLM**: long context becomes a program over an external REPL instead of prompt text.
4. **Local dogfood**: the scripts and tests exercise those primitives as ordinary repo code.

## Machine studying: memory as data

["Machine studying"](https://jacobxli.com/blog/2026/machine-studying/) is studying a corpus *before* a downstream
task is known and retaining the expertise. The useful part for this library is not weight-update studying; it is
the harness-side residue: source maps, hooks, notes, indexes, concept links, and probes that shift later work to
lower tool/token budgets.

Here that retention is **study notes projected into the same `bio_edges` / `entailed_edge` graph** as facts and
ontologies: addressable data the agent queries, distinct from *skills* (activated behavior) and *facts*
(measured, provenanced). The local exercise points are `src/core/study.ts`, `src/core/study-exec.ts`,
`src/core/blackboard.ts`, `test/study-scaffold.test.ts`, `test/study-exec.test.ts`, and `test/blackboard.test.ts`.
They prove hooks as retrieval contracts, access-list DAGs, per-worker isolation, shared note memory, and
blackboard coordination without needing a live model. See [`machine-studying-lineage`](./machine-studying-lineage.md).

## Fugu: learned orchestration

[Sakana Fugu](https://sakana.ai/fugu/) ([release](https://sakana.ai/fugu-release/),
[technical report](https://arxiv.org/html/2606.21228v1); ICLR-2026 papers *TRINITY* and *The Conductor*) is a
trained orchestrator for model collectives. The important source section for this repo is §3.2.2,
"Function Calling Agentic Workflows." It identifies a real tension:

- In a single-agent tool loop, the message transcript can carry function-call context.
- In a multi-agent workflow, sharing every worker's tool transcript causes **orchestration collapse**: later
  workers are steered by the first worker's path and repeat it.
- Fully isolating workers is also bad, because agents need memory of earlier environment interactions to avoid
  redundant tool calls and rediscovering the same artifacts.

Fugu resolves that with two mechanisms: **access lists** for current-workflow isolation, and **persistent shared
memory** across workflows so later agents can observe prior tool calling when useful. That maps directly onto this
substrate:

- `StudyScaffold.accessList` is the access-list contract. Tests prove each worker sees only the upstream notes it
  was granted, while tree and survey/debate topologies fan in through an aggregator.
- `bio_observations` plus run facts are the shared memory/tool-call cache. Runs, results, receipts, job status,
  and memory notes are queryable as-of facts; an agent can ask what already ran before repeating an expensive
  lookup or compute.
- `src/core/blackboard.ts` and `src/hosts/sql-blackboard.ts` are the current blackboard shapes;
  `scripts/blackboard-shared.mjs` shows the same publish/await pattern across OS processes through a
  ducknng-served DuckDB table.
- `scripts/nng-job-runner.mjs` records a worker's durable async status into the same observation slot a local
  job store reads.
- `scripts/nng-file-handoff.mjs` records a produced file by CAS digest, then a separate reader follows the ledger
  to exact bytes.
- `scripts/pipeline-fanout.mjs`, `scripts/nng-survey.mjs`, and `scripts/nng-pair.mjs` exercise bounded worker
  pools, survey/quorum, and proposer-verifier communication.

What we deliberately *lack* is the trained orchestrator. The library provides the data plane a Fugu-like
orchestrator would conduct: manifests, access lists, observations, CAS, jobs, and DuckDB/ducknng transport.

## RLM: a REPL over context

[Recursive Language Models](https://arxiv.org/abs/2512.24601) treat a near-infinite prompt as a **persistent
variable inside a REPL**: the model writes code to slice, search, partition, and summarize an external context,
so prompt size is decoupled from the context window. It is evaluated on order-sensitive long-context tasks like
the **OOLONG** benchmark, which punishes RAG and approximate attention.

`bio_query` / DuckDB **is** that REPL: and a stronger one for the tasks that matter here:

- data lives **addressably outside the prompt** (a table, a CAS handle), so there is no context to rot;
- an OOLONG-style *count / order / join* is a `GROUP BY` / `ORDER BY` / `JOIN`: **exact and deterministic**,
  where an attention-based reader is only approximate. **Counting beats the model; it doesn't ask it.**

RLM writes Python to navigate text; we write SQL to query data. Same move (a program over external context), but
ours is a declarative, indexed, provenance-carrying substrate rather than string-slicing.

The local dogfood is deliberately honest about map versus reduce:

- `examples/long-context-aggregate/manifest.json` and `test/long-context-aggregate-example.test.ts` exercise the
  deterministic reduce: once labels exist, the distributional question is a bounded `GROUP BY`.
- `test/map-reduce-labeling.test.ts` and `scripts/rlm-map-reduce.mjs` exercise the missing semantic map shape:
  partitions are labeled by isolated workers, workers write no shared state, the host merges label artifacts as
  the single writer, and only then does SQL aggregate. The live model would sit at that labeling boundary; the
  tests use a rule so the topology is reproducible.
- `ducknng_run_rpc` / `ducknng_query_rpc` provide the stateful cross-process DuckDB REPL when the host explicitly
  opts into remote execution. The RLM control plane becomes durable, shared, and inspectable instead of prompt
  text.

## Agent topologies: NNG protocols as agent patterns

[ducknng](https://github.com/sounkou-bioinfo/ducknng) binds the [NNG](https://nng.nanomsg.org/) scalability
protocols (in the lineage of R's [`nanonext`](https://github.com/r-lib/nanonext) +
[`mirai`](https://mirai.r-lib.org/)) as first-class SQL. Each protocol *is* an agent
coordination pattern:

| NNG protocol | agent pattern | runnable demo (separate processes, over the ducknng socket layer) |
|---|---|---|
| `push` / `pull` | a bounded **worker pool**: task distribution | `scripts/pipeline-fanout.mjs`; the distributed `JobRunner` `scripts/nng-job-runner.mjs` |
| `pub` / `sub` | a **blackboard**: broadcast state to subscribers | `scripts/blackboard-shared.mjs` |
| `surveyor` / `respondent` | **survey / debate / quorum**: 1:N with replies | `scripts/nng-survey.mjs` (a multi-provider jury: quorum + abstention) |
| `pair` | a **1:1 channel**: proposer↔verifier | `scripts/nng-pair.mjs` (adversarial propose→refute→converge) |
| `bus` | a **peer mesh**, decentralized consult | reachability TESTED (`test/ducknng-socket-reachability.test.ts`, a bus round-trip); mesh demo pending |

Multi-agent coordination is transport, not a framework: message-passing is **NNG**, and status/results land in the
shared **SQL ledger**, so coordination is *inspectable data*, not opaque runtime state. (The `.md` beside each demo
script is only a captured run for the record, not part of the mechanism.) Every NNG protocol is **reachable** the
same way (`open_socket(<proto>)` → `listen`/`dial` → `send`/`recv_aio` + `aio_collect`), verified end to end
including a bus round-trip; the bus *mesh* demo is still pending. See the [design notes](./design.md).

**Reach: authenticated HTTP, MCP, and streaming.** ducknng's HTTP side (`ncurl_table` / `ncurl_aio`) takes
**host-provided headers**, so the network leg reaches anything HTTP-shaped *as SQL* while auth stays host-owned:
an authenticated REST/GraphQL API (the host injects the `Authorization` header: never an agent param), an
[**MCP**](https://modelcontextprotocol.io/) server (JSON-RPC over HTTP + SSE), and **streaming** transports
(SSE / websockets via ducknng `wss`). **MCP is an `ncurl` call**: an `initialize` handshake to a live MCP server
(`initialize` / `tools/list` / `tools/call` are JSON-RPC 2.0 over HTTP) is a single `ncurl_table` POST: *verified
against a public MCP server*, see [`examples/connectors/mcp.json`](../examples/connectors/mcp.json); the session
id it returns threads through as a header on the next call. And server-*pushed* notifications and live streams
are **ducknng `wss`**, covered by the same transport, with secrets never leaving the host boundary. So "call
an MCP tool," "hit a token-gated database," and "subscribe to a stream" are all SQL.

**And the inverse holds: pi-bio-agent can *be* an MCP server, not just call one.** `ducknng` mounts an HTTP
server (*verified*: a POST to an `http://` ducknng mount returns a framed reply), so the substrate's declared
operations can be **served over HTTP**. Wrapping them as MCP tools, a thin `initialize` / `tools/list` / `tools/call` → operation facade over the same host functions, turns pi-bio-agent into an **MCP server**, the
mirror of the [`mcp.json`](../examples/connectors/mcp.json) client. (The HTTP-serve primitive is proven; the
JSON-RPC facade is the next build, not a claim of done.)

## Actions Speak Louder Than Prompts: graph-as-code

[Actions Speak Louder than Prompts](https://arxiv.org/abs/2509.18487) (Finkelshtein, Cucerzan, Jauhar, and
White; ICLR 2026) is a direct external version of the same bet for graph inference. It compares prompting,
tool-use, and graph-as-code for text-rich node classification across domains, homophily regimes, feature lengths,
model sizes, and ablations over features, edges, and labels. The load-bearing finding for this repo is simple:
when graph context is large or information is distributed across structure, features, and labels, generated code
over graph state is the strongest interaction mode.

This is not only a benchmark result; it is an architectural constraint. A graph should not be primarily carried as
prompt text. It should be represented as addressable tables and edges, with the model writing a small program over
that state:

- Prompting is acceptable for a small neighborhood or a human-facing summary, but it is not the substrate.
- Tool-use is a useful intermediate form, but fixed tools become another skill surface if they are too narrow.
- Graph-as-code is the stable shape: here, usually graph-as-SQL over DuckDB, `bio_edges_as_of`, `entailed_edge`,
  resolver-materialized tables, and the temporal run/memory ledger.

The paper's heterophily result also matters. The graph substrate must not assume simple neighborhood homophily or
label propagation. Biomedical graphs are often mixed: an edge can mean similarity, causality, containment,
contradiction, evidence, derivation, or regulatory relation. The correct agent posture is therefore adaptive:
inspect structure, features, labels, evidence, and provenance as separate queryable signals, then use whichever
signal is informative for the current operation. That is exactly why this library keeps graph semantics as typed
predicates and provenance rather than a neighborhood blob in a prompt.

## Metacurator: deterministic spine plus typed judgment

[metacurator](https://github.com/seandavi/metacurator) is not just prior art; reconciling it is a closes-over
point. It independently arrives at the same split for a different scientific workflow: sample-level publication
metadata curation. The useful evidence is in the code, not the README: [`models.py`](https://github.com/seandavi/metacurator/blob/main/src/metacurator/models.py)
marks accession maps and grounded terms as deterministic outputs, [`ground.py`](https://github.com/seandavi/metacurator/blob/main/src/metacurator/ground.py)
does lookup -> round-trip -> branch -> obsolete checks, and [`judge.py`](https://github.com/seandavi/metacurator/blob/main/src/metacurator/judge.py)
contains the only model boundary: `classify_tables`, `propose_mapping`, and `disambiguate`.

That maps cleanly onto this substrate:

- `resolve · archive · acquire · tables · dictionary · ground · diff · report` are resolver/materialization/SQL
  stages with receipts.
- `classify_tables`, `propose_mapping`, and `disambiguate` are typed judgment operations: the model chooses among
  bounded candidates or emits a typed object that deterministic code validates. Unknown mapping targets and
  out-of-candidate CURIEs are contract errors; low-confidence or out-of-range choices become explicit review
  states rather than trusted facts.
- LinkML/schema contracts are the same family as manifests and operation specs: executable behavior is driven by
  declared contracts, not prose prompts.
- Ontology grounding belongs in the graph/SQL tier. The model may rank or choose a candidate, but CURIEs and
  mappings come from deterministic stores.

The important consolidation lesson is that metacurator does **not** require a metacurator-shaped primitive in core.
It closes over existing pieces: declared resources, SQL materialization, ontology tables, typed judgments,
receipts, and the temporal ledger. If a future curation application needs more, it should first prove that need as
application code, not as a new core abstraction.

## The unifying claim

Learned orchestration, REPL-over-context, every topology, and studying-as-memory all reduce to **addressable data
+ SQL + DuckDB-native transport**. That is why "a new question is a manifest," "a new format is a DuckDB extension,"
"a new compute backend is a `JobDispatch`," and "memory, compute, and facts are one temporal ledger" are the same
sentence.

## Lineage: where the substrate came from

The substrate is not a greenfield idea; it is the **factoring** of a working corpus. **ClawBio**, roughly 80 per-question bioinformatics skills, each a 12–26 KB bespoke program, is the origin: those skills factor into
*shared format resolvers + declared SQL operations + term sets + one generic runner*, which is exactly this
library. Reproducing that surface as **manifests + SQL**, with no new TypeScript per question, is the flagship
test, and its `rhi_01` case is the flagship's ground truth
([`rare-high-impact`](../examples/rare-high-impact/)).
**Machine studying** is the memory half of the same bet: the agent studies a corpus *before* the task and keeps
what it learns as queryable notes, not prompt context.

### References
- **ClawBio** (the origin corpus this substrate factors): <https://github.com/ClawBio/ClawBio>
- **metacurator** (deterministic curation spine + typed judgment boundary): <https://github.com/seandavi/metacurator>
- **Machine studying** (Li, Battle, Khattab, 2026): <https://jacobxli.com/blog/2026/machine-studying/>
- Actions Speak Louder than Prompts (Finkelshtein, Cucerzan, Jauhar, White; graph-as-code over graph prompts):
  <https://arxiv.org/abs/2509.18487>
- Sakana Fugu (learned orchestration): <https://sakana.ai/fugu/> · report <https://arxiv.org/html/2606.21228v1>
- Recursive Language Models / RLM (REPL over context, OOLONG): <https://arxiv.org/abs/2512.24601>
- NNG scalability protocols: <https://nng.nanomsg.org/> · the R lineage `nanonext` <https://github.com/r-lib/nanonext> · `mirai` <https://mirai.r-lib.org/> (a Python worker could bind NNG via `pynng`, a factual binding, not part of the lineage)
- ducknng (Arrow-native DuckDB extension for NNG/HTTP/RPC transport): <https://github.com/sounkou-bioinfo/ducknng>
- SemanticSQL (the `bio_edges` + `entailed_edge` graph shape): <https://github.com/INCATools/semantic-sql>
- LinkedIn design thread (sounkou-bioinfo × Manuel): [comment thread](https://www.linkedin.com/feed/update/urn:li:activity:7473824764575436800?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A7473824764575436800%2C7473848362723680256%29&replyUrn=urn%3Ali%3Acomment%3A%28activity%3A7473824764575436800%2C7476647053071114241%29)
