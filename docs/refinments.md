---
type: Worklog
title: Refinements
description: "Open design issues and cleanup targets still to sharpen before abstractions harden."
tags: [refinements, open-issues, worklog]
---

# Refinments

Open design issues and cleanup targets. Keep this file focused on what still needs sharpening before the abstractions harden.

## Naming and layering

- Keep `BioToolSpec` as the biomedical/user-facing contract; avoid mixing transport details into it.
- Continue refining `BioOperationSpec` with concrete operation-pack fixtures before adding execution.
- Decide the canonical relationship between `BioToolSpec.inputs/outputs` and `inputSchema/outputSchema` before external consumers rely on either representation.
- Keep broad types in `types.ts` provisional unless they gain validators, tests, or a real consumer.
- Separate host surfaces from execution adapters in code and docs:
  - host: Pi, future MCP/CLI
  - execution: HTTP/OpenAPI/GraphQL, DuckDB SQL, MCP transport, R/Python/shell/code runtime
- Move format adapters such as OKF under a `formats/` or `adapters/` namespace rather than making them core primitives.

## Integration surfaces

- Keep core importable as a TypeScript library; all host surfaces call into it.
- Pi coding-agent extension remains the first host adapter and proof target.
- Add a small CLI with `--json` output for validation, indexing, and operation-pack tests.
- Add JSON-RPC over stdio after CLI commands stabilize; avoid a long-running daemon until there is a real need.
- Decide whether the MCP surface is generated from BioToolSpecs or hand-curated per operation pack.
- Define one command/RPC schema naming convention and use it consistently across Pi, CLI, JSON-RPC, and future MCP.
- Ensure network/code execution is opt-in and policy-explicit in every surface, not just Pi.
- Keep the Pi extension thin: substantial logic moves to shared `src/` functions with tests.
- Use `pi-ai` plus Pi's modular `ModelRegistry`/`AuthStorage` services for model providers; do not add a parallel provider or credential registry. Treat `auth.json` as an AuthStorage backend, not our own storage contract.

## Pi coding-agent extension refinements

- Move current extension helper logic into reusable library functions so CLI/JSON-RPC can call the same code.
- Add Pi tools for spec validation, not just listing.
- Add operation-pack discovery and `operation.describe` before execution.
- Add operation dry-run output: request shape, cache key, network policy, provenance plan, and expected resource handles.
- Add study-note indexing/search tests and decide whether notes are JSON, OKF markdown, or both during the transition.
- Add a tool/command naming convention that can map cleanly to CLI and JSON-RPC names.
- Keep `/reload` as the activation boundary for drafted project-local skills.
- Use Pi's existing model/auth path (`pi-ai`, `ModelRegistry`, `AuthStorage`, OAuth helpers, and `pi.registerProvider` where appropriate) for any model-backed study/delegation features.
- Do not expose network execution, code execution, or DuckDB execution through Pi until policies and tests exist.

## Staggered build plan

### Stage 0 — docs and tests first

- Land `docs/design.md` and this refinement log.
- Add a minimal Node `node:test` setup.
- Add tests around existing validators and SQL guard.
- Add a `check` script that runs typecheck plus tests.

### Stage 1 — core contracts

- Base tool, operation, resolver, run, SQL, storage/CAS validators are in place.
- Add more operation-spec fixtures for valid and invalid provider/API shapes.
- Add schema-level compatibility checks between BioToolSpec, BioOperationSpec, and BioResolverSpec.

### Stage 2 — storage/index substrate

- Add the default project layout helper.
- Add DuckDB schema contracts or schema-generation SQL for resources, operations, runs, ontology, KG, and study-note indexes.
- Add filesystem study-note indexing tests.
- Keep raw bytes out of DuckDB unless explicitly materialized.

### Stage 3 — Pi extension hardening

- Keep the Pi coding-agent extension as the first real host integration.
- Refactor extension internals so tools call shared core/library functions.
- Add validation and dry-run tools before adding execution tools.
- Add tests that import/build the extension and verify registered tool names and schemas.

### Stage 4 — CLI

- Add a small `bin/pi-bio-agent` entry point.
- Implement read-only commands first: list/validate/describe/index.
- Support `--json` on every command.
- Make CLI tests call the same functions as the Pi extension.

### Stage 5 — JSON-RPC stdio

- Expose the stabilized CLI/core operations through JSON-RPC over stdio.
- Keep it process-per-session and local-first.
- Add protocol tests with request/response fixtures.

### Stage 6 — operation packs

- Implement OpenTargets as the first declarative operation pack with mock-network tests.
- Add Monarch/HPO and Ensembl/VEP only after the operation-pack shape proves stable.
- Generate typed clients or a restricted code-runtime facade from operation specs.

### Stage 7 — code runtime

- Add a restricted code runtime only after operation clients exist.
- No ambient network, raw secrets, or raw DuckDB handle.
- Add tests for timeout, output cap, denied ambient APIs, and in-env filtering.

### Stage 8 — workflow fixtures

- Add synthetic rare-disease reanalysis fixtures.
- Test structured evidence assembly, provenance, and expert-review framing.
- Promote stable workflow instructions into skills only after fixtures pass.

## Storage refinements

- Keep the documented default on-disk layout in sync with `bioProjectLayout()`:
  - `.pi/bio-agent/study-notes/`
  - `.pi/bio-agent/resources/`
  - `.pi/bio-agent/cas/<algo>/<digest>`
  - `.pi/bio-agent/artifacts/`
  - `.pi/bio-agent/bio.duckdb`
- Define the DuckDB catalog tables for resources, CAS entries, runs, operations, ontology terms, KG nodes/edges, and study-note indexes.
- Define which resources are copied into CAS versus left as virtual resolver handles.
- Decide whether CAS writes are automatic for HTTP responses or opt-in per operation policy.
- Add a stable locator rule for virtual handles: use semantic, version-independent identifiers where possible, not volatile row IDs or transient URLs.
- Add cache invalidation rules for public APIs, ontology releases, and local annotation caches.
- Decide how deletion/retention is expressed in single-user core without adding a deployment authorization model.

## Code execution runtime

- Define the restricted code runtime contract before exposing powerful execution:
  - allowed clients only, no ambient network by default
  - no raw secrets
  - no raw filesystem except workspace/artifact APIs
  - no raw DuckDB handle except scoped read-only query clients
  - timeout, memory/output cap, and audit receipt
- Decide first supported language: JavaScript is natural for generated clients; R/Python remain useful through explicit tools for analysis/reporting.
- Define how operation clients are generated from operation specs and injected into the runtime.
- Add tests proving large intermediate results can be filtered in-env without entering model context.

## Operation packs

- Start with small declarative packs rather than bespoke adapters:
  - OpenTargets GraphQL
  - Monarch/HPO ontology evidence
  - Ensembl/VEP annotation
  - ClinVar/ClinGen evidence references
- For each pack, require:
  - input schema
  - output shape or normalizer
  - identifier namespace notes
  - network policy
  - cache/provenance policy
  - mock-network tests
- Keep provider/API documentation in study bundles; promote stable invocation details into operation specs.

## Skills and study notes

- Keep skills procedural, not executable or schema-bearing.
- Add a skill validation check: frontmatter present, description clear, no secrets, no patient-specific facts, no API client implementation pasted into the body.
- Add a promotion flow:
  - source snapshot
  - study note / OKF concept
  - indexed bundle
  - operation or resolver spec
  - workflow skill only after repeated use
- Add study-note search/index tests.

## KG and ontology substrate

**Direction settled (2026-06-29): the SemanticSQL shape.** The graph is `bio_edges(from_id, predicate,
to_id)` (the statement/edge base) plus `entailed_edge` (the precomputed transitive closure). The same shape
serves imported ontologies and our own committed graph; descendants/subsumption/graph-walk are one indexed
JOIN, not a walker. See [`design.md`](./design.md#the-semanticsql-shape-statements--entailed_edge-one-substrate-for-graph-ontology-and-scales).

- DONE: `entailed_edge` closure (`materializeEntailedEdges`, `src/duckdb/graph-closure.ts`) — per-predicate
  transitive closure over `bio_edges`, indexed both directions; cycles terminate via UNION dedup.
- DONE: ordinal scales as data (`scale_members` from a ranked `TermSet`) — total order to the graph's partial
  order; `decideGrounding` membership unchanged.
- NEXT (deferred until a real grounding/traversal consumer): an `ontology.semsql` resolver that lands an OBO
  ontology's `statements` + `entailed_edge` into the same shape — ingest via `sqlite_scan -> parquet` (sidesteps
  live ATTACH where unavailable), index `entailed_edge` on `(to_id,predicate)`+`(from_id,predicate)`, pin a
  bbop-sqlite build date as source provenance, honor per-ontology CC-BY. OLS4 REST only for fresh text→CURIE
  misses (judgment tier); cached CURIEs + FTS are the deterministic projection tier; ABSTAIN below threshold.
- Add bounded graph-walk semantics with expansion handles so high-degree neighborhoods do not flood context
  (now a bounded SQL query over `entailed_edge`, not a custom walker).
- Add trust/provenance fields consistently across facts, edges, and artifacts (`bio_edges.trust` exists; keep
  it uniform with receipts/artifacts).
- Add as-of/known-at time lenses where variant reanalysis or changing knowledge releases matter.

## Biomedical workflow fixtures

- Add synthetic fixtures for rare-disease reanalysis:
  - de-identified case summary
  - HPO terms
  - variants
  - public evidence rows
  - ACMG candidate labels
  - expert-review addendum output
- Tests should assert structure, provenance, and safety language; they should not grade free-form prose.
- Ensure the workflow never emits a final diagnosis or clinical directive without expert-review framing.

## Testing framework

- Use Node `node:test` and TypeScript typecheck as the default test framework.
- Keep live API tests opt-in through explicit command arguments or config objects; do not activate live tests through ambient process state.
- Add conformance tests for:
  - no provider-specific shape in core
  - resolver fail-closed behavior
  - no ambient network in code runtime
  - read-only SQL validation
  - operation pack request generation
  - resource/CAS integrity
  - skill boundary rules
- Treat `validateReadOnlySelect()` as a preflight helper only. The eventual execution adapter must also use a genuinely read-only/scoped DuckDB connection or equivalent sandbox.

## Documentation cleanup

- Keep `docs/design.md` as the positive architecture note.
- Keep this file as the scratchpad for things to refine.
- When a refinement is resolved, move the stable decision into the appropriate design doc and delete the scratch item.
