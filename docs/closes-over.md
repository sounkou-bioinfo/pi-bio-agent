---
type: Reference
title: What the substrate closes over
description: "How the manifest/SQL/DuckDB substrate subsumes agent topologies, learned orchestration (Fugu), and REPL-over-context (RLM) — with references."
tags: [topologies, fugu, rlm, machine-studying, positioning]
---

# What the substrate closes over

Several frontier ideas in agent research, learned orchestration, REPL-over-context, multi-agent topologies, and studying-before-the-task are usually shipped as separate systems. In this substrate they are consequences of one property: **addressable data + SQL + DuckDB-native transport**. We do not claim to implement those papers directly; the claim is that the substrate exposes the lower-level machinery they rely on.

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

## Fugu: learned orchestration

[Sakana Fugu](https://sakana.ai/fugu/) ([release](https://sakana.ai/fugu-release/),
[technical report](https://arxiv.org/html/2606.21228v1); ICLR-2026 papers *TRINITY* and *The Conductor*) is a
trained ~7B **conductor** that learns which expert models to activate, what roles they take (Thinker / Worker /
Verifier), how they communicate, and how to combine their work: orchestration *learned*, not hand-designed.

We have every **substrate** piece a conductor needs, as data. The report's §3.2.2 ("Function Calling Agentic
Workflows") names two mechanisms explicitly, and each has a direct substrate analogue:
- **"persistent shared memory"**. Fugu keeps *inter-workflow shared memory* so agents "observe tool calling from
  previous workflows" and "not make redundant, repeated tool calls." Our **`bio_observations` temporal ledger is
  exactly that**: every run and tool call is a queryable, as-of fact (the run-graph), so a later agent/workflow
  reads what already happened instead of repeating it, and now **memory notes live in the same store** (`agent:memory:`
  namespace, append-only revisions + as-of), so shared memory spans facts *and* learned notes, persisted in a DB
  (better semantics than a prompt), shareable across processes via ducknng RPC / CAS.
- **"access list"**. Fugu's plan "specifies … an access list indexing which subtask solutions from the previous
  steps to include in the worker's context," with intra-workflow isolation to avoid "orchestration collapse." Our
  **study-scaffold worker access-lists** (`accessList` in `src/core/study.ts`) route exactly which prior notes each
  worker sees: the same selective-visibility model.
- **workflow-as-data**: manifests + study scaffolds are the plan the conductor would route.

What we deliberately *lack* is the **trained orchestrator**: the agent is an *un-trained* conductor over the same
substrate. That is a policy on top, not a different architecture: Fugu *learns* the routing over its persistent
shared memory + access lists; we make that memory and routing inspectable, as-of-queryable data. (A hosted product
ships the learned conductor; this library provides the substrate it conducts.)

## RLM: a REPL over context

[Recursive Language Models](https://arxiv.org/abs/2512.24601) treat a near-infinite prompt as a **persistent
variable inside a REPL**: the model writes code to slice, search, partition, and summarize an external context,
so prompt size is decoupled from the context window. It is evaluated on order-sensitive long-context tasks like
the **OOLONG** benchmark, which punishes RAG and approximate attention.

`bio_query` / DuckDB **is** that REPL: and a stronger one for the tasks that matter here:
- data lives **addressably outside the prompt** (a table, a CAS handle), so there is no context to rot;
- an OOLONG-style *count / order / join* is a `GROUP BY` / `ORDER BY` / `JOIN`: **exact and deterministic**,
  where an attention-based reader is only approximate. **Counting beats the model; it doesn't ask it.**

RLM writes Python to navigate text; we write SQL to query data. Same move (a program over external context),
but ours is a declarative, indexed, provenance-carrying substrate rather than string-slicing.

And it need not be one-shot. Against a `ducknng` server the agent holds a **persistent, cross-process DuckDB REPL
over RPC**: state built in one call is there in the next. *Verified*: a table `CREATE`d + `INSERT`ed via
`ducknng_run_rpc`, then read back with `ducknng_query_rpc`, returned `count=3, total=42`; the server-side session
persisted across calls. For a large result there are proper cursor SESSIONS: `ducknng_open_query` returns a
`session_id` + `session_token`, then `fetch_query` / `close_query` / `cancel_query` stream batches. Statefulness
and the full write surface are **exec-gated**: the host opts in with `ducknng_register_exec_method` (per-method
auth, peer/mTLS allowlists), so the agent gets a real stateful REPL *only* where the host grants it. That is RLM's
control plane, but durable, shared, and inspectable, not a prompt.

## Machine studying: memory as data

["Machine studying"](https://jacobxli.com/blog/2026/machine-studying/) is studying a corpus *before* a downstream
task is known and retaining the expertise. Here that retention is **study notes projected into the same
`bio_edges` / `entailed_edge` graph** as facts and ontologies: addressable data the agent queries, distinct from
*skills* (activated behavior) and *facts* (measured, provenanced). See [`machine-studying-lineage`](./machine-studying-lineage.md).

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
- **Machine studying** (Li, Battle, Khattab, 2026): <https://jacobxli.com/blog/2026/machine-studying/>
- Sakana Fugu (learned orchestration): <https://sakana.ai/fugu/> · report <https://arxiv.org/html/2606.21228v1>
- Recursive Language Models / RLM (REPL over context, OOLONG): <https://arxiv.org/abs/2512.24601>
- NNG scalability protocols: <https://nng.nanomsg.org/> · the R lineage `nanonext` <https://github.com/r-lib/nanonext> · `mirai` <https://mirai.r-lib.org/> (a Python worker could bind NNG via `pynng`, a factual binding, not part of the lineage)
- ducknng (Arrow-native DuckDB extension for NNG/HTTP/RPC transport): <https://github.com/sounkou-bioinfo/ducknng>
- SemanticSQL (the `bio_edges` + `entailed_edge` graph shape): <https://github.com/INCATools/semantic-sql>
- LinkedIn design thread (sounkou-bioinfo × Manuel): [comment thread](https://www.linkedin.com/feed/update/urn:li:activity:7473824764575436800?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A7473824764575436800%2C7473848362723680256%29&replyUrn=urn%3Ali%3Acomment%3A%28activity%3A7473824764575436800%2C7476647053071114241%29)
