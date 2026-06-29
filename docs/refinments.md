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

## Prior art: {targets} — lessons for CAS, caching, and the executor

We are building a [`targets`](https://docs.ropensci.org/targets/)-shaped lazy, content-addressed substrate (see
[design.md](./design.md#the-substrate-is-a-lazy-content-addressed-evaluation-graph)). The hard-won lessons
from `targets` ([mdsumner/targeted-learning](https://github.com/mdsumner/targeted-learning)) mostly
**validate** our design and **sharpen the deferred specs**;
each lands only when a concrete consumer forces it, never ahead.

- **Receipt = marker file; never conflate "what to hash" with "what to pass."** `targets`'s `tar_format()`
  conflated the change-detection hash with the value passed downstream, so external-file tracking uses a
  *marker file*: a local file holding the reference (path/URI) + a content validator (ETag), separate from the
  bytes. Our **receipt already is that marker** — `{ source (where), version=content digest (what), retrievedAt
  (when) }`, separate from the materialized table (the value). Keep that separation; it is what avoids the trap.
- **Format/repository split → our resolver already collapses the combinatorics.** `targets` split `format`
  (serialization) from `repository` (location) to avoid the format×provider explosion. `duckdb.sql_materialize`
  is the same move taken further: one resolver, declared SQL, any reader/source — no resolver-per-format zoo.
- **Resolution memoization — BUILT** (`src/duckdb/resolution-memo.ts`): the lazy graph's memo table, keyed on
  content FRESHNESS (`file_scan` content digest; `http.get` ETag/Last-Modified via conditional `If-None-Match` →
  `304`). `sql_materialize` deliberately opts out (arbitrary SQL has undeclared/volatile determinants). The
  remaining layer is CAS-of-bytes (cross-db reuse) — see the section above. CAS = store by content hash,
  versioned; use it for collaboration / reproducibility / rollback / audit; skip it for large churny outputs.
- **Remote freshness via ETag/Last-Modified — DONE in `http.get`** (the `FetchLike` port now exposes response
  headers; a stored validator drives a conditional request and a `304` replays the cached receipt).
- **An audit pass re-validates external state**: a separate run comparing stored vs current validators (ETags)
  to catch data that changed outside the pipeline. Relevant once remote resources + caching exist.
- **Error handling for the future `process` executor + `http.get`**: `targets` offers stop / continue / null /
  trim plus transient-error retry/backoff for cloud. For us these are **policy (host/manifest data), not baked
  in**; failed-run receipts already enable "re-run only the failed." Design the executor for transient errors
  (retry as a host fetch/exec decorator), per host-controlled effects.
- **The DuckDB-over-files aggregation pattern is the validated substrate.** `targets` users' go-to for "many
  inputs → a value" is: write Parquet per branch, then `duckdbfs::open_dataset(files) |> group_by |> summarise
  |> collect()` — i.e. resolver(s) → operation SQL. A process-op producing Parquet artifacts that `file_scan`/
  `sql_materialize` then aggregate is exactly this; no bespoke combine step.

## CAS-of-bytes — BUILT (slices 1-2), and its honest scope

Distinct from the resolution memo (which caches a materialized TABLE within one persistent db): CAS dedups the
raw BYTES across dbs/projects, keyed by content hash. BUILT:
- `src/core/cas.ts` (`CasStore`: pathFor/has/put + a cross-db url->{etag,address} index) + `src/hosts/fs-cas.ts`
  (filesystem, `<root>/<algo>/<digest>`, atomic).
- Host opt-in by composition (`cas` threads RunRequest -> runQuery/runOperation -> `ResolutionContext.cas`),
  default absent = fast mode.
- `http.get` CAS mode: a 200 snapshots the body under its sha256 + seeds the url->ETag index; a DIFFERENT db
  with an empty per-db memo sends If-None-Match from that index and on 304 materializes from CAS bytes with NO
  re-download (test: body downloads exactly once across two dbs).

### Honest scope — CAS is for WHOLE objects, not a universal remote cache (pal #7)
CAS-of-whole-bytes is right for a REST/JSON API body or a moderate dump fetched by `http.get` itself. It is the
WRONG granularity for two cases, which are separate tiers chosen by which resolver the manifest declares:

- **Small-region joins over a huge indexed remote VCF (gnomAD):** use HTTP RANGE + tabix via htslib, not whole-
  object CAS. Spec — region-scoped `duckhts.read_bcf` (an intentional extension; today it only takes
  `{path,table}` and reads the whole file, `src/duckdb/resolvers/duckhts-read-bcf.ts`):
  - params `{ path, index?, table, regions: [{chrom,start,end}] }`; resolver canonicalizes to htslib region
    strings and reads only those blocks (`read_bcf(?, region := ?)`).
  - Provenance: record the VCF URI + the INDEX (.tbi/.csi) URI + index/file ETag + the canonical region list;
    do NOT record a whole-file sha256 that was never downloaded. CAS may cache the small INDEX bytes (reused,
    tiny) and/or the derived region table — never the whole VCF.
  - Traps: htslib regions are 1-based closed vs BED 0-based half-open; validate VCF+index as a pair (ETag skew);
    split multiallelics + left-normalize REF/ALT + match contig naming/assembly before exact joins; prefer CSI
    for large contigs.
- **Remote columnar/large files DuckDB reads directly (parquet/csv on http/s3):** lean on DuckDB httpfs +
  `cache_httpfs` block caching, NOT our CAS — those bytes never flow through our resolver (pal #8 confirmed).
  `cache_httpfs` is a mutable/evictable PERFORMANCE cache, NOT a receipted artifact — do not conflate it with
  provenance. Enable recipe (a host bootstraps the connection BEFORE resolving):
  ```sql
  INSTALL httpfs; LOAD httpfs;
  INSTALL cache_httpfs FROM community; LOAD cache_httpfs;
  SET cache_httpfs_cache_directory = '/var/cache/pi-bio-agent/duckdb-httpfs';  -- host-owned
  -- version-specific knobs: SELECT name,value,description FROM duckdb_settings() WHERE name LIKE 'cache_httpfs%';
  ```
  Then `read_parquet('https://…')` etc. used by `duckdb.file_scan`/`duckdb.sql_materialize` benefit
  transparently. `cache_httpfs` is now in the extension catalog (`src/duckdb/extensions.ts`).
  - GAP (pal #8): the host runner (`src/hosts/run-store.ts`) has no connection-INIT hook. `sql_materialize` can
    `LOAD` declared `params.extensions` but cannot `INSTALL` or `SET`. A real host needs a small
    connection-bootstrap layer — a `duckdbInitSql` / `beforeRun(conn)` option on the run request that runs
    INSTALL/LOAD/SET once per connection. Spec'd; build when a remote-parquet example drives it (do NOT
    half-build — it touches the run-store acquire path).
  - Provenance note: for DuckDB-internal remote reads the receipt records the URI + SQL/params + resolver +
    time, but NO byte digest (we never saw the bytes). That is correct for fast/lazy/range mode. Byte-perfect
    replay would require snapshot mode (download whole object into CAS first), which forfeits lazy/range reads —
    a bad trade for large parquet/HTS; offer it only when regulatory provenance demands it.

### Decision rule for a manifest author
- REST/JSON API body, whole moderate object, ETag-validated, reused across projects -> `http.get` (+ CAS).
- Small genomic region of a huge indexed remote VCF/BCF -> region-scoped `duckhts.read_bcf` (tabix range).
- Remote parquet/csv DuckDB can scan directly -> `duckdb.file_scan`/`sql_materialize` + httpfs (+ cache_httpfs).

## Effect discipline — pal review #5 follow-ups

Pal #5 audited for ambient/hidden effects. One real finding fixed: wall-clock reads now funnel through the one
`systemClock()` adapter (`src/core/clock.ts`) instead of scattered `?? new Date()` fallbacks. Open, in priority:

- **Strict `now` (the endpoint, deferred).** The funnel removes the *hidden* scattered reads but keeps a
  last-resort fallback. The strict version makes `now` required on `ResolutionContext`, `RunOperationRequest`,
  `newRunRecord`, etc., so the only wall-clock read is at the host entrypoint (extension/CLI) — pushing the
  clock to the OS-adapter boundary like `index-networked.ts` does for fetch. Deferred: it ripples into ~46 test
  call sites; do it when a determinism/replay need (a reproducible run) drives it.
- **Run/note ID generation.** `runId` (`Date.now()`) and study-note `randomUUID()` are nondeterministic host-
  boundary effects. Inject an `idFactory` (or require `runId`) when reproducible run identity is needed.
- **Memo cache opt-out.** The resolution memo silently changes whether a resolver re-fetches (freshness-correct
  — it replays the SAME receipt, so results are identical, only perf differs). Add `cache?: false` to the run
  request / resolver ctx for callers who want to force a cold re-resolve.

By doctrine, NOT bugs (recorded so we don't re-litigate): pal #1-4/#10-12 — DuckDB replacement scans / httpfs /
htslib / direct fs reaching local files and remote URLs. The library is deliberately NOT the network/filesystem
sandbox; egress + fs confinement are the HOST's boundary (container/seccomp/Pi/OS). `validateReadOnlySelect`
governs statement CLASS (single read-only SELECT), not reachability.

## Network opt-in hardening — pal review #4 follow-ups

The host network opt-in is wired by COMPOSITION, not ambient env: `createBioExtension({ network })` takes the
fetch port explicitly; the default entrypoint injects none (http.get fails closed), and `index-networked.ts` is
the operator's explicit grant. (Pal #4 suggested an env gate, but env vars inherit across forks/embeddings and
are invisible to the model — the substrate's injected-effect discipline forbids them; choosing the entrypoint is
the visible, auditable, agent-inaccessible grant instead.) Open,
freshness/provenance-correct refinements it surfaced, in priority order. Build each only with the named consumer
in hand; none are speculative, but none should be half-built autonomously.

- **Cancellation — DONE.** `AbortSignal` now threads Pi tool -> RunQuery/RunOperationRequest -> runQuery/
  runOperation -> `ResolutionContext.signal` -> http.get's injected fetch. An aborted tool call tears the
  request down (best-effort; a resolver that can't honor it ignores it).
- **Byte cap / timeout (still open).** `maxBytes`/timeout need streaming: the current `FetchResponse.text()`
  reads the whole body. To cap, the response contract would expose a byte stream the resolver reads with a
  limit, aborting via the (now-threaded) signal when exceeded. Consumer: a huge/unbounded remote response.
- **304 revalidation provenance.** A `304` replays the stored receipt with the original `retrievedAt` — honest
  about the BYTES (unchanged) but silent that freshness was reconfirmed later. Optional enhancement: stamp a
  `revalidatedAt` note so the receipt shows "T1 bytes, revalidated current at T2". Not a correctness bug.
- **Redirect provenance.** The receipt records the declared `p.url`, not the final response URL after redirects.
  `FetchResponse` has no `.url`; widen it and record the final URL when it differs.
- **Per-call acknowledgement (optional, never sufficient alone).** An `allowNetwork: true` tool param as an
  ADDITIONAL per-call acknowledgement on top of the env gate — visible in the transcript — but the env gate
  stays the hard requirement.

NOT bugs, by doctrine (the library is not the egress firewall — the host sandbox is): the env gate governs only
`http.get`'s bound fetch, not other resolvers' remote reads (`file_scan`/`read_bcf`/`sql_materialize` may read
remote URIs if the host/DuckDB allows); and `http.get` does no SSRF allowlisting — the host's injected fetch
enforces allow/block lists. Both are documented at the opt-in site so a reader does not over-trust the gate.

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

**Direction settled (2026-06-29): the [SemanticSQL](https://github.com/INCATools/semantic-sql) shape.** The graph is `bio_edges(from_id, predicate,
to_id)` (the statement/edge base) plus `entailed_edge` (the precomputed transitive closure). The same shape
serves imported ontologies and our own committed graph; descendants/subsumption/graph-walk are one indexed
JOIN, not a walker. See [`design.md`](./design.md#the-semanticsql-shape-statements--entailed_edge-one-substrate-for-graph-ontology-and-scales).

- DONE: `entailed_edge` closure (`materializeEntailedEdges`, `src/duckdb/graph-closure.ts`) — per-predicate
  transitive closure over `bio_edges`, indexed both directions; cycles terminate via UNION dedup.
- DONE: ordinal scales as data (`scale_members` from a ranked `TermSet`) — total order to the graph's partial
  order; `decideGrounding` membership unchanged.
- NEXT (deferred until a real grounding/traversal consumer): a thin ontology-ingest resolver that projects an
  OBO ontology into our `statements` + `bio_edges` shape. NO DuckDB sqlite extension — the real SemanticSQL
  schema is four flat all-TEXT triple tables (`statements(subject,predicate,object,value,datatype,language)`,
  `edge(s,p,o)`, `entailed_edge(s,p,o)`, `prefix`); their `edge` IS our `bio_edges`. Ingest from a
  NATIVE-readable format: OBO Graphs JSON via `read_json`, or build TSVs / triple parquet via
  `duckdb.file_scan`, or an optional one-time `sqlite3` CLI dump → parquet (the sqlite3 binary, not DuckDB's
  extension). Compute the closure with `materializeEntailedEdges` (we don't need their `entailed_edge`). Pin a
  build date as provenance, honor per-ontology CC-BY. OLS4 REST only for fresh text→CURIE misses (judgment
  tier); cached CURIEs + FTS are the deterministic projection tier; ABSTAIN below threshold.
- Add bounded graph-walk semantics with expansion handles so high-degree neighborhoods do not flood context
  (now a bounded SQL query over `entailed_edge`, not a custom walker).
- Add trust/provenance fields consistently across facts, edges, and artifacts (`bio_edges.trust` exists; keep
  it uniform with receipts/artifacts).
- Add as-of/known-at time lenses where variant reanalysis or changing knowledge releases matter.

## Retrieval and semantic search

Settled direction (2026-06-29): a **tiered retrieval ladder, cheapest deterministic tier first**. Search
returns *candidates (data)* that feed `decideGrounding` (rank, ABSTAIN below threshold, never invent a CURIE);
the engine is a swappable adapter. Climb a tier only when a real corpus/recall failure forces it.

- Tier 0 — exact: SQL equality on label/exact-synonym (`statements`). Deterministic, offline. HAVE.
- Tier 1 — lexical BM25: DuckDB FTS over labels/synonyms/notes/docs. In-DB, offline. NEXT real add (already
  planned for grounding misses).
- Tier 2 — dense single-vector: DuckDB VSS (HNSW) over an embedding column for paraphrase recall. Still in-DB.
  Add only if Tier 1 recall is insufficient on a real corpus.
- Tier 3 — late-interaction multivector ([ColBERT](https://github.com/stanford-futuredata/ColBERT) /
  [TACHIOM](https://github.com/TusKANNy/tachiom)-style): SOTA high-recall, but a large-corpus / research-grade
  runtime (TACHIOM exists to fix the k-means index bottleneck at ~600M-vector scale). OVERKILL
  for ontology grounding (MONDO ~25k, HPO ~17k, SO ~2k terms — tiny candidate spaces) and for our notes. If
  literature-scale retrieval ever forces it, it enters as an EXTERNAL retrieval SERVICE behind a resolver/HTTP
  boundary returning ranked candidates as DATA — never a multivector engine baked into core. Absorb the
  function (ranked candidates), not the runtime.

Tiers 0–2 live IN the DuckDB substrate (SQL/FTS/VSS), consistent with graph-as-SQL; only Tier 3 goes external.

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
