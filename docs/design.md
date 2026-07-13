---
type: Reference
title: Conceptual architecture
description: "The canonical conceptual model for core boundaries, execution, evidence, memory, and host composition."
tags: [architecture, contracts, execution, evidence, memory]
---

# Conceptual architecture

This document is the conceptual checksum for `pi-bio-agent`. Read it before changing a core contract. Focused
mechanics belong in the linked reference documents; historical influences belong in [lineage.md](lineage.md).

## The bet

`pi-bio-agent` exists to replace per-question skill sprawl with agent-authored programs over declared scientific
data. A new question should usually require schema inspection and SQL, not a new TypeScript helper or skill.

The compact form is:

```text
declared resources
  -> schema discovery
  -> agent-authored SQL or code
  -> deterministic execution through host-granted ports
  -> result + receipts + replay + CAS
  -> temporal observations and graph projections
  -> typed judgment or approval where evidence alone cannot decide
```

The actor may be a human, language model, automation, or a group of agents. The substrate does not distinguish
their cognitive status. It gives each actor apparatus with a known shape: queryable data, executable operations,
bounded effects, durable evidence, and explicit judgment boundaries. Those constraints do not replace creativity;
they make creative composition inspectable.

## Conceptual checksum

These invariants should remain true after every architectural change.

1. **The model is not the source of biomedical facts.** An actor may route, inspect, compose, explain, and make a
   typed judgment. Facts come from declared data, deterministic computation, receipts, or recorded approval.
2. **Manifests and SQL are the program.** TypeScript interprets contracts and binds host capabilities. It should not
   accumulate question-specific biomedical logic.
3. **DuckDB is the common work surface.** Files, extension table functions, remote responses, graph edges, memory,
   and reductions become relations that ordinary SQL can inspect and join.
4. **Effects are injected and fail closed.** Network, compute, credentials, filesystem policy, extension loading,
   clocks, and deployment isolation belong to the host.
5. **Evidence is structural.** Runs carry declarations, receipts, replay material, CAS references, environment
   evidence, and observation links when the host supplies those facilities.
6. **Memory and knowledge share one temporal store.** `bio_observations` is the append-only source of truth;
   `bio_edges_as_of` and note files are projections or views.
7. **Graph work is action over data, not prompt serialization.** The actor queries or writes code over graph tables
   instead of receiving large neighborhoods as prose.
8. **Judgment is narrow and typed.** Irreducible choices are proposed by a model or human, validated against an
   explicit contract, and recorded. Mechanical work stays in code, SQL, or specifications.
9. **Reproducibility verdicts are honest.** Live sources and volatile functions remain visibly non-reproducible
   unless their relevant bytes and environment are pinned.
10. **Applications pull abstractions into core.** One application owns its policy. A reusable primitive is promoted
    only after repeated concrete use reveals the same motion and the existing boundaries cannot express it cleanly.

## Ownership

| Layer | Owns | Must not own |
|---|---|---|
| Core | contracts, validators, registries, runs, replay, CAS, observations, graph projection, async lifecycles | disease-specific policy, UI workflow, source-specific product behavior |
| DuckDB adapters | resource materialization, SQL validation, extension binding, relation projection | question-specific analysis clients |
| Host adapters | credentials, network admission, process execution, stores, clocks, approvals, isolation | hidden scientific fallbacks |
| Applications | manifests, SQL relations, fixtures, review policy, packets, API and UI composition | duplicate runners, ledgers, retry systems, or graph substrates |
| Skills | thin procedural onboarding over stable substrate surfaces | a separate executable client or one skill per biomedical question |
| Documents | executable or linked explanations of implemented contracts | a second implementation or a stronger claim than the evidence |

The public SDK is the shared implementation. Pi tools, the CLI, Quarto, and future hosts adapt that SDK rather than
reimplementing execution semantics.

## Manifests and ad-hoc queries

A manifest declares what is available: resolvers, resources, table names, stable operations, bindings, and relevant
reproducibility metadata. It is not a workflow diagram and should remain thin.

An ad-hoc query answers the current question. The actor first describes the manifest, inspects tables with
`DESCRIBE`, `SUMMARIZE`, and bounded samples, then composes read-only SQL. This is the default path for novel
questions. SQL graduates into a named operation only when repetition, testing, or an external contract makes stable
identity useful.

A stable operation is useful for regression tests, replay, shared workflows, and public interfaces. It is not more
scientifically valid merely because it was named or pinned. Validity comes from declarations, evidence, and the
analysis itself.

See [resources-and-tool-specs.md](resources-and-tool-specs.md) and [guide.md](guide.md).

## Four DuckDB-centered pillars

### Data

Files and domain formats should enter through DuckDB readers, community extensions, or a general materialization
resolver. `duckdb.file_scan`, `duckdb.sql_materialize`, and extension table functions are preferred to bespoke
parsers. CAS stores immutable bytes; a resource records how bytes or live data become a relation.

DuckDB is already the default stateful scientific REPL. Temporary tables, materialized relations, graph projections,
and CAS handles let an actor keep a large working set outside the prompt and inspect bounded slices as needed. This
is the generic answer to context rot and the RLM-shaped case: the actor partitions, queries, joins, and reduces data in
the database instead of repeatedly loading the whole table into context. A persistent Python, R, or other kernel over
NNG can complement this surface for methods that need process-local state; it is not required to make the workbench
stateful.

### Network

`ducknng` makes HTTP responses, RPC-backed shared state, and NNG communication available through DuckDB-facing
primitives. The host supplies endpoints, admission, credentials, TLS handles, and extension provisioning.
`http.get` remains a host-injected fallback when SQL-native network is unavailable.

One-response materialization, bounded fanout, and retry are distinct mechanics. Reuse the implemented
`ducknng_ncurl_table`, `ducknng.http_fanout`, `ncurlFanout`, and host-fetch policy paths rather than adding a
source-specific HTTP client.

### Rendering and graphics are views

Quarto is the document and publishing boundary, not a second scientific substrate. Its TypeScript engine-extension
surface is enough for this repository's literate QMD files: an engine receives Markdown, executes selected cells, and
returns Markdown plus supporting files/includes for Pandoc and the target format. The `pi-bio` engine should therefore
remain a thin execution adapter. Results, figures, and interactive specifications come from DuckDB/compute and are
content-addressed; Quarto renders them. A figure is a derived view of a pinned relation and run, never a source of
biomedical fact.

`ggsql` is a promising optional host/display extension at this boundary: it keeps data selection and a Grammar of
Graphics specification in SQL and targets Vega-Lite-style output. It belongs beside DuckDB as a provisioned renderer or
extension, not in core and not as a new scientific resolver. An agent-authored visualization query must still be
validated, tied to its input relation and run, and captured as a CAS-backed supporting artifact. The workbench can
dogfood this path before promoting a generic figure-output contract.

Our opinionated offers are deliberately small:

- **Interactive workbench:** use AntV G2 directly. It is the browser-facing renderer for linked tables, graph windows,
  review queues, and exploratory charts; the UI owns the chart instance and receives bounded relation data or a
  content-addressed view spec.
- **SQL-authored chart:** use `ggsql` when the actor should stay in DuckDB/SQL. Treat its grammar as an optional
  provisioned extension and persist the normalized chart spec plus the query/run digests. Its current alpha status
  means it is an integration target, not a core dependency.
- **R/literate bridge:** use `gglite` when an R analyst or R-backed QMD wants the same G2 output. It is an adapter for
  that host, not a second renderer the workbench must maintain.
- **Publication:** use Quarto to place static or interactive artifacts into HTML/PDF/websites and to interleave
  executable narrative. Do not make Quarto, G2, `ggsql`, or `gglite` responsible for scientific provenance.

The useful lesson from litedown is scope discipline: fuse executable cells with narrative and keep the renderer
small. We do not need another Markdown engine while Quarto already provides project rendering, figures, crossrefs,
websites, and engine extensions. Quarto 2/q2 is an experimental implementation detail to watch, not a dependency to
design against; keep QMD and the `pi-bio` engine contract portable.

### Compute

Compute is asynchronous from the bottom: `submit`, `status`, `collect`, and `cancel`. A local process, NNG worker,
scheduler, durable queue, remote machine, or stateful session is an implementation of that lifecycle.

`compute.run` is the manifest resolver that submits and collects one result because relation materialization needs a
value. Durable task composition uses task -> step -> checkpoint. Resume reads completed content-pinned checkpoints
and continues from the first missing step; it does not require another workflow engine.

### Knowledge and memory

External ontologies, foreign knowledge graphs, run provenance, typed memory links, and application relations share
an edge-shaped SQL vocabulary. SemanticSQL supplies the relation shape; it is not another store. SQL closure,
`bio_edges_as_of`, and `entailed_edge` let an actor walk these graphs without copying them into context.

See [duckdb-substrate.md](duckdb-substrate.md), [ontology-and-knowledge-graphs.md](ontology-and-knowledge-graphs.md),
and [memory-and-knowledge-unification.md](memory-and-knowledge-unification.md).

## Evidence and identity

Human-readable ids aid discovery. Content digests establish identity. A schema or version tag belongs at a real
serialization, persistence, or IPC boundary; internal values do not need ceremonial version proliferation.

A scientific run should be explainable through the strongest evidence its host can supply:

- the manifest snapshot and digest;
- exact SQL or operation identity;
- resource and capability receipts;
- input, output, artifact, and environment digests;
- a replay specification and explicit reproducibility verdict;
- temporal observations linking actor, tool call, run, result, and approval.

CAS proves byte identity, not freshness or truth. A live-source receipt proves that a request occurred, not that the
same endpoint will return the same bytes later. Replay must distinguish reproduced, diverged, and not reproducible.

## Memory is recorded relation

Memory is not a hidden prompt cache or a second document database. `remember` appends a typed content observation
and typed link observations to `bio_observations`. A later revision supersedes the current slot while history remains
queryable; forgetting appends a tombstone. Recall reconstructs the current content, while graph tools project the
same current links into `bio_edges_as_of`.

Agent sessions, run events, job checkpoints, host events, and domain facts may enter that same ledger through typed
ingestion adapters. Their schemas differ, but their temporal and provenance mechanics do not. Human-readable note
files are optional derived views.

## Interactive workbench boundary

The browser has two planes that must not collapse into each other:

```text
browser conversation and activity -> AgentHostPort -> Pi SDK (first adapter)
browser evidence and review        -> public SDK -> runs / jobs / CAS / observations / graph
```

The agent-host port owns open/resume, prompt, steer, follow-up, abort, bounded transcript, and ephemeral activity
subscription. Its event buffer exists for responsive presentation and reconnect; it is not the scientific ledger.
The browser hands durable ids and CAS/graph references to an agent, and reloads scientific state from the evidence
plane. This keeps the application usable when the actor is Pi, another model host, a human, or automation.

Pi's runtime tool registration and active-tool mutation are useful implementation details. They can progressively
disclose coarse capabilities without restarting a session and, where the provider supports it, without invalidating
the whole prompt cache. They do not justify a generic core tool-mutation API or a tool per source/question. A future
host-neutral capability profile must be derived from at least one additional host; until then it stays in the Pi
adapter.

The browser distinguishes three application surfaces, following the useful separation proven by Piclaw: persistent
panes for substantial viewers/editors, durable timeline or evidence records for approvals and receipts, and SSE only
for transient live signals. The first `WorkbenchAddon` contract was derived only after two paired application cases
existed: Clinical Evidence contributes analysis routes plus a pane, and Artifacts contributes ledger/CAS routes plus a
figure/report pane. The host approves and serves each browser module and registers its API contribution at startup.
There is deliberately no runtime catalog, browser-supplied module path, addon KV store, or new scientific storage
model. Agent control remains shell infrastructure. Add focus/resize, dock placement, or installation only when a real
editor/terminal or deployment repeats those needs.

Clinical Reanalysis is a third evidence-plane pane: it projects the latest recorded packet per case and writes
review disposition revisions to the canonical ledger. Its selected case/analysis pointer is deliberately narrow
application state shared with Evidence and Artifacts, not a generic addon message bus. The queue exposes recorded
follow-up, reanalysis, conflict, gap, and open-review reasons rather than an opaque clinical priority score.

## Typed judgment

Deterministic code should mint identifiers, parse formats, compute candidates, apply mappings, and produce diffs.
When ambiguity remains, a model or human chooses from a typed candidate set. The host validates the response,
records the decision and evidence, and can require approval before activation.

This boundary supports grounding, schema mapping, candidate disambiguation, review, and scientific interpretation
without treating generated prose as measured data. Abstention is a valid typed result when declarations do not
support a stronger conclusion.

## Method selection and self-extension

The substrate should support an actor that learns how to choose scientific methods under constraints. This is a
first-party application of machine studying, not a reason to hard-code a method recommender into core:

```text
study corpus, tool docs, data and environment descriptions
  -> action/method catalog relations
  -> candidate method or manifest authored by the actor
  -> deterministic validation and sandbox test
  -> recorded comparison, approval, and activation
  -> a revised manifest, operation, or host skill
```

This is self-extension through durable specifications, not unrestricted mutation of the substrate or silent changes
to executable capabilities. The actor may create a new manifest, operation, compute program, or skill revision. The
host validates the candidate, records its implementation/input/environment digests, runs its declared tests, and
requires the applicable typed or human approval before activation. A rejected or superseded revision remains in the
ledger as history.

The current pieces are deliberately separate and composable: study scaffolds produce `skill_draft` and other typed
notes; the action catalog is application data; manifest and SQL validators check candidates; the harness-adaptation
path validates and tests operation candidates; skill revisions use the temporal observation ledger; runs and action
cache provide execution evidence. A method-selection application should compose these pieces before asking core for a
new abstraction. Repeated friction in candidate output contracts, environment selection, or stateful kernel sessions
is the evidence that can promote the smallest missing contract.

## Host capabilities and permissions

The package records and gates effects; it is not a sandbox. By default, a host adapter runs with the permissions of
its process. Stronger boundaries require host composition such as a microVM, container, scheduler policy, credential
broker, SQL authorizer, or network proxy. Core accepts only the approved typed ports and records their receipts.

Failing closed is part of the contract. An unavailable resolver, extension, credential profile, CAS, compute
runner, or graph capability must produce an explicit unsupported result rather than silently switching execution
paths.

## Immanent abstraction from applications

Applications are not merely consumers; they are the pressure surface from which core abstractions are derived.
The movement is concrete:

1. Express the application with existing manifests, SQL, ports, and evidence primitives.
2. Observe repeated friction in two or more real uses.
3. Name the shared motion without importing either application's policy.
4. Reconcile it with existing primitives and delete the weaker boundary.
5. Promote the smallest general contract to core, with examples and tests.
6. Return both applications to the public surface and verify that no private workaround remains.

The clinical workbench exposed generic bounded HTTP fanout; that belonged in core. Its phenotype ranking, coverage
semantics, evidence reconciliation, and review policy remain application relations. This distinction is the main
defense against both TypeScript sprawl and premature framework design.

## Executable documentation

Documentation should be a woven view of executable code, not copied output. QMD examples may interleave SDK calls,
SQL, R, Python, shell, assertions, and rendered results. Scientific cells must still use the normal runner, CAS,
receipts, and ledger; `piBio.json()` is presentation, not provenance.

The proof hierarchy is:

1. contract tests for invariants;
2. executable manifest and QMD examples for public composition;
3. application runs for cross-boundary pressure;
4. live-source runs for compatibility, clearly separated from hermetic correctness;
5. prose that links to those proofs.

Generated Markdown is committed for ordinary readers. QMD is the authored source when execution is part of the
claim.

## Further reading

- [lineage.md](lineage.md): why these bets were selected and what adjacent systems do or do not prove.
- [domain-model.md](domain-model.md): the small kernel and its type admission test.
- [concurrency.md](concurrency.md): local and remote observation-store access.
- [roadmap.md](roadmap.md): current closure, success criteria, and consumer-pulled work.
- [refinments.md](refinments.md): concrete unresolved edges, not speculative features.
