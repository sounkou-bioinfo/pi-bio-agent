# pi-bio-workbench

`pi-bio-workbench` is the first-party application package over `pi-bio-agent`. It is where domain relations, review
policy, evidence packets, APIs, and browser surfaces are composed. The root package remains the policy-free
execution and evidence substrate.

The workbench includes [clinical genomics](examples/clinical-genomics/application.md) and the generic
[method-selection application](examples/method-selection/application.md). Their executable QMD files are the
application narratives and proofs; rendered Markdown is committed for ordinary readers.

The browser shell loads host-approved `WorkbenchAddon` pairs. Clinical Evidence and Clinical Reanalysis are loaded
only for a workspace that explicitly supplies the clinical manifest; Artifacts projects verified CAS figures and
reports. Addons use the same public SDK and store rather than creating application-local persistence.

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

The existing case-workup lane is evidence routing. It does not claim diagnosis or clinical validity. The separate
SVCv4 draft kernel below begins the deterministic classification backbone, while the same resumable study can accept
registered VCF/TSV/CSV assets, one or more case-description revisions, family structure, and an optional prior
assessment. VEP annotations alone are not a classification: population, inheritance/segregation, de novo,
functional, curated, phenotype, and review evidence remain explicit inputs.

Case inputs enter as immutable revisions rather than mutable workspace paths. A revision records pseudonymous family
members and relationships plus CAS-addressed narrative, indexed variant-set, optional tabular variant, and optional
prior-assessment assets. The CLI stages local files into CAS; the HTTP API supports streamed, digest-verified asset
upload followed by revision registration. Every analysis records the exact revision digest and links it to the
grounding, runs, packet, and graph projection. Omitted optional assets become typed empty relations rather than
falling back to example data.

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

### SVCv4 public-draft SQL kernel

The clinical example contains a source-pinned, reviewable SQL projection of the public ClinGen SVCv4 Classification
Model draft. It declares the score hierarchy, caps, branch exclusivity, profile selection, evidence-line admission,
roll-up, classification bands, and fail-closed classification gate. The only active method evaluator is `POP_FRQ`.
It preserves observed frequency, a counted zero, a covered no-hit, insufficient coverage, and a missing query as
different states; a one-sided exact binomial upper bound can represent what a sufficiently powered no-hit excludes
without fabricating an allele frequency of zero. A counted zero requires a source variant record with `AC=0` and
`AN>0`. A no-hit keeps AF, AC, and source AN null and may use only a separately evidenced locus-level post-QC callable
allele denominator; nominal panel or cohort size is not substituted for callability.

`clinical.svcv4_form_scopes` is the bridge from indexed candidate search to the classification model. It joins one
checkpointed candidate result to separately admitted, source-pinned gene-disease-MOI observations and emits either
one exact case-independent `POP_FRQ` scope or an explicit `not_formed` reason. It does not infer MOI from a gene,
phenotype rank, or candidate allele, and its assembly-pinned fallback allele identifier is deliberately not labelled
as GA4GH VRS.

`clinical.svcv4_case_audit` separately validates the public case-capture contracts for `CLN_AFF`, `CLN_DNV`,
`CLN_ALTV`, `CLN_ALTG`, and `CLN_UAF`. It preserves absent fields, explicit nulls, and `UNKNOWN`, validates nested
family/compound-heterozygous context, and records invalid or incomplete evidence without awarding points. The public
draft does not yet publish the ClinGen CSpec scoring algorithms for these methods, `POP_HMZ`, or the PFD methods, and
`CLN_CCS` remains underspecified. Those evaluators are deliberately marked `specified_not_implemented` or
`underspecified` rather than reconstructed from older rules.

The only included profile is `method_evaluation_only`, so `clinical.svcv4_classify` cannot emit a clinical class.
Source identities and method-definition digests are data, and a future clinical profile must admit a complete set of
validated evaluators before the classification gate opens. The executable contract is
[svcv4.test.ts](test/svcv4.test.ts); the generated binding is
[svcv4.manifest.json](examples/clinical-genomics/svcv4.manifest.json).

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

The clinical application QMD uses a deterministic regression case: it registers an immutable family/case revision,
runs a hermetic VEP-compatible endpoint, verifies transient retry, executes all nine steps, resumes from checkpoints,
and renders a collapsed evidence summary. It proves the application contracts, not model quality, clinical validity,
or performance on a real cohort.

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
node packages/workbench/dist/cli.js case register \
  /path/to/workspace \
  /path/to/case-revision.json

node packages/workbench/dist/cli.js run \
  /path/to/workspace \
  CASE-RD-001 \
  <revision-id-from-register> \
  analysis-demo
```

Asset paths in `case-revision.json` are resolved relative to the descriptor and staged into the workspace CAS before
the revision is committed. `case list` and `case get` inspect the immutable registry. The bundled CLI run composition
still uses recorded grounding and the local graph/interval providers while consuming the registered narrative and
indexed variant set plus the configured VEP endpoint. It is therefore an executable integration surface, not yet a
production rare-disease interpretation profile. Embedded hosts inject real model or human grounding ports, pinned
graph and interval sources, VCF identity, annotation endpoint/profile, network admission, credentials, and extension
provisioning.

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
  examples/clinical-genomics \
  8787
```

Open <http://127.0.0.1:8787>. The browser opens, resumes, and renames persistent Pi sessions; discovers invokable
extension/template/skill commands for slash completion; accepts prompt/steer/follow-up input; and aborts or closes an
active session. Tool payloads and raw lifecycle deltas stay under collapsible diagnostics rather than dominating the
conversation. Starting the server against `examples/clinical-genomics` explicitly adds the hermetic Evidence and
Reanalysis regression panes. Every pane hands durable run ids and CAS references back to Pi for ledger/graph
inspection.

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
