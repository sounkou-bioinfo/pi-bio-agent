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

A **library for agent-controlled scientific computation over a typed DuckDB graph substrate**, with biomedical
workflows as the first domain.

```text
typed graph substrate    durable domain + harness structure (graph-as-SQL over DuckDB)
operation specs/clients   controlled ways to touch outside data/tools
code runtime              bounded composition over scoped clients (later)
Pi extensions/skills      the first host-adapter and harness-adaptation surface
study notes               machine-studying ingress into the graph
skills                    stabilized-workflow packaging
```

**The harness records itself in the same graph: carefully scoped.** Capabilities, adapters, specs,
skills, runs, artifacts, and extension declarations live as facts alongside domain data (e.g.
`manifest —provides→ operation`, `run —produced→ artifact`). Executable code still lives in package
files / CAS / artifacts: the graph records declarations, provenance, dependencies, activation, and
outputs, not the running code. Inspectable as graph data without the graph becoming the executor. See
[`ontology-and-knowledge-graphs.md`](./ontology-and-knowledge-graphs.md#the-graph-bet-the-domain-wager).

## 2. Falsifiable success (the headline)

Capabilities are enabling contracts and safety gates, not co-equal success metrics. There is one
falsifiable claim, and it is the spine of the project:

> Does the graph/notes/harness substrate let the agent produce **better-supported answers with less
> inference/tool budget** than a baseline?

This is a **gated objective**. Gates first: a run that fails any of these fails regardless of score:

```text
provenance correct
no unsupported biomedical claims
no diagnosis / clinical-recommendation framing
reproducible run receipt
explicit sources / evidence
bounded tool / code behavior
```

Only then **measure**: accuracy or evidence-quality **per token / tool-call / wall-clock budget**,
against a baseline without the notes/graph substrate. The enabling capabilities are the means; the
cost-curve is the evidence they were worth it. (The
[machine-studying](./machine-studying-lineage.md) framing, made operational.)

## 3. Testing contract

A pyramid plus a conformance cross-cut. Layers 1–3 substantially exist today; 4–6 do not.

1. **Pure contract tests**: validators/projections. Deterministic, fail-closed, no I/O.
2. **SQL/KG tests**: schema DDL, constraints, dangling links, external-inbound guard, read-only SQL
   validation. Fake `SqlConn` and real in-memory DuckDB.
3. **Effect tests**: real local effects (notes, CAS, run ledger, DuckDB sync, CLI). No ambient
   activation; explicit write flags.
4. **Application-operation tests**: API clients: mock-network by default, request-shape goldens, provenance.
   Live integration only via explicit config/CLI arg.
5. **Flagship fixture tests**: synthetic project in, expected graph/run/report out (§4). Assert
   structure, provenance, safety framing, bounded tool-calls/time, **not** prose.
6. **Harness-adaptation tests**: a generated extension/spec/skill ships a manifest, declares its
   effects, passes static validation, carries tests, survives install/reload, and rolls back.
   **The agent may propose; CI decides whether it becomes real.**

**Conformance cross-cut** (asserted across layers): no provider-specific shape in core; resolvers fail
closed; no ambient network/env activation; writes gated behind explicit flags; application connectors and
case-workflow code must go through manifests, resolvers, operations, and recorded runs rather than bypassing the
substrate.

## 4. Flagship: "rare high-impact variants" walking skeleton

A forcing function landed early, not a finale, with a concrete public target. From the project's origin
(ClawBio, a per-question skill-sprawl agent): *"how many rare high-impact variants do I have?"* required
hand-writing a skill, and the hard part was **abstention**: a naive count over-called (~110), but once
you refuse to call "no frequency data" rare, the defensible number collapses (~6 documented-rare LoF, 1
disease-relevant).

It exposes both bets at once: *substrate over skill sprawl* (the count is one SQL filter over annotated
variants) and the *abstention/safety gate* (no-frequency ≠ rare; benign LoF ≠ actionable). Intentionally
tiny: composition pressure, not clinical realism:

```text
3 synthetic variants (no-frequency, benign LoF, documented-rare disease-relevant)
1 mocked annotation table (frequency + consequence; duckhts-shaped, real reader drops in)
1 note with the abstention caveat
1 SQL filter: rare ∧ high-impact ∧ frequency-known   (a query, not a skill)
1 run record + provenance
1 result (count via SQL GROUP BY) + caveats: what was excluded and why
```

No live APIs, no ACMG engine, **no diagnosis language**. It forces the whole substrate to compose:
resolvers → DuckDB tables → the operation's SQL → the answer → run record + receipts → provenance. The
test asserts the abstention, structure, provenance, and stability, not prose.

## 5. Phases (walking skeleton first)

Inverted from substrate-first: a thin flagship lands early and stays green as substrate thickens behind it.

**Current position:** the flagship is built (manifest #1); `runOperation` produces run records, results,
and resolution receipts, persisted under `.pi/bio-agent/runs/`. Built out since: the SQL-native network
path (`ducknng_ncurl_table`, `http.get` fallback), the compute pillar (`process.compute` over Arrow
IPC), region-scoped `duckhts.read_bcf`, CAS-of-bytes, and the two-pillar coloc flagship
(`examples/coloc`, multi-tissue post-GWAS colocalization).

**Temporal memory + one Datomic/CAS store: built.** Notes, skills, facts, and runs are append-only,
as-of, attributed observations in one `bio_observations` store: a Datomic-style immutable fact log.
Agent tools use it; the legible file is a view. When the host injects a `cas`, result/receipt/replay
bytes stay outside the DB (referenced by digest); an LLVM-style ActionCache gives hash-dedup and replay.
Sandboxing and effect-limits are the host's job, never ours.

```text
Phase 0 (done)   Flagship skeleton: manifest #1, runOperation -> run/result/receipts, host persistence.
Phase 1 (done)   Run/provenance substrate: run+receipt persistence + CAS-of-bytes. Temporal anchoring +
                 KG-fact recording are consumed by Phase 4 (built with it, not speculative).
Phase 2 (done)   Network is SQL-native: ducknng_ncurl_table composes URL/headers/body in SQL and parses
                 JSON -> table with no TS resolver; http.get is the fallback + fanout/retry seam.
Phase 3 (done)   Out-of-process compute: process.compute (Arrow IPC) with timeout/output caps, process-
                 group kill, script-bytes provenance, fail-closed. Table, file, and files-only outputs
                 all built (declared outputs captured into CAS). It is one-shot execution; durable async
                 lifecycle belongs to the job lane below.
Phase 4 (active) Safe harness-adaptation surface: declare -> validate -> test -> record -> activate ->
                 rollback. Consumes Phase 1's leftover (record = judgments as KG facts; activate/
                 rollback = as-of temporality). See slice status below.
```

The expertise-per-budget measurement (§2) runs continuously now that the Phase 0 skeleton exists.

### Phase 4 slices (walking skeleton first)

Foundation is the **temporal provenance statement**: Phase 4 promotes selected results/judgments and
activation events into `bio_observations`, whose edge-like rows project into graph shape as of time t
(`bio_edges` stays the atemporal compiled graph). The irreducible **human** stays at `activate` (the
approval gate): the substrate provides the rails, the sign-off is hosted, not computed
([design.md](./design.md#where-the-human-stays-in-the-loop-the-judgmentapproval-boundary)).

- **4.0. Temporal provenance store. Built.** `bio_observations` keyed by `statement_key`; `asOf(t)` =
  latest row per key; rollback = append a row pointing at an older version. Edge-like rows project into
  `bio_edges_as_of(t)` with `entailed_edge` closure.
- **4.1. Record a real judgment. Built.** The production `examples/coloc` run records its per-tissue
  posteriors as time-versioned KG facts: `runColocRecord` (`src/producers/coloc-record.ts`) runs the
  manifest, parses the posteriors, and records each one as a scalar observation plus the thresholded
  PP.H4 > t call as an edge into `bio_edges_as_of`. The mapping is defined once (shared by the example
  CLI `examples/coloc/record.mjs` and the test) and uses only the generic `recordObservation`: coloc
  is one producer, not a shape the substrate bends toward; there is no `PP.Hk` logic in `src/core`.
- **4.2. Activate/rollback state machine. Built.** Current active version is latest-as-of; rollback
  appends the prior version (never mutates).
- **4.3: declare → validate → test → record → activate happy path. Built.** Validate → run the
  candidate over its fixture in a sandbox → record status → activate iff both pass AND an injected
  approval policy approves. The candidate is generic data, not a bio example.
- **4.4. Rollback + durable approval gate. Built.** The substrate owns only park + resume: submit
  records `approval="pending"`; decide resumes it later (across restart/human delay), activating iff
  approved. A decision is terminal; deciding an unsubmitted/failed candidate fails closed. RBAC, quorum,
  notifications, identity, and approval UX stay the host's.

Discipline: each slice earns the next: do not build the state machine or loop ahead of its consumer.
The forbidden/allowed table in §6 is the invariant every slice must already satisfy.

### Reproducibility + long-running lane (C/L): library obligations

Reproducibility and long-running tasks are domain-inherent library goals (a 6-hour result that can't say
what produced it is a weak receipt): required, not deferred. Built interleaved **C1 → L1 → C2 → L2/L3**;
the lane is **complete**.

- **C1: environment identity + replay seed. Built.** Runtime-agnostic `EnvDescriptor` (composite
  layers, no runtime privileged), deterministic `envDigest`, explicit `unknown` (never a fake pin),
  declared-vs-observed attestation. Every run seeds `replay.json` with actual inputs. It does not execute replay.
- **L1: async JobRunner skeleton. Built.** A `JobRunner` port (submit/status/collect/cancel) over
  `BioRunRecord` + job-status observations (same temporal substrate as Phase 4). In-memory and ledger-backed
  implementations exist; outputs can be CAS refs.
- **L1.5: durable queue/lease coordination. Built.** `hosts/job-queue.ts` provides an operational queue over
  `SqlConn`: enqueue replay specs, atomically claim the next available job, heartbeat/extend leases, park a
  job as waiting, and finish a live claim. The observation ledger remains the status/result audit truth; the
  queue is the worker coordination index.
- **C2: reproduceRun().** Re-execute `replay.json` + attestation, diff digests →
  reproduced/diverged/not_reproducible (honest reasons, never fake confidence).
- **L2/L3: durable resume + cancellation. Built.** Rehydrate job status without the runner; cancel
  records a terminal `cancelled` phase where the ledger wins over process memory. Strictly-monotonic,
  terminal-is-terminal.

What stays the host's (named consumers now exist, and the coloc flagship forces the interface): micromamba/conda/renv/container execution, SLURM/k8s/Modal adapters, scheduler policy, semantic env compatibility, and push notification.

### Later lane (not core): NNG host capabilities

A note, not a build: deferred until a real cross-machine/worker-pool consumer forces it. Two
capabilities unrelated as abstractions but merged as a host SERVICE, never as a substrate concept:
**storage/namespace** (`ducknng-fs`: `path → metadata → digest/bytes` over ducknng RPC + CAS + a future
FUSE host-port) and **execution/control** (pure NNG process calling, slotting behind the existing
`ProcessRunner` port: no new core type). Order: `nngProcessRunner` (shared run dir/CAS, contract
unchanged) → `process.nng_compute` (pure Arrow-over-NNG, cross-machine) → `ducknng-fs` host-port.

The specific pending compute mode is therefore **NNG-backed stateful process compute**, not a new operation semantics:
Arrow IPC payloads over ducknng to a remote or persistent worker, declared outputs captured to CAS, environment
attestation recorded, and durable status/result/cancel exposed through the same `JobRunner` ledger. A persistent
Python/R/Julia kernel is a sessionful runner implementation with explicit session handles and replay boundaries;
it must not smuggle ambient REPL variables into a run receipt.

**Guardrail:** process calling must not depend on the filesystem conceptually. The fs is a staging
convenience; the execution model stays manifest-declares → host-injects-runner → runner-executes →
resolver-materializes → records what happened.

## 6. Harness-adaptation doctrine (mods vs hooks)

Extending the harness is core to the Pi lineage: packages, extensions, custom tools, skills, prompts,
reload/install boundaries. `pi-bio-agent` inherits that and makes it biomedical-safe and provenance-
aware. The lineage is **agent-mediated extension through explicit harness surfaces, not arbitrary self-
mutation.** This answers the harness-update failure mode directly:

> **Safe adaptation is declarative, validated, reversible, recorded, and never edits core in place.**

Core updates happen through package / git / update mechanisms; agent-authored changes enter only as
application-owned specs, skills, or extensions: with tests and reload boundaries.

```text
bad (forbidden)                       good (the only path)
  edit core files in place              propose a declared extension/spec/skill
  monkey-patch tools                    validate it (fail-closed contract)
  silently change execution behavior    test it (CI gates it)
  hidden env/process activation         record it in graph/run provenance
                                        activate at a boundary (/reload, install, CLI flag)
                                        remove / roll it back
```

**This is a design invariant now, not a Phase-4 add-on.** Every new surface must already be compatible
with `declare → validate → test → record → activate → rollback`, even before the adaptation tooling is
built.
