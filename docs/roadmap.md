---
type: Reference
title: Roadmap, success, and testing contract
description: "Read before planning roadmap, success metrics, tests, or flagship work."
tags: [roadmap, testing, success, flagship]
---

# Roadmap, success, and testing contract

Decisions, not aspirations. This file is the spine: what we are building, the one claim that can
falsify it, how we test, the flagship that exercises everything, the phase order, and the doctrine for
how the harness is allowed to change.

## 1. What we are building

A **dynamic biomedical agent harness over a typed DuckDB graph substrate** — not a bio plugin. The
layers, and what each is *for*:

```text
typed graph substrate   durable domain + harness structure (graph-as-SQL over DuckDB)
operation specs/clients  controlled ways to touch outside data/tools (adapters + ingestion)
code runtime             bounded composition layer over scoped clients (later)
Pi extensions/skills     the safe harness-adaptation boundary
study notes              machine-studying ingress into the graph
skills                   stabilized-workflow packaging
```

**The harness records itself in the same graph — carefully scoped.** Harness *capabilities, adapters,
specs, skills, runs, artifacts, and extension declarations* are represented in the same graph substrate
as domain facts (`extension —declares→ tool`, `tool —implements→ BioToolSpec`, `run —produced→
artifact`, `skill —derived_from→ study-note`, `operation —requires→ network-policy`). **Executable code
still lives in package files / CAS / artifacts** — the graph records *declarations, provenance,
dependencies, activation, and outputs*, not the running code itself. This makes the harness
*inspectable as graph data* without making the graph the executor. See
[`ontology-and-knowledge-graphs.md`](./ontology-and-knowledge-graphs.md#the-graph-bet-the-domain-wager).

## 2. Falsifiable success (the headline)

Capabilities are **enabling contracts and safety gates, not co-equal success metrics.** There is one
falsifiable claim, and it is the spine of the project:

> Does the graph/notes/harness substrate let the agent produce **better-supported answers with less
> inference/tool budget** than a baseline?

This is a **gated objective**. Gates first — a run that fails any of these is a failure regardless of its
score:

```text
provenance correct
no unsupported biomedical claims
no diagnosis / clinical-recommendation framing
reproducible run receipt
explicit sources / evidence
bounded tool / code behavior
```

Then, and only then, **measure**: accuracy or evidence-quality **per token / tool-call / wall-clock
budget**, against a baseline without the notes/graph substrate. The enabling capabilities — study a
corpus, represent it structurally, compose tools without hallucinating, adapt the harness safely — are
the means; the cost-curve is the evidence they were worth it. (This is the
[machine-studying](./machine-studying-lineage.md) framing made operational.)

## 3. Testing contract

A pyramid, plus a conformance cross-cut. Layers 1–3 substantially exist today; 4–6 do not.

1. **Pure contract tests** — validators/projections (`BioToolSpec`, `BioOperationSpec`,
   `ResourceHandle`, `StudyNote`, `studyNoteGraph`, ontology/KG helpers, interval/variant primitives).
   Deterministic, fail-closed, no I/O.
2. **SQL/KG tests** — schema DDL, constraints, indexes, dangling links, external-inbound guard, report
   limits, read-only SQL validation. Both a fake `SqlConn` and a real in-memory DuckDB.
3. **Effect tests** — real local effects: filesystem notes, CAS paths, run ledger, DuckDB sync, CLI
   commands. No ambient env/process activation; explicit write flags.
4. **Operation-pack tests** — API clients: mock-network by default, request-shape golden tests,
   cache-key/provenance tests. Live integration only via explicit config/CLI arg, never hidden activation.
5. **Flagship fixture tests** — synthetic project in, expected graph/run/report out (see §4). Assert
   *structure, provenance, and safety framing*, plus bounded tool-calls/time — **not** free-form prose.
6. **Harness-adaptation tests** — a generated extension/spec/skill ships a manifest, declares its
   tools/effects, passes static validation (no undeclared network/filesystem/raw-DB), carries unit
   tests, survives an install/reload smoke test, and has a rollback path. **The agent may propose; CI
   decides whether it becomes real.**

**Conformance cross-cut** (asserted across layers, not a single layer): no provider-specific shape in
core; resolvers fail closed; no ambient network/env activation; writes gated behind explicit flags.

## 4. Flagship: "rare high-impact variants" walking skeleton

The flagship is a **forcing function landed early**, not a finale, and it has a concrete, public target.
It comes straight from the project's origin (ClawBio, a per-question skill-sprawl agent): the question
*"how many rare high-impact variants do I have?"* there required hand-writing a skill, and the hard part
turned out to be **abstention** — a naive count over-called (~110), but once you refuse to call
"no frequency data" rare, the defensible number collapses (~6 documented-rare LoF, 1 disease-relevant).

That is **why this is the flagship**: it exposes both bets at once — *substrate over skill sprawl*
(the count is one SQL filter over annotated variants, not a bespoke skill) and the *abstention/safety
gate* (no-frequency ≠ rare; benign LoF ≠ actionable; unsupported claims are excluded). It is intentionally
tiny — **composition pressure, not clinical realism**:

```text
3 synthetic variants  (one no-frequency, one benign LoF, one documented-rare disease-relevant)
1 mocked annotation table (frequency + consequence; duckhts-shaped, so the real reader drops in)
1 note with the abstention caveat
1 SQL filter: rare ∧ high-impact ∧ frequency-known   (a query, not a skill)
1 run record + provenance
1 result (the count via SQL GROUP BY) + caveats as operation notes; what was excluded and why
```

No live APIs, no full ACMG engine, **no diagnosis language**. It forces the whole substrate to compose:
resolvers → DuckDB tables, the operation's SQL → the answer, run record + resolution receipts → provenance.
The test asserts the **abstention** (the count excludes no-frequency variants and says so), structure,
provenance, and stability — not free-form prose.

## 5. Phases (walking skeleton first)

Inverted from substrate-first: a thin flagship lands early and stays green as substrate thickens behind it.
**Current position:** the flagship is built (manifest #1) and `runOperation` produces run records + results +
resolution receipts; the host tool `bio_run_operation` persists `run/result/receipts` under
`.pi/bio-agent/runs/`. So `BioRunSpec`/`BioRunRecord`, `Provenance`, `BioOperationSpec`, and the
resolver/registry all have **real producers**. Since built out: the SQL-native NETWORK path
(`ducknng_ncurl_table` in `sql_materialize`; the `ols4-grounding` + `variant-annotation` examples ship, with
`http.get` as the fallback) plus the **owned ducknng** stack (we dropped quack; per-DuckDB-version backport
branches + the volatile-scalar `ncurl` fix → `ncurl-retry`'s SQL-native recursive-CTE retry), the COMPUTE pillar
(`process.compute` over Arrow IPC, nanoarrow + argv + errors-as-values), region-scoped `duckhts.read_bcf`, a
`duckdbInitSql` connection-init hook, CAS-of-bytes (`src/core/cas.ts`), and **the two-pillar coloc flagship**
(`examples/coloc`, multi-tissue post-GWAS colocalization, DATA harmonization + out-of-process R `coloc.abf`).
Docs are kept honest by **literate generation** (`npm run readme:examples` runs the manifest; `check:examples`
fails on drift). The items below are **not partial/owed work** and sandboxing/effect-limits are
the **host's** job, never ours. They are also where the irreducibly **human** parts cluster (judgment, approval,
curation) — see [design.md "Where the human stays in the loop"](./design.md#where-the-human-stays-in-the-loop-the-judgmentapproval-boundary).
They split by whether the consumer is named yet:
- **Named consumer = Phase 4** (so built WITH it, not speculative): **temporal anchoring** and **recording
  results/judgments as KG facts** are exactly what Phase 4's `record → activate → rollback` consumes (record =
  judgments as KG facts; activate/rollback = as-of temporality). Phase 1 and Phase 4 are linked — this leftover
  has a concrete consumer, it is just correctly sequenced behind it.
- **Consumer not yet real** (deferred by discipline): wiring process-op FILE artifacts into CAS waits on the
  `process` artifact transport (Phase 3's remainder), which waits on a real pipeline.

**These are ONE thing — the coloc flagship unifies them.** The "real pipeline" the artifact transport waits on
**is** post-GWAS colocalization ([`examples/coloc/`](../examples/coloc/README.md)). Its WALKING SKELETON is
**built** (multi-tissue `coloc.abf` over Arrow IPC, DATA harmonization + COMPUTE), so the unification is now
concrete: **thickening** coloc drives the rest — multi-output / file-producing `ColocEngine` runs force the
`process` artifact transport (#3, Phase-3 remainder), and recording its per-tissue posteriors as time-versioned
KG facts is Phase-4's `record` (#2). So the deferred items are not speculative — they are **built as coloc
thickens**, the anti-idealist "a real consumer forces it" rule made literal (the consumer now exists).

```text
Phase 0 (done)   Flagship walking skeleton: manifest #1, runOperation -> run/result/receipts, host
                 persistence. Three contracts became real producers.
Phase 1 (DONE)   Run/provenance substrate: run+receipt persistence DONE; CAS-of-bytes DONE
                 (src/core/cas.ts + fs-cas.ts, http.get byte-reuse across DBs). Leftover: temporal
                 anchoring + KG-fact recording are CONSUMED BY PHASE 4 (built with it, not speculative);
                 process-op FILE artifacts -> CAS waits on the Phase 3 artifact transport.
Phase 2 (DONE)   Network is SQL-native: ducknng_ncurl_table inside duckdb.sql_materialize composes the
                 URL/headers/body in SQL and parses JSON -> table with NO TS resolver (ols4-grounding GET +
                 variant-annotation POST both ship). http.get (src/duckdb/resolvers/http-table-scan.ts) is
                 the fallback for a no-ducknng build + the multi-request retry/fanout seam; fetch is
                 INJECTED (fail-closed, host opt-in). Two-tier grounding proven (projection + judgment).
Phase 3 (DONE: table + file artifacts) Out-of-process COMPUTE: process.compute resolver (Arrow IPC,
                 table-producing) DONE with timeout/output caps, process-group kill, script-bytes
                 provenance, fail-closed. FILE OUTPUTS now built too (process-artifacts example): declared
                 `outputs` captured into CAS, content-addressed, recorded in the receipt — values in the
                 IPC, files beside it (the nf-r-ipc/Nextflow split). FILES-ONLY ops now built too
                 (`resultTable:"artifacts"`, process-files-only example): a tool that returns no table —
                 no inputSql, no out.arrow, no Arrow codec loaded — just writes files; the resource's TABLE
                 is the captured-artifacts listing (name/path/kind/digest/size), each a CAS handle. Remaining:
                 the long-running operation-level `process` transport (multi-output batch).
Phase 4 (ACTIVE — the main lane) Safe harness-adaptation surface: extension/spec/skill scaffold
                 implementing declare -> validate -> test -> record -> activate -> rollback. CONSUMES
                 Phase 1's leftover: `record` = judgments as KG facts; `activate`/`rollback` = as-of
                 temporality. DONE: 4.0a (bio_observations temporal store + as-of), 4.1 (coloc records
                 judgments), 4.2 (activate/rollback), 4.3 (declare->validate->test->record->activate, GENERIC),
                 4.4 (DURABLE approval: submit parks a validated+tested candidate as `approval="pending"`, decide
                 resumes it later — across a restart/human delay — approving+activating or rejecting; a decision
                 is terminal; park+resume is a temporal observation, "candidates awaiting approval as-of t" an
                 as-of query). The substrate is the loop; examples (coloc, …) are interchangeable DATA — never a
                 shape it bends toward (the bet). The substrate owns park+resume ONLY — RBAC/quorum/notification/
                 UI/identity stay the HOST's. Remaining: a 2nd producer when a real one exists.
```

The expertise-per-budget measurement (§2) runs continuously now that the Phase 0 skeleton exists.

### Phase 4 plan (walking skeleton first)

The governance loop `declare → validate → test → record → activate → rollback`, built thinnest-first. The
foundation is the **temporal provenance statement** — receipts already carry source + digest + time, and Phase 4
promotes selected results/judgments and activation events into **`bio_observations`** (append-only, as-of-versioned),
whose edge-like rows project into graph shape as of time t. `bio_edges` stays the atemporal compiled graph. The
irreducible **human** stays
at `activate` (the approval gate) — the substrate provides the rails (record + as-of + the state machine), the
sign-off is hosted, not computed ([design.md "Where the human stays in the loop"](./design.md#where-the-human-stays-in-the-loop-the-judgmentapproval-boundary)).

Each slice is end-to-end and deterministic-tested; build the foundation only as the next slice consumes it.

- **4.0 — Temporal provenance-statement store (the Phase-1-leftover foundation).** Keep `bio_edges` **atemporal
  + UNIQUE-per-triple** (it's the compiled navigation graph + the closure source); the temporal layer is a NEW
  append-only **`bio_observations`** table (the docs already name it as the "true-on-date-X, superseded-by-Y"
  store). `record(conn, obs)` appends a result/judgment as a time-stamped, content-addressed
  observation/statement row carrying a **`statement_key`** (the state SLOT a later row supersedes — NOT the full
  triple: activation changes the object `v1→v2`, a coloc `PP.H4` changes the value), plus `subject_id,
  predicate, object_id?, value?, recorded_at, valid_from?, valid_to?, source, digest, attrs, trust`. `asOf(t)` =
  **latest row per `statement_key`** where `recorded_at ≤ t` (and valid interval contains t). Edge-like rows
  (`object_id` set) **project into `bio_edges_as_of(t)`**, and `entailed_edge` materializes over that projection
  (generalize `materializeEntailedEdges` to take a source/target table). record = append; current = latest as-of;
  rollback = append a row pointing at an older version — event-sourcing, not mutable state. Defer the strict-`now`
  refactor (the ~46-test ripple) — tests pass explicit `recordedAt`, the host defaults it via the existing
  injected `now`. Driven by 4.1. **BUILT (4.0a):** `src/duckdb/observations.ts`
  (`createBioObservationSchema`/`recordObservation`/`observationsAsOf`/`materializeBioEdgesAsOf`/`entailedEdgesAsOf`)
  + `test/observations-as-of.test.ts` (supersession across a changing object/value, duplicate-triple-allowed,
  idempotency, the as-of edge closure); `materializeEntailedEdges` generalized to take a source/target table.
- **4.1 — Record a real judgment. BUILT.** `coloc` is the producer: every per-tissue posterior is a scalar
  observation (`coloc:posterior:PP.Hk`) and the high-PP.H4 tissue becomes the edge `tissue
  ←shares_causal_variant_with← gwas_locus` (projecting into `bio_edges_as_of`). `test/coloc-record.test.ts` —
  4.1a deterministic (no R, non-skipped) + 4.1b the real `examples/coloc` run. **The recorder is GENERIC**
  (`recordObservation`); coloc is *one* producer (a manifest), not a shape the substrate is built toward — any
  other producer (a categorical classifier, an abstaining call, …) is just more data through the same primitive.
- **4.2 — The activate/rollback state machine. BUILT.** `src/duckdb/activation.ts` (`recordActivation` /
  `activeOperationAsOf` / `rollbackOperation`) — a thin wrapper over `recordObservation`: `statement_key =
  activation:operation:<id>`, the current active version is latest-as-of, `rollback` **appends** the prior
  version (never mutates), `trust.provenanceClass = "attested"`. `test/activation-as-of.test.ts` (5 cases).
- **4.3 — The declare → validate → test → record → activate happy path. BUILT.** `src/hosts/harness-adaptation.ts`
  `runCandidateActivation(conn, candidate, deps)`: validate (`validateReadOnlySelect`) → run the candidate over its
  fixture in a SANDBOX → record validation + test status as observations → activate **iff both pass AND an injected
  approval policy approves** (the human/policy boundary — "tests pass" is NOT "production activation"). The
  candidate is **GENERIC DATA** (an operation spec + fixture + expected), deliberately *not* a bio example — the
  substrate is the loop, the examples are interchangeable. `test/harness-adaptation.test.ts`: good→activates,
  wrong-expected→recorded-failed-no-activation, non-read-only→validation-fails, **approval-rejects→not activated**.
- **4.4 — Rollback + the approval gate (DURABLE). BUILT.** Revert to a prior active version (as-of) via
  `recordActivation(reason:"rollback")`. The `activate` decision is the host/human **policy gate** (the boundary).
  The substrate owns only what is substrate-shaped: **park + resume**. `submitCandidateForApproval` validates +
  tests + records `approval="pending"` (a temporal observation); `decideCandidateApproval` resumes it LATER (a
  distinct, strictly-later timestamp = a process restart / a human delay), recording approved/rejected and
  activating iff approved. A decision is **terminal** (no double-approve); deciding a candidate that didn't pass
  validation+test, or was never submitted, **fails closed**. "Candidates awaiting approval as-of t" is an as-of
  query over the `approval` slot. `runCandidateActivation` stays the synchronous convenience wrapper (no time gap
  → no `pending` row). What stays the HOST's (NOT built, by discipline): RBAC, quorum, notifications, a task
  queue, an identity provider, any approval UX — `src/hosts/harness-adaptation.ts`.

Discipline: do NOT build the full state machine (4.2) or the loop (4.3) ahead of 4.0/4.1; each slice earns the
next. The forbidden/allowed table in §6 is the invariant every slice must already satisfy.

### Reproducibility + long-running execution (the C/L lane) — LIBRARY obligations, not example-driven

Reproducibility and long-running tasks are DOMAIN-INHERENT library goals (bioinformatics jobs run for hours; a
6-hour result that can't say what produced it is a weak receipt) — so by "library facilities must be correct, not
consumer-gated" they are required, not deferred. Built interleaved: **C1 → L1 → C2 → L2/L3** (C1 makes a job worth
running; L1 gives reproduce() a job-shaped target; C2 validates it; L2/L3 make it durable + cancellable).

- **C1 — environment identity + replay seed. BUILT.** `src/core/reproducibility.ts`: a RUNTIME-AGNOSTIC
  `EnvDescriptor` (composite LAYERS — platform/executable/package_lock/package_snapshot/container_image/duckdb/
  module; containers/conda/micromamba/renv are equal citizens, none privileged), deterministic `envDigest`,
  explicit `unknown` (never a fake pin), and an `EnvironmentAttestation` (declared-vs-observed + drift status).
  `ProcessRunner.describeEnvironment?` (optional probe; `nodeProcessRunner` returns a minimal observed descriptor,
  no version shell-out); `process.compute` records the attestation in provenance (`env_status:…`). Every run seeds
  **`replay.json`** — the ACTUAL replay inputs (authored manifest snapshot + resolved process facts, sql/params) so
  C2 can re-execute, not just compare digests. Does NOT execute anything (no micromamba/container run — C2/host).
- **L1 — async JobRunner skeleton.** A `JobRunner` port (submit/status/collect/cancel) over the existing
  `BioRunRecord` (queued/running/waiting/succeeded/failed/cancelled) + job-status observations (`job:<runId>:status`
  as an as-of slot — the SAME temporal substrate as Phase 4). In-memory fake first; outputs → CAS. No NNG, no cancel yet.
- **C2 — reproduce().** Re-execute `replay.json` + env attestation, diff result/artifact digests →
  reproduced/diverged/**not_reproducible** (honest: unknown env / missing snapshot / un-snapshotted live source →
  not_reproducible WITH reasons, never fake confidence).
- **L2/L3 — durable job store/resume + cancellation** (process-group kill already exists in `node-process-runner`).

What stays the HOST's (NOT built): micromamba/conda/renv/container EXECUTION, a cluster/queue JobRunner adapter
(SLURM/k8s — a host adapter like `nodeProcessRunner` is the local one), scheduler, semantic env compatibility.

### Later (a separate lane, not core): NNG host capabilities — compute distribution + `ducknng-fs`

A **note, not a build** — deferred until a real cross-machine/worker-pool consumer forces it (the anti-idealist
rule). Two capabilities that are **unrelated as abstractions** but **merge as a host SERVICE**, never as a
substrate concept:

- **Storage/namespace** (`ducknng-fs`): `path → metadata → digest/bytes` — a DuckDB `fs_node` metadata graph over
  ducknng RPC + CAS bytes + a future FUSE host-port (the Latch Data split: metadata DB + object bytes + FUSE; the
  `scripts/ducknng-fs.mjs` dogfood proves the storage half). A *systems* lane (consistency races, chunked/partial
  reads, deletion races, reconciliation) — kept later.
- **Execution/control** (pure NNG process calling): `command + env + inputs → exit/status/logs/outputs`. Slots
  behind the **existing `ProcessRunner` port** — no new core type.

Build order (each a HOST capability, injected, interpreting existing declarations — like `nodeProcessRunner`):
1. **`nngProcessRunner`** — implements `ProcessRunner` over NNG (sends `ProcessRunSpec`, returns
   `ProcessRunResult`). First slice assumes a **shared run dir / CAS**, so `process.compute`'s Arrow-file +
   argv-paths contract is **UNCHANGED**. The first proof is about the *runner seam* (echo-like worker), not biology.
2. **`process.nng_compute`** — later, **pure Arrow-over-NNG** (controller sends Arrow IPC bytes + command; worker
   returns Arrow output bytes + logs/status). Removes the shared-filesystem requirement → true cross-machine.
   Needs a NEW adapter surface (it owns the Arrow bytes) — do NOT mutate the clean `ProcessRunner`.
3. **`ducknng-fs` host-port** + optional **`nng-host` daemon** exposing `fs.*` + `proc.*` over one
   transport/auth/sandbox boundary.

**GUARDRAIL:** process calling must NOT depend on the filesystem *conceptually* (`proc.run` is never a method on
the fs). The fs is a **staging convenience**; the execution model stays: manifest declares compute → host injects
runner → runner executes → resolver materializes output → run/receipt/observation records what happened.

## 6. Harness-adaptation doctrine (mods vs hooks)

Extending the harness is **core to the Pi lineage** — Pi packages, extensions, custom tools, skills,
prompts, provider registration, reload/install boundaries. `pi-bio-agent` inherits that and makes it
biomedical-safe and provenance-aware. But the lineage is **agent-mediated extension through explicit
harness surfaces, not arbitrary self-mutation.** This is the answer to "what happens when you update
your harness and it's hacked to pieces?":

> **Safe adaptation is declarative, validated, reversible, recorded, and never edits core in place.**

Core updates happen through package / git / update mechanisms. Agent-authored changes enter only as
specs, skills, operation packs, or extensions — with tests and reload boundaries.

```text
bad (forbidden)                          good (the only path)
  edit core runtime files in place         propose a declared extension/spec/skill
  monkey-patch tools                       validate it (fail-closed contract)
  silently change execution behavior       test it (CI gates it)
  hidden env/process activation            record it in graph/run provenance
                                           activate it at a boundary (/reload, install, CLI flag)
                                           remove / roll it back
```

**This is a design invariant now, not a Phase-4 add-on.** Every new surface must already be compatible
with `declare → validate → test → record → activate → rollback`, even before the adaptation tooling is
built.
