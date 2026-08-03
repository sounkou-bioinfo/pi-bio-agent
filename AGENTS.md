# AGENTS.md

Instructions for coding agents working in this repository.

## Start here

- Read `docs/INDEX.md` before opening unrelated design notes.
- Read `docs/design.md` before changing a shared boundary. Use the focused document that owns the mechanism:
  `docs/domain-model.md`, `docs/duckdb-substrate.md`, `docs/concurrency.md`,
  `docs/memory-and-knowledge-unification.md`, or `docs/ontology-and-knowledge-graphs.md`.
- `README.qmd` is the README source. `README.md` is generated.
- The root package is the public SDK. `packages/workbench` is the first-party application and
  `packages/quarto-engine` is a rendering adapter. Downstream packages consume public exports, not `src/` internals.

## Architectural rules

- Biomedical facts come from declared data, deterministic computation, resolver receipts, or recorded approval.
  A model may inspect, compose, explain, propose, and abstain; it is not a fact source.
- Manifests, resources, SQL, term sets, and observations are the program. TypeScript interprets them and binds host
  capabilities. Do not add question-specific biomedical logic to core.
- DuckDB is the common work surface for files, extension table functions, remote responses, graph relations,
  observations, and reductions. Prefer SQL, a table function, or an existing extension over another parser or client.
- Network, process execution, credentials, extension provisioning, clocks, filesystem policy, and deployment
  isolation belong to the host. Missing capabilities fail clearly; there are no silent fallbacks.
- Read-only SQL validation is not a sandbox. Strong isolation is a host responsibility.
- Runs remain explainable through declarations, receipts, replay material, CAS references, environment evidence, and
  temporal observations whenever the host supplies those facilities.
- CAS proves byte identity, not freshness or scientific truth. Live sources and volatile functions must remain
  visibly non-reproducible unless their relevant inputs and environment are pinned.
- `bio_observations` is the append-only temporal source for memory, facts, runs, jobs, approvals, and links.
  Graph tables and note files are projections, not competing stores.
- Query graph data with SQL or generated code. Do not serialize large graph neighborhoods or ledgers into prompts.
- Keep judgment narrow and typed. Mechanical parsing, mapping, scoring, and diffing stay in code or SQL; ambiguous
  choices are validated against an explicit candidate set and may abstain.

## Change admission

- Express a need in an application or executable pattern first. Promote a shared primitive only after at least two
  concrete uses repeat the same mechanism and existing public surfaces cannot express it cleanly.
- Do not add a second runner, queue, cache, ledger, graph model, resolver lifecycle, transport lifecycle, or auth layer
  to avoid using the existing one. Reconcile or delete the weaker boundary.
- A new scientific question should normally require schema inspection and SQL, not a new helper or skill.
- A new source or format belongs in a resolver or DuckDB extension. A new analysis belongs in SQL or a declared
  operation. A new backend implements the existing injected ports.
- Applications own domain policy, rankings, review packets, UI workflow, and source-specific product behavior.
  Core owns reusable execution, evidence, replay, temporal, and graph primitives.
- Pi-specific session control and dynamic-tool behavior stay in the Pi adapter. Promote host-neutral control behavior
  only after another host repeats it.
- `WorkbenchAddon` is an application-level API/browser pairing, not a general plugin marketplace or storage system.
- Self-extension means producing a validated manifest, operation, compute program, or skill revision with evidence and
  approval. It does not mean silently mutating core code or host permissions.
- Do not preserve speculative architecture in living docs. Unimplemented work with no active consumer, failing test,
  or executable proof should be removed or tracked as an issue until it becomes current.

## Documentation

- Update the existing owning document. Delete duplicate or stale prose instead of adding another note.
- Living design docs describe implemented behavior, active boundaries, and demonstrated gaps. They are not feature
  inventories, work diaries, or holding areas for stalled ideas.
- Claims about behavior must point to code, a test, an executable QMD, or a recorded application run. State explicitly
  when an example proves mechanics rather than scientific or deployment validity.
- Edit generated sources rather than outputs: `README.qmd` for `README.md`, and `examples/patterns/*.qmd` for generated
  pattern Markdown.
- A `ts`, `sql`, or `sh` block should run or be included from executed source. Use `text` for pseudocode.
- Keep prose direct. Remove assistant mannerisms, private-review shorthand, hype, repeated doctrine, and versioned
  implementation anecdotes from canonical design documents.
- New docs require frontmatter, an owning link, and regeneration of the docs index. Do not hand-edit generated indexes.

## Implementation discipline

- Prefer explicit interfaces and injected ports over ambient globals and scattered environment switches.
- Preserve package boundaries. Do not hide a missing core primitive behind an application copy.
- Preserve failure evidence. A run that started and failed remains auditable; preflight errors must not masquerade as
  scientific runs.
- Keep large data and graph state in relations or CAS. Prompt and UI truncation are presentation choices, not changes
  to the scientific result.
- Fix maintained DuckNNG behavior in the DuckNNG repository when the defect is there; do not add source-specific
  workarounds here.
- This is pre-1.0 software. Prefer a smaller clear surface and deletion over compatibility scaffolding for unused or
  unclear APIs.

## Checks

- Use `rg` for repository search.
- Run the focused owning test first.
- Documentation changes: `npm run docs:index` and `npm run check:docs`.
- README or generated-pattern changes: run the corresponding generator/check command.
- Shared code or manifest changes: `npm run typecheck` plus focused tests; use `npm test` when shared behavior changes.
- Cross-package or architectural changes: `npm run check:all`.
- `NEWS.md` is maintained manually and should record shipped behavior, not design speculation.
