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
   limits, read-only SQL validation. Both a fake `KgSqlConn` and a real in-memory DuckDB.
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

## 4. Flagship: rare-disease reanalysis walking skeleton

The flagship is a **forcing function landed early**, not a finale. It is intentionally tiny — the goal is
**composition pressure, not clinical realism**:

```text
3 synthetic variants
2 HPO terms
1 mocked gene/disease/evidence table
1 note with an ACMG / source caveat
1 run record
1 evidence subgraph
1 report (stable JSON)
```

No live APIs, no full ACMG engine, **no diagnosis language**. It forces the whole substrate to compose:
notes → graph, variants/phenotypes → typed nodes, mocked evidence → edges with provenance, run record →
produced artifacts, report → structured safety-bounded output. Output is a **provenance-backed
reanalysis report — ranked candidates with evidence graph, sources, caveats, and missing evidence — not
a diagnosis.** The test asserts structure + provenance + safety language + bounded budget.

## 5. Phases (walking skeleton first)

Inverted from substrate-first: a thin flagship lands early and stays green as substrate thickens behind
it. Current position: the notes → graph → DuckDB → report → CLI ingress is **done and engine-verified**;
`BioRunSpec`/`BioRunRecord`, `storage`/CAS, `Provenance`, and `BioOperationSpec` are **contracts with no
producers yet.**

```text
Phase 0 (next)  Flagship walking skeleton. Synthetic fixture -> run record + evidence subgraph +
                report. Mocked everything. Turns three contracts into real producers; gives us the
                cost-curve harness. THIS is the next code slice.
Phase 1         Thicken the run/provenance substrate behind the skeleton: run ledger, CAS
                materialization, provenance receipts — driven by what the skeleton needs.
Phase 2         First declarative operation pack (OpenTargets or Monarch): mock-network tests,
                dry-run/execute split, cache/provenance policy. Feeds the skeleton's evidence.
Phase 3         Bounded code composition: scoped clients only, no raw fetch/secrets/DB handle,
                timeout/output caps, a receipt per operation call.
Phase 4         Safe harness-adaptation surface: extension/spec/skill scaffold implementing
                declare -> validate -> test -> record -> activate -> rollback.
```

The expertise-per-budget measurement (§2) runs continuously once the Phase 0 skeleton exists.

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
