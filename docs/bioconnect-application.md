---
type: Proposal
title: "BioConnect: an end-to-end clinical-genomics application on pi-bio-agent"
description: "The flagship APPLICATION product that consumes pi-bio-agent as a library: staged, deterministic-first variant analysis (case structuring, annotation, HPO, prioritization, scoring, ACMG, family-aware interpretation) with recorded-and-gated judgment. Read before scoping the application or a paper."
tags: [flagship, application, clinical-genomics, product, reproducibility]
---

# BioConnect: an end-to-end clinical-genomics application on pi-bio-agent

BioConnect is a **downstream application product**, not part of the library. It consumes `pi-bio-agent` the way
the thesis intends: the library ships primitives; the application brings the workflow, the manifests, the
producers, and the domain rules. If BioConnect runs a real clinical-genomics case end to end with the library
essentially unchanged, the bet is demonstrated at product scale, not just in the walking skeleton.

It is the **rare-high-impact flagship grown up**: same substrate, same abstention/no-diagnosis gates, a real
staged workflow instead of three synthetic variants.

## The mental model

> One case-analysis agent, backed by DuckDB tables and a few strong tools, operating over a staged flow. Not a pile
> of unrelated scripts, and not an agent zoo.

DuckDB does retrieval, filtering, aggregation, and baseline scoring, deterministically. The model is called only on
the *reduced* candidate set, for interpretation and synthesis, and its output is recorded and gated. That is design
bet #1 (the manifest is the program) and #2 (four legs on one DuckDB substrate), arriving independently from a
clinical team ([`bioconnect-flagship`](../docs/roadmap.md), study synthesis 2026-07-03).

## The staged workflow, mapped to primitives

Each stage names the `pi-bio-agent` primitive it uses and whether it is a **manifest** the app composes (no library
change), an **app producer** (host code the app owns), or a **library build** (a new capability the library adds).

| # | Stage | Primitive | Where it lives |
|---|---|---|---|
| 1 | Case structuring (singleton vs multiplex/family) | SQL views over ingested tables | app manifest |
| 2 | Batch annotation on UNIQUE SNV/CNV keys | `ncurl_table` (GeneBe, with fanout + backoff) **or** `process.compute` (VEP CLI) | app manifest |
| 3 | HPO extraction harness (4 modes) | grounding: deterministic-first + abstaining model | **library build** |
| 4 | Gene prioritization over Monarch KG | `bio_edges` + `entailed_edge`, remote `ATTACH monarch-kg.duckdb`, duckpgq paths | app manifest (uses build #4) |
| 5 | Deterministic variant scoring | SQL over annotation columns (REVEL/AlphaMissense/SpliceAI/CADD) | app manifest |
| 6 | Deterministic inheritance scoring | SQL over genotypes + family structure | app manifest |
| 7 | Combined baseline score, calibrated on ClinVar/known-solved | SQL combine + a calibration producer | app producer |
| 8 | Targeted ACMG evidence assembly (points-based, reduced set) | `scale_members` (ACMG points) + a combine producer | app producer |
| 9 | Family-aware interpretation (multiplex) | SQL aggregations over the family variant view | app manifest |
| 10 | Optional agentic synthesis / rerank on the reduced set | recorded-and-gated judgment (Phase 4) | library (record + gate) |

**Six stages are a manifest away** (1, 2, 4, 5, 6, 9). The judgment stages (3's adjudication, 8, 10) are
**recorded and gated, never computed by the substrate**. What the library must add is small.

## What the library builds (ranked by immanence)

Each abstracts at least two things that already exist, so it reveals a real general, not an imagined one.

1. **HPO grounding harness** (highest). Abstracts `decideGrounding` (`src/core/judgment.ts`) + the `ols4-grounding`
   `ncurl_table` manifest. Today grounding is one projection-then-judgment path; the four BioConnect modes
   (tool-only, model-only, candidates→model, model→tools→model) generalize it. Named consumer, and it *closes
   grounding*. The `model→tools→model` mode is a real agentic loop beyond the current single-shot judge: the new logic.
2. **Monarch-KG manifest / connector** (medium). Abstracts SemanticSQL statements→`bio_edges` ingest + the
   `sql_materialize` resolved-resource pattern. New surface: remote `ATTACH` of `monarch-kg.duckdb` and a
   biolink→predicate projection. Prototype on a locus extract first; remote ATTACH stresses the graph-at-scale hedge.
3. **Ledger → training-dataset exporter** (lowest, external consumer). Abstracts the `coloc-record` producer +
   rare-high-impact receipts + Phase-4 approval rows. Emits fine-tune-ready, contested-flagged (input, judgment)
   rows. See "the judgment data plane" below.

Everything else (calibration weights, ACMG-points curation, scoring rules, the case-analysis agent and its tools)
is **app code**: manifests, `src/producers/`-style modules, and a thin agent over prepared DuckDB views. The
library does not learn a domain.

## Production and reproducibility (the regulatory-fit argument)

Clinical genomics is regulated, so this is the section a paper needs.

- **Ingestion / ETL.** Real inputs are VCF, a database, CSV, or Excel. A manifest *is* the ETL: `duckhts` reads
  VCF, `file_scan` reads CSV/Parquet, `ATTACH` reads another DB, the DuckDB excel extension reads Excel. The
  standard format is the resolved resource tables plus `bio_observations`, and the receipt records where each byte
  came from. "Prefer database tables" is the substrate.
- **Annotation throughput and cost.** Turnaround drives a resolver choice, both manifest-expressible: the GeneBe
  API via `ncurl_table` with rate-limited fanout + exponential backoff (the WGS-chr22 seam), or the VEP CLI via
  `process.compute` (a genome in minutes, not hours). Restricted fields (REVEL, AlphaMissense, CADD, SpliceAI,
  OMIM are commercial-restricted) are *declared* in the manifest and *recorded* in the receipt (source, version,
  license); the allow/deny gate is host policy, like PII, not core.
- **Versioning for audit and accreditation.** Tool, database, and API versions must be logged. That is the
  `EnvDescriptor` attestation + resolver receipts (resolver version, params digest, source snapshot) + the
  immutable `bio_observations` ledger + `reproduceRun()`. Built for exactly this.
- **LLM non-determinism.** The reproducible, auditable work is deterministic SQL: retrieval, filtering, scoring,
  and counting are a `GROUP BY`, so they replay bit-for-bit. The model runs only on the reduced set, and its output
  is **recorded** (immutable, with its inputs and a digest) and **gated** (human sign-off). An auditor never needs
  the model to be deterministic: the ledger says what it produced, on what inputs, when, and who approved it.
  Vendor model-determinism features help *replay*, but the audit trail does not depend on them. The one line:
  **determinism where the regulator needs it (the computation and the provenance), recorded and human-signed-off
  judgment where the model helps; non-determinism is contained to an auditable layer, never the reproducible
  computation.**
- **PII / BAA.** The rule is a decision, not a caveat: if a model request contains PII, a **local model or a
  provider BAA is mandatory**; if PII is stripped first, any model (local or cloud, no BAA) is fine. So
  de-identification is a *preprocessing gate* before the heavier judgment model — a `process.compute` op or a
  wrapped-`fetch` decorator running a local PII-detection/removal model (e.g. OpenMed's clinical PII models: HIPAA
  Safe Harbor, the 19 identifiers — names, DOB, MRN, SSN, addresses; see
  [Maziyar Panahi / OpenMed](https://x.com/MaziyarPanahi/status/2011216438883676265)). It is a host port decorator,
  not core; the receipt records that de-id ran and which model/version. (Note: this is itself a *differentiated
  intelligence* instance — a small specialized local model for one bounded task — so the same small-tuned-model
  pattern shows up twice in the pipeline, at de-id and at HPO extraction.) In the current dataset PII was removed
  upfront and the genotypes are synthetic, so HPO extraction has no model restriction; the gate matters for real
  clinical text.

## The judgment data plane

The Bridgewater/Thinking-Machines result (fine-tune a small model to org taste, beat frontier ~30% fewer errors at
~14× lower cost) is the **complement** to this application, not a competitor. They *train* the judge; we *record
and gate* it. But the `bio_observations` ledger + CAS **is** the provenanced (input, judgment) corpus a fine-tune
assumes, and their contested-example verification (train on cheap labels, route disagreements to experts) **is**
this app's abstain-and-route grounding plus the Phase-4 approval gate. BioConnect produces the data plane; whether
to train a differentiated model on it is the host's call (the trained conductor we deliberately leave out). Build
#3 (the exporter) is the seam.

## Safety gates (inherited, non-negotiable)

The rare-high-impact gates carry over: abstention (no-frequency ≠ rare; correlated predictors collapse to one
evidence bucket, not several), no diagnosis or clinical-recommendation framing, explicit sources and evidence,
bounded tool/code behavior, a reproducible receipt. A run that fails any gate is a failure regardless of its rank
quality.

## Honest gaps

- The library produces the *dataset*, not the trained model; do not claim it "closes over fine-tuning," only the
  data plane. Weight-update studying is out of scope ([`machine-studying-lineage`](./machine-studying-lineage.md)).
- `model→tools→model` HPO adjudication is a genuine agentic loop; it is the real new logic in build #1.
- Remote Monarch ATTACH stresses the closure-at-scale hedge; prove it on a locus extract before claiming graph-walk
  performance over the full KG.
- Calibration and ACMG points encode human curatorial judgment (authored rules, not derivable); they are app
  producers with tests, and the receipt records which ruleset/version ran.
- The "small model beats frontier" result is domain-contingent (financial taste has no external truth). Clinical
  genomics has ClinVar and a no-diagnosis gate, so the transferable part is the *recipe*, which the ledger supplies.

## The bet, at product scale

pi-bio-agent stays a lean substrate. BioConnect is the host that brings the backend: a manifest pack, a few
producers, a thin case-analysis agent, and one new library capability (the grounding harness). If it runs a real
case end to end under the gates, with the annotation source and every tool/DB/API version in the receipt and the
model's judgment recorded and signed off, the substrate has done its job: the application is composed, not coded.
