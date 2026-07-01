---
type: Reference
title: What the substrate closes over
description: "How the manifest/SQL/DuckDB substrate subsumes agent topologies, learned orchestration (Fugu), and REPL-over-context (RLM) — with references."
tags: [topologies, fugu, rlm, machine-studying, positioning]
---

# What the substrate closes over

Several frontier ideas in agent research — learned orchestration, REPL-over-context, multi-agent topologies,
studying-before-the-task — are usually shipped as separate systems. In this substrate they are **not features to
add**; they are consequences of one property: **addressable data + SQL + an owned transport**. We do not claim to
*implement* these papers — we claim our substrate is the thing they approximate. Below, each with its reference.

## Agent topologies — NNG protocols as agent patterns

[ducknng](https://github.com/sounkou-bioinfo/ducknng) binds the [NNG](https://nng.nanomsg.org/) scalability
protocols (the lineage of R's [`nanonext`](https://github.com/r-lib/nanonext) + [`mirai`](https://mirai.r-lib.org/)
and Python's [`pynng`](https://github.com/codypiersall/pynng)) as first-class SQL. Each protocol *is* an agent
coordination pattern:

| NNG protocol | agent pattern |
|---|---|
| `push` / `pull` | a bounded **worker pool** — task distribution (the distributed `JobRunner`, `scripts/nng-job-runner.mjs`) |
| `pub` / `sub` | a **blackboard** — broadcast state to subscribers |
| `surveyor` / `respondent` | **survey / debate / quorum** — 1:N with replies |
| `bus` | a peer mesh |
| `pair` | a 1:1 channel |

Multi-agent coordination is therefore transport, not a framework — and status/results flow back into the shared
SQL ledger, so the coordination is *inspectable data*, not opaque runtime state. See
the [design notes](./design.md) and `scripts/live-multi-agent.ts`, `scripts/pipeline-fanout.mjs`.

**Reach: authenticated HTTP, MCP, and streaming.** ducknng's HTTP side (`ncurl_table` / `ncurl_aio`) takes
**host-provided headers**, so the network leg reaches anything HTTP-shaped *as SQL* while auth stays host-owned:
an authenticated REST/GraphQL API (the host injects the `Authorization` header — never an agent param), an
[**MCP**](https://modelcontextprotocol.io/) server (JSON-RPC over HTTP + SSE), and **streaming** transports
(SSE / websockets via ducknng `wss`). So "call an MCP tool," "hit a token-gated database," and "subscribe to a
stream" reduce to `ncurl`/`wss` calls — the HTTP-shaped parts need no bespoke client (full MCP session / SSE
semantics may still want a thin host wrapper), and secrets never leave the host boundary.

## Fugu — learned orchestration

[Sakana Fugu](https://sakana.ai/fugu/) ([release](https://sakana.ai/fugu-release/),
[technical report](https://arxiv.org/html/2606.21228v1); ICLR-2026 papers *TRINITY* and *The Conductor*) is a
trained ~7B **conductor** that learns which expert models to activate, what roles they take (Thinker / Worker /
Verifier), how they communicate, and how to combine their work — orchestration *learned*, not hand-designed.

We have every **substrate** piece a conductor needs, as data:
- **workflow-as-data** — manifests + study scaffolds are the plan;
- **shared memory** — CAS (content-addressed) is the cross-agent store;
- **access lists** — study-scaffold worker access-lists route exactly what each agent may see.

What we deliberately *lack* is the **trained orchestrator** — the agent is an *un-trained* conductor over the same
substrate. That is a policy on top, not a different architecture: Fugu learns the routing; we make the thing being
routed inspectable and composable. (A hosted product ships the learned conductor; we own the substrate it conducts.)

## RLM — a REPL over context

[Recursive Language Models](https://arxiv.org/abs/2512.24601) treat a near-infinite prompt as a **persistent
variable inside a REPL**: the model writes code to slice, search, partition, and summarize an external context,
so prompt size is decoupled from the context window. It is evaluated on order-sensitive long-context tasks like
the **OOLONG** benchmark, which punishes RAG and approximate attention.

`bio_query` / DuckDB **is** that REPL — and a stronger one for the tasks that matter here:
- data lives **addressably outside the prompt** (a table, a CAS handle), so there is no context to rot;
- an OOLONG-style *count / order / join* is a `GROUP BY` / `ORDER BY` / `JOIN` — **exact and deterministic** for
  table-shaped tasks, where an attention-based reader is only approximate: SQL answers, it doesn't ask the model.

RLM writes Python to navigate text; we write SQL to query data. Same move (a program over external context),
but ours is a declarative, indexed, provenance-carrying substrate rather than string-slicing.

## Machine studying — memory as data

["Machine studying"](https://jacobxli.com/blog/2026/machine-studying/) is studying a corpus *before* a downstream
task is known and retaining the expertise. Here that retention is **study notes projected into the same
`bio_edges` / `entailed_edge` graph** as facts and ontologies — addressable data the agent queries, distinct from
*skills* (activated behavior) and *facts* (measured, provenanced). See [`machine-studying-lineage`](./machine-studying-lineage.md).

## The unifying claim

Learned orchestration, REPL-over-context, every topology, and studying-as-memory all reduce to **addressable data
+ SQL + an owned transport**. That is why "a new question is a manifest," "a new format is a DuckDB extension," "a
new compute backend is a `JobDispatch`," and "memory, compute, and facts are one temporal ledger" are the same
sentence. We own the substrate those ideas are approximations of.

## Lineage — where the substrate came from

The substrate is not a greenfield idea; it is the **factoring** of a working corpus. **ClawBio** — ~80
per-question bioinformatics skills, each a 12–26 KB bespoke program — is the origin: those skills factor into
*shared format resolvers + declared SQL operations + term sets + one generic runner*, which is exactly this
library. Reproducing the ClawBio surface as **manifests + SQL** (zero new TypeScript per question) is the
north-star "ClawBio for free" factoring the library is built toward; its `rhi_01` case is the flagship's ground
truth ([`rare-high-impact`](../examples/rare-high-impact/)).
**Machine studying** is the memory half of the same bet — the agent studies a corpus *before* the task and keeps
what it learns as queryable notes, not prompt context.

### References
- **ClawBio** (the origin corpus this substrate factors) — <https://github.com/ClawBio/ClawBio>
- **Machine studying** (Li, Battle, Khattab, 2026) — <https://jacobxli.com/blog/2026/machine-studying/>
- Sakana Fugu (learned orchestration) — <https://sakana.ai/fugu/> · report <https://arxiv.org/html/2606.21228v1>
- Recursive Language Models / RLM (REPL over context, OOLONG) — <https://arxiv.org/abs/2512.24601>
- NNG scalability protocols — <https://nng.nanomsg.org/> · `nanonext` <https://github.com/r-lib/nanonext> · `mirai` <https://mirai.r-lib.org/> · `pynng` <https://github.com/codypiersall/pynng>
- ducknng (owned Arrow-native NNG transport) — <https://github.com/sounkou-bioinfo/ducknng>
- SemanticSQL (the `bio_edges` + `entailed_edge` graph shape) — <https://github.com/INCATools/semantic-sql>
- LinkedIn design thread (sounkou-bioinfo × Manuel) — [comment thread](https://www.linkedin.com/feed/update/urn:li:activity:7473824764575436800?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A7473824764575436800%2C7473848362723680256%29&replyUrn=urn%3Ali%3Acomment%3A%28activity%3A7473824764575436800%2C7476647053071114241%29)
