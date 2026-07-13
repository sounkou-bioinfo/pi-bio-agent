# pi-bio-workbench

`pi-bio-workbench` is the first-party application package over `pi-bio-agent`. It is where domain relations, review
policy, evidence packets, APIs, and browser surfaces are composed. The root package remains the policy-free
execution and evidence substrate.

The workbench includes a source-pinned published-variant surface, [clinical genomics](examples/clinical-genomics/application.md), and the generic
[method-selection application](examples/method-selection/application.md). Their executable QMD files are the
application narratives and proofs; rendered Markdown is committed for ordinary readers.

The browser shell loads host-approved `WorkbenchAddon` pairs. Variants projects registered benchmark rows and
independently resolved source snapshots; Clinical Evidence and Clinical Reanalysis are loaded only for a workspace
that explicitly supplies the clinical manifest; and Artifacts projects verified CAS figures/reports. Addons use the
same public SDK and store rather than creating application-local persistence.

## Package boundary

The workbench imports the public `pi-bio-agent` package. It does not import root `src/` internals or maintain a
second runner, ledger, CAS, graph, retry system, or workflow engine.

| Root substrate | Workbench application |
|---|---|
| manifests, resolvers, SQL validation | domain manifests and relations |
| query and operation runners | task composition and host policy |
| async compute and durable checkpoints | clinical step definitions |
| CAS, receipts, replay, observations | evidence packet and review queue |
| graph projection and foreign sources | phenotype and case-evidence semantics |
| public SDK and host ports | CLI, API, browser, and agent-host adapters |

Applications are also the main abstraction pressure surface. A workbench workaround does not become a core feature
by convenience. The same motion must appear in another application or generic pattern, conflict with no stronger
existing primitive, and admit a smaller policy-free contract. The promoted primitive then returns through the public
package surface and the workbench workaround is deleted.

## Clinical application

The application has two traversal orders over the same declared case evidence:

- direct assessment starts from observed variants;
- inverted assessment starts from a case narrative, reviewed HPO assertions, Monarch disease/gene hypotheses,
  assembly-pinned intervals, indexed VCF reads, and bounded VEP annotation.

Both lanes close into `case_evidence`. Coverage states distinguish an unsearched hypothesis from completed search
with no supporting variant. Missing population frequency remains an abstention. The complete relations stay in the
analysis DuckDB; the review-bearing packet and checkpoints use CAS references.

This is evidence routing. It does not claim ACMG/AMP classification, diagnosis, or clinical validity. The next
application closure can extend the same resumable study from uploaded VCF/TSV/CSV plus a case narrative through HPO
grounding, phenotype/gene retrieval, indexed range restriction, VEP, typed ACMG evidence proposals, phenotype
reranking, literature evidence, and gated review. VEP annotations alone are not an ACMG classification: population,
inheritance/segregation, de novo, functional, curated, and review evidence remain explicit inputs.

### Release-pinned ClinVar reclassification harness

The workbench now has a separate temporal source plane for ClinVar-style releases. Raw TSV/XML/VCF bytes and a
declared normalizer identity are content-addressed in CAS; normalized release-scale assertions live in DuckLake; and
the ordinary ledger records only release metadata, source and normalized artifact references, exact DuckLake snapshot
anchors, graph links, and recorded operations. `clinical.clinvar_assertion_graph` derives assertion-to-variation,
condition, and gene edges by SQL from one pinned snapshot. It is a queryable graph view, not a second graph database
or a bulk copy of ClinVar into observations.

`prepareClinVarTemporalTask` prepares a blind-evaluation record for retrospective source-label work: it materializes
only the baseline release into a non-overlapping agent workspace, records an HMAC target commitment keyed by
evaluator-only entropy, and keeps the target release, commitment secret, and delta operation in the evaluator
workspace. The task metadata therefore cannot be matched against candidate target metadata by simple enumeration.
`clinical.clinvar_temporal_candidates` performs source-label selection in baseline SQL;
`registerClinVarTemporalProposalSet` then accepts one ranked prediction or explicit abstention per candidate. It
rejects a handoff unless the task, candidate manifest, baseline bindings, exact DuckLake snapshot, host receipt,
result CAS digest, replay, and run-object root agree. The proposal artifact records actor/provider/model identity and
a digest of the host's prompt/tool/model contract; it remains a proposal rather than becoming a biomedical fact.

`runClinVarTemporalProposalEvaluation` copies that verified artifact across the host boundary and executes two
declared evaluator-only SQL operations over the hidden target delta: per-candidate scores and aggregate coverage,
accuracy, change recall, and reciprocal-rank metrics. Proposal bytes are protected bindings, so replay pins their
digest without serializing them. A structured host isolation receipt is pinned in task and run provenance, but only a
host container, microVM, filesystem policy, or equivalent tool boundary can enforce it. A prompt alone is not a
blind. The result measures later ClinVar source-label agreement, not clinical truth, diagnosis, ACMG validity, or a
replacement for expert review. The executable proof is
[clinvar-temporal.test.ts](test/clinvar-temporal.test.ts).

### Published ACMG workbook

The Ma et al. supplementary workbook now enters through `registerPublishedAcmgWorkbook`: the ZIP container, inner
XLSX, and normalized bundle are content-addressed; a declared SQL operation validates role counts and data-quality
signals; and the registration links those artifacts to the validation run in the ordinary ledger. The adapter keeps
four roles separate: S1-S7 Hong Kong Genome Project (HKGP) rule development, S8-S11 authored knowledge, S12 held-out
variant validation, and S13 variant reanalysis. It preserves source cells, normalizes five-class labels while retaining
raw spellings, parses criterion strength/footnote markers, and independently recomputes the worksheet's model/human
concordance flags.

The `rule_development` role is specific: S1-S7 contain 1,000 curator-reviewed HKGP variants used to optimize the
AI-CURA prompt/evidence-reading procedure for seven literature-dependent criteria. They did not develop the ACMG/AMP
rules. They are real variant examples, but they are development-contaminated and therefore cannot contribute to
independent validation metrics.

The paper uses two different retrieval inputs that should not be collapsed into “RAG”:

- variant publications were found outside the model (the study used Mastermind), downloaded with supplements, and
  converted when necessary from XLSX to CSV or Word to text before being supplied to the LLM. These files are the
  evidence corpus for PVS1 (RNA), PS2/PM6, PS3, PS4, PM3, PP1, and PP4. The preparation was necessary because the
  model was run as a bounded document reader rather than an autonomous literature-search agent, and because tables
  and supplements had to be represented in supported formats;
- S8-S10 are narrow authored policy/interpretation knowledge bases retrieved for gene-disease consistency in
  PS2/PM6, modified segregation scoring in PP1, and gene-specific phenotype/testing specificity in PP4. S11 supplies
  PS4 thresholds. This is criterion guidance, not a search index of the publications.

The remaining literature-independent evidence was assembled from declared sources and deterministic predictors. The
study then ran the literature-dependent readers at least twice and manually aggregated criterion decisions. That is
a useful benchmark design, but it is not yet an end-to-end tool-using agent or a complete automated ACMG/AMP kernel.

These rows are variant-centered, not rare-disease case packets. The workbook contains no stable ClinVar/ClinGen
accessions, so import keeps identity unresolved. `resolvePublishedVariantWithNcbi` then runs declared `http.get`
operations against NCBI Variation and ClinVar, retains every response and resolver receipt in CAS, validates the
HGVS/SPDI/GRCh38 identity, and links the resolution to the workbook row and source runs. Run the exact supplied
archive with both content digests:

```sh
npm run benchmark:acmg --workspace=packages/workbench -- \
  --archive /path/to/scitranslmed.adz4172_tables_s1_to_s13.zip \
  --expected-archive-digest sha256:eedf0d516842e5a1f929606161f61ae8185253d679810abc603d64526bbdd2ee \
  --expected-workbook-digest sha256:4e8c55487dafcf88f4c34c233e52f5fc12860f7a7e9dcef4490f6464535ddbfa \
  --workspace .pi/published-acmg-benchmark

npm run resolve:acmg-variant --workspace=packages/workbench -- \
  --row-id 'ST12_150 ClinGen varinats:39' \
  --workspace .pi/published-acmg-benchmark

npm run serve --workspace=packages/workbench -- \
  .pi/published-acmg-benchmark \
  8787
```

Open <http://127.0.0.1:8787> and choose **Variants**. The featured real row is
`NM_001369369.1(FOXN1):c.880G>A (p.Val294Ile)`. The pane keeps the workbook source classification, human
reassessment, current ClinVar classification, current identifiers, criteria, source response digests, and run ids
separate. The importer prints bounded role counts and quality findings, not the 1,480 source rows.

## Run

```sh
npm install
npm run provision:ducknng --workspace=packages/workbench
npm run provision:duckhts --workspace=packages/workbench
npm run check:workbench
npm run application:clinical
npm run application:method-selection
npm run application:method-selection-agent
```

The clinical application QMD uses synthetic biology only as a deterministic substrate regression proof: it runs a
hermetic VEP-compatible endpoint, verifies transient retry, executes all eight steps, resumes from checkpoints, and
renders a collapsed evidence summary. It is not the default browser workspace and must not be presented as a real
case or clinical benchmark.

The method-selection QMD studies a refreshable action relation, discovers the method with SQL under host constraints,
authors a manifest operation, runs it, validates and approves the candidate, writes the approved skill revision into the
same ledger, and walks the resulting graph. DuckDB remains the stateful work surface; external catalogs and optional
NNG/embedded kernels are application inputs. The path is deliberately model-light and can be driven by a skill-only
CLI host or a weaker agent: schema inspection and bounded SQL carry the scientific state instead of prompt context.

`examples/method-selection/agent.qmd` is the live boundary proof. It invokes `gpt-5.3-codex-spark` with only the
packaged skill, `read`/`write`/`bash`, and the `pi-bio-agent` CLI. The agent authors the selected manifest and operation;
the harness independently checks the result, replay, session import, ledger, and graph. Run it only when the host has
configured model credentials; it is intentionally not part of the deterministic package check.

Run the package CLI directly when an application document is not needed:

```sh
npm run build:all
node packages/workbench/dist/cli.js run \
  packages/workbench/examples/clinical-genomics \
  CASE-RD-001 \
  analysis-demo
```

The default CLI composition uses recorded grounding and local graph/VCF fixtures but the configured VEP endpoint.
Embedded hosts inject model or human grounding ports, graph attachment, VCF identity, VEP endpoint/profile, network
admission, credentials, and extension provisioning.

## Live foreign graph

The same hypothesis operation can query Monarch's versioned DuckDB snapshot:

```sh
npm run pattern:monarch --workspace=packages/workbench
```

The host attaches the snapshot read-only. The manifest queries canonical `edges`, `nodes`, and `closure` tables; no
Monarch-specific resolver or denormalized graph copy is required. The output is a ranked hypothesis relation for
targeted search and review, not a diagnosis.

## API

```sh
npm run serve --workspace=packages/workbench -- \
  .pi/published-acmg-benchmark \
  8787
```

Open <http://127.0.0.1:8787>. The browser opens, resumes, and renames persistent Pi sessions; discovers invokable
extension/template/skill commands for slash completion; accepts prompt/steer/follow-up input; and aborts or closes an
active session. Variants shows bounded S12/S13 rows, workbook decisions, model decisions, and independently pinned
current-source identities. Tool payloads and raw lifecycle deltas stay under collapsible diagnostics rather than
dominating the conversation. Starting the server against `examples/clinical-genomics` explicitly adds the synthetic
Evidence and Reanalysis regression panes; they are not loaded into the real-variant workspace. Every pane hands
durable run ids and CAS references back to Pi for ledger/graph inspection.

This host explicitly grants local `compute.run` with the workspace CAS. A plot or report is a declared compute output
with media/role metadata, then a run/CAS/graph artifact visible in the Artifacts addon. A file written directly by
Python, R, or shell is merely a workspace side effect and is not presented as scientific evidence.

The reference workbench keeps Pi's built-in `bash` for host inspection, authoring, testing, and CLI work. This is
intentionally not a replacement "bio bash": arbitrary shell commands do not have the declared inputs, outputs,
environment, receipts, or replay contract of scientific compute. When a command produces evidence for a scientific
claim, the agent must declare it as a `compute.run` resource and execute it through `bio_query` or a declared
operation. The embedded Pi host emits Pi's `session_shutdown` lifecycle before disposing a session, so session
ingestion records ordinary bash command/result digests, but filesystem side effects do not become workbench artifacts.
Inline media returned in a tool result may separately be retained as a `session_image` audit
artifact; it is not a run-linked scientific output.

For likely plot, figure, external-runtime, or workflow requests, the Pi extension injects a visible just-in-time
reminder before the agent starts. It points granted hosts to declared `compute.run`; without a compute grant it fails
closed instead of treating raw bash as a scientific fallback. Pi's `user_bash` hook is separate and covers only
human-entered `!` and `!!` commands.

Zod route schemas validate requests and generate OpenAPI 3.1. The server fixes its workspace and Pi extension at
startup; callers submit neither host paths nor executable extension configuration, and store/session paths are not
part of the HTTP contract. `AgentHostPort` is host-neutral. The first adapter embeds Pi's public SDK; Pi-specific
session and dynamic-tool mechanics do not enter the browser protocol.

### Permissions and deployment

The reference server binds `127.0.0.1` and applies a same-origin content-security policy. This protects the local HTTP
surface from accidental network exposure; it is not process isolation. Pi, its enabled tools, extensions, and any
declared compute or network access they invoke run with the permissions of the user who launched the server. The
reference workbench keeps Pi's built-in shell, which has the operator's ordinary system access. Use a container,
microVM, or other host policy when that authority is too broad; evidence recording is not process isolation.

Do not expose this reference server directly to a network. A remote or multi-user deployment must add authentication,
TLS, per-principal admission, credential policy, and an appropriate process/container/microVM boundary. DuckNNG can
provide authenticated shared SQL and worker transport; that does not itself sandbox the Pi process.

## Checks

```sh
npm run check:workbench
npm run test:web --workspace=packages/workbench
npm run application:clinical
npm run benchmark:grounding --workspace=packages/workbench
```

Playwright starts the real loopback server and a local VEP fixture, opens a real Pi SDK session without spending a
model turn, executes and reads back a real CAS-backed clinical analysis, renders a real CAS-backed SVG figure,
exercises SSE, and checks desktop/mobile geometry. The grounding benchmark tests retrieval-contract behavior with
recorded proposals and reviews. Neither is a model-quality claim.
