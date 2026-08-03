# AGENTS.md

Instructions for coding agents working in `packages/workbench`.

## Start here

- Read the root `AGENTS.md` first. It owns repository-wide execution, evidence, temporal, graph, and documentation
  rules.
- The workbench consumes the public `pi-bio-agent` package. Do not import root `src/` internals or duplicate core
  runners, stores, queues, CAS, replay, graph, or checkpoint machinery.
- The executable application QMDs are the primary workflow narratives. Do not create a second prose design that
  restates them without executing the public surface.

## Product boundary

- The workbench owns application manifests, SQL relations, fixtures, clinical policy, review packets, API schemas,
  browser composition, and user workflow.
- Core owns reusable validation, resource resolution, execution, async compute shape, jobs/checkpoints, CAS, receipts,
  replay, observations, and graph projection.
- A clinical choice stays here. A repeated policy-free mechanism needed by another consumer moves to core with tests,
  and every consumer returns to the public SDK afterward.
- Biomedical claims come from declared resources, deterministic SQL or compute, receipts, source-linked evidence, and
  recorded judgment. Generated prose is never the fact source.
- This is pre-1.0 software. Delete a false model or private workaround rather than preserving it behind compatibility
  scaffolding.

## Thin application rule

- Manifests and SQL are the application program. Generate the clinical manifest from its template; do not hand-edit
  duplicated generated JSON.
- Before adding TypeScript, determine whether existing SQL, a resolver, DuckDB extension, async runner, CAS,
  checkpoints, or graph projection already expresses the mechanism.
- Workbench TypeScript is limited to application orchestration, host capability composition, typed API boundaries,
  browser integration, and source adapters that cannot be represented by an existing public primitive.
- Do not add another retry loop, async lifecycle, auth/profile layer, evidence store, graph model, manifest layer, or
  workflow engine. Extend the owning primitive or keep the domain-specific part in SQL.
- An internal intermediate does not earn a schema and version merely because it has a name. Version persisted
  artifacts, public APIs, replay boundaries, and independently consumed relations.

## Browser and host boundary

- Interactive conversation and durable scientific evidence are separate planes. Session prompts, steering, abort,
  transcripts, and transient activity belong to the agent host; scientific state belongs to runs, jobs, CAS,
  observations, graph relations, packets, and approvals.
- Pi is the first agent-host adapter, not the workbench protocol. Keep Pi SDK types, dynamic-tool behavior, and session
  mechanics inside the Pi adapter until another host demonstrates a shared requirement.
- Browser requests address opaque ids. They do not supply host paths, executable extension code, credentials, or
  capability grants.
- The reference server is loopback-only and is not a process sandbox. Remote or multi-user deployment requires host
  authentication, TLS, admission policy, and isolation.
- `WorkbenchAddon` pairs host-approved API registration with a same-origin browser module. Addons use the canonical
  SDK and stores; they do not install themselves, accept browser-supplied modules, or create private persistence.
- Browser changes require Playwright coverage over the real local server. Exercise desktop and mobile layout and
  inspect screenshots for geometry changes.

## Scientific artifacts and effects

- A figure, report, or generated table is a scientific artifact only when a declared run captures it in CAS and links
  it to its producing run. A process writing an arbitrary workspace file does not satisfy that contract.
- Use declared `compute.run` inputs and outputs for Python, R, shell, or workflow computation that supports a
  scientific claim. Ordinary bash remains host work and is audited through session ingestion, not promoted into a
  fake scientific run.
- Network, credentials, process permissions, extension provisioning, and isolation are host grants. Missing grants
  fail clearly; do not add hidden fallbacks.

## Clinical evidence invariants

- Direct and phenotype-first analyses are traversal orders over shared evidence, not separate execution kernels.
  Both produce compatible candidate and assessment relations.
- Preserve negative, uncertain, family-context, missing-frequency, missing-coverage, unsupported-scope, and
  unsearched states. Missing or unsearched evidence is not negative evidence.
- Assembly, coordinate, sample, and family-member mismatches fail closed.
- Evidence packets are immutable. Review dispositions are separate temporal observations keyed to one packet item and
  do not silently transfer to a later analysis.
- Reanalysis queues expose recorded reasons and latest evidence state. They are not diagnostic scores or clinical
  classifications.
- Online annotation is targeted and bounded. If the admitted set or endpoint cannot be handled, fail or use a
  declared local-compute path; never truncate silently.
- Hermetic fixtures establish mechanics and regression behavior. They do not establish ACMG/AMP validity, diagnostic
  accuracy, clinical utility, or retrospective yield.

## API, documentation, and checks

- Zod schemas are the runtime API contract and OpenAPI source. Do not maintain a second hand-written API schema.
- Keep stalled product ideas out of this file. An unimplemented browser, evidence-extraction, benchmark, or deployment
  plan belongs in an issue until a current consumer, failing test, or executable proof makes it active.
- Edit QMD sources rather than generated Markdown. Keep claims bounded to what their assertions establish.
- Use `rg` for search. Run `npm run manifest:clinical` after template changes.
- Run the focused test first, then `npm run check` for workbench changes. Use `npm run check:all` from the repository
  root for shared contracts or cross-package changes.
- Run `npm run demo:clinical` for the deterministic end-to-end clinical composition and `npm run pattern:monarch` for
  the pinned foreign-graph path when those surfaces change.
