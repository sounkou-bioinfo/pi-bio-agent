---
type: Reference
title: Domain model
description: "Read before adding any core type or manifest — kernel slots, resources/CAS/resolvers, temporality, manifests, and execution backends."
tags: [domain-model, resources, resolvers, temporality, manifests, execution-backends]
---

# Domain model

## The domain bet

> A bio agent is **time-aware, resource-addressed, and operation-registered
> bioinformatics execution and knowledge**: concrete operations are registered, inspectable,
> reproducible, and queryable.

Core models the **grammar by which a domain becomes inspectable**, not all of bioinformatics. The clean
shape:

```text
Time-aware biomedical resource graph
  + immutable artifacts (CAS) + virtual resources (recipes) + registered schemas/views
  + registered operations + evidenced temporal facts + runs/provenance + host-agnostic adapters
```

## Three layers

Bioinformatics is too broad for core to encode as `Feature`/`Sample`/`Cohort`/`Matrix` classes, but too
real to ignore. The resolution is **manifests over a small kernel, executed by pluggable backends**:

```text
core kernel        identity · resource handles/CAS/resolvers · facts/relations/time · declarations · runs · memory
manifests          genomics · proteomics · transcriptomics/single-cell · metagenomics · data-science · clinical-annotation
execution backends DuckDB SQL (data + SQL-native network via ducknng) · `compute.run` out-of-process compute (R/Python/Go/shell over Arrow IPC)
```

- **core owns the grammar** (what *is* a resource, operation, fact, run, term, temporal scope, resolver).
- **manifests own domain vocabulary/views/tools** (how do I get annotated variants? what view exists?).
- **backends own execution** (with policy, provenance, timeouts, CAS receipts, tests).
- **runs/CAS/provenance/time make outputs reproducible.**

## The kernel: six-slot test

Everything in `core/` is exactly one of these. **If a proposed type is none of them, it does not belong
in core**: the test that rejects the speculative zoo (Feature/Sample/Cohort/Matrix/…) up front.

1. **Identity**: names of things (open ids + CURIEs).
2. **Handle**: a reference to content: virtual recipe, CAS artifact, or external pointer (+ its resolver).
3. **Fact / relation**: a temporal, evidenced graph assertion.
4. **Declaration**: a registered capability/operation/view/term-set/predicate/resolver (via a manifest).
5. **Run**: the ledger that produces facts/handles with provenance.
6. **Memory**: machine-studying notes as time-stamped, authored revisions in the one `bio_observations` ledger
   (`memory:`), projected into the graph. Append-only, as-of-recallable, tombstone-retractable. *Not facts.*

## Boundaries

```text
core/         contracts, primitives, validators — no question-specific SQL, no Pi dependency, no domain zoo
duckdb/       materialization, schema/view execution, graph sync
extensions/   application-owned views, term sets, SQL operations, resolvers, fixtures
hosts/        Pi, CLI, future JSON-RPC/MCP
notes/        machine-studying memory, not authoritative facts
```

No hidden global activation: registries are **explicit objects passed into runners/tests/hosts**.

## Identity & vocabulary: open ids, not fake enums

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
genomic identities, `GenomicInterval`, `VariantKey`, `OntologyTermRef`, `ContentAddress`, are this slot.)

## Resources: handles, CAS, virtual

Four distinct things: collapsing them is the bug:

```text
external reference       URL / accession / file / API pointer
virtual resource         a recipe + identity for data (resolver + params)   — MAY be re-resolved
CAS artifact             immutable bytes/table/materialization               — NEVER mutates
materialization record   the resolver run that turned virtual -> CAS/view
```

```ts
interface ContentAddress { algorithm: "sha256"; digest: string; mediaType?: string; sizeBytes?: number }
interface VirtualResourceSpec {
  id: ResourceId; title: string; kind: "virtual";
  resolver: string; params: Record<string, unknown>;   // a registered resolver id + its inputs (opaque to core)
  schemaRef?: SchemaId;                                 // validated keys: id/title/kind/resolver/params/schemaRef (unknown keys rejected)
}
```

> **A virtual resource may be re-resolved. A CAS artifact never mutates.** Reproducibility without
> pretending external data is stable. The agent reasons over handles + compact summaries, never raw bytes;
> live/expensive stays virtual, materialized goes to CAS, hot structured facts go to DuckDB.

## Resolvers: turning virtual into real

The bridge from a virtual handle to concrete bytes/tables, **without core knowing any vendor**. (Pattern
generalized from a connector/resolver plugin design, opaque `resolver_ref`, fail-closed, stable-locator, minus the clinical scope/ACL/global-singleton specifics.)

```ts
interface BioResolverSpec {       // DECLARATION — serializable, lives in a manifest
  id: string; version: string; title: string; description: string;
  output: { mode: "inline" | "reference" | "content_address" | "table"; mediaType?: string; schemaRef?: string };
  temporal?: { kind: "snapshot" | "live" | "as_of"; source?: string; versionRequired?: boolean };
  // validated keys: id/version/title/description/output/temporal (unknown keys rejected). Network/compute POLICY is
  // a host concern (injected effects fail closed), not a resolver-spec field; auth is host-owned (see http.get).
}
type BioResolverImpl = (resource: VirtualResourceSpec, ctx: ResolutionContext) => Promise<ResolverOutput>;  // BINDING — runtime only
interface ResolverOutput { result: ResourceHandle; sourceSnapshots: SourceSnapshot[]; provenance: Provenance[]; } // the impl returns only resolved data
interface ResolutionReceipt {  // the REGISTRY stamps identity/provenance — an impl cannot forge them
  resourceId: string; resolverId: string; resolverVersion: string; resolvedAt: string; paramsDigest: string;
  sourceSnapshots: SourceSnapshot[]; result: ResourceHandle; /* usually CAS/reference/inline/table */ provenance: Provenance[];
}
```

Four rules, all load-bearing:

1. **Opaque resolver ids.** Core never learns "how gnomAD works": `resolver: { id: "gnomad.variant_frequency", query }`. The id is a registered capability.
2. **Fail closed.** A handle naming `resolver = opentargets.associations` with no such resolver registered → resolution *fails*. It must not silently fall back to HTTP/shell/generic fetch.
3. **Stable-locator discipline.** Resolve by a **source-consistent, churn-stable** key, never a volatile id. Good: accession+version, genome-build+normalized-variant-key, CURIE+ontology-release, DOI/checksum. Bad: temp path, API/UI row id, unversioned "latest" (unless explicitly marked `live`). This is where **temporality enters resolution**: a handle pins what it depends on.
4. **Declaration separate from implementation.** A **manifest carries `BioResolverSpec` (data)**; a host/runtime **binds the `BioResolverImpl` (function)**: `registry.registerManifest(manifest)` then `registry.bindResolverImpl(id, impl)`, and resolution is resource-centered via `registry.resolveResource(resourceId, ctx)`. Manifests stay serializable/snapshot-able; impls never live in the manifest.

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

## Temporality: on facts/resources/runs, AND on memory notes

Bio drifts: gnomAD/Ensembl/UniProt versions change, ontology releases change, genome builds matter, APIs
drift, "unknown frequency" ≠ "rare", and old facts may stay historically true but no longer current.

```ts
interface SourceSnapshot   { source: string; version?: string; releasedAt?: string; retrievedAt?: string }
interface TemporalScope    { asOf?: string; sourceSnapshots?: SourceSnapshot[]; coordinateSystem?: string }
interface TemporalValidity { observedAt?: string; validFrom?: string; validTo?: string; recordedAt: string }
```

Bi-temporal (`valid_*` × `recordedAt`) makes **reanalysis** work ("what did we believe on date X"). It
belongs on facts, evidence, resources, runs, and source snapshots, **and on memory notes**, which now live in
the same append-only `bio_observations` ledger (`memory:` namespace): every `remember`/`forget` is a
time-stamped, authored revision with as-of recall, full history, and tombstone retraction. The one exception is
**CAS content** (timeless identity; only its *retrieval* is timed).

## Facts / KG: evidenced temporal assertions

```ts
interface BioFact { id: string; subject: string; predicate: PredicateId; object: string | number | boolean | null;
  qualifiers?: Record<string, unknown>; temporal?: TemporalValidity; evidence?: EvidenceBlock[] }
interface EvidenceBlock { sources: SourceSnapshot[]; artifacts?: ContentAddress[]; method?: string; confidence?: number }
```

**Notes = mutable agent memory; facts = temporal, evidenced graph assertions.** (Built: `BioGraphNode`/
`Edge`/`TrustBlock`; the temporal/evidence fields are the target they grow into.)

## Schema discovery: let the agent write SQL

There is **no `BioViewDef`, no pre-declared table type, no `requiredColumns`**. Modelling every table shape
recreates skill sprawl as schema sprawl (`AnnotatedVariantsV1`, `ClinVarVariantsV1`, …). SQL's advantage is
schema **discovery**. The boundary:

```text
resolver:   materializes some table
DuckDB:     discovers its schema (information_schema / DESCRIBE)
agent:      reads the schema, then writes the SQL it needs (mapping + analysis)
DuckDB:     the binder is the arbiter — a missing column fails closed at run time
registry:   records the operation + provenance
```

The substrate ships only generic discovery (`describeTable`, `assertColumnsPresent`) for the agent to CALL;
the runner enforces no column contract. Interchangeability is proven behaviorally: the same classification
logic yields the same answer over a raw VCF (`duckhts.read_bcf` + an INFO→canonical mapping in the
operation's SQL), CSV/Parquet (`duckdb.file_scan`), and inline providers. The source-dialect mapping is
**manifest SQL data**, not resolver code: a new VCF dialect is a new projection, never a new `.ts`.

**Caveat: same columns ≠ same normalized variant identity.** `variant_key` is provider-verbatim; a
normalization projection (assembly/seqid/pos/ref/alt → canonical key) is more manifest SQL, authored when a
second real source actually disagrees, not a TS abstraction.

## Operations: the boundary for executable behavior

```ts
interface BioOperationSpec {
  id: OperationId; title: string;
  transport: "duckdb.sql";          // executable today; widen only when a transport ships with a runner
  inputSchema: unknown; outputSchema?: unknown;   // inputSchema is REQUIRED (validateBioOperationSpec)
  sql?: { sqlTemplate: string; readOnly: true; singleStatement?: true; requiredResources?: ResourceId[] };
  notes?: string[];                 // caveats/abstention rationale travel here, as data
}
```

The operation's SQL returns the answer: classified rows, or a `GROUP BY` count. There is no report
primitive and no TypeScript reducer: counts/aggregation are SQL.

Question logic lives **here or in application-owned operation specs: never in core helpers.**

## Typed judgment: the determinism gradient

Some steps are irreducibly judgment (which ontology term grounds this free-text label?). Borrowed from
metacurator: a model may **propose**, but the deterministic substrate **decides**. The candidate set is a
registered `TermSet` (data); the model is a `BioJudgeImpl` **injected by the host** (core never calls a
model); and `decideGrounding` validates the proposal against the candidates: grounding to the exact
`TermRef`, **abstaining** on null or low confidence, and **rejecting an invented identifier** (`JudgeContractError`).

```ts
type BioJudgeImpl = (input: { question: string; candidates: TermRef[] }) => Promise<BioJudgeProposal>; // host-injected
runGroundingJudgment(registry, { termSetId, question, minConfidence?, now }, judge): Promise<GroundingJudgment>;
```

This is a **pattern over existing primitives** (a term set + a thin validator), not a new registry kind:
the model can choose or abstain, but it can never mint an id the substrate did not already register.

## Application manifests

A manifest is the registration boundary for concrete application behavior. It declares serializable specs;
**do not prebuild a giant framework: let the flagship pull each `provides.*` kind into existence.**
(A manifest is the program: a named bag of `provides.*`, with no taxonomy tag the substrate must
interpret.)

```ts
interface BioManifest {
  id: string; version: string; title: string; description: string;
  provides: {
    resolvers?: BioResolverSpec[];                    // declarations; impls bound at runtime
    resources?: VirtualResourceSpec[];                // named inputs resolved into tables
    termSets?: TermSet[];                             // ontology vocabulary as data
    operations?: BioOperationSpec[];                  // declared SQL
  };
}
```

Examples (registered data, not guessed TS classes): a **genomics** application provides `duckhts.read_bcf`/
`gnomad.frequency_lookup` resolvers, `so.loss_of_function` term set, and `rare_high_impact.report` SQL;
**proteomics** provides mzML/FASTA resolvers, UniProt/GO sets, peptide/PSM SQL; **single-cell** provides
h5ad/Zarr resolvers and PCA/UMAP SQL. Source dialect and analysis are SQL, not per-application TypeScript.

## Execution backends: SQL plus compute, not a zoo

`BioOperationSpec`/`BioResolverSpec` separate **what** from **how**, but "how" does **not** fan out into a
per-language backend enum. Operations are declared SQL today:

```ts
type BioOperationTransport = "duckdb.sql";
```

- **`duckdb.sql`** carries both **data** (files/formats as table functions) and **network** (`ducknng_ncurl_table`: an HTTP/GraphQL call is a SQL table function, not a per-API TypeScript client).
- **`compute.run`** is the one general out-of-process backend (argv in a run dir over Arrow IPC, declared file
  artifacts, CAS capture, environment evidence, receipts, replay, and async `ComputeRunner` integration). `Rscript`,
  `python`, `bcftools`, `nextflow`, and `snakemake` are argv choices for that backend, never separate transports:
  one backend, not `runDeseq2()`/`runGatk()` sprawl. If an application wants a process-first authoring surface later,
  it should be syntax over `compute.run`, not a second operation lifecycle (see
  [design notes](design.md#execution-beyond-sql-shell-r-and-workflows-as-compute-operations)).

Core defines only the **contract**; actual execution lives in adapters with policy, provenance, timeouts, CAS
receipts, and tests. CLI/R/Python tools are first-class, `bcftools`/`duckhts`, Bioconductor, scanpy/pysam, but
they enter as **manifest data + argv through `compute.run`**, not as bespoke per-tool TypeScript.

## Flagship as proof

Rare-high-impact-variants becomes **manifest #1**, proving the bet end to end:

```text
manifest:   termSet so.loss_of_function · resolver(s) for the variant source (output: table)
            · operation rare_high_impact.report
operation:  SQL — classify variants: count only frequency-KNOWN rare LoF, abstain on unknown frequency,
            exclude benign. Counts/aggregation are SQL (GROUP BY), never a TypeScript reducer.
outputs:    result JSON (the answer) · run record · resolution receipts · provenance
```

Not a bespoke skill, not a core SQL helper, not hidden policy: **registered resolver + operation SQL +
provenance + abstention.** The same resolver shape later supports `duckhts.read_bcf`,
`gnomad.frequency_lookup`, `vep.consequence_lookup`, `opentargets.associations`, `uniprot.entry`,
`zarr.matrix_slice`, `r.bioconductor_result`, `python.scanpy_result`: generic readers, with source dialect
and analysis as manifest SQL, not per-source TypeScript.

## Model vs current code (honest status)

| Slot | Built | Target (grows into) |
|---|---|---|
| Identity | `GenomicInterval`, `VariantKey`, `OntologyTermRef`, `ContentAddress`, `PredicateId=string` | id aliases, `TermRef`/`TermSet`/`PredicateDef` registry |
| Handle | `ResourceHandle`, `VirtualResourceSpec`, `BioResolverSpec`/`Impl`, `ResolutionReceipt`, `resolveResource`, real resolvers (`duckdb.file_scan`, `duckhts.read_bcf`), `ContentAddress`/`casPathForAddress` | gnomAD/http resolvers, CAS materialization |
| Fact | `BioGraphNode`/`Edge`/`Snapshot`, `TrustBlock`, `Provenance` | `BioFact` + `EvidenceBlock` + `TemporalValidity`; recording judgments/results as edges |
| Declaration | `BioOperationSpec`, `BioResolverSpec`, `BioManifest` registry (validated, frozen) | `PredicateDef` registry |
| Run | `BioRunSpec`/`Record`/`Event` + host producer (`bio_run_operation` → run/result/receipts persisted) | richer run lifecycle (resume, budgets) |
| Memory | temporal notes in `bio_observations` (`memory:`: `remember`/`forget`/`recall`, as-of + history + author, projected into the graph) | richer recall ranking / cross-agent trust policy |

Everything in the right column is built **consumer-driven**, when the flagship or a real manifest needs it, never speculatively.
