---
type: Reference
title: Domain model
description: "Read before adding any core type or domain pack — kernel slots, resources/CAS/resolvers, temporality, domain packs, and execution backends."
tags: [domain-model, resources, resolvers, temporality, domain-packs, execution-backends]
---

# Domain model

## The domain bet

> A bio agent is **not a pile of skills**. It is **time-aware, resource-addressed, operation-registered
> bioinformatics execution and knowledge** — where concrete operations are registered, inspectable,
> reproducible, and queryable.

Core models the **grammar by which a domain becomes inspectable** — not all of bioinformatics. The clean
shape:

```text
Time-aware biomedical resource graph
  + immutable artifacts (CAS) + virtual resources (recipes) + registered schemas/views
  + registered operations + evidenced temporal facts + runs/provenance + host-agnostic adapters
```

## Three layers

Bioinformatics is too broad for core to encode as `Feature`/`Sample`/`Cohort`/`Matrix` classes, but too
real to ignore. The resolution is **domain packs over a small kernel, executed by pluggable backends**:

```text
core kernel        identity · resource handles/CAS/resolvers · facts/relations/time · declarations · runs · memory
domain packs       genomics · proteomics · transcriptomics/single-cell · metagenomics · data-science · clinical-annotation
execution backends DuckDB SQL · CLI · R · Python · HTTP · wasm/local-service
```

- **core owns the grammar** (what *is* a resource, operation, fact, run, term, temporal scope, resolver).
- **packs own domain vocabulary/views/tools** (how do I get annotated variants? what view exists?).
- **backends own execution** (with policy, provenance, timeouts, CAS receipts, tests).
- **runs/CAS/provenance/time make outputs reproducible.**

## The kernel: six-slot test

Everything in `core/` is exactly one of these. **If a proposed type is none of them, it does not belong
in core** — the test that rejects the speculative zoo (Feature/Sample/Cohort/Matrix/…) up front.

1. **Identity** — names of things (open ids + CURIEs).
2. **Handle** — a reference to content: virtual recipe, CAS artifact, or external pointer (+ its resolver).
3. **Fact / relation** — a temporal, evidenced graph assertion.
4. **Declaration** — a registered capability/operation/view/term-set/predicate/resolver (via a manifest).
5. **Run** — the ledger that produces facts/handles with provenance.
6. **Memory** — mutable machine-studying notes, projected into the graph. *Not facts.*

## Boundaries

```text
core/         contracts, primitives, validators — no question-specific SQL, no Pi dependency, no domain zoo
duckdb/       materialization, schema/view execution, graph sync
extensions/   domain & operation packs: views, term sets, SQL operations, resolvers, fixtures
hosts/        Pi, CLI, future JSON-RPC/MCP
notes/        machine-studying memory, not authoritative facts
```

No hidden global activation: registries are **explicit objects passed into runners/tests/hosts**.

## Identity & vocabulary — open ids, not fake enums

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

Predicate vocabularies are **registered data** (RO/BFO/SKOS seeded), never TypeScript unions. (Built
genomic identities — `GenomicInterval`, `VariantKey`, `OntologyTermRef`, `ContentAddress` — are this slot.)

## Resources: handles, CAS, virtual

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
  resolver: string; params: Record<string, unknown>;   // a registered resolver id + its inputs (opaque to core)
  schemaRef?: SchemaId; temporalScope?: TemporalScope; dependencies?: ResourceId[];
}
```

> **A virtual resource may be re-resolved. A CAS artifact never mutates.** Reproducibility without
> pretending external data is stable. The agent reasons over handles + compact summaries, never raw bytes;
> live/expensive stays virtual, materialized goes to CAS, hot structured facts go to DuckDB.

## Resolvers — turning virtual into real

The bridge from a virtual handle to concrete bytes/tables, **without core knowing any vendor**. (Pattern
generalized from a connector/resolver plugin design — opaque `resolver_ref`, fail-closed, stable-locator —
minus the clinical scope/ACL/global-singleton specifics.)

```ts
interface BioResolverSpec {       // DECLARATION — serializable, lives in a manifest
  id: string; version: string; title: string; description: string;
  inputSchema?: unknown;
  output: { mode: "inline" | "reference" | "content_address" | "table"; mediaType?: string; schemaRef?: string };
  temporal?: { kind: "snapshot" | "live" | "as_of"; source?: string; versionRequired?: boolean };
  policy?: { network: "forbidden" | "explicit" | "allowed"; cache: "none" | "prefer_cas" | "require_cas"; timeoutSeconds?: number };
}
type BioResolverImpl = (resource: VirtualResourceSpec, ctx: ResolutionContext) => Promise<ResolverOutput>;  // BINDING — runtime only
interface ResolverOutput { result: ResourceHandle; sourceSnapshots: SourceSnapshot[]; provenance: Provenance[]; } // the impl returns only resolved data
interface ResolutionReceipt {  // the REGISTRY stamps identity/provenance — an impl cannot forge them
  resourceId: string; resolverId: string; resolverVersion: string; resolvedAt: string; paramsDigest: string;
  sourceSnapshots: SourceSnapshot[]; result: ResourceHandle; /* usually CAS/reference/inline/table */ provenance: Provenance[];
}
```

Four rules, all load-bearing:

1. **Opaque resolver ids.** Core never learns "how gnomAD works" — `resolver: { id: "gnomad.variant_frequency", query }`. The id is a registered capability.
2. **Fail closed.** A handle naming `resolver = opentargets.associations` with no such resolver registered → resolution *fails*. It must not silently fall back to HTTP/shell/generic fetch.
3. **Stable-locator discipline.** Resolve by a **source-consistent, churn-stable** key, never a volatile id. Good: accession+version, genome-build+normalized-variant-key, CURIE+ontology-release, DOI/checksum. Bad: temp path, API/UI row id, unversioned "latest" (unless explicitly marked `live`). This is where **temporality enters resolution** — a handle pins what it depends on.
4. **Declaration separate from implementation.** A **manifest carries `BioResolverSpec` (data)**; a host/runtime **binds the `BioResolverImpl` (function)** — `registry.registerManifest(manifest)` then `registry.bindResolverImpl(id, impl)`, and resolution is resource-centered via `registry.resolveResource(resourceId, ctx)`. Manifests stay serializable/snapshot-able; impls never live in the manifest.

**Resolver vs operation** (a kernel distinction):

```text
resolver  = dereference / materialize a resource     (side-effect-light, receipt-producing)
operation = transform / analyze, produce facts/reports/CAS/runs
```

```text
resolver: tabix.slice_vcf          operation: annotate_variants
resolver: uniprot.protein_record   operation: protein_enrichment
resolver: opentargets.associations operation: rank_candidate_genes
```

The clean path: `virtual handle → registered resolver → CAS/materialized table → DuckDB view → operation → run record + facts + provenance`.

## Temporality — on facts/resources/runs, never on notes

Bio drifts: gnomAD/Ensembl/UniProt versions change, ontology releases change, genome builds matter, APIs
drift, "unknown frequency" ≠ "rare", and old facts may stay historically true but no longer current.

```ts
interface SourceSnapshot   { source: string; version?: string; releasedAt?: string; retrievedAt?: string }
interface TemporalScope    { asOf?: string; sourceSnapshots?: SourceSnapshot[]; coordinateSystem?: string }
interface TemporalValidity { observedAt?: string; validFrom?: string; validTo?: string; recordedAt: string }
```

Bi-temporal (`valid_*` × `recordedAt`) makes **reanalysis** work ("what did we believe on date X"). It
belongs on facts, evidence, resources, runs, and source snapshots — **not** on notes (mutable memory; git
is their history) and **not** on CAS content (timeless identity; only its *retrieval* is timed).

## Facts / KG — evidenced temporal assertions

```ts
interface BioFact { id: string; subject: string; predicate: PredicateId; object: string | number | boolean | null;
  qualifiers?: Record<string, unknown>; temporal?: TemporalValidity; evidence?: EvidenceBlock[] }
interface EvidenceBlock { sources: SourceSnapshot[]; artifacts?: ContentAddress[]; method?: string; confidence?: number }
```

**Notes = mutable agent memory; facts = temporal, evidenced graph assertions.** (Built: `BioGraphNode`/
`Edge`/`TrustBlock`; the temporal/evidence fields are the target they grow into.)

## Schemas / views — declarative, generated

```ts
interface ColumnDef  { name: string; type: "TEXT" | "INTEGER" | "DOUBLE" | "BOOLEAN" | "JSON"; nullable?: boolean; description?: string }
interface BioViewDef { id: ViewId; name: string; description: string; columns: ColumnDef[]; dependsOnResources?: ResourceId[]; temporalScope?: TemporalScope }
```

Generate DDL/docs/contract/tests from these when a consumer needs it — no hand-written SQL contract strings.

A view contract is also the **interchange point between providers**: it is the record SHAPE that every
resolver must materialize, so interchangeable providers can feed one operation. `ANNOTATED_VARIANTS_V1` is
the first — VCF (`duckhts.vcf_scan`), CSV/Parquet (`duckdb.file_scan`), and inline rows all materialize it,
checked by `assertTableMatchesView` before the operation runs. **Caveat — same columns ≠ same normalized
variant identity.** `variant_key` is passed through verbatim per provider; cross-provider key normalization
(assembly/seqid/pos/ref/alt → a canonical key) is deferred until a second real source disagrees. The
contract fixes shape, not identity.

## Operations — the boundary for executable behavior

```ts
interface BioOperationSpec {
  id: OperationId; title: string;
  transport: "duckdb.sql" | "http" | "local.tool" | "agent";
  requiredViews?: ViewId[]; requiredResources?: ResourceId[];
  inputSchema?: unknown; outputSchema?: unknown;
  policy?: { allowNetwork?: boolean; timeoutSeconds?: number; writeMode?: "none" | "explicit" };
}
```

Question logic lives **here or in the registered operation pack — never in core helpers.**

## Typed judgment — the determinism gradient

Some steps are irreducibly judgment (which ontology term grounds this free-text label?). Borrowed from
metacurator: a model may **propose**, but the deterministic substrate **decides**. The candidate set is a
registered `TermSet` (data); the model is a `BioJudgeImpl` **injected by the host** (core never calls a
model); and `decideGrounding` validates the proposal against the candidates — grounding to the exact
`TermRef`, **abstaining** on null or low confidence, and **rejecting an invented identifier** (`JudgeContractError`).

```ts
type BioJudgeImpl = (input: { question: string; candidates: TermRef[] }) => Promise<BioJudgeProposal>; // host-injected
runGroundingJudgment(registry, { termSetId, question, minConfidence?, now }, judge): Promise<GroundingJudgment>;
```

This is a **pattern over existing primitives** (a term set + a thin validator), not a new registry kind:
the model can choose or abstain, but it can never mint an id the substrate did not already register.

## Domain packs & the manifest

A domain/operation pack is the registration boundary for concrete implementations. It declares
serializable specs; **do not prebuild a giant framework — let the flagship pull each `provides.*` kind
into existence.**

```ts
interface DomainPackManifest {
  id: string; version: string; title: string; description: string;
  domains: string[];                                 // ["genomics"], ["proteomics"], ...
  provides: {
    resourceKinds?: ResourceKindDef[];               // "vcf", "bcf", "mzML", "h5ad"
    resolvers?: BioResolverSpec[];                    // declarations; impls bound at runtime
    views?: BioViewDef[]; termSets?: TermSet[]; predicates?: PredicateDef[];
    operations?: BioOperationSpec[]; tools?: BioToolSpec[];
  };
}
```

Examples (registered data, not guessed TS classes): a **genomics** pack provides vcf/bam resource kinds,
`annotated_variants`/`alignments` views, `so.loss_of_function`, `annotate_variant`/`count_rare_high_impact`
operations, `duckhts`/`vep` tools; **proteomics** provides mzML/FASTA, peptide/PSM views, UniProt/GO sets;
**single-cell** provides h5ad/Zarr, count-matrix views, PCA/UMAP operations, Seurat/Scanpy/`duckdb_zarr`.

## Execution backends

`BioOperationSpec`/`BioResolverSpec` separate **what** from **how**. One operation ("annotate variants")
may have many implementations:

```ts
type ExecutionBackend = "duckdb.sql" | "cli" | "r" | "python" | "http" | "wasm";
```

Core defines only the **contract**; actual execution lives in adapters with policy, provenance, timeouts,
CAS receipts, and tests. CLI/R/Python are first-class — `bcftools`/`duckhts`, Bioconductor, scanpy/pysam.

## Flagship as proof

Rare-high-impact-variants becomes **manifest #1**, proving the bet end to end:

```text
manifest:   termSet so.loss_of_function · resolver fixture.annotated_variants (output: table)
            · view annotated_variants · operation rare_high_impact.report
operation:  SQL over annotated_variants — count only frequency-KNOWN rare LoF, exclude unknown-frequency,
            emit abstention/caveat counts
outputs:    report JSON · run record · resolution/materialization record · provenance
```

Not a bespoke skill, not a core SQL helper, not hidden policy — **registered resolver + view + operation
SQL + temporal provenance + abstention.** The same resolver shape later supports `duckhts.vcf_scan`,
`gnomad.frequency_lookup`, `vep.consequence_lookup`, `opentargets.associations`, `uniprot.entry`,
`zarr.matrix_slice`, `r.bioconductor_result`, `python.scanpy_result`.

## Model vs current code (honest status)

| Slot | Built | Target (grows into) |
|---|---|---|
| Identity | `GenomicInterval`, `VariantKey`, `OntologyTermRef`, `ContentAddress`, `PredicateId=string` | id aliases, `TermRef`/`TermSet`/`PredicateDef` registry |
| Handle | `ResourceHandle`, `VirtualResourceSpec`, `BioResolverSpec`/`Impl`, `ResolutionReceipt`, resource-centered `resolveResource`, `ContentAddress`, `casPathForAddress` | real resolvers (vcf scan, gnomAD lookup), CAS materialization |
| Fact | `BioGraphNode`/`Edge`/`Snapshot`, `TrustBlock`, `Provenance` | `BioFact` + `EvidenceBlock` + `TemporalValidity` |
| Declaration | `BioToolSpec`, `BioOperationSpec` | `BioViewDef`, `PredicateDef`, `DomainPackManifest` registry |
| Run | `BioRunSpec`/`Record`/`Event` (no producer) | first producer = the flagship |
| Memory | `StudyNote`, `studyNoteGraph`, KG sync | — (intentionally time-free) |

Everything in the right column is built **consumer-driven** — when the flagship or a real domain pack
needs it — never speculatively.
