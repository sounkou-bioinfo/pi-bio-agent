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

## Motivation

OpenAI's June 18, 2026 rare-disease reanalysis report is a useful external forcing function, not a product template to
clone: previously unsolved cases can become newly interpretable as gene-disease relationships, variant evidence, case
reports, and literature change. In that study, a model surfaced evidence-linked hypotheses for expert review across
376 previously unsolved cases, with 18 diagnoses established only after human review, additional testing, and clinical
confirmation (https://openai.com/index/diagnose-rare-childhood-diseases/). The core lesson here is generic: scientific
value sits in evolving ecosystems of packages, statistical methods, data formats, ontologies, knowledge graphs, and
papers. In life sciences, much of that accumulated practice already lives in the R/Bioconductor ecosystem and its
literature trail. The library's job is to make that practice accessible as declared, replayable, queryable workflows
with receipts, CAS artifacts, environment attestations, and explicit judgment gates.

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
- **Compute environments are declared and observed as receipts.** `compute.run` records declared-vs-observed
  `EnvDescriptor` attestation. `withObservedEnvironment` lets a host attach known runtime/package state, such as an
  `renv.lock` digest or package snapshot, to any compute backend without adding an R-specific runner or probing the
  child process. `envDescriptorFromRenvLock` maps a common R/Bioconductor lockfile into that same generic descriptor:
  exact lock bytes are pinned as a `package_lock` layer, while package/version records are projected as an inspectable
  `package_snapshot`.
- **Approval is a durable gate.** The Phase-4 approval path records and gates the irreducible judgment; it should be
  reused rather than shadowed with another policy-decision primitive.
- **The bring-it-home substrate pieces compose.** `npm run dogfood:bring-it-home` executes a deterministic in-core
  proof that records a host-event receipt, resumes a slash-bearing sequential workflow plan from checkpoints, parses an
  `renv.lock` into an `EnvDescriptor`, runs a tiny R `compute.run` step with matching declared/observed environment
  attestation, projects both a staged external KG and the internal observation graph through `GraphProjectionProfile`,
  and records a secret-free ducknng HTTP profile receipt. It also links a Pi-shaped session tool call to a scientific
  run, exports the derived digest-only corpus tables to Parquet, reads the exported corpus back through DuckDB, packs
  the built package, installs that tarball into a temporary TypeScript consumer, compiles imports, and smoke-loads
  runtime exports using only the public package exports
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

**Current proof.** The helper is exported from the public package surface and tested for open host-owned kinds,
stable identity, fail-closed link validation, and ordinary graph projection through `bio_edges_as_of`. The
bring-it-home dogfood records a `workbench.input.steer` receipt with two links, and the training-corpus export reads
host events into the digest-only corpus without learning a host taxonomy.

**Done when.** The core primitive is done. Remaining work is adapter-owned: a Pi, workbench, or scheduler adapter may
record only events that the host actually emits, and must not infer runtime intent from transcript text.

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
recorded step checkpoint instead of redoing the completed step. `runJobStepWithCheckpoint`,
`runJobStepsWithCheckpoints`, and `recordJobStepCheckpoint` promote that repeated pattern into the narrow core surface:
read checkpoints first, run only missing sequential steps, and record completed values as `job_step_checkpoint`.
Step dependencies are not inferred; a step declares its real dependency by reading earlier checkpoint values through
the helper context, or by recording explicit graph edges in the application/workflow layer.

**Current proof.** The focused tests prove a sequential plan reuses a completed prefix checkpoint after restart and
fails closed when a step asks for a missing/future checkpoint. The Absurd-style queue dogfood proves the distributed
case: attempt 1 records an `extract` step, its lease expires, attempt 2 reclaims the job, reuses the checkpoint without
rerunning extraction, records the next step, and completes through the same live-claim-gated status/result slots. The
bring-it-home dogfood uses the public helper on a slash-bearing step id and verifies the resumed execution counts.

**Done when.** The core convention is done. Remaining work is consumer-owned: real applications should use these
helpers for staged workflows, keep step bodies idempotent around the checkpoint boundary, and attach run/CAS evidence
inside each durable step where their domain requires it.

### 3. SDK Surface Polish

**Goal.** Downstream applications should consume stable substrate APIs without reaching through private paths or
duplicating local types.

Likely cleanup:

- package-root or subpath exports for the host-facing types that apps already need, especially CAS/store types and
  run/job request/result types;
- `wrapSqlConn` for host-owned SQL policy over the same execution port, so relation visibility, no-external-I/O
  profiles, query audit, or subject-scoped deployment rules are composition instead of a second hook framework;
- a short import guide showing the intended dependency direction: app imports `pi-bio-agent` primitives, injects host
  ports, and keeps application behavior out of core;
- tests that compile a small external-style consumer against the public exports.

**Current proof.** `package.json` exposes the root, `/core`, `/duckdb`, and `/hosts` entry points. The bring-it-home
dogfood command builds `dist`, creates an `npm pack` tarball, installs that packed artifact into a temporary consumer
project, and typechecks imports of the host-facing run, CAS, job, graph-projection, reproducibility, and manifest
contracts through those public exports only. The same temp consumer then runs a Node ESM smoke import to catch
declaration/runtime export mismatches. The host-policy test now uses the exported `wrapSqlConn` helper to prove that
no-external-I/O and subject-scoped relation visibility are host-owned port policies, including `DESCRIBE`/`SUMMARIZE`
over hidden relations and common catalog disclosure channels, not new `bio_query` statement classes.

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

**Current proof.** `recordArtifactReference` records the shared shape: intrinsic byte metadata as a `cas:<digest>`
artifact fact, and reference context as a caller-owned edge such as `run:<id> produces cas:<digest>` or
`toolcall:<id> displays cas:<digest>`. Session image ingestion uses the same helper. The focused artifact test proves
graph-walkability and ledger-aware GC rooting; the training-corpus test proves run-produced figure metadata
(`source_digest`, `spec_digest`, `plotting_system`) flows into the exported corpus.
Run persistence also closes the shared-CAS root path: when a host supplies `casMetadata` on the run ledger's SQL
authority, result/receipt/replay and run-object bytes are recorded as `cas_object` rows and rooted by `cas_ref` rows
under `run:<id>`, so metadata-driven GC does not depend on run-directory files.

**Remaining.** Consumer-driven renderer coverage only: richer figure/report metadata should be added when the
workbench path emits real R/Python/HTML artifacts, not as a plot taxonomy in core.

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

**Current proof.** `materializeTrainingCorpus` derives fixed digest-only temporary corpus tables from the existing
`bio_observations` ledger: sessions, messages, turns, tool calls, runs, artifacts, host events, approval/judgment
facts, and per-turn training units. `exportTrainingCorpusParquet` writes those tables as Parquet and returns a receipt
with row counts and file digests. `test/training-corpus.test.ts` seeds a composed ledger (session trace, tool->run
link, run fact, image artifact, host event, and approval gate), proves the export joins those surfaces without
inlining private text or clobbering persistent caller tables, and reads the Parquet files back. `npm run
dogfood:bring-it-home` exercises the same export in the combined substrate proof.

**Done when.** The core slice is done. Follow-on work is consumer-owned: private payload hydration, redaction policy,
publication review, and VARIANT-shredded Parquet when a real downstream corpus consumer benefits from nested typed
columns. The ledger contract remains `value_json`; VARIANT is an export format choice, not the base store.

### 7. ducknng Profile Cleanup

**Goal.** Keep network capability host-owned and fail-closed.

Core should prefer ducknng profile-based HTTP for credentialed endpoints: SQL passes `profile_id`, while the host or
ducknng control plane owns admission and secret injection. Host-injected `http.get` remains a deliberate resolver port
for applications that choose it, not an implicit fallback.

**Current proof.** `registerDucknngHttpProfile` returns a secret-free profile receipt derived from ducknng's redacted
profile listing: profile id, URL/method/TLS scope, profile version/timestamps/expiry, auth header names, and a digest
of subject restrictions. Subject allow-lists are normalized as sorted unique sets before registration and receipt
digesting, so the policy surface is set-shaped rather than caller-order-shaped. Unit tests prove the receipt cannot
carry token values or subject ids, while the ducknng SQL HTTP integration tests exercise profile-based auth and subject
admission when the installed extension exposes that API.
Connector runs can now accept those secret-free receipts as host capability receipts: replay pins only
`hostReceiptDigests`, run/artifact provenance references `host.capability:<schema>` by digest, and the action-cache key
changes when the host policy receipt changes. Reproduction fails closed unless the same receipt is re-supplied. Known
ducknng profile receipts are self-checked before use: their `policyDigest` must match the canonical digest of the
redacted receipt body, and raw subject lists or extra secret-bearing fields are rejected.
`refreshDucknngHttpProfile` covers the rotation seam without a drop/register gap: the host refreshes credential
material, re-commissions the same profile id through ducknng's upsert path, and receives previous/current redacted
receipts. Tokens remain host-owned bound parameters, never SQL text or replay data. The bring-it-home dogfood now
exercises this helper contract against a fake `SqlConn`: it commissions and rotates a subject-restricted profile,
pins the rotated receipt into a run, and proves replay/reproduce use only the receipt digest. No current example
teaches agent-visible secret headers or bearer tokens in manifest SQL. The remaining `http.get` + `withAuth` examples
are deliberately the separate JS-fetch resolver path for hosts that choose it; they are not profile-auth workarounds.
Real ducknng runtime profile admission is still covered by the gated SQL HTTP tests when the installed extension
exposes that API. A gated local ducknng runtime fixture also exercises `tls+tcp://` RPC with a host-provisioned
self-signed TLS handle, mTLS client-certificate rejection, and exact peer-identity allow-list admission/denial.

**Done when.** The core profile receipt path is done for this repository. Remaining work is either upstream in
ducknng or consumer-owned:

- ducknng may add a host-only embedded subject bracket so an embedding service can execute a query as subject X
  without relying on the current service/session execution-subject mechanism;
- a credentialed downstream app should use scoped profiles for SQL-native HTTP and pin the returned receipt digest
  into run replay/provenance;
- if a host needs relation/resource visibility, it should scope the injected `SqlConn` or ducknng service profile so
  hidden objects are unreachable through ordinary reads and catalog/introspection statements. Core should not add a
  special `DESCRIBE`/`SUMMARIZE` hiding rule.

## Sequencing

1. **SDK surface polish.** Do this as soon as the downstream workbench imports awkward private paths; let real usage
   decide the exports.
2. **Foreign graph projection breadth only when forced.** The first real external graph source is in place through
   Monarch KGX over HTTP. Do not add a SemanticSQL generator preemptively; add source-specific staging SQL/views when
   a workflow actually reads them.
3. **Graphics metadata.** The corpus export now carries artifact CAS rows and display/produce references. The
   remaining work is richer run-produced figure metadata when a downstream report path needs it.
4. **ducknng profile cleanup.** Secret-free profile receipts are pinned into connector run replay/provenance/action
   keys, refresh/rotation uses the same ducknng upsert receipt path, and subject restrictions are canonicalized before
   registration. Next work is downstream/upstream: real credentialed apps should use the profile path instead of
   ad-hoc token plumbing, and an embedded subject bracket belongs in ducknng first because the current subject
   mechanism is service/session-bound.
5. **Runtime host adapters.** `recordHostEvent` is available; add concrete Pi/workbench hook adapters only when a
   consumer reads those event receipts.

The core is "home" when downstream applications can stay boring: they declare resources and operations, inject host
ports, record runtime control receipts when needed, and read one SQL-addressable ledger for data, graph facts, runs,
jobs, sessions, artifacts, and judgments.
