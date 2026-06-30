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

## What the substrate closes over — Fugu, RLM, networked agents reduce to one property

Three frontier ideas, one foundation. The load-bearing realization: each reduces to **data living addressably
OUTSIDE the prompt (DuckDB tables + CAS + receipts), navigated by BOUNDED queries + content-addressed shared
memory.** That single property — our bet — is what closes over all three, which is why the *baseline* (the large
executable middle of ClawBio as manifests) and the *speculative upside* share one substrate rather than being
separate efforts.

- **[RLM — Recursive Language Models](https://alexzhang13.github.io/blog/2025/rlm/)** (Zhang & Khattab, MIT
  CSAIL; [arXiv 2512.24601](https://arxiv.org/abs/2512.24601)): store the unbounded context as a *variable in a
  Python REPL*; the LM peeks/greps/partitions/maps/summarizes it and launches recursive LM sub-calls — dodging
  "context rot" because no call holds the whole context. **We close over it: `bio_query` over DuckDB is the same
  loop with context as TABLES, not a string var.** peek=`LIMIT`/schema discovery; grep=`WHERE LIKE`/`regexp`/
  FTS; partition+map=`GROUP BY` + per-partition sub-operations; summarize=SQL aggregates; the agent only ever
  sees BOUNDED results. Sharper: RLM's OOLONG benchmark ("among these user IDs, how many label X over 6000
  rows") is literally a `GROUP BY` — RLM recurses and makes counting errors at long context; we one-shot it
  deterministically. Semantic-only sub-calls ("label each row") fall back to the judgment boundary
  (`decideGrounding`/sub-agent); recursion depth = nested sub-operations.
- **[Sakana Fugu](https://sakana.ai/fugu)**: its "shared memory so agents don't re-discover artifacts" = our
  CAS + `studyNoteIndex`; workflow-as-data with access lists = a conductor manifest / `StudyScaffold` (below).
- **Networked agents**: stigmergy via a shared CAS root — agents communicate by content-addressed receipted
  artifacts, not live chat.

Narrative: BASELINE = the SQL-REPL-over-addressable-data substrate + a process runtime reproduce the large
executable MIDDLE of ClawBio as manifests. SPECULATIVE upside = the same substrate closing over Fugu/RLM/
networked agents.

Honest boundary (pal #9, corrected — most of pal's "fits neither" classes COLLAPSE; pushed back): "all of
ClawBio for free" is too strong, but the gap is much smaller than pal claimed. Working through pal's classes:

- **stateful-async services** (submit -> poll -> fetch): a sequence of HTTP calls with a `job_id` threaded
  through + a poll-until-ready loop. That is http-with-session + a poll primitive driven by a process op /
  conductor step — COMPOSITION, not a new transport. Collapses.
- **GraphQL**: a `POST` with a JSON query body to one endpoint, JSON back -> table — a `method`+`body`
  generalization of the http resolver. Collapses.
- **auth**: a host-INJECTED header (Bearer/API key); the resolver already takes `headers`, secrets stay out of
  the manifest like `fetch` does. Collapses, and matches the doctrine.
- **pagination**: follow `next` cursors in a bounded loop, `UNION` each page into the table — a resolver loop /
  conductor map. Collapses.
- **human/clinical sign-off**: a host gate AROUND runs — out of executable scope by definition (the substrate
  produces the auditable artifact a human approves), not a coverage gap.

The ONLY genuinely irreducible thing is the LM's own SEMANTIC JUDGMENT (literature interpretation, phenotype
disambiguation, narrative synthesis) — and that is not a gap, it is the judgment boundary we designed on purpose
(two-tier grounding: deterministic SQL projection -> LM judgment). The substrate FEEDS it; the model does the
semantic step. So the corrected claim: substrate + process runtime + judgment boundary cover ClawBio's
COMPUTATIONAL surface; what isn't "free" is (i) the model's semantic judgment (the designed seam) and (ii) human
sign-off (host policy). The collapse is ARCHITECTURAL (no new substrate class), but it does require real
http-resolver generalization (POST/body, host-injected auth, pagination-follow, poll) that does not exist yet —
that is pal's one accurate point. See "HTTP resolver generalization" below.

Narrowed further (pal #10c, honest): "no new SUBSTRATE class for many request/response APIs" is the defensible
claim; **production SEMANTICS are NOT free** and are real engineering, not architecture:
- stateful-async needs DURABLE job ids + resume-after-crash + idempotency keys + cancellation + TTL/cleanup +
  PARTIAL receipts (today a resolver that submits a remote job and crashes before returning loses the job id —
  `src/core/operations.ts` only records a receipt after `resolveResource` returns).
- auth is more than a header: OAuth refresh needs a host-owned TOKEN LIFECYCLE + retry-on-401 (today `headers`
  come from manifest params, not a host `authHeaders` capability).
- rate limits: `429`/`Retry-After`/quota budgets/host throttling — unaddressed.
- streaming/binary/SSE/websockets: today `FetchResponse` is `text()`-only, JSON/CSV/NDJSON — full-body only.
- real remote WRITES/transactions: the operation surface is read-only by design; POST with `mutates:false` does
  not cover two-phase workflows, retries, idempotency, transaction receipts.
So: the bet is "the substrate absorbs the request/response API SHAPE as data"; the durable effect/auth/rate-
limit/streaming/write machinery is genuine work the process runtime + host capabilities must provide.

Resolutions (these are ADDRESSABLE via known machinery, not open research):
- **auth / OAuth refresh** -> lean on **pi's auth storage + token-refresh ops** (the host already has credential
  storage + refresh lifecycle; inject it as the host `authHeaders` capability, never in the manifest).
- **rate limits** -> exponential backoff with `Retry-After`/`429` awareness in the resolver's retry policy.
- **streaming / binary / SSE / websockets** -> **pi-mono has reusable patterns** for these transports; widen
  `FetchResponse` beyond `text()` to a byte stream and adopt them.
- **the HTTP carrier itself** -> **`ducknng_ncurl`** (ducknng ships an HTTP/curl client + `ducknng_ncurl_table`):
  the http-resolver generalization (POST/body/auth/streaming) AND the nng agent topologies live in ONE DuckDB
  extension, both Arrow-native. So the request/response generalization and the multi-agent transport converge.

### Streaming transports (decided — not either/or, three needs, three tools)
- **Pull-streaming HTTP** (large bodies; byte-cap so a runaway response can't exhaust memory): read the runtime
  `fetch` body (a `ReadableStream`) with a cap. BUILT: `src/duckdb/resolvers/http-stream.ts` `readCapped(stream,
  maxBytes)` — the byte-cap half of pal #4. DuckDB-native equivalent: `ducknng_ncurl`.
- **SSE** (server-sent events: LLM token streams, progress): parse `data:` frames off the same chunked stream.
  **pi-mono** ([github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono)) has these exact parsing
  patterns (it streams LLM output) — adopt them for an SSE transport.
- **Bidirectional / server-push / live subscriptions** -> **wss over nng** (ducknng's `ws://`/`wss://`
  transport). THE tie-in: the pub/sub blackboard's `awaitNote` currently POLLS (SELECT loop); over wss-over-nng
  it becomes a real PUSH subscription (no polling). ducknng unifies `ncurl` (HTTP) + ws/wss + the nng
  topologies, Arrow-native — so the streaming carriers and the agent transport are again one extension.

### HTTP resolver generalization (the real build the collapse needs)
`http.get` is today GET-only, JSON/CSV/NDJSON, single-shot. To make the classes above manifest-expressible:
- `method` + `body` params (POST/PUT; GraphQL = POST + JSON query body). Keep read-only INTENT explicit (a
  declared `mutates: false` or a separate `http.post` name) so the effect surface stays honest.
- host-INJECTED auth headers (never in the manifest) — a host `authHeaders` capability composed like `network`.
- pagination: a `paginate` spec (`next` JSONPath / `Link` header) the resolver follows, UNION-ing pages.
- a poll primitive: submit -> poll `status` until ready -> fetch, with bounded backoff (cancellable via the
  already-threaded `AbortSignal`). Drives stateful-async services.
Each is a bounded resolver generalization within the bet, not a new transport. Build on a concrete consumer.

## API discovery (OpenAPI/OPTIONS) + parameterized resources — the two pieces that de-toy the API examples

Three user questions converge on the same gap. The variant-annotation example hard-codes 5 rsIDs in the request
body — overfitting: a real skill doesn't bake the query data into the manifest. The two missing pieces:

- **API DISCOVERY (don't hand-author the resource shape).** Many bio APIs (Ensembl, EBI, …) ship an OpenAPI/
  Swagger spec. DERIVE http resources from it: the endpoint URL (server+path), method, parameters, request-body
  schema, and RESPONSE schema all come from the spec — so the resource is GENERATED, not authored (matches
  "hand-writing manifests should be banned"), and the response shape the agent unnests is grounded in the spec,
  not guessed. `OPTIONS` is the *runtime* sibling of this (an endpoint's "what can I do here" probe) — which is
  why OPTIONS/HEAD aren't in the body->table resolver: they're DISCOVERY, a separate concern from data-fetch.
  Build: `openApiToResources(spec)` -> http resource templates (url/method/body-schema/format); the agent picks
  an operation and fills its params.
- **PARAMETERIZED RESOURCES — done the SQL way, not a DSL.** The query data comes from the agent / upstream, not
  the manifest, and it is all SQL (no bespoke templating; the `fillTemplate`/`$sql` DSL was reverted):
  - **agent params = DuckDB SESSION VARIABLES.** `bindings` -> `SET VARIABLE name = ?` on the conn before
    resolution; a resource's `url` (when not a literal) is a SQL EXPRESSION evaluated against the conn:
    `'https://…/search?q=' || getvariable('query') || '&ontology=' || coalesce(getvariable('ontology'),'mondo')`.
    DuckDB composes it; a non-http result fails closed. (ols4-grounding now works exactly this way.)
  - **upstream data = SQL subqueries.** "Discover then annotate": stage-1 reads a VCF (`duckhts.read_bcf`) -> a
    `variants` table; stage-2's request composes from it in SQL — a url with a subquery, or a body built with
    `json_group_array((SELECT id FROM variants))`. The request is a function of upstream data, in SQL.
  - **Encoding: solved in pure SQL.** DuckDB has `url_encode` built in, so values compose safely:
    `'…?q=' || url_encode(getvariable('query'))` turns `lung cancer` into `lung%20cancer`. No UDF needed.
  - **The fetch ITSELF is SQL via ducknng — PROVEN (corrected).** Earlier I wrongly said "ducknng isn't
    installable here." It is: built for DuckDB v1.5.2 (community/local build); our node-api ships v1.5.4 — a
    version LAG, not unavailability (node-api `1.5.2-r.2`/`1.5.3-r.3` exist). In a version-matched scratch env
    (`@duckdb/node-api@1.5.2-r.2` + `LOAD '~/ducknng/build/release/ducknng.duckdb_extension'`), this ran live:
    `SELECT * FROM ducknng_ncurl_table('http://httpbin.org/' || url_encode(getvariable('path')), 'GET', NULL,
    NULL, 12000, 0::UBIGINT)` — fetched + parsed the JSON body into a table, URL composed in pure SQL. So with
    ducknng version-matched, HTTP needs NO `http.get` TS resolver at all: it's `ducknng_ncurl_table` (+ chunking
    via SQL, retry via SQL/Retry-After). **HTTPS works too** (proven against the REAL OLS4 API): build a TLS
    config from the system CA bundle as IN-MEMORY PEM and pass its id —
    `SET VARIABLE tls = ducknng_tls_config_from_pem('', '', getvariable('ca'), '', 1);
     SELECT * FROM ducknng_ncurl_table('https://www.ebi.ac.uk/ols4/api/search?q=' || url_encode(getvariable('query')),
       'GET', NULL, NULL, 20000, getvariable('tls')::UBIGINT)` -> parsed the OLS4 response into a table
    (`response`, `responseHeader`, `facet_counts`). So the WHOLE fetch is SQL: SET VARIABLE params + url_encode
    composition + a PEM TLS config + ncurl_table parse. The `http.get` TS resolver (global fetch) + the
    http-policies (withRetry/withAuth) remain the FALLBACK when the DuckDB version doesn't match a ducknng build.
    ADOPTED: pinned `@duckdb/node-api` to **1.5.2-r.2** — the prebuilt ducknng (community AND the local build) is
    for v1.5.2, NOT 1.5.3 (the install error confirms it); on 1.5.2, `INSTALL ducknng FROM community` loads (6
    ncurl fns) AND duckhts still works (184 tests green). When ducknng is released/backported for a newer DuckDB
    (or built from source — trivial), bump the pin. Next: migrate the `http.get` resource to a
    `duckdb.sql_materialize` over `ducknng_ncurl_table` so the fetch is SQL, with the TS resolver as fallback.
- **BATCH HTTP = a chunked, rate-limited PIPELINE, not one request.** VEP caps the batch (~200-1000 ids) and
  rate-limits (~15 req/s, `429`+`Retry-After`, hourly quota). Annotating a real VCF: chunk the variant list (SQL)
  into batches <= the limit, run them through `runPipeline` (the push/pull pool) with `withRetry` (429/backoff),
  `UNION` the results. The pieces exist; wiring a "batched http resource" over them is the remaining build.

Together: OpenAPI gives the resource SHAPE (derived); SQL (SET VARIABLE + subqueries) fills the params; a chunked
rate-limited pipeline handles scale. Nothing query-specific is hardcoded, and it is all SQL + the pipeline pieces.

## Machine studying — Fugu pieces 2 & 3 over the study-notes system

Sakana Fugu (https://sakana.ai/fugu, arXiv 2606.21228) factors into: (1) a LEARNED orchestrator, (2) scaffold-
as-data — workflow steps `(subtask, worker, access_list)` where the access list is which prior outputs enter a
worker's context, and (3) a memory discipline — intra-workflow ISOLATION + inter-workflow SHARED MEMORY so
agents don't redundantly re-discover artifacts. We drop (1) — we won't train an orchestrator; the agent (or a
static scaffold) conducts. Pieces (2) and (3) map onto our study-notes system as a "machine studying" loop:

- **(3) is already built.** `studyNoteIndex` (`src/core/study.ts`) is the cheap index scanned BEFORE re-deriving
  — Fugu's shared memory that prevents redundant re-discovery. `hook` is a per-note retrieval predicate; notes
  project into a traversable KG (`studyNoteGraph`: `memory` nodes + `depends_on`/`references`/`contrasts_with`
  edges). CAS-of-bytes is the same discipline for corpus BYTES (don't re-fetch). Intra-isolation = keep
  independent probes (`question_bank`/`worked_example`/`failure_case`/`expertise_probe`) from being railroaded
  by the first note's framing, then synthesize into a `concept_map`/`index`.
- **(2) is the one real gap.** `deriveStudyPlan` returns a flat `string[]`; Fugu's scaffold is a DAG. Note
  `links: depends_on` + `sources` (`path/url/locator/quote`) ARE the access-list primitives — but the PLAN
  doesn't use them. Lift the plan to a `StudyScaffold`.

### Buildable kernel (non-breaking; awaiting user steer — touches the study contract)
```ts
interface StudyStep {
  id: string;                       // step/slug
  subtask: string;                  // what to study/extract
  produces: StudyArtifactKind;      // the note kind this step writes
  accessList: { notes?: string[];   // upstream note slugs whose bodies feed this step's context
                sources?: StudyNote["sources"] }; // + external sources
}
interface StudyScaffold { schema: "pi-bio.study_scaffold.v1"; corpusId: string; objective: string; steps: StudyStep[]; }
// deriveStudyScaffold(corpus, objective): StudyScaffold  — a DAG, leaving deriveStudyPlan intact (non-breaking)
```
The accessList edges are the same shape as note `links: depends_on` — so a scaffold step and the note it
produces share one dependency model; execution = topological order, each step reads only its accessList (the
isolation boundary), writes its note (the shared memory). Provenance composes: each note's `sources` already
records what fed it. Build only on explicit go — it changes `deriveStudyPlan`'s consumers and needs a test.

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

The COMPUTE pillar of "ClawBio for free": the data/lookup/annotation/query skills are the SQL-REPL + resolver
tiers, but ClawBio's compute skills (Ancestry PCA, Fine-Mapping SuSiE/ABF, scRNA, nf-core/Galaxy wrappers,
R/shell) need to run external code. Design grounded in two local prior-art projects (`~/nf-r-ipc`, `~/DuckTinyCC`):

- **Spawn external processes from Node** (`child_process`; detached for long-running, like the pal launches) —
  NOT in-DuckDB FFI (`~/DuckTinyCC` JIT-compiles C into SQL UDFs at runtime; wild, but the wrong risk surface
  for the process path) and NOT a JVM/Nextflow plugin. The host owns process spawning = a host-injected effect,
  matching the doctrine; it is sandboxable and simple. (DuckTinyCC stays a niche later option for hot-path UDFs.)
- **Arrow IPC as the interchange** (the lingua franca): DuckDB exports Arrow natively; R reads via
  `nanoarrow`/`arrow`, Python via `pyarrow`. DuckDB -> Arrow -> process -> Arrow -> DuckDB (read via arrow scan).
  This is exactly `~/nf-r-ipc`'s transport (Nextflow<->R over Arrow IPC), but Node-hosted.
- **A strict contract** modeled on `~/nf-r-ipc/CONTRACT.md`: the invocation is DATA in a manifest (a "process
  operation": `{executable, script: path|inline, inputs: [table], output: schema|kind, args}`); typed request/
  response; typed error classes; fail-closed. Provenance RECEIPT (same model as resolvers): script digest +
  input digests + exit code + stdout/stderr + output digest + wall time.
- **Result shape:** rectangular results (PCA loadings, credible sets, summary stats) -> Arrow tables directly.
  Non-tabular R values -> adopt nf-r-ipc's `value_graph` (a FLAT Arrow table encoding a tree via
  `value_id/parent_id/key/index/tag/v_*`, with distinct typed-NA tags + R-class normalization) — the SAME
  flat-table-encodes-a-tree pattern as our SemanticSQL statements (a real convergence, not a new abstraction).
- **Out-of-process is the robust choice (3rd confirming instance, `~/mangoro`):** R<->Go IPC over nanomsg
  (mangos) + Arrow (nanoarrow), explicitly AVOIDING in-process FFI (cgo c-shared's multiple-runtime problems) —
  the same call as avoiding DuckTinyCC. Two execution modes: SPAWN-PER-CALL (simple, stateless) vs a PERSISTENT
  WORKER messaged via nanomsg+Arrow (amortizes R/Python startup, stateful) — the latter fits long-running or
  per-tissue-repeated compute (e.g. coloc over GTEx tissues). Node-hosted: child_process + Arrow files/stdio,
  or a held-open worker over a socket.
- **CLI composition layer (`~/BLIT`, [WangLabCSU/blit](https://github.com/WangLabCSU/blit)):** command-line
  tools as COMPOSABLE OBJECTS, not strings — `exec()` -> a structured object; pipe translation (`|>` -> `|`);
  `cmd_run`/`cmd_parallel`; LIFECYCLE HOOKS (`on_start`/`on_exit`/`on_succeed`/`on_fail`) -> adopt as receipt
  events + fault-tolerant branching; MICROMAMBA/Conda env management -> a process op should DECLARE + PIN its
  env (tool versions) in the receipt for reproducibility; auto native-data->CLI-input (df->tsv->temp->cleanup)
  for tools that don't speak Arrow (our `http.get` temp-materialize already has this shape). So: nf-r-ipc =
  Arrow/nanoarrow transport + typed contract; BLIT = CLI composition + env pinning + lifecycle; mangoro =
  out-of-process generalizes (R/Go) + persistent-worker option; Node = the host that spawns + owns lifecycle.
- **Init non-transactional caveat (pal #9):** `duckdbInitSql` runs statement-by-statement, not in a transaction;
  on a persistent DB a later failure can leave earlier side effects with no failed-run receipt. Fine for
  idempotent INSTALL/LOAD/SET (its intended use); keep DDL/DML out of init.

### Flagship: post-GWAS colocalization (`~/PostGWAS` + `~/coloclize`) — the two-pillar proof
PostGWAS independently arrives at our architecture: provider CONTRACTS (`SumstatProvider`, `LDProvider` returning
a provenance-bearing `DatasetLD` object, `AncestryWeightsProvider`, `ColocEngine`, `FineMapResultProvider`) with
DuckDB/PlinkingDuck/coloc/HyPrColoc/ColocBoost as ADAPTERS — i.e. our resolver/port + receipt model in R/S7. The
agent solves coloc as a manifest: DATA pillar = tabix region-extract per GTEx tissue + SQL harmonization
(SumstatProvider) + LD from PLINK2 reference via PlinkingDuck (LDProvider); COMPUTE pillar = ColocEngine /
fine-mapping as Arrow-IPC process ops; COMPOSITION = a DAG with per-tissue partition+map. Receipts at every step
(allele basis, harmonization, LD provenance, coloc posteriors). This is the "fruitfulness in speculative new
areas" demonstration — the bet generalizing from ClawBio lookups to real statistical-genetics research.

The restricted-runtime contract (build before exposing powerful execution):

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
