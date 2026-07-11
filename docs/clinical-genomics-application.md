---
type: Proposal
title: "Clinical-genomics application pattern on pi-bio-agent"
description: "A downstream application pattern that consumes pi-bio-agent as a library: staged, deterministic-first variant analysis (case structuring, annotation, HPO, prioritization, scoring, ACMG, family-aware interpretation) with recorded-and-gated judgment. Read before scoping clinical-genomics applications or papers."
tags: [flagship, application, clinical-genomics, product, reproducibility]
---

# Clinical-genomics application pattern on pi-bio-agent

This is a **downstream application pattern**, not part of the library. The library supplies reusable primitives; the
application supplies the workflow, manifests, producers, domain rules, and host policy. A real clinical-genomics
case-analysis application should be able to run end to end by composing the library, not by adding clinical rules to
core.

It generalizes the **rare-high-impact example**: same substrate, same abstention/no-diagnosis gates, a real staged
workflow instead of three synthetic variants.

## The mental model

> One case-analysis agent, backed by DuckDB tables and explicit tools, operating over a staged flow.

DuckDB does retrieval, filtering, aggregation, and baseline scoring deterministically. The model is called only on
the *reduced* candidate set for interpretation and synthesis, and its output is recorded and gated. This is the
manifest-as-program design applied to a reusable application architecture.

## The staged workflow, mapped to primitives

Each stage names the `pi-bio-agent` primitive it uses and whether it is an **app manifest**, an **app producer**
(host code the app owns), or the substrate's existing **record + gate**. There is no "library build" column:
on re-examination every stage composes existing primitives (see the closure ledger in
[`bring-it-home-plan.md`](./bring-it-home-plan.md)).

| # | Stage | Primitive | Where it lives |
|---|---|---|---|
| 1 | Case structuring (singleton vs multiplex/family) | SQL views over ingested tables | app manifest |
| 2 | Batch annotation on UNIQUE SNV/CNV keys | `ncurl_table` (GeneBe, with fanout + backoff) **or** `compute.run` (VEP CLI) | app manifest |
| 3 | HPO extraction harness (4 modes) | `decideGrounding` (deterministic-first + abstaining model) + the judge port + the agent loop | app manifest |
| 4 | Gene prioritization over Monarch KG | `bio_edges` + `entailed_edge`, remote `ATTACH monarch-kg.duckdb`, duckpgq paths | app manifest |
| 5 | Deterministic variant scoring | SQL over annotation columns (REVEL/AlphaMissense/SpliceAI/CADD) | app manifest |
| 6 | Deterministic inheritance scoring | SQL over genotypes + family structure | app manifest |
| 7 | Combined baseline score, calibrated on ClinVar/known-solved | SQL combine + a calibration producer | app producer |
| 8 | Targeted ACMG evidence assembly (points-based, reduced set) | `scale_members` (ACMG points) + a combine producer | app producer |
| 9 | Family-aware interpretation (multiplex) | SQL aggregations over the family variant view | app manifest |
| 10 | Optional agentic synthesis / rerank on the reduced set | recorded-and-gated judgment (Phase 4) | library (record + gate) |

Six stages are a manifest (1, 2, 4, 5, 6, 9), two are app producers (7, 8), and the judgment stages (3's
adjudication, 10) are **recorded and gated, never computed by the substrate**.

## Core-library impact

The first draft of this spec named three "library builds." Re-examined against the core-boundary rule, none is a
new primitive. Each is a composition of existing pieces and stays app-side:

1. **HPO grounding "harness"** is not a core build. `decideGrounding` (`src/core/judgment.ts`) already covers the
   candidates→model mode (deterministic match → abstaining model, no invented CURIE); deterministic-only is the SQL,
   model-only is the judge port, model→tools→model is the agent's own tool loop. A 4-mode harness is a mode selector
   over `decideGrounding` + the agent — a manifest, not a primitive. Add a thin `bio_ground` convenience only if ≥2
   real HPO/gene uses prove the pattern repetitive.
2. **Monarch-KG projection** is not a core build. It is pure SQL, shown in
   `scripts/foreign-graph-closure.mjs`: `ATTACH`
   read-only + a `subject/predicate/object → from_id/predicate/to_id` SELECT + the existing `materializeEntailedEdges`
   (which already takes any source table). It belongs in a manifest. The script probes a pinned remote canonical
   `edges` relation; the remaining app questions are predicate policy, use of upstream closure, and snapshot
   provenance, not a missing core primitive.
3. **Ledger → training dataset** is not a core build. It is a `SELECT`/view over `bio_observations` joined to the Phase-4
   approval slots (contested = a `WHERE` over decisions), with a documented dataset schema.

So the downstream application should be application code over the existing library: manifests, producers, fixtures,
rules, host policy, and a thin case-analysis agent. The one library-adjacent item is a field, not an abstraction:
let a resolver receipt carry `license` + de-id status next to `source`/`version`. Everything else (calibration
weights, ACMG points, scoring rules, agent prompts, and application tools) remains outside core.

## Production and reproducibility

Clinical genomics requires auditable inputs, versions, and decisions. The application should make those records
queryable rather than rely on narrative reports alone.

- **Ingestion / ETL.** Real inputs are VCF, a database, CSV, or Excel. A manifest *is* the ETL: `duckhts` reads
  VCF, `file_scan` reads CSV/Parquet, `ATTACH` reads another DB, the DuckDB excel extension reads Excel. The
  standard format is the resolved resource tables plus `bio_observations`, and the receipt records where each byte
  came from. "Prefer database tables" is the substrate.
- **Annotation throughput and cost.** Turnaround drives a resolver choice, both manifest-expressible: the GeneBe
  API via `ncurl_table` with rate-limited fanout + exponential backoff (the WGS-chr22 seam), or the VEP CLI via
  `compute.run`. Restricted fields (REVEL, AlphaMissense, CADD, SpliceAI,
  OMIM are commercial-restricted) are *declared* in the manifest and *recorded* in the receipt (source, version,
  license); the allow/deny gate is host policy, like PII, not core.
- **Versioning for audit and accreditation.** Tool, database, and API versions must be logged. The existing path is
  `EnvDescriptor` attestation + resolver receipts (resolver version, params digest, source snapshot) + the
  immutable `bio_observations` ledger + `reproduceRun()`.
- **LLM non-determinism.** The reproducible, auditable work is deterministic SQL: retrieval, filtering, scoring,
  and counting are a `GROUP BY`, so they replay bit-for-bit. The model runs only on the reduced set, and its output
  is **recorded** (immutable, with its inputs and a digest) and **gated** (human sign-off). An auditor never needs
  the model to be deterministic: the ledger says what it produced, on what inputs, when, and who approved it.
  Vendor model-determinism features help *replay*, but the audit trail does not depend on them. The policy is:
  deterministic computation and provenance; recorded, human-signed-off judgment where a model helps.
- **PII / BAA.** The rule is a decision, not a caveat: if a model request contains PII, a **local model or a
  provider BAA is mandatory**; if PII is stripped first, any model (local or cloud, no BAA) is fine. So
  de-identification is a *preprocessing gate* before the heavier judgment model — a `compute.run` op or a
  wrapped-`fetch` decorator running a local PII-detection/removal model against HIPAA Safe Harbor-style identifiers
  such as names, dates of birth, medical record numbers, Social Security numbers, and addresses. It is a host port
  decorator, not core; the receipt records that de-id ran and which model/version. For synthetic or pre-deidentified
  fixtures this gate is expected to be a no-op; for real clinical text it is mandatory.

## The judgment data plane

Fine-tuning or otherwise specializing a small model to an organization's review preferences is the **complement** to
this application, not a competitor. The application does not train the judge; it records and gates judgments. But the
`bio_observations` ledger + CAS **is** the provenanced `(input, judgment)` corpus such training assumes, and
contested-example verification maps directly onto abstain-and-route grounding plus the Phase-4 approval gate. The
application produces the data plane; whether to train a differentiated model on it is the host's call.

## Safety gates (inherited, non-negotiable)

The rare-high-impact gates carry over: abstention (no-frequency ≠ rare; correlated predictors collapse to one
evidence bucket, not several), no diagnosis or clinical-recommendation framing, explicit sources and evidence,
bounded tool/code behavior, a reproducible receipt. A run that fails any gate is a failure regardless of its rank
quality.

## Honest gaps

- The library produces the *dataset*, not the trained model; do not claim it "closes over fine-tuning," only the
  data plane. Weight-update studying is out of scope ([`machine-studying-lineage`](./machine-studying-lineage.md)).
- `model→tools→model` HPO adjudication is a genuine agentic loop, but the agent already does that with the grounding
  tools; it is app behavior, not a library primitive.
- Foreign graph projection and closure are proven on a hermetic Biolink edge fixture
  (`scripts/foreign-graph-closure.mjs`), while its best-effort remote probe checks a pinned Monarch canonical `edges`
  relation. Full nodes/edges/upstream-closure traversal and future snapshot selection remain application policy.
- Calibration and ACMG points encode human curatorial judgment (authored rules, not derivable); they are app
  producers with tests, and the receipt records which ruleset/version ran.
- Claims about small specialized models outperforming frontier models are domain-contingent. For this application,
  the transferable part is the provenanced review recipe, not a model-quality claim.

## Product-scale boundary

pi-bio-agent stays a lean substrate. The application host brings the backend: manifests, producers, tests, host
policy, and a thin case-analysis agent, with no new library primitives unless repeated implementations prove a
missing primitive. If a real case can run end to end under the gates, with the annotation source and every
tool/DB/API version in the receipt and the model's judgment recorded and signed off, the substrate has done its job:
the application is composed around stable primitives instead of absorbed into core.
