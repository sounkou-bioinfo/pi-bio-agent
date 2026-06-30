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
`http.get` as the fallback), the COMPUTE pillar (`process.compute` over Arrow IPC), region-scoped
`duckhts.read_bcf`, a `duckdbInitSql` connection-init hook, and CAS-of-bytes (`src/core/cas.ts`, proven by
`http.get` byte-reuse across DBs). The items below are **not partial/owed work** and sandboxing/effect-limits are
the **host's** job, never ours. They are also where the irreducibly **human** parts cluster (judgment, approval,
curation) — see [design.md "Where the human stays in the loop"](./design.md#where-the-human-stays-in-the-loop-the-judgmentapproval-boundary).
They split by whether the consumer is named yet:
- **Named consumer = Phase 4** (so built WITH it, not speculative): **temporal anchoring** and **recording
  results/judgments as KG facts** are exactly what Phase 4's `record → activate → rollback` consumes (record =
  judgments as KG facts; activate/rollback = as-of temporality). Phase 1 and Phase 4 are linked — this leftover
  has a concrete consumer, it is just correctly sequenced behind it.
- **Consumer not yet real** (deferred by discipline): wiring process-op FILE artifacts into CAS waits on the
  `process` artifact transport (Phase 3's remainder), which waits on a real pipeline.

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
Phase 3 (DONE: table compute) Out-of-process COMPUTE: process.compute resolver (Arrow IPC, table-producing)
                 DONE with timeout/output caps, process-group kill, script-bytes provenance,
                 fail-closed-without-runner. Consumer-gated (deferred, NOT owed): the operation-level
                 `process` transport that captures FILE artifacts (waits on a real pipeline consumer).
Phase 4          Safe harness-adaptation surface: extension/spec/skill scaffold implementing
                 declare -> validate -> test -> record -> activate -> rollback. CONSUMES Phase 1's
                 leftover: `record` = judgments as KG facts; `activate`/`rollback` = as-of temporality.
```

The expertise-per-budget measurement (§2) runs continuously now that the Phase 0 skeleton exists.

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
