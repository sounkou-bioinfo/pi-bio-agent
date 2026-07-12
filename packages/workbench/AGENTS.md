# AGENTS.md

Instructions for coding agents working in this repository.

## Product Boundary

- `packages/workbench` is the first-party application binding over the root `pi-bio-agent` package. It owns domain
  data, relations, workflow composition, review policy, API schemas, and user-facing surfaces. Core owns execution,
  durable jobs/checkpoints, CAS, receipts, replay, graph/memory primitives, and host-injected effects.
- Keep the dependency one-way through the public `pi-bio-agent` package surface. Do not import root `src/` internals,
  vendor substrate code, or maintain a second workbench checkout. The package metadata uses the GitHub package
  contract for external consumers; this monorepo is the lockstep development path.
- A missing generic primitive is a core change; a clinical choice stays in manifests, SQL, fixtures, or host
  composition. Never conceal a core gap behind a workbench helper just to make one path pass.
- The agent or human composes over declared facts. Biomedical facts come from declared resources, deterministic SQL
  or compute, receipts, CAS, and recorded judgments, not from generated prose.
- This is pre-1.0 work. Delete false models instead of preserving them behind compatibility shims.

## Thin Binding Rule

- Manifests and SQL are the workbench program. Keep them declarative and small: one template is authored and the
  generated manifest is derived by `npm run manifest:clinical`; do not hand-edit duplicated generated JSON.
- Before adding a TypeScript file or helper, check whether existing core SQL, a resolver, SemanticSQL, DuckDB FTS,
  DuckHTS, DuckNNG, the async runner, CAS, or checkpoints already express the behavior. Domain questions belong in
  relations and operations, not per-question clients, skills, parsers, or workflow engines.
- TypeScript in this repository is limited to application orchestration, host policy/capability injection, typed API
  boundaries, and an adapter that a concrete source genuinely requires. If the same adapter shape appears twice,
  name the concrete consumers and move the reusable primitive to `pi-bio-agent` instead of adding a third app file.
- Do not create a second retry loop, async lifecycle, auth/profile abstraction, graph projection, evidence format, or
  manifest layer when the core or DuckNNG surface already provides it. Extend the owning primitive and add the
  smallest application-specific SQL around it.
- Do not create a new schema/version/helper merely to label an internal intermediate. A persisted artifact, public API,
  replay contract, or independently consumed relation must earn its own contract; otherwise use ordinary SQL rows.
- Treat executable application QMDs as the primary application narrative. They should call the public package,
  assert the contract they describe, and render bounded evidence. Do not maintain a second prose design document
  that restates the workflow without executing it.

## Immanent Core Abstractions

- The workbench is where missing primitives become visible through repeated use. Implement application policy here
  first with manifests, SQL, and existing ports.
- Promote a primitive only after another application or generic pattern exhibits the same motion. Name both
  consumers, reconcile the proposed contract with existing core abstractions, and move only policy-free mechanics.
- After promotion, route every consumer through the public `pi-bio-agent` API and delete local adapters. A core
  abstraction that leaves its motivating application on a private path is incomplete.

## Proven Core Capabilities

- `duckdb.sql_materialize` is the general declared read-only SQL materializer. Use it over DuckDB-native files,
  `httpfs`, views, SemanticSQL projections, and extension table functions; do not write a source-specific loader.
- `ducknng_ncurl_table` handles one dynamic-schema response. `ducknng.http_fanout` and core `ncurlFanout` handle
  declared batch SQL with bounded AIO launch/drain, transient retry, backoff, cancellation, and terminal failure.
  `ducknng` also provides host-owned profiles and in-memory TLS handles. Do not add `fetch`, `urllib`, or a VEP client.
- `duckhts.read_bcf` performs indexed region reads. Existing examples prove the online VEP fanout path; application
  code supplies only domain batch SQL and response normalization.
- Compute is the async `submit/status/collect/cancel` port. Workflow code uses task -> step -> checkpoint and resumes
  from completed content-pinned steps; it does not invent another lifecycle.
- Use canonical graph relations, pinned foreign graph projections, SemanticSQL views, FTS, and SQL closure. Do not
  serialize large graph neighborhoods into prompts or create a mandatory phenotype-mapper service.

## Clinical Traversals

- Direct and inverted are traversal orders over shared evidence, not separate kernels. Direct starts from variants;
  inverted starts from the case narrative, grounds phenotype assertions, walks phenotype/disease/gene relations,
  selects assembly-pinned intervals, reads indexed case VCF regions, and annotates the selected alleles. Both converge
  on compatible candidate and assessment relations.
- Preserve negative, uncertain, family-context, missing-frequency, missing-coverage, and unsupported-scope states.
  A missed or unsearched variant is not negative evidence. Assembly or coordinate mismatches fail closed.
- The inverted lane composes declared ontology labels/synonyms, FTS or SQL, typed term sets and grounding validation,
  graph projection/closure, Monarch, DuckHTS, existing VEP fanout, and SQL ranking. Add another provider only after a
  measured retrieval or reranking gap.
- The rare-disease application policy is case narrative -> grounded phenotype assertions -> Monarch disease/gene
  hypotheses -> assembly-pinned gene intervals -> indexed case-VCF range reads -> existing VEP fanout -> SQL ranking
  -> literature evidence and gated review. This is workbench composition, not evidence for another core resolver,
  mapper, workflow engine, or per-question skill.
- Online VEP is targeted and bounded. If the admitted set or endpoint cannot be handled, fail clearly or route to a
  declared local compute path; never truncate or silently substitute an answer.

## Provenance And Coordination

- Every scientific path is manifest/operation -> resolver or injected port -> DuckDB relation -> run -> CAS/receipt ->
  observation. A deliberate bypass is integration debt.
- Subagents and UI surfaces exchange durable relations, CAS references, checkpoints, and observations. Prose may explain
  a handoff, but it is not the scientific state and must not be the only record of a candidate, source, score, or
  judgment.
- Live sources, volatile SQL, host effects, auth profiles, and region reads must be recorded honestly. Host policy owns
  network, filesystem, credentials, process isolation, and extension provisioning; this repository is not a sandbox.

## API And Checks

- Zod schemas are the runtime contract and the source for OpenAPI. Do not maintain a second hand-written API spec.
- Use `rg` and `apply_patch`. Run `npm run manifest:clinical` after template changes, then `npm run check`.
- Run `npm run demo:clinical` for the end-to-end clinical path and `npm run pattern:monarch` for the pinned foreign
  graph path. Unit fixtures prove contracts; live pattern proves source and host compatibility.
- Keep README documentation consistent. For cross-package changes, also read the substrate repository's `AGENTS.md`
  and review with the reusable Pi review session described there.
