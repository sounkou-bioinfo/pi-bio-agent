---
type: Proposal
title: Bring-it-home plan — core substrate closure
description: "Core-library closure status after the workbench split: landed primitives, current dogfood proof, and the remaining SDK, artifact, corpus, and ducknng provenance work."
tags: [roadmap, substrate, host-events, jobs, graph-projection, artifacts, corpus, ducknng]
---

# Bring-it-home plan — core substrate closure

This document is the core-library closure plan after splitting application work into a downstream workbench. It is not
an application roadmap. The core repository owns primitives, validators, receipts, replay, CAS, the observation graph,
and host-injected effect ports. Application repositories own manifests, operation packs, report formats, review
rubrics, UI, and domain-specific pipelines.

The immediate goal is to make the substrate boringly complete: every application path should be expressible as
declared resources -> SQL/materialization -> async compute when needed -> recorded run -> observations/links -> CAS
artifacts -> replay/export. If a downstream app cannot do that without bypassing the ledger, that is a core gap. If it
can, the behavior belongs downstream.

## Closed In Core

These are not remaining work items:

- **Session traces are observation projections.** Persisted session JSONL is stored in CAS and projected into
  `session:`, `entry:`, `msg:`, `turn:`, `toolcall:`, and `cas:` facts/edges in `bio_observations`. No `session_*`
  base tables.
- **Chat-to-run stitching is a generic edge.** Controlled tool execution records `toolcall:<id> executes run:<id>` and
  `run:<id> invoked_by toolcall:<id>` using `recordObservationLink`. Transcript scanning is not part of the design.
- **Runs, memory, jobs, facts, and traces share one ledger.** The current fact, a remembered note, a job status, a
  scientific run, and a session edge are all rows in `bio_observations`, read as-of and projected to
  `bio_edges_as_of`.
- **Async execution has one lifecycle.** `AsyncRunner` is `submit/status/collect/cancel`. `ComputeRunner` and
  `JobRunner` specialize that shape; `in-memory-job-runner`, `ledger-job-runner`, and `queue-job-runner` are
  implementations, not competing lifecycles. `resumeBioJob` and `cancelBioJob` already exist.
- **Approval is a durable gate.** The Phase-4 approval path records and gates the irreducible judgment; it should be
  reused rather than shadowed with another policy-decision primitive.
- **The bring-it-home substrate pieces compose.** `npm run dogfood:bring-it-home` executes a deterministic in-core
  proof that records a host-event receipt, resumes a slash-bearing workflow step from a checkpoint, projects both a
  staged external KG and the internal observation graph through `GraphProjectionProfile`, and records a secret-free
  ducknng HTTP profile receipt. It also packs the built package, installs that tarball into a temporary TypeScript
  consumer, compiles imports, and smoke-loads runtime exports using only the public package exports
  (`pi-bio-agent`, `pi-bio-agent/core`, `pi-bio-agent/duckdb`, and `pi-bio-agent/hosts`).

## Core Work Items

### 1. Host-Event Receipts

**Goal.** Capture runtime facts that persisted transcripts cannot reconstruct: steering delivery, cancellation,
interrupts, context digests, compaction intent, model-call metadata, scheduler lease events, and similar host-side
control facts.

**Primitive.** `recordHostEvent(conn, event)` is a thin convenience over `recordObservation` plus optional
`recordObservationLink` edges:

- one scalar `host_event` fact on a caller-owned subject;
- `kind` is an open host-owned string stored as data, never a core enum;
- payloads are small structured metadata and digests, not secrets or large blobs;
- relationships to turns, model calls, runs, jobs, workflows, or artifacts are ordinary edge-like observations.

The core must not know another host's event vocabulary. A host may choose kinds such as `workbench.input.steer` or
`scheduler.lease_lost`; those names are not core semantics. If an application wants domain meaning, it records its own
domain observation explicitly.

**Done when.** The helper is exported, tested for open kinds and graph projection, and any host adapter that uses it is
thin: it records only events the host actually emits and does not infer intent from transcript text.

### 2. Workflow Step Checkpoint Convention

**Goal.** Multi-step applications resume from completed durable steps, not by replaying all application code after a
crash, compaction, lease expiry, or process switch.

The runner layer already has resume/cancel. The checkpoint convention is now a small helper over the observation
ledger, not a workflow engine.

**Shape.**

- a workflow/task node is caller-owned, for example `workflow:<id>` or `job:<id>`;
- each durable step records a `job_step_checkpoint` or equivalent step fact in `bio_observations`;
- the step result references CAS/run outputs by digest;
- resume reads completed step checkpoints and continues from the first missing step;
- code outside a step may rerun after failure, but completed step effects must not repeat.

`test/absurd-queue-push-dogfood.test.ts` already demonstrates the important behavior: a reclaimed attempt reuses a
recorded step checkpoint instead of redoing the completed step. `runJobStepWithCheckpoint` / `recordJobStepCheckpoint`
promote that repeated pattern into the narrow core surface: read the checkpoint first, run only if missing, and record
the completed value as `job_step_checkpoint`.

**Done when.** A downstream workflow uses the helper in anger, is killed mid-run, resumes against the same store,
skips completed steps from checkpoint facts, and still produces reproducible run/CAS evidence for each completed step.

### 3. SDK Surface Polish

**Goal.** Downstream applications should consume stable substrate APIs without reaching through private paths or
duplicating local types.

Likely cleanup:

- package-root or subpath exports for the host-facing types that apps already need, especially CAS/store types and
  run/job request/result types;
- a short import guide showing the intended dependency direction: app imports `pi-bio-agent` primitives, injects host
  ports, and keeps application behavior out of core;
- tests that compile a small external-style consumer against the public exports.

**Current proof.** `package.json` exposes the root, `/core`, `/duckdb`, and `/hosts` entry points. The bring-it-home
dogfood command builds `dist`, creates an `npm pack` tarball, installs that packed artifact into a temporary consumer
project, and typechecks imports of the host-facing run, CAS, job, graph-projection, reproducibility, and manifest
contracts through those public exports only. The same temp consumer then runs a Node ESM smoke import to catch
declaration/runtime export mismatches.

**Done when.** This stays consumer-driven: if a real sibling app needs a stable type and cannot import it through one
of those public entry points, add the export with a consumer compile check. Do not add private-path imports or local
copies of core contracts downstream.

### 4. Foreign Graph Projection Profiles

**Goal.** Make external knowledge graphs and association tables enter the same SemanticSQL surface as internal facts.

Use the existing `GraphProjectionProfile` shape:

- source tables -> subject/predicate/object bindings;
- CURIE/prefix rules and provenance;
- optional temporal projection;
- closure over `bio_edges_as_of` and `entailed_edge`.

This is profile work first, not a new graph subsystem. Workload-derived first-answer summaries, such as an LFS-style
projection, are a latency optimization under this item: build them only when a measured foreign-graph query workload
needs first-answer latency improvements.

**Current proof.** `test/graph-projection.test.ts` executes the same profile materializer over a staged ontology edge
fixture and over the internal `bio_edges_as_of` observation graph, then closes both with the same local
`entailed_edge` machinery. `examples/monarch-kg-http` and `test/monarch-kg-http-example.test.ts` add the production
foreign-graph slice: a real Monarch KGX TSV download over HTTP is staged by `duckdb.sql_materialize`/`httpfs` into
the canonical SemanticSQL edge columns, projected into `bio_edges`, and consumed by a manifest operation.

**Done when.** This primitive is done when the first real source runs through it, which Monarch does. Further work is
consumer-driven breadth: add a second foreign graph or attachable ontology artifact only when a workflow needs it, and
promote node/label/mapping generated views only after repeated use.

### 5. Graphics And Artifact Metadata

**Goal.** Figures and displayed images are first-class CAS artifacts, not report-only files.

Keep this as metadata on existing facts/edges:

- `media_type`;
- `semantic_role`;
- producer run or displaying session/turn/toolcall edge;
- source table/query/spec digest;
- plotting or rendering system when known.

The artifact bytes live in CAS. The generative spec or script is part of the producing run's inputs. No plot table is
needed.

**Done when.** A run-produced figure and a session-displayed image can be walked through the graph, cited by CAS
digest, rooted by GC, and replayed or honestly marked non-reproducible.

### 6. Export / Training Corpus

**Goal.** Export the ledger as a typed corpus over sessions, tool trajectories, scientific runs, artifacts, and
judgment gates. The core owns the data plane, not a training loop.

Shape:

- corpus unit = state -> request -> turn -> tool trajectory -> runs/artifacts -> judgment or correction labels;
- export is a derived query over `bio_observations`, run facts, CAS metadata, and approval facts;
- redaction/publication is an as-of projection, not a separate source of truth;
- `value_json` remains the ledger round-trip contract;
- VARIANT-shredded Parquet is the export target when useful, because it avoids raw VARIANT return through Node while
  giving external engines typed nested columns.

**Done when.** A corpus export can be read by an external engine, joins trace/run/judgment data, and has a redacted
projection with explicit receipts.

### 7. ducknng Profile Cleanup

**Goal.** Keep network capability host-owned and fail-closed.

Core should prefer ducknng profile-based HTTP for credentialed endpoints: SQL passes `profile_id`, while the host or
ducknng control plane owns admission and secret injection. Host-injected `http.get` remains a deliberate resolver port
for applications that choose it, not an implicit fallback.

**Current proof.** `registerDucknngHttpProfile` returns a secret-free profile receipt derived from ducknng's redacted
profile listing: profile id, URL/method/TLS scope, profile version/timestamps/expiry, auth header names, and a digest
of subject restrictions. Unit tests prove the receipt cannot carry token values or subject ids, while the ducknng SQL
HTTP integration tests exercise profile-based auth and subject admission when the installed extension exposes that API.
Connector runs can now accept those secret-free receipts as host capability receipts: replay pins only
`hostReceiptDigests`, run/artifact provenance references `host.capability:<schema>` by digest, and the action-cache key
changes when the host policy receipt changes. Reproduction fails closed unless the same receipt is re-supplied.

**Done when.** Credentialed HTTP examples use subject-scoped profiles with no secrets in SQL, restricted profiles are
invisible/unusable to non-admitted subjects, and workaround-shaped token plumbing is removed where profiles cover the
use case.

## Sequencing

1. **SDK surface polish.** Do this as soon as the downstream workbench imports awkward private paths; let real usage
   decide the exports.
2. **Foreign graph projection breadth only when forced.** The first real external graph source is in place through
   Monarch KGX over HTTP. Do not add a SemanticSQL generator preemptively; add source-specific staging SQL/views when
   a workflow actually reads them.
3. **Graphics metadata and corpus export.** These become valuable once runs, traces, and judgments accrue from real
   app executions.
4. **ducknng profile cleanup.** Secret-free profile receipts are pinned into connector run replay/provenance/action
   keys. Next work is rotation/refresh and subject bracketing for embedded hosts.
5. **Runtime host adapters.** `recordHostEvent` is available; add concrete Pi/workbench hook adapters only when a
   consumer reads those event receipts.

The core is "home" when downstream applications can stay boring: they declare resources and operations, inject host
ports, record runtime control receipts when needed, and read one SQL-addressable ledger for data, graph facts, runs,
jobs, sessions, artifacts, and judgments.
