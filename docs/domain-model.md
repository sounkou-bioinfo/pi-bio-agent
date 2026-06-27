---
type: Reference
title: Domain model
description: "Read before adding any core type — the domain bet, the six-slot test, virtual/CAS resources, and temporality the substrate is built on."
tags: [domain-model, resources, temporality, manifest, primitives]
---

# Domain model

## The domain bet

> A bio agent is **not a pile of skills**. It is a **time-aware resource/knowledge substrate** where
> concrete operations are **registered, inspectable, reproducible, and queryable**.

So the core models **resources, identity, time, schemas/views, facts/evidence, operations, runs, and
manifests** — not variant-question helpers or Diamond-shaped entity types. The clean shape:

```text
Time-aware biomedical resource graph
  + immutable artifacts (CAS)
  + virtual resources (recipes)
  + registered schemas/views
  + registered operations
  + evidenced temporal facts
  + runs / provenance
  + host-agnostic adapters
```

## The six-slot test

Everything in `core/` is exactly one of these. **If a proposed type is none of them, it does not belong
in core** — this is the test that rejects the speculative zoo (Feature/Sample/Cohort/Matrix/…) up front.

1. **Identity** — names of things (open ids + CURIEs).
2. **Handle** — a reference to content: virtual recipe, CAS artifact, or external pointer.
3. **Fact / relation** — a temporal, evidenced graph assertion.
4. **Declaration** — a registered capability/operation/view/term-set/predicate (enters via manifest).
5. **Run** — the ledger that produces facts/handles with provenance.
6. **Memory** — mutable machine-studying notes, projected into the graph. *Not facts.*

## 1. Boundaries

```text
core/         contracts, primitives, validators — no question-specific SQL, no Pi dependency, no domain zoo
duckdb/       materialization, schema/view execution, graph sync
extensions/   concrete implementations: views, term sets, SQL operations, resolvers, fixtures (operation packs)
hosts/        Pi, CLI, future JSON-RPC/MCP
notes/        machine-studying memory, not authoritative facts
```

Core answers: *what is a resource, operation, fact, run, term, temporal scope?* Extensions answer: *how
do I get annotated variants? how do I run this report? what view exists?*

## 2. Identity & vocabulary — open ids, not fake enums

```ts
type Curie = string;        // "SO:0001587"
type PredicateId = string;  // "BFO:0000050", "skos:exactMatch" — NOT a "is_a" | "part_of" | string union
type ResourceId = string; type OperationId = string; type ViewId = string; type RunId = string; type SchemaId = string;

interface TermRef    { id: Curie; label?: string }
interface TermSet    { id: string; title: string; members: TermRef[] }              // "so.loss_of_function"
interface PredicateDef {
  id: PredicateId; label: string;
  category: "ontology" | "mapping" | "evidence" | "note_navigation" | "domain";
  transitive?: boolean; inverseOf?: PredicateId;
}
```

Predicate vocabularies are **registered data** (RO/BFO/SKOS seeded), never TypeScript unions. (Existing
genomic identities — `GenomicInterval`, `VariantKey`, `OntologyTermRef`, `ContentAddress` — are the
already-built members of this slot.)

## 3. Virtual resources + CAS (central)

Four distinct things — collapsing them is the bug:

```text
external reference       URL / accession / file / API pointer
virtual resource         a recipe + identity for data (resolver + params)   — MAY be re-resolved
CAS artifact             immutable bytes/table/materialization               — NEVER mutates
materialization record   the resolver run that turned virtual -> CAS/view
```

```ts
interface ContentAddress { algorithm: "sha256" | "sha512"; digest: string; mediaType?: string; sizeBytes?: number }

interface VirtualResourceSpec {
  id: ResourceId; title: string; kind: "virtual";
  resolver: string; params: Record<string, unknown>;   // a registered resolver id + its inputs
  schemaRef?: SchemaId; temporalScope?: TemporalScope; dependencies?: ResourceId[];
}

interface MaterializationRecord {
  resourceId: ResourceId; contentAddress: ContentAddress; createdAt: string;
  resolver: { id: string; version: string }; temporalScope?: TemporalScope; inputs?: ResourceId[];
}
```

> **A virtual resource may be re-resolved. A CAS artifact never mutates.** That gives reproducibility
> without pretending external data is stable. The agent reasons over handles + compact summaries, never
> raw bytes; live/expensive stays virtual (fails closed with no resolver), materialized goes to CAS, hot
> structured facts go to DuckDB, large raw bytes stay out of DuckDB.

## 4. Temporality — on facts/resources/runs, never on notes

Bio drifts: gnomAD versions change, ontology releases change, genome builds matter, APIs drift, "unknown
frequency" is not "rare", and old facts may stay historically true but no longer current. So time is
first-class on the fact/resource layers:

```ts
interface SourceSnapshot   { source: string; version?: string; releasedAt?: string; retrievedAt?: string }
interface TemporalScope    { asOf?: string; sourceSnapshots?: SourceSnapshot[]; coordinateSystem?: string }
interface TemporalValidity {
  observedAt?: string;   // when the measurement/event happened
  validFrom?: string; validTo?: string;   // valid-time: true in the world
  recordedAt: string;    // transaction-time: when the substrate recorded it
}
```

Bi-temporal (`valid_*` × `recordedAt`) is what makes **reanalysis** work ("what did we believe on date
X"). It belongs on facts, evidence, resources, runs, and source snapshots — **not** on notes (mutable
memory; git is their history) and **not** on CAS content (content is timeless identity; only its
*retrieval* is timed).

## 5. Facts / KG — evidenced temporal assertions, not a placeholder `Evidence` entity

```ts
interface BioFact {
  id: string; subject: string; predicate: PredicateId;
  object: string | number | boolean | null;
  qualifiers?: Record<string, unknown>;
  temporal?: TemporalValidity; evidence?: EvidenceBlock[];
}
interface EvidenceBlock { sources: SourceSnapshot[]; artifacts?: ContentAddress[]; method?: string; confidence?: number }
```

This resolves the note-vs-KG split cleanly: **notes = mutable agent memory; facts = temporal, evidenced
graph assertions.** (Current `BioGraphNode`/`BioGraphEdge`/`TrustBlock` are the built graph layer; the
temporal/evidence fields above are the target they grow into.)

## 6. Schemas / views — declarative, generated

No hand-written SQL contract strings. Small declarative contracts that *generate* DDL/docs/contract/tests
when a consumer needs them:

```ts
interface ColumnDef  { name: string; type: "TEXT" | "INTEGER" | "DOUBLE" | "BOOLEAN" | "JSON"; nullable?: boolean; description?: string }
interface BioViewDef { id: ViewId; name: string; description: string; columns: ColumnDef[]; dependsOnResources?: ResourceId[]; temporalScope?: TemporalScope }
```

## 7. Operations — the boundary for executable behavior

`BioOperationSpec` is where biomedical *behavior* lives — question logic goes here or in the registered
operation pack, **never** in core helpers:

```ts
interface BioOperationSpec {
  id: OperationId; title: string;
  transport: "duckdb.sql" | "http" | "local.tool" | "agent";
  requiredViews?: ViewId[]; requiredResources?: ResourceId[];
  inputSchema?: unknown; outputSchema?: unknown;
  policy?: { allowNetwork?: boolean; timeoutSeconds?: number; writeMode?: "none" | "explicit" };
}
```

## 8. Extension manifest — consumer-driven

The registration boundary for concrete implementations. **Do not prebuild a giant manifest framework —
let the flagship pull each `provides.*` kind into existence.**

```ts
interface BioExtensionManifest {
  id: string; version: string; title: string; description: string;
  provides: {
    resources?: VirtualResourceSpec[]; views?: BioViewDef[]; termSets?: TermSet[];
    predicates?: PredicateDef[]; operations?: BioOperationSpec[];
  };
}
```

## 9. Flagship as proof

Rare-high-impact-variants becomes **manifest #1**, proving the bet end to end:

```text
manifest:   termSet so.loss_of_function · virtual resource (synthetic annotated variants)
            · view annotated_variants · operation rare_high_impact.report
operation:  SQL over annotated_variants — count only frequency-KNOWN rare LoF, exclude unknown-frequency,
            emit abstention/caveat counts
outputs:    report JSON · run record · provenance/materialization record
```

Not a bespoke skill, not a core SQL helper, not hidden policy — **registered resource + registered view
+ operation SQL + temporal provenance + abstention.**

## Model vs current code (honest status)

| Slot | Built | Target (grows into) |
|---|---|---|
| Identity | `GenomicInterval`, `VariantKey`, `OntologyTermRef`, `ContentAddress`, `PredicateId=string` | id aliases, `TermRef`/`TermSet`/`PredicateDef` registry |
| Handle | `ResourceHandle`, `ResourceResolverSpec`, `ContentAddress`, `casPathForAddress` | `VirtualResourceSpec`, `MaterializationRecord`, real resolution |
| Fact | `BioGraphNode`/`Edge`/`Snapshot`, `TrustBlock`, `Provenance` | `BioFact` + `EvidenceBlock` + `TemporalValidity` |
| Declaration | `BioToolSpec`, `BioOperationSpec` | `BioViewDef`, `PredicateDef`, `BioExtensionManifest` registry |
| Run | `BioRunSpec`/`Record`/`Event` (no producer) | first producer = the flagship |
| Memory | `StudyNote`, `studyNoteGraph`, KG sync | — (intentionally time-free) |

Everything in the right column is built **consumer-driven** — when the flagship or a real operation pack
needs it — never speculatively.
