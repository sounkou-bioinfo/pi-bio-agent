---
type: Worklog
title: Refinements
description: "Open design issues and cleanup targets still to sharpen before abstractions harden."
tags: [refinements, open-issues, worklog]
---

# Refinements

Open design issues and cleanup targets. Keep this file focused on what still needs sharpening before the abstractions harden.

## Generic clinical-genomics application: does the library need anything new?

First pass named three possible library builds for a downstream clinical-genomics application
([`clinical-genomics-application.md`](./clinical-genomics-application.md)). Re-examined against the core-boundary
rule ([`design.md`](./design.md#core-boundary)), none currently requires a core primitive. The application should
remain application code over the library: manifests, producers, fixtures, rules, host policy, and an agent. Add a
core convenience only when repeated application implementations expose a shared primitive.

1. **Grounding harness with modes.** `decideGrounding` (`src/core/judgment.ts`) covers the
   candidates→model mode (deterministic match → abstaining model, no invented CURIE, recorded + gated). The others
   are endpoints: deterministic-only = the SQL grounding; model-only = the judge port; model→tools→model = the
   agent's own tool loop. A "4-mode harness" is a mode selector over `decideGrounding` + the agent — config and a
   manifest, not a primitive. (If, after at least two real HPO/gene uses, hand-rolling the resolve→adjudicate
   pattern proves repetitive, a thin `bio_ground` tool is justified.)
2. **External graph → `bio_edges`.** `scripts/foreign-graph-closure.mjs` shows the current mechanism:
   `ATTACH` read-only + a `subject/predicate/object → from_id/predicate/to_id` SELECT + the existing
   `materializeEntailedEdges` (which already takes any source table). The script's closure derives the 2-hop
   subsumption and the gene→has_phenotype→ancestor walk; the real remote `monarch-kg.duckdb` ATTACHes over httpfs
   and is biolink-shaped. It is application SQL over existing primitives. The opt-in live benchmark
   (`node scripts/foreign-graph-closure.mjs --bench-remote-subclass`) materializes the remote Monarch
   `biolink:subclass_of` slice and closes it at run time. Treat the output as a regression benchmark, not a
   pinned artifact or a universal guarantee for every predicate policy or source snapshot.
3. **Ledger → training dataset.** A `SELECT`/view over `bio_observations` joined to the Phase-4
   approval slots (contested = a `WHERE` over decisions), producing a stable dataset schema. A documented query, not
   a new pipeline. The data plane a differentiated-intelligence fine-tune consumes is the product surface, not the training loop.

Also app/host, not library: unique-key dedup (a SQL `DISTINCT` idiom); scoring weights + ACMG points + calibration
(authored rules, app producers with tests); PII de-id + license gating (host port decorators — the one small
library-adjacent item is letting the resolver receipt carry `license` + de-id status alongside `source`/`version`,
so the host can gate on provenance). Net: the clinical-genomics work should happen outside core, in the
application.

Dogfood requirement: downstream application code that fetches, normalizes, or scores around the substrate is
technical debt unless it is proving a missing primitive. The expected route is application manifest or operation
spec -> resolver or adapter -> DuckDB table -> recorded run.

## Naming and layering

- The manifest (`BioManifest`) is the user-facing contract; keep transport details out of it.
- Continue refining `BioOperationSpec` with concrete manifest fixtures before adding execution.
- Keep broad types in `types.ts` provisional unless they gain validators, tests, or a real consumer.
- Separate host surfaces from execution adapters in code and docs:
  - host: Pi, future MCP/CLI
  - execution: DuckDB SQL, `ducknng` (network/RPC/topologies as SQL), `duckhts` (HTS readers), out-of-process R/Python/shell
- Move format adapters such as OKF under a `formats/` or `adapters/` namespace rather than making them core primitives.

## Integration surfaces

- Keep core importable as a TypeScript library; all host surfaces call into it.
- Pi coding-agent extension remains the first host adapter and proof target.
- Add a small CLI with `--json` output for validation, indexing, and application-operation tests.
- Add JSON-RPC over stdio after CLI commands stabilize; avoid a long-running daemon until there is a real need.
- Decide whether the MCP surface is generated from the manifest's operations or hand-curated.
- Define one command/RPC schema naming convention and use it consistently across Pi, CLI, JSON-RPC, and future MCP.
- Ensure network/code execution is opt-in and policy-explicit in every surface, not just Pi.
- Keep the Pi extension thin: substantial logic moves to shared `src/` functions with tests.
- Use `pi-ai` plus Pi's modular `ModelRegistry`/`AuthStorage` services for model providers; do not add a parallel provider or credential registry. Treat `auth.json` as an AuthStorage backend, not our own storage contract.

## Pi coding-agent extension refinements

- Move current extension helper logic into reusable library functions so CLI/JSON-RPC can call the same code.
- Add Pi tools for spec validation, not just listing.
- Add operation discovery and `operation.describe` before execution.
- Add operation dry-run output: request shape, cache key, network policy, provenance plan, and expected resource handles.
- Add study-note indexing/search tests and decide whether notes are JSON, OKF markdown, or both during the transition.
- Add a tool/command naming convention that can map cleanly to CLI and JSON-RPC names.
- Keep `/reload` as the activation boundary for drafted project-local skills.
- Use Pi's existing model/auth path (`pi-ai`, `ModelRegistry`, `AuthStorage`, OAuth helpers, and `pi.registerProvider` where appropriate) for any model-backed study/delegation features.
- Do not expose network execution, code execution, or DuckDB execution through Pi until policies and tests exist.

## Staggered build plan

### Stage 0: docs and tests first

- Land `docs/design.md` and this refinement log.
- Add a minimal Node `node:test` setup.
- Add tests around existing validators and SQL guard.
- Add a `check` script that runs typecheck plus tests.

### Stage 1: core contracts

- Base tool, operation, resolver, run, SQL, storage/CAS validators are in place.
- Add more operation-spec fixtures for valid and invalid provider/API shapes.
- Add schema-level compatibility checks between BioOperationSpec, BioResolverSpec, and VirtualResourceSpec.

### Stage 2: storage/index substrate

- Add the default project layout helper.
- Add DuckDB schema contracts or schema-generation SQL for resources, operations, runs, ontology, KG, and study-note indexes.
- Add filesystem study-note indexing tests.
- Keep raw bytes out of DuckDB unless explicitly materialized.

### Stage 3: Pi extension hardening

- Keep the Pi coding-agent extension as the first real host integration.
- Refactor extension internals so tools call shared core/library functions.
- Add validation and dry-run tools before adding execution tools.
- Add tests that import/build the extension and verify registered tool names and schemas.

### Stage 4: CLI

- Add a small `bin/pi-bio-agent` entry point.
- Implement read-only commands first: list/validate/describe/index.
- Support `--json` on every command.
- Make CLI tests call the same functions as the Pi extension.

### Stage 5: JSON-RPC stdio

- Expose the stabilized CLI/core operations through JSON-RPC over stdio.
- Keep it process-per-session and local-first.
- Add protocol tests with request/response fixtures.

### Stage 6: application-owned operations

- Implement OpenTargets as the first declarative application-owned operation with mock-network tests.
- Add Monarch/HPO and Ensembl/VEP only after the operation-spec shape proves stable.
- Generate typed clients or a restricted code-runtime facade from operation specs.

### Stage 7: code runtime

- Add a restricted code runtime only after operation clients exist.
- No ambient network, raw secrets, or raw DuckDB handle.
- Add tests for timeout, host quotas, denied ambient APIs, and in-env filtering.

### Stage 8: workflow fixtures

- Add synthetic rare-disease reanalysis fixtures.
- Test structured evidence assembly, provenance, and expert-review framing.
- Promote stable workflow instructions into skills only after fixtures pass.

## Prior art: {targets}, lessons for CAS, caching, and the executor

We are building a [`targets`](https://docs.ropensci.org/targets/)-shaped lazy, content-addressed substrate (see
[design.md](./design.md#the-substrate-is-a-lazy-content-addressed-evaluation-graph)). The hard-won lessons
from `targets` ([mdsumner/targeted-learning](https://github.com/mdsumner/targeted-learning)) mostly
**validate** our design and **sharpen the deferred specs**;
each lands only when a concrete consumer forces it, never ahead.

- **Receipt = marker file; never conflate "what to hash" with "what to pass."** `targets`'s `tar_format()`
  conflated the change-detection hash with the value passed downstream, so external-file tracking uses a
  *marker file*: a local file holding the reference (path/URI) + a content validator (ETag), separate from the
  bytes. Our **receipt already is that marker**: `{ source (where), sourceValidator (which observed version; e.g.
  ETag in the current `http.get` path, or a host-supplied snapshot id for other sources), retrievedAt (when) }`,
  separate from the materialized table (the value) and from CAS byte identity when we actually store bytes. Keep that
  separation; it is what avoids the trap.
- **Format/repository split → our resolver already collapses the combinatorics.** `targets` split `format`
  (serialization) from `repository` (location) to avoid the format×provider explosion. `duckdb.sql_materialize`
  is the same move taken further: one resolver, declared SQL, any reader/source. No resolver-per-format zoo.
- **Resolution memoization: built** (`src/duckdb/resolution-memo.ts`): the lazy graph's memo table, keyed on
  content FRESHNESS (`file_scan` content digest; `http.get` ETag/Last-Modified via conditional `If-None-Match` →
  `304`). `sql_materialize` deliberately opts out (arbitrary SQL has undeclared/volatile determinants). The
  remaining layer is CAS-of-bytes (cross-db reuse): see the section above. CAS = store by content hash,
  versioned; use it for collaboration / reproducibility / rollback / audit; skip it for large churny outputs.
- **Remote freshness via ETag/Last-Modified: done in `http.get`** (the `FetchLike` port now exposes response
  headers; a stored validator drives a conditional request and a `304` replays the cached receipt).
- **An audit pass re-validates external state**: a separate run comparing stored vs current validators (ETags)
  to catch data that changed outside the pipeline. Relevant once remote resources + caching exist.
- **Error handling for the future `process` executor + `http.get`**: `targets` offers stop / continue / null /
  trim plus transient-error retry/backoff for cloud. For us these are **policy (host/manifest data), not baked
  in**; failed-run receipts already enable "re-run only the failed." Design the executor for transient errors
  (retry as a host fetch/exec decorator), per host-controlled effects.
- **The DuckDB-over-files aggregation pattern is the validated substrate.** `targets` users' go-to for "many
  inputs → a value" is: write Parquet per branch, then `duckdbfs::open_dataset(files) |> group_by |> summarise
  |> collect()`: i.e. resolver(s) → operation SQL. A process-op producing Parquet artifacts that `file_scan`/
  `sql_materialize` then aggregate is exactly this; no bespoke combine step.

## CAS-of-bytes: built scope

Distinct from the resolution memo (which caches a materialized TABLE within one persistent db): CAS dedups the
raw bytes across dbs/projects, keyed by content hash. Built:
- `src/core/cas.ts` (`CasStore`: pathFor/has/put + a cross-db url->{etag,address} index) + `src/hosts/fs-cas.ts`
  (filesystem, `<root>/<algo>/<digest>`, atomic).
- Host opt-in by composition (`cas` threads RunRequest -> runQuery/runOperation -> `ResolutionContext.cas`),
  default absent = fast mode.
- `http.get` CAS mode: a 200 snapshots the body under its sha256 + seeds the (scope,url)->ETag index; a DIFFERENT
  db with an empty per-db memo but the same host-provided `remoteCacheScope` sends If-None-Match from that index
  and on 304 materializes from CAS bytes with no re-download (test: body downloads exactly once across two dbs).
  The scope is FAIL-CLOSED: the cross-db index is skipped entirely without a scope, and is keyed per-scope so an
  authenticated response (host auth injected by a fetch policy is invisible to the resolver's memo decision) can
  never leak one caller's bytes to another. Public content uses one constant scope for full reuse.

### Honest scope: CAS is for whole objects, not a universal remote cache
CAS-of-whole-bytes is right for a REST/JSON API body or a moderate dump fetched by `http.get` itself. It is the
wrong granularity for two cases, which are separate tiers chosen by which resolver the manifest declares:

- **Small-region joins over a huge indexed remote VCF (gnomAD):** use HTTP range + tabix via htslib, not whole-
  object CAS. Built: region-scoped `duckhts.read_bcf` (`src/duckdb/resolvers/duckhts-read-bcf.ts`) takes a
  `region` (an htslib `chrom:start-end` string OR `{chrom,start,end}`) and emits `read_bcf(?, region := ?,
  tidy_format := true)`, reading only that region's blocks; the live WGS chr22 flagship uses it
  (`examples/wgs-chr22-annotation`, `test/duckhts-region.test.ts`). Remaining (spec):
  - a MULTI-region `regions: [{chrom,start,end}]` array and an explicit `index?` param (today: single `region`,
    index discovered by convention); resolver canonicalizes to htslib region strings and reads only those blocks.
  - Provenance: record the VCF URI + the INDEX (.tbi/.csi) URI + index/file ETag + the canonical region list;
    do not record a whole-file sha256 that was never downloaded. CAS may cache the small index bytes (reused,
    tiny) and/or the derived region table: never the whole VCF.
  - Traps: htslib regions are 1-based closed vs BED 0-based half-open; validate VCF+index as a pair (ETag skew);
    split multiallelics + left-normalize REF/ALT + match contig naming/assembly before exact joins; prefer CSI
    for large contigs.
- **Remote columnar/large files DuckDB reads directly (parquet/csv on http/s3):** lean on DuckDB httpfs +
  `cache_httpfs` block caching, not our CAS: those bytes never flow through our resolver.
  `cache_httpfs` is a mutable/evictable performance cache, not a receipted artifact: do not conflate it with
  provenance. Enable recipe (a host bootstraps the connection BEFORE resolving):
  ```sql
  INSTALL httpfs; LOAD httpfs;
  INSTALL cache_httpfs FROM community; LOAD cache_httpfs;
  SET cache_httpfs_cache_directory = '/var/cache/pi-bio-agent/duckdb-httpfs';  -- host-owned
  -- version-specific knobs: SELECT name,value,description FROM duckdb_settings() WHERE name LIKE 'cache_httpfs%';
  ```
  Then `read_parquet('https://…')` etc. used by `duckdb.file_scan`/`duckdb.sql_materialize` benefit
  transparently. `cache_httpfs` is now in the extension catalog (`src/duckdb/extensions.ts`).
  - **Built:** the host runner (`src/hosts/run-store.ts`) has a `duckdbInitSql?: string[]` option on
    both request types, run statement-by-statement once per connection BEFORE resolution (`test/run-store-init-sql.test.ts`), so a host can `INSTALL`/`LOAD`/`SET` (httpfs + cache_httpfs, ducknng, secrets) without `sql_materialize`
    needing to. (The non-transactional caveat below still applies: keep DDL/DML out of init.)
  - Provenance note: for DuckDB-internal remote reads the receipt records the URI + SQL/params + resolver +
    time, but no byte digest (we never saw the bytes). That is correct for fast/lazy/range mode. Byte-perfect
    replay would require snapshot mode (download whole object into CAS first), which forfeits lazy/range reads: a bad trade for large parquet/HTS; offer it only when regulatory provenance demands it.

### Decision rule for a manifest author
- REST/JSON API body, whole moderate object, ETag-validated, reused across projects -> `http.get` (+ CAS).
- Small genomic region of a huge indexed remote VCF/BCF -> region-scoped `duckhts.read_bcf` (tabix range).
- Remote parquet/csv DuckDB can scan directly -> `duckdb.file_scan`/`sql_materialize` + httpfs (+ cache_httpfs).

## What the substrate closes over: Fugu, RLM, networked agents reduce to one property

Three frontier ideas, one foundation. The load-bearing realization: each depends on **data living addressably
outside the prompt (DuckDB tables + CAS + receipts), navigated by bounded queries + content-addressed shared
memory.** That property is why the baseline (the executable middle of ClawBio as manifests) and the speculative
upside share one substrate rather than becoming separate efforts.

- **[RLM: Recursive Language Models](https://alexzhang13.github.io/blog/2025/rlm/)** (Zhang & Khattab, MIT
  CSAIL; [arXiv 2512.24601](https://arxiv.org/abs/2512.24601)): store the unbounded context as a *variable in a
  Python REPL*; the LM peeks/greps/partitions/maps/summarizes it and launches recursive LM sub-calls: dodging
  context degradation because no call holds the whole context. **`bio_query` over DuckDB is the same loop with
  context as tables, not a string variable.** peek=`LIMIT`/schema discovery; grep=`WHERE LIKE`/`regexp`/
  FTS; partition+map=`GROUP BY` + per-partition sub-operations; summarize=SQL aggregates; the agent only ever
  sees bounded results. Sharper: the reduce half of RLM's OOLONG benchmark ("among these user IDs, how many label
  X over 6000 rows") is a `GROUP BY` *once the labels exist*: RLM recurses and can miscount at long context, and
  the count is exact for us. But the map half (labeling each row) is not solved by SQL: it stays the judgment/LM
  boundary (`decideGrounding`/sub-agent); the `GROUP BY` is only the deterministic reduce after labels exist.
  Recursion depth = nested sub-operations.
- **[Sakana Fugu](https://sakana.ai/fugu)**: its "shared memory so agents don't re-discover artifacts" = our
  CAS + `studyNoteIndex`; workflow-as-data with access lists = a conductor manifest / `StudyScaffold` (below).
- **Networked agents**: stigmergy via a shared CAS root. Agents communicate by content-addressed receipted
  artifacts, not live chat.

Narrative: the SQL-REPL-over-addressable-data substrate plus a process runtime covers the executable middle of
ClawBio as manifests. The same substrate can later support Fugu/RLM/networked-agent patterns.

Honest boundary: claiming the substrate covers all of ClawBio is too strong. Working through the classes that
looked outside the substrate:

- **stateful-async services** (submit -> poll -> fetch): a sequence of HTTP calls with a `job_id` threaded
  through + a poll-until-ready loop. That is http-with-session + a poll primitive driven by a compute op /
  conductor step: composition, not a new transport.
- **GraphQL**: a `POST` with a JSON query body to one endpoint, JSON back -> table: a `method`+`body`
  generalization of the http resolver.
- **auth**: SQL-native HTTP should use a host-commissioned ducknng profile; the separate `http.get` resolver uses
  host-injected fetch auth when an application deliberately chooses that port. In both paths, secrets stay outside
  the manifest and outside agent-visible SQL.
- **pagination**: follow `next` cursors in a bounded loop, `UNION` each page into the table: a resolver loop /
  conductor map.
- **human/clinical sign-off**: a host gate around runs: out of executable scope by definition (the substrate
  produces the auditable artifact a human approves), not a coverage gap.

The genuinely irreducible thing is the model's semantic judgment (literature interpretation, phenotype
disambiguation, narrative synthesis), and that is not a gap; it is the judgment boundary designed on purpose
(two-tier grounding: deterministic SQL projection -> LM judgment). The substrate feeds it; the model does the
semantic step. So the corrected claim: substrate + process runtime + judgment boundary cover ClawBio's
computational surface; what is not covered is (i) the model's semantic judgment and (ii) human sign-off (host
policy). The architectural claim is no new substrate class, but it does require real request/response lifecycle
machinery: POST/body, scoped auth profiles, pagination-follow, poll/resume, retries, and receipts. See
"HTTP resolver generalization" below.

Narrowed further: "no new substrate class for many request/response APIs" is the defensible
claim; **production semantics are not free** and are real engineering, not architecture:
- stateful-async needs durable job ids + resume-after-crash + idempotency keys + cancellation + TTL/cleanup +
  partial receipts (today a resolver that submits a remote job and crashes before returning loses the job id: `src/core/operations.ts` only records a receipt after `resolveResource` returns).
- auth is more than a header: OAuth refresh needs a host-owned token lifecycle + retry-on-401, and SQL-native
  calls need profile commissioning/rotation on the DuckDB/ducknng runtime.
- rate limits: `429`/`Retry-After`/quota budgets/host throttling: unaddressed.
- streaming/binary/SSE/websockets: today `FetchResponse` is `text()`-only, JSON/CSV/NDJSON: full-body only.
- real remote WRITES/transactions: the operation surface is read-only by design; POST with `mutates:false` does
  not cover two-phase workflows, retries, idempotency, transaction receipts.
So: the bet is "the substrate absorbs the request/response API SHAPE as data"; the durable effect/auth/rate-
limit/streaming/write machinery is genuine work the process runtime + host capabilities must provide.

Resolutions (these are ADDRESSABLE via known machinery, not open research):
- **auth / OAuth refresh** -> lean on **pi's auth storage + token-refresh ops**. For SQL-native ducknng calls, the
  host resolves/refreshes credentials and commissions a scoped profile on the execution runtime; agent SQL receives
  only `profile_id`. For the `http.get` resolver path, inject auth through `withAuth`, never the manifest.
- **rate limits** -> exponential backoff with `Retry-After`/`429` awareness in the resolver's retry policy.
- **streaming / binary / SSE / websockets** -> **pi-mono has reusable patterns** for these transports; widen
  `FetchResponse` beyond `text()` to a byte stream and adopt them.
- **the HTTP carrier itself** -> **`ducknng_ncurl`** (ducknng ships an HTTP/curl client + `ducknng_ncurl_table`):
  the request/response generalization (POST/body/profile auth/streaming) and the nng agent topologies live in one
  DuckDB extension, both Arrow-native. So the connector plane and the multi-agent transport converge.

### Streaming transports (decided: not either/or, three needs, three tools)
- **Pull-streaming HTTP** (large bodies; byte-cap so a runaway response can't exhaust memory): read the runtime
  `fetch` body (a `ReadableStream`) with a cap. Built and wired: `src/duckdb/resolvers/http-stream.ts`
  `readCapped(stream, maxBytes)`, applied by the default networked adapter (`cappedFetchLike`). DuckDB-native
  equivalent: `ducknng_ncurl`.
- **SSE** (server-sent events: LLM token streams, progress): parse `data:` frames off the same chunked stream.
  Pi's LLM streaming code already carries the practical parser/lifecycle pattern; adopt that shape without
  adding another connector-specific stream stack.
- **Bidirectional / server-push / live subscriptions** -> **wss over nng** (ducknng's `ws://`/`wss://`
  transport). The tie-in: the pub/sub blackboard's `awaitNote` currently polls (SELECT loop); over wss-over-nng
  it becomes a push subscription. ducknng unifies `ncurl` (HTTP) + ws/wss + the nng
  topologies, Arrow-native, so the streaming carriers and the agent transport are again one extension.

### HTTP resolver generalization (the real build the collapse needs)
`http.get` is today GET-only, JSON/CSV/NDJSON, single-shot. To make the classes above manifest-expressible:
- `method` + `body` params (POST/PUT; GraphQL = POST + JSON query body). Keep read-only INTENT explicit (a
  declared `mutates: false` or a separate `http.post` name) so the effect surface stays honest.
- scoped auth profiles (never in the manifest): a host commissions a ducknng HTTP profile and SQL supplies only
  `profile_id`; the `http.get` resolver path can use injected `withAuth` headers.
- pagination: a `paginate` spec (`next` JSONPath / `Link` header) the resolver follows, UNION-ing pages.
- a poll primitive: submit -> poll `status` until ready -> fetch, with bounded backoff (cancellable via the
  already-threaded `AbortSignal`). Drives stateful-async services.
Each is a bounded resolver generalization within the bet, not a new transport. Build on a concrete consumer.

## API discovery (OpenAPI/OPTIONS) + parameterized resources: the two pieces that de-toy the API examples

Three user questions converge on the same gap. The variant-annotation example hard-codes 5 rsIDs in the request
body. Overfitting: a real skill doesn't bake the query data into the manifest. The two missing pieces:

- **API discovery (do not hand-author the resource shape).** Many bio APIs (Ensembl, EBI, …) ship an OpenAPI/
  Swagger spec. Derive HTTP resources from it: the endpoint URL (server+path), method, parameters, request-body
  schema, and response schema all come from the spec, so the resource is generated, not authored (matches
  "hand-writing manifests should be banned"), and the response shape the agent unnests is grounded in the spec,
  not guessed. `OPTIONS` is the *runtime* sibling of this (an endpoint's "what can I do here" probe), which is
  why OPTIONS/HEAD aren't in the body->table resolver: they're discovery, a separate concern from data-fetch.
  Build: `openApiToResources(spec)` -> http resource templates (url/method/body-schema/format); the agent picks
  an operation and fills its params.
- **Parameterized resources: done the SQL way, not a DSL.** The query data comes from the agent / upstream, not
  the manifest, and it is all SQL (no bespoke templating; the `fillTemplate`/`$sql` DSL was reverted):
  - **agent params = DuckDB SESSION VARIABLES.** `bindings` -> `SET VARIABLE name = ?` on the conn before
    resolution; a resource's `url` (when not a literal) is a SQL EXPRESSION evaluated against the conn:
    `'https://…/search?q=' || getvariable('query') || '&ontology=' || coalesce(getvariable('ontology'),'mondo')`.
    DuckDB composes it; a non-http result fails closed. (ols4-grounding now works exactly this way.)
  - **upstream data = SQL subqueries.** "Discover then annotate": stage-1 reads a VCF (`duckhts.read_bcf`) -> a
    `variants` table; stage-2's request composes from it in SQL: a url with a subquery, or a body built with
    `json_group_array((SELECT id FROM variants))`. The request is a function of upstream data, in SQL.
  - **Encoding: solved in pure SQL.** DuckDB has `url_encode` built in, so values compose safely:
    `'…?q=' || url_encode(getvariable('query'))` turns `lung cancer` into `lung%20cancer`. No UDF needed.
  - **The fetch itself is SQL via ducknng.** The package is pinned to `@duckdb/node-api@1.5.2-r.2`, and
    version-matched ducknng builds load in this runtime. The proved shape is:
    `ducknng_ncurl_table('https://…?q=' || url_encode(getvariable('query')), 'GET', non_secret_headers, body,
    timeout, tls, profile_id)`: SQL composes params and request bodies, ducknng fetches/parses JSON into columns,
    and credentialed calls use a host-commissioned profile id rather than a SQL-visible token. Plain HTTPS works by
    passing a host-created TLS config id; authenticated HTTPS works when the loaded ducknng build exposes HTTP
    profiles. The `http.get` TypeScript resolver plus `withRetry`/`withAuth` is a separate JS-fetch path for hosts
    that intentionally keep connector policy outside DuckDB.
- **Batch HTTP = a chunked, rate-limited pipeline, not one request.** VEP caps the batch (~200-1000 ids) and
  rate-limits (~15 req/s, `429`+`Retry-After`, hourly quota). Annotating a real VCF: chunk the variant list (SQL)
  into batches <= the limit, run them through `runPipeline` (the push/pull pool) with `withRetry` (429/backoff),
  `UNION` the results.
- **SQL-native HTTP: both examples migrated.** `ols4-grounding` (GET, URL from a scalar `getvariable` +
  `url_encode`) and `variant-annotation`
  (POST batch) are now `duckdb.sql_materialize` over `ducknng_ncurl_table`: no TS resolver. An earlier note here
  claimed the batch case "can't be pure SQL"; that was wrong. The corrections, precisely:
  - `ducknng_ncurl_table` arg order is `(url, method, headers_json[VARCHAR], body[BLOB], timeout_ms, tls)`: for
    a POST the body is the **4th** arg (a `BLOB`), headers the **3rd** (a JSON array `[{name,value}]`).
  - **One within-limit batch is one POST, fully SQL.** `ncurl_table` returns a large *response* fine (many
    rows): response size was never the constraint. The body composes from a scalar: from a binding
    (`json_object('ids', json(getvariable('vep_ids')))`, what the example does) or, to build it from upstream
    rows, a **scalar subquery returning exactly one body value**: `SET VARIABLE vep_body = (SELECT
    json_object('ids', json_group_array(id)) FROM variants)` then `getvariable('vep_body')::BLOB`. That
    `SET VARIABLE`-from-subquery is **plain DuckDB, not ducknng-specific** (the old "no between-resource hook"
    point conflated a substrate convenience with a ducknng limit). On the pinned 1.5.2 build a subquery placed
    *directly inside* the table-function args is still rejected ("Table function cannot contain subqueries"), so
    the aggregate goes through a variable first; a later build may let the scalar subquery sit inline.
  - **The table-function limits below are DuckDB-core, not ducknng-specific.** "Table function cannot contain
    subqueries" and "does not support lateral join column parameters" are how *every* DuckDB table function
    behaves (`read_csv`, `read_parquet`, … all reject subquery args and correlated lateral column inputs);
    `ducknng_ncurl_table` only **inherits** them. The single genuinely *ducknng-flavored* wrinkle is that its
    schema is **dynamic** (columns derived from the JSON response at bind time), which makes a per-row/lateral
    call even less expressible than for a fixed-schema reader. So this is a DuckDB constraint we route around, not
    a ducknng defect.
  - **The one real constraint is multi-*request* fanout**, not row count. Because of the DuckDB-core limits above,
    `ducknng_ncurl_table` can't be **lateral-correlated** for one-call-per-chunk inside a single `SELECT`, but
    that does not mean per-chunk HTTP leaves SQL: the scalar `ducknng_ncurl_aio(...)` *does* fire one real request
    per row with **error-as-value** `(ok, status, body_text)`, so the per-chunk fanout is SQL-native; only the
    multi-round retry orchestration is host code (`src/duckdb/ncurl-fanout.ts`), and only because a recursive CTE
    constant-folds the I/O (see the retry note below). For chunk fanout (a whole VCF > VEP's ~200–1000-id/request cap, ~15 req/s + `429`/`Retry-After`):
    launch per-row `ducknng_ncurl_aio(...)` handles (scalar, it *can* fire per chunk), materialize the aio ids, and **drain repeatedly**, `ducknng_ncurl_aio_collect(...)` is an *any-ready collector, not a wait-for-all
    barrier*, so getting 1 of 3 launched handles back is legal until you drain the rest (the earlier "returned
    one row, fragile" note misread this). Or drive the separate calls outside one SQL statement with
    `runPipeline` + `withRetry` (honoring `Retry-After`) and `UNION` the results.
  So: single GET/POST with scalar params (incl. an upstream-aggregated body) is the SQL-native path today (both
  examples). For multi-request chunked-VCF fanout, use scalar `ducknng_ncurl_aio(...)` plus the host drain/retry
  loop in `src/duckdb/ncurl-fanout.ts`, or choose the separate TS `http.get` resolver path deliberately.
- **Retry is error-as-value, and the loop is the AIO drain (not a recursive CTE): verified on 1.5.2.** Two
  building blocks are real: (a) `ducknng_ncurl(...)` and `ducknng_ncurl_aio_collect(...)` return `(ok, status,
  error, …)` ROWS: a non-2xx / `429` / `503` / connection failure is a VALUE you branch on, not a thrown
  exception (contrast `ducknng_ncurl_table`, which THROWS on non-2xx, proved: same transient failure returns a
  `status=503` row from `ncurl` but a Binder Error from `ncurl_table`). So a retry decision is `WHERE status IN
  (429,503,…)`, not try/catch. (b) iteration IS simulable in SQL: `WITH RECURSIVE` loops, counts attempts, and
  terminates on a data condition. But the naive composition, a single recursive CTE that re-fires a table function (`ncurl`/`ncurl_table`) per iteration, does not re-hit the network: DuckDB evaluates the literal-arg
  IO table function ONCE per statement and reuses the result across all iterations (proved three ways: a scalar
  subquery → one real call reused 4×; the table function in `FROM` → call#s `1,2,2,2`), and you can't perturb the
  args per iteration to defeat the folding because the table functions reject column/correlated args ("only
  literals"). The primitive that re-executes per row is the scalar launcher `ducknng_ncurl_aio(url, …)`, so it accepts a per-row column arg: `SELECT ducknng_ncurl_aio(url, …) AS h FROM chunks` launches one
  real request per chunk (proved: 3 chunks → 3 distinct server-side call#s), then `ducknng_ncurl_aio_collect(
  list(h), wait_ms)` drains them (one error-as-value row per newly-terminal handle). Retry = re-launch the subset
  whose drained `status` says to (another per-row scalar `aio` over the not-yet-2xx chunks), looped at the
  statement-driver level (agent re-issues a drain round) with backoff between rounds. Net: error-as-value makes
  retry a data branch; the re-executing loop is launch-all + status-driven re-launch/drain (scalar aio), not a
  recursive CTE over the throwing/constant-folded table functions. This is the SQL-native shape of the
  "rate-limits = exponential backoff" production-semantics resolution.
- **Update: the constant-fold issue was fixed in ducknng, with backport work tracked separately.** Root cause:
  `ducknng_ncurl(...)` did HTTP I/O inside a table-function BIND path, so DuckDB treated the constant-argument
  table function as reusable inside the recursive CTE: the retry CTE iterated but the request fired once
  (reused). Fix (in the ducknng branch we maintain): raw `ducknng_ncurl(...)` now executes through a **volatile
  scalar** internally (`ducknng__ncurl_row(...)`); the public `ducknng_ncurl(...)` stays a table macro over it. So
  a recursive-CTE retry now **re-fires the HTTP call per iteration** (verified upstream: `503, 503, 200`; body
  call counts `1, 2, 3`; still error-as-value, no throw). **Key rule for that pattern:** make the call **depend on
  the recursive row** (put `attempt` in the URL/body), e.g. `url || '?attempt=' || (a.attempt+1)`, else DuckDB may
  still make one extra **speculative** call after the stop condition. Caveats, both load-bearing: (1) this is the
  scalar/row `ducknng_ncurl` path: the dynamic-schema `ducknng_ncurl_table(...)` infers columns from response
  Content-Type at bind, so it stays unsuitable for lateral per-row retry/chunk fanout (don't "just mark it
  volatile"); (2) the fix is **not in our installed community build** (`8dbf073` still exposes `ducknng_ncurl` as
  a `table` function, no `ducknng__ncurl_row`), so `src/duckdb/ncurl-fanout.ts` is still required today. Once we
  backport the volatile-scalar fix across the DuckDB versions we ship, a single-endpoint multi-round retry
  collapses to **one recursive-CTE SELECT** (attempt-in-row); `ncurl-fanout.ts` then remains only for the
  table-function CHUNK fanout (many endpoints) and for unpatched builds. This is the first concrete payoff of
  maintaining the ducknng stack directly.
- **Follow-up: backport landed on the release branch; community builds do not carry it.** Tracking:
  [`#1`](https://github.com/sounkou-bioinfo/ducknng/issues/1) (per-DuckDB-version branches),
  [`#2`](https://github.com/sounkou-bioinfo/ducknng/issues/2) (the volatile-scalar `ncurl` fix: **done**, landed
  on `main` and backported to `release/duckdb-1.5.2`, commit `95196e0`), and
  [`#3`](https://github.com/sounkou-bioinfo/ducknng/issues/3) (publish tagged binary releases per DuckDB version).
  **Verified in the node-api runtime** (loading the `release/duckdb-1.5.2` build with `allow_unsigned`):
  `ducknng__ncurl_row` is registered `VOLATILE`, and a `WITH RECURSIVE` retry with the call **depending on the
  recursive row** (`?attempt=N`) re-fires per iteration (distinct calls, not one reused): the fix works.
  - **The catch: `community-extensions` does not carry backports.** The community build tracks one line, so
    `INSTALL ducknng FROM community` will never ship the 1.5.2-branch fix (still `8dbf073` here). To consume it we
    must use a **from-source / repo-published-release** build (the point of `#3`): download/build the
    `release/duckdb-1.5.2` `.duckdb_extension` and `LOAD '<path>'`. Because that build is **unsigned**, the host
    sets `allow_unsigned_extensions = true` in `duckdbConfig` (host-owned, never an agent param): the signing
    difference documented here is now the real install path. **Provisioning helper:** `npm run provision:ducknng-owned`
    (`scripts/provision-ducknng-owned.sh`) resolves the target DuckDB version, then downloads the tagged release
    asset (`v0.1.1+duckdb<ver>`) if published, else builds `release/duckdb-<ver>` from source, places it under
    `.pi/ducknng/duckdb-<ver>/ducknng.duckdb_extension`, and verifies `ducknng__ncurl_row` is `VOLATILE` before
    printing the `LOAD` recipe. (Per-DuckDB-version binary publishing is upstream `#3`.)
  - **Trigger to flip the substrate:** probe `duckdb_functions()` for `ducknng__ncurl_row`; when present (i.e. the
    host loaded an owned build), enable the recursive-CTE retry path and narrow `ncurl-fanout.ts` to the
    chunk-fanout case. With the default community build it stays absent, so `ncurl-fanout.ts` remains in use: no
    change until the host opts into the owned build.
  - **Signing differs for maintained builds.** The *community* `ducknng`/`nanoarrow` are **signed**: they
    `INSTALL/LOAD FROM community` with no `allow_unsigned_extensions` (we dropped that flag from the signed-path
    examples/tests). But an extension we **build from source** (the backport branches, a local dev build) is
    **unsigned**, so loading it requires `allow_unsigned_extensions = true`. That is **host-owned `duckdbConfig`**
    set at DB open (`DuckDBInstance.create(path, { allow_unsigned_extensions: "true" })`: the same home as
    cache_httpfs / S3 secrets), **never an agent param**, and it stays scoped to the dev/owned-build deployment.
    So the rule is: *signed community build → no flag; our from-source backport build → host sets the flag.* Both
    are the host's choice by composition, consistent with the powerful-by-default, host-controlled-effects stance.

Together: OpenAPI gives the resource SHAPE (derived); SQL (SET VARIABLE + subqueries) fills the params; a chunked
rate-limited pipeline handles scale. Nothing query-specific is hardcoded, and it is all SQL + the pipeline pieces.

## Machine studying: Fugu pieces 2 & 3 over the study-notes system

Sakana Fugu (https://sakana.ai/fugu, arXiv 2606.21228) factors into: (1) a LEARNED orchestrator, (2) scaffold-
as-data, workflow steps `(subtask, worker, access_list)` where the access list is which prior outputs enter a worker's context, and (3) a memory discipline, intra-workflow ISOLATION + inter-workflow SHARED MEMORY so
agents don't redundantly re-discover artifacts. We drop (1): we won't train an orchestrator; the agent (or a
static scaffold) conducts. Pieces (2) and (3) map onto our study-notes system as a "machine studying" loop:

- **(3) is already built.** `studyNoteIndex` (`src/core/study.ts`) is the cheap index scanned BEFORE re-deriving. Fugu's shared memory that prevents redundant re-discovery. `hook` is a per-note retrieval predicate; notes
  project into a traversable KG (`studyNoteGraph`: `memory` nodes + `depends_on`/`references`/`contrasts_with`
  edges). CAS-of-bytes is the same discipline for corpus BYTES (don't re-fetch). Intra-isolation = keep
  independent probes (`question_bank`/`worked_example`/`failure_case`/`expertise_probe`) from being railroaded
  by the first note's framing, then synthesize into a `concept_map`/`index`.
- **(2) is the one real gap.** `deriveStudyPlan` returns a flat `string[]`; Fugu's scaffold is a DAG. Note
  `links: depends_on` + `sources` (`path/url/locator/quote`) ARE the access-list primitives, but the PLAN
  doesn't use them. Lift the plan to a `StudyScaffold`.

### Buildable kernel (non-breaking; awaiting user steer: touches the study contract)
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
The accessList edges are the same shape as note `links: depends_on`, so a scaffold step and the note it
produces share one dependency model; execution = topological order, each step reads only its accessList (the
isolation boundary), writes its note (the shared memory). Provenance composes: each note's `sources` already
records what fed it. Build only on explicit go: it changes `deriveStudyPlan`'s consumers and needs a test.

## Effect discipline: prior-review follow-ups

A prior review audited for ambient/hidden effects. One real finding fixed: wall-clock reads now funnel through the one
`systemClock()` adapter (`src/core/clock.ts`) instead of scattered `?? new Date()` fallbacks. Open, in priority:

- **Strict `now` (the endpoint, deferred).** The funnel removes the *hidden* scattered reads but keeps a
  last-resort fallback. The strict version makes `now` required on `ResolutionContext`, `RunOperationRequest`,
  `newRunRecord`, etc., so the only wall-clock read is at the host entrypoint (extension/CLI): pushing the
  clock to the OS-adapter boundary like `index-networked.ts` does for fetch. Deferred: it ripples into ~46 test
  call sites; do it when a determinism/replay need (a reproducible run) drives it.
- **Run/note ID generation.** `runId` (`Date.now()`) and study-note `randomUUID()` are nondeterministic host-
  boundary effects. Inject an `idFactory` (or require `runId`) when reproducible run identity is needed.
- **Memo cache opt-out.** The resolution memo silently changes whether a resolver re-fetches (freshness-correct: it replays the same receipt, so results are identical, only perf differs). Add `cache?: false` to the run
  request / resolver ctx for callers who want to force a cold re-resolve.

By doctrine, these are not library bugs: DuckDB replacement scans, httpfs, htslib, and direct filesystem access can
reach local files and remote URLs. The library is deliberately not the network/filesystem sandbox; egress and
filesystem confinement are the host's boundary (container/seccomp/Pi/OS). `validateReadOnlySelect` governs
statement class for embeddable SELECT fragments, and the result-statement guard additionally allows read-only
DuckDB introspection (`DESCRIBE`/`SUMMARIZE`). Neither is a reachability or tenant-isolation mechanism.

### Frontier residues for public release

**(1) DuckDB ambient egress: not a library build.** A prior review re-flagged that in the default
profile `bio_query(sql: "SELECT * FROM read_csv_auto('https://…')")` can reach the network if httpfs autoloads.
This is the same doctrine as above: **the library is deliberately not the network/
filesystem sandbox**. Egress confinement is the host's boundary (container / seccomp / Pi / OS). The fail-closed
facility the library owns is the injected `fetch` port (http.get injects none by default → fails closed); DuckDB's own
reachability (httpfs / replacement scans / htslib) is a host-provisioned capability, and we never claim SQL can't
reach out. Do not thread a network-grant lockdown into the runner or make the library police egress. If a host
wants defense-in-depth it can pass this via its own `duckdbConfig` at DB open (host code, host choice, not a library
default): `autoinstall_known_extensions=false` + `autoload_known_extensions=false` +
`disabled_filesystems='HTTPFileSystem,S3FileSystem'` (+ `lock_configuration=true` to seal). Documenting the recipe
is fine; building/defaulting it into the library is not: that would re-open a closed doctrine.

**(1b) `compute.run.params.env` secrets boundary.** The replay manifest snapshot is persisted
verbatim (`run-store.ts` `manifest.snapshot: raw`), so a credential in `params.env` leaks in cleartext into
replay.json / CAS: asymmetric with host `duckdbInitSql`, which is digested for exactly this reason. Fixed now at
the boundary: documented that `params.env` is non-secret-only and host secret env comes through the host-injected
ComputeRunner (never a manifest param). Open decision (reproducibility trade-off): whether to also
redact `compute.run` env values in the persisted snapshot (keys kept for replay structure, values omitted): closes the leak with no leaky denylist, but loses faithful replay of legit non-secret env values. Parallels the
initSql digest choice (reduced fidelity for secret-safety). Decide before building.

**(2) Server-side atomic monotonic writes ([[reproducibility-and-longrunning-lane]] residue #2).** The earlier
residue was real: `withSlotLock` serialized only in-process, so separate RPC clients could compute the same
`recorded_at` for a same-slug `remember`/`forget`. The current fix is the compare-and-set insert path
(`insertObservationIfSlotMax`) plus the ducknng server's serialized execution lane: one atomic
`INSERT ... SELECT ... WHERE NOT EXISTS ... RETURNING` commits only if the slot max has not advanced. Keep this
as a hard constraint, not a vague concurrency claim: a concurrent connection pool can reintroduce stale-snapshot
behavior, so shared same-slug writes require the serialized server model documented in `docs/concurrency.md`.

## Network opt-in hardening: prior-review follow-ups

The host network opt-in is wired by composition, not ambient env: `createBioExtension({ network })` takes the
fetch port explicitly; the default entrypoint injects none (http.get fails closed), and `index-networked.ts` is
the operator's explicit grant. (A prior review suggested an env gate, but env vars inherit across forks/embeddings and
are invisible to the model: the substrate's injected-effect discipline forbids them; choosing the entrypoint is
the visible, auditable, agent-inaccessible grant instead.) Open,
freshness/provenance-correct refinements it surfaced, in priority order. Build each only with the named consumer
in hand; none are speculative, but none should be half-built autonomously.

- **Cancellation: done.** `AbortSignal` now threads Pi tool -> RunQuery/RunOperationRequest -> runQuery/
  runOperation -> `ResolutionContext.signal` -> http.get's injected fetch. An aborted tool call tears the
  request down (best-effort; a resolver that can't honor it ignores it).
- **Byte cap: done (timeout still open).** The default networked adapter (`index-networked.ts` `cappedFetchLike`)
  now shapes `FetchResponse.text()` through `readCapped(res.body, DEFAULT_MAX_RESPONSE_BYTES)`, so a runaway/
  unbounded remote body can't exhaust process memory; a host wraps its own fetch for a tighter/per-endpoint cap.
  Timeout is still host-policy (wrap the fetch with an `AbortSignal` deadline).
- **304 revalidation provenance.** A `304` replays the stored receipt with the original `retrievedAt`: honest
  about the bytes (unchanged) but silent that freshness was reconfirmed later. Optional enhancement: stamp a
  `revalidatedAt` note so the receipt shows "T1 bytes, revalidated current at T2". Not a correctness bug.
- **Redirect provenance.** The receipt records the declared `p.url`, not the final response URL after redirects.
  `FetchResponse` has no `.url`; widen it and record the final URL when it differs.
- **Per-call acknowledgement (optional, never sufficient alone).** An `allowNetwork: true` tool param as an
  additional per-call acknowledgement on top of the env gate, visible in the transcript, but the env gate
  stays the hard requirement.

Not bugs, by doctrine (the library is not the egress firewall; the host sandbox is): the env gate governs only
`http.get`'s bound fetch, not other resolvers' remote reads (`file_scan`/`read_bcf`/`sql_materialize` may read
remote URIs if the host/DuckDB allows); and `http.get` does no SSRF allowlisting: the host's injected fetch
enforces allow/block lists. Both are documented at the opt-in site so a reader does not over-trust the gate.

## Storage refinements

- Keep the documented default on-disk layout in sync with `bioProjectLayout()`:
  - `.pi/bio-agent/study-notes/`
  - `.pi/bio-agent/resources/`
  - `.pi/bio-agent/cas/<algo>/<digest>`
  - `.pi/bio-agent/artifacts/`
  - `.pi/bio-agent/store.duckdb` (the one temporal `bio_observations` store; owned by `bioStorePath()`, not `bioProjectLayout()`)
- Define the DuckDB catalog tables for resources, CAS entries, runs, operations, ontology terms, KG nodes/edges, and study-note indexes.
- Define which resources are copied into CAS versus left as virtual resolver handles.
- Decide whether CAS writes are automatic for HTTP responses or opt-in per operation policy.
- Add a stable locator rule for virtual handles: use semantic, version-independent identifiers where possible, not volatile row IDs or transient URLs.
- Add cache invalidation rules for public APIs, ontology releases, and local annotation caches.
- Decide how deletion/retention is expressed in single-user core without adding a deployment authorization model.

## Code execution runtime

The compute pillar for the ClawBio factoring: the data/lookup/annotation/query skills are the SQL-REPL + resolver
tiers, but ClawBio's compute skills (Ancestry PCA, Fine-Mapping SuSiE/ABF, scRNA, nf-core/Galaxy wrappers,
R/shell) need to run external code. Design grounded in two prior-art projects (`nf-r-ipc`, `DuckTinyCC`):

- **Spawn external processes from Node** (`child_process`; detached for long-running): not in-DuckDB FFI
  (`DuckTinyCC` JIT-compiles C into SQL UDFs at runtime, but that is the wrong risk surface
  for the process path) and not a JVM/Nextflow plugin. The host owns process spawning = a host-injected effect,
  matching the doctrine; it is sandboxable and simple. (DuckTinyCC stays a niche later option for hot-path UDFs.)
- **Arrow IPC as the interchange** (the lingua franca): DuckDB exports Arrow natively; R reads via
  `nanoarrow`/`arrow`, Python via `pyarrow`. DuckDB -> Arrow -> process -> Arrow -> DuckDB (read via arrow scan).
  This is exactly `nf-r-ipc`'s transport (Nextflow<->R over Arrow IPC), but Node-hosted.
- **A strict contract** modeled on `nf-r-ipc`'s contract: the invocation is data in a manifest (a "process
  operation": `{executable, script: path|inline, inputs: [table], output: schema|kind, args}`); typed request/
  response; typed error classes; fail-closed. Provenance receipt (same model as resolvers): script digest +
  input digests + exit code + stdout/stderr + output digest + wall time.
- **Result shape:** rectangular results (PCA loadings, credible sets, summary stats) -> Arrow tables directly.
  Non-tabular R values -> adopt nf-r-ipc's `value_graph` (a flat Arrow table encoding a tree via
  `value_id/parent_id/key/index/tag/v_*`, with distinct typed-NA tags + R-class normalization): the same
  flat-table-encodes-a-tree pattern as our SemanticSQL statements (a real convergence, not a new abstraction).
- **Out-of-process is the robust choice (third confirming instance, `mangoro`):** R<->Go IPC over nanomsg
  (mangos) + Arrow (nanoarrow), explicitly avoiding in-process FFI (cgo c-shared's multiple-runtime problems): the same call as avoiding DuckTinyCC. Spawn-per-call and a persistent worker are runner implementations under the same replay/receipt/job lifecycle, not separate semantics. A held-open worker messaged via nanomsg+Arrow amortizes R/Python startup and fits long-running or per-tissue-repeated compute (e.g. coloc over GTEx tissues). Node-hosted: child_process + Arrow files/stdio, or a held-open worker over a socket.
- **CLI composition layer (`BLIT`, [WangLabCSU/blit](https://github.com/WangLabCSU/blit)):** command-line
  tools as composable objects, not strings: `exec()` -> a structured object; pipe translation (`|>` -> `|`);
  `cmd_run`/`cmd_parallel`; lifecycle hooks (`on_start`/`on_exit`/`on_succeed`/`on_fail`) -> adopt as receipt
  events + fault-tolerant branching; micromamba/Conda env management -> a compute op should declare + pin its
  env (tool versions) in the receipt for reproducibility; auto native-data->CLI-input (df->tsv->temp->cleanup)
  for tools that don't speak Arrow (our `http.get` temp-materialize already has this shape). So: nf-r-ipc =
  Arrow/nanoarrow transport + typed contract; BLIT = CLI composition + env pinning + lifecycle; mangoro =
  out-of-process generalizes (R/Go) + persistent-worker option; Node = the host that spawns + owns lifecycle.
- **Init non-transactional caveat:** `duckdbInitSql` runs statement-by-statement, not in a transaction;
  on a persistent DB a later failure can leave earlier side effects with no failed-run receipt. Fine for
  idempotent INSTALL/LOAD/SET (its intended use); keep DDL/DML out of init.

### Flagship: post-GWAS colocalization (`PostGWAS` + `coloclize` shape), the two-pillar proof
PostGWAS independently arrives at our architecture: provider contracts (`SumstatProvider`, `LDProvider` returning
a provenance-bearing `DatasetLD` object, `AncestryWeightsProvider`, `ColocEngine`, `FineMapResultProvider`) with
DuckDB/PlinkingDuck/coloc/HyPrColoc/ColocBoost as adapters: i.e. our resolver/port + receipt model in R/S7. The
agent solves coloc as a manifest: data pillar = tabix region-extract per GTEx tissue + SQL harmonization
(SumstatProvider) + LD from PLINK2 reference via PlinkingDuck (LDProvider); compute pillar = ColocEngine /
fine-mapping as Arrow-IPC compute ops; composition = a DAG with per-tissue partition+map. Receipts at every step
(allele basis, harmonization, LD provenance, coloc posteriors). This is the "fruitfulness in speculative new
areas" demonstration: the bet generalizing from ClawBio lookups to real statistical-genetics research.

The restricted-runtime contract (build before exposing powerful execution):

- Define the restricted code runtime contract before exposing powerful execution:
  - allowed clients only, no ambient network by default
  - no raw secrets
  - no raw filesystem except workspace/artifact APIs
  - no raw DuckDB handle except scoped read-only query clients
  - timeout, host quotas, and audit receipt
- Decide first supported language: JavaScript is natural for generated clients; R/Python remain useful through explicit tools for analysis/reporting.
- Define how operation clients are generated from operation specs and injected into the runtime.
- Add tests proving large intermediate results can be filtered in-env without entering model context.

## Application operation sets

- Start with small declarative application-owned operation sets rather than bespoke core adapters:
  - OpenTargets GraphQL: `examples/connectors/opentargets-graphql.json` proves the carrier is just a
    `ducknng_ncurl_table` POST whose typed nested response is unnested in operation SQL; no GraphQL-specific core
    resolver is needed.
  - Monarch/HPO ontology evidence
  - Ensembl/VEP annotation
  - ClinVar/ClinGen evidence references
- For each operation set, require:
  - input schema
  - output shape or normalizer
  - identifier namespace notes
  - network policy
  - cache/provenance policy
  - mock-network tests
- Keep provider/API documentation in study bundles; promote stable invocation details into application-owned
  operation specs.

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

**Direction settled: project the [SemanticSQL](https://github.com/INCATools/semantic-sql) source-spec shape into DuckDB.**
The upstream source of truth is LinkML: `statements(subject,predicate,object,value,datatype,language)`,
`prefix(prefix,base)`, `entailed_edge(subject,predicate,object)`, plus generated views such as `edge`. Our local
compiled graph is `bio_edges(from_id, predicate, to_id)` plus `entailed_edge` / `entailed_edge_as_of`. The same
shape serves imported ontologies and our own committed graph; descendants/subsumption/graph-walk are one indexed
JOIN, not a walker. See [`design.md`](./design.md#the-semanticsql-shape-source-spec---local-graph-tables).

- Done: `entailed_edge` closure (`materializeEntailedEdges`, `src/duckdb/graph-closure.ts`): per-predicate
  transitive closure over `bio_edges`, indexed both directions; cycles terminate via UNION dedup.
- Done: ordinal scales as data (`scale_members` from a ranked `TermSet`): total order to the graph's partial
  order; `decideGrounding` membership unchanged.
- Source-spec gap audit from `INCATools/semantic-sql`:
  - **SemanticSQL-shaped sources are absorbable as DuckDB data.** Edge-shaped relations use
    `subject,predicate,object` plus optional `attrs,trust`; an ordinary `GraphProjectionProfile` maps them into
    `bio_edges`. For base `statements`, `materializeSemanticSqlSourceViews` now creates the generated `edge`,
    label, synonym, mapping, and term views that manifests and graph projection profiles consume. When a staged
    `prefix(prefix, base)` table is supplied, those views canonicalize matching IRIs to CURIEs before projection.
    We still do not parse the full upstream LinkML source to generate every DDL/view; parity expands only when a
    concrete grounding or traversal consumer needs more of the source spec.
  - **Prefix canonicalization is present, not a traversal primitive.** Here `prefix(prefix, base)` means namespace
    expansion/canonicalization (`HP` -> an HPO base IRI, `biolink` -> a Biolink base IRI), not run-id prefixes,
    observation-key prefixes, or graph walk policy. Remaining identifier hygiene is receipts and multi-database
    conflict policy, not basic IRI-to-CURIE projection.
  - **Generated views have a base conformance path.** The helper covers the common `edge`, labels, synonyms,
    mappings, and term rows. OWL restriction/axiom, RO edge, subgraph, taxon-constraint, similarity, and
    term-association views remain source-spec conformance work for consumers that need them.
  - **`edge` semantics are under-modeled.** In SemanticSQL, `edge` is a generated relation-graph view that folds
    named subclasses, existential restrictions, subproperties, and selected type assertions. Our current import
    test treats `edge` as already materialized rows.
  - **Closure semantics are simpler.** SemanticSQL commonly consumes `relation-graph` output; our CTE closes each
    declared predicate independently. That is good for local graphs, but not source-spec parity for equivalence,
    reflexivity policy, property hierarchy, individuals, or imported precomputed closures.
  - **Axiom annotations and provenance are not carried through.** OWL reified axioms, axiom annotations, evidence
    xrefs, ontology status, and repair/problem views need a projection into receipts/trust/attrs rather than being
    flattened away.
  - **Real foreign KG projection is dogfooded; multi-ontology attachment is not.** The Monarch KGX download path
    (`examples/monarch-kg-http`, `test/monarch-kg-http-example.test.ts`) stages an HTTP TSV into the canonical edge
    view and projects it into `bio_edges`. SemanticSQL's SQLite pattern also supports attached databases and
    cross-ontology joins; the DuckDB equivalent over multiple attached/staged ontology artifacts remains source-spec
    parity work.
- Next: keep source-spec parity consumer-pulled but active. A thin ontology-ingest resolver can stage the
  SemanticSQL source-spec shape in DuckDB and project its generated `edge` view into our `bio_edges` shape.
  No DuckDB sqlite extension is required: ingest from a native-readable format such as OBO Graphs JSON via
  `read_json`, generated TSVs / triple parquet via `duckdb.file_scan`, or an optional one-time `sqlite3` CLI dump
  -> parquet. Compute the closure with `materializeEntailedEdges` unless a pinned upstream `entailed_edge`
  artifact is deliberately accepted. Pin a build date as provenance, honor per-ontology CC-BY. OLS4 REST only for
  fresh text→CURIE misses (judgment tier); cached CURIEs + FTS are the deterministic projection tier; abstain
  below threshold.
- Built at the library-helper level: **graph projection profiles**, not a convenience tool zoo. A
  profile is data that says how any source relation becomes a graph projection: foreign KGs (Monarch KGX TSV
  downloads over HTTP),
  SemanticSQL staging tables (`statements` / generated `edge`), internal producers, memory links, and
  `bio_observations` as-of views all compile through the same contract. The profile declares source
  tables/columns, CURIE-prefix registry, generated-view policy (`edge`, labels, synonyms, restrictions),
  transitive-predicate policy, closure source (`relation-graph` artifact vs local CTE), temporal/as-of policy,
  and provenance/license fields. `src/core/graph-projection.ts` validates this contract and emits the projection
  SQL; `src/duckdb/graph-projection.ts` executes it and materializes local closure. Tests now prove the same executor
  over a staged ontology edge table, the internal `bio_edges_as_of` observation graph, and a Monarch KGX HTTP
  download consumed by a manifest operation. Further SemanticSQL view generation is adapter/product work, not a
  substrate gap.
- Built at the library-helper level: **bounded graph-query windows** so high-degree neighborhoods do not flood
  context. This is not a new graph runtime: `src/duckdb/graph-window.ts` returns bounded rows plus omitted counts
  and, when needed, a continuation resource handle over the same projections (`bio_edges`, `bio_edges_as_of`,
  `entailed_edge`, `entailed_edge_as_of`). It applies symmetrically to foreign KGs and our own graph;
  `bio_walk_memory` is the current small in-memory affordance, while large/as-of walks should use SQL windows over
  the compiled graph. Exposed in the Pi extension as `bio_graph_window`; still pending: CLI/operation integration
  and continuation-resume ergonomics.
- Add trust/provenance fields consistently across facts, edges, and artifacts (`bio_edges.trust` exists; keep
  it uniform with receipts/artifacts).
- Add as-of/known-at time lenses where variant reanalysis or changing knowledge releases matter.

## Competitive pressure and remaining library questions

Public science-agent products now advertise reproducible artifacts with code/environment/conversation history,
scientific renderers, managed local/HPC/GPU compute, persistent Python/R kernels, domain specialists, and large
database/connector catalogs. Our answer cannot be "more bespoke connectors"; it has to be fewer, stronger
substrate contracts: DuckDB/ducknng as the connector plane, CAS/replay as the reproducibility plane, and the graph
ledger as the memory/provenance plane.

Open library questions to resolve before claiming that position:

- **Connector plane:** how far can `duckdb.sql_materialize` + ducknng `ncurl_table` + file scans cover the
  "connector zoo" before a source-specific resolver is justified? Rule: if a connector only returns rows, keep it
  SQL/table-shaped. Auth, egress, TLS, session tokens, and sandboxing are host policy, but they should still prefer
  SQL-native carriers first where the carrier can keep secrets unreadable: DuckDB `CREATE SECRET`, ducknng
  TLS/mTLS/peer allowlists, and host-authored declared operations. TypeScript is justified for a missing host
  boundary, audit hook, token-refresh policy, or policy injector; not for routine per-API clients.
- **ducknng credentialed HTTP integration point (landed in ducknng; keep lifecycle gaps explicit).** The right
  boundary is now: the host registers a scoped outbound HTTP profile on the DuckDB/ducknng runtime (local hosts use
  `registerDucknngHttpProfile`), optionally restricts it by execution subject, agent-visible SQL supplies only
  `profile_id`, and `ducknng_ncurl`, `ducknng_ncurl_aio`, and `ducknng_ncurl_table` resolve the secret header
  inside ducknng after scheme/host/port/path/method/TLS/admission checks. Caller headers that collide with the
  injected profile auth header fail rather than overriding the credential, profile listing is redacted, and
  `registerDucknngHttpProfile` returns a secret-free receipt over profile id, scope, version/timestamps/expiry,
  header names, and subject-restriction digest. This removes the old `SET VARIABLE token` /
  `ducknng_http_headers_build(['Authorization'], ...)` integration pattern for generic authenticated SQL connectors.

  Connector runs now accept the secret-free profile receipt as a host capability receipt: replay/action keys pin the
  policy digest, run/artifact provenance references only that digest, and reproduction fails closed unless the same
  receipt is re-supplied. Remaining library/host work is narrower and should not be confused with the integration
  point:
  - rotation/refresh: `refreshDucknngHttpProfile` re-commissions the same profile id through ducknng's upsert path
    and returns previous/current redacted receipts; host auth storage such as Pi `AuthStorage` still owns how a fresh
    token is obtained and must pass it only as a bound parameter, never SQL text;
  - embedded-host subject bracketing: `ducknng` services and HTTP routes install the execution subject, and
    connection-id bindings carry it through DuckDB worker-thread execution. SQL cannot set the subject. Pure
    in-process hosts that do not route through ducknng service dispatch still need a deliberate application-facing
    adapter over ducknng's host/internal bracketing surface;
  - whole-header ownership policy: if a deployment needs to forbid all caller-supplied headers except an allowlist,
    that must be explicit profile metadata, not a hardcoded taxonomy of auth-looking header names;
  - DuckDB Secret Manager integration remains useful as a future storage/provider backend, but ducknng still needs
    its own URL/method/header scoping at send time.

  `http.get` + host `withAuth` remains a separate JS-fetch resolver path. DuckDB data-at-rest encryption protects
  persisted DB/WAL/temp files; it does not make SQL-readable session variables safe.
- **ducknng auth/state validation:** already exercised in-tree: `ducknng_ncurl_table` against local HTTP fixtures,
  scalar AIO fanout/retry, `ducknng_run_rpc` / `ducknng_query_rpc` mutable shared state, and NNG socket
  reachability. Also checked: local MCP-style `initialize` -> `Mcp-Session-Id` -> `tools/list` header threading,
  an SSE route served by ducknng and consumed with `ducknng_ncurl`, scoped HTTP profile receipts pinned into replay
  and action-cache keys, profile rotation through `refreshDucknngHttpProfile`, gated subject-restricted profile auth
  when the loaded ducknng build exposes execution subjects, and a local `tls+tcp://` fixture for TLS/mTLS client
  authentication plus exact peer-allowlist admit/deny. The `ducknng` service/HTTP-route execution-subject and
  connection-binding path now exists; remaining conformance targets before product claims are narrower:
  `wss`/server-push subscriptions, a non-SQL embedded-host adapter over that subject bracket for non-service hosts,
  and optional whole-header ownership policy when a deployment needs it.
- **Token rotation/refresh seam:** reuse the Pi pattern rather than inventing manifest config. Pi's
  `AuthStorage` stores API keys/OAuth credentials in a locked 0600 file, refreshes OAuth under lock, and returns an
  access token only at request time. `http.get` supports dynamic refresh because `withAuth` calls `getAuthHeaders`
  per request and host auth wins over manifest headers. For the ducknng SQL path, the host should resolve or refresh
  the token, register/update the scoped HTTP profile on the execution connection, and give agent SQL only the
  profile id.
- **Downstream VM seam:** if an application needs stronger execution isolation than local child-process compute or a
  bubblewrap-style wrapper, use a downstream microVM host such as
  [Gondolin](https://github.com/earendil-works/gondolin), not a new core sandbox model. Gondolin's useful pattern
  is VM execution with host-mediated HTTP/TLS, filesystem policy, and placeholder secret substitution scoped by
  host allowlists. In this library, that remains a host composition: run Pi/workers/tools in the VM, inject only the
  authorized ports, and keep the core contract at manifests, SQL, receipts, CAS, jobs, and ledger facts.
- **Generic long-running job/service lane:** this is bigger than `compute.run`. Agents, external compute,
  stateful kernels, queue workers, remote API jobs, and interactive services all need one async lifecycle:
  submit/claim/heartbeat/wait/event/complete/cancel/status/collect. The primitive is `AsyncRunner`; `ComputeRunner`
  is the compute specialization, and the durable replay queue is the run specialization. The first concrete
  library piece now exists: `hosts/job-queue.ts` provides a `SqlConn`-backed operational queue with replay enqueue,
  atomic claim, lease heartbeat, waiting/park, terminal finish, and live-claim-gated status/result writes. The
  queue/claim tables are mutable coordination. The observation ledger is the status/result audit truth. Cancellation
  is durable intent plus best-effort backend interruption; stale workers whose lease was cancelled or reclaimed must
  be rejected at the ledger boundary. Receipts, replay specs, CAS result/artifact digests, and run observations are
  the evidence that survives backend swaps.

  Absurd is useful prior art here because the implementation is DB-native, not README-only: tasks, runs,
  checkpoints, waits, events, and idempotency keys are tables; `claim_task` uses leased `FOR UPDATE SKIP LOCKED`
  claims; `extend_claim` is heartbeat; `await_event` parks a run as sleeping; `emit_event` is first-write-wins and
  wakes sleepers. That maps cleanly to our shape: task/run tables become an `AsyncRunner` backend; checkpoints and
  intermediate results become CAS handles plus ledger observations; event waits are coordination facts; terminal
  receipts and result digests remain the reproducibility authority. The core closure is now the narrow runner plus
  checkpoint convention: status/result slots, queue claims, live-claim-gated writes, `recordHostEvent` for runtime
  control receipts, `runJobStepWithCheckpoint` / `runJobStepsWithCheckpoints` for completed step reuse, and ducknng
  push frames as optional wakeups. Remaining work is consumer/backend-specific: idempotency-key conventions, event
  waits, and durable stream semantics only when a real queue or application needs them. Be precise about push: a
  durable event log can be authoritative; a raw live transport frame is only a wakeup unless the backend gives it
  durable/acknowledged stream semantics.

  The important application primitive is the **step checkpoint**, not only the queue. A task can be decomposed into
  ordered steps whose successful return values are retained; after a worker crash, lease expiry, or agent
  compaction/resume, the next attempt should read the completed checkpoint prefix and continue from the first
  missing step; later suffix checkpoints are rerun rather than reused, because they may have been computed from a
  stale or absent upstream value. Prefix reuse is replay-digest gated, so a step from a different run spec is not
  silently adopted. This applies equally to Nextflow-shaped compute stages, long API jobs, and agent turns. The
  first local dogfood is `test/absurd-queue-push-dogfood.test.ts`: attempt 1 records an `extract` step,
  its lease expires, attempt 2 reclaims the job, reuses that checkpoint without re-running it, records the
  `summarize` step, and completes through the same live-claim-gated ledger result/status slots. The repeated
  checkpoint pattern is now lifted into `runJobStepWithCheckpoint` / `recordJobStepCheckpoint` in
  `src/hosts/job-store.ts`: a caller-owned step
  id maps to an encoded `job:<runId>:step:<encodedStepId>` slot, the single-step helper reads that slot first, and
  the sequential helper reuses only the checkpoint prefix before recording fresh suffix checkpoints with the replay
  digest. This is the resume convention, not an orchestration engine.

  Do not add an Absurd type system to core. The core should expose the narrow structural contracts an Absurd-like
  backend needs to satisfy: replay spec in, async handle out, status/progress observations, checkpoint/event ids,
  CAS result/artifact handles, and terminal receipts. A ducknng-backed Absurd adapter can be a host package or
  example when real applications need it; if two implementations converge on the same checkpoint/event schema,
  then promote that schema into core.
- **Push wakeups are transport facts unless made durable.** Over a ducknng server, workers can use raw NNG
  `push/pull` for distribution and `pub/sub` or monitor/event streams for wakeups, but this backend still checks
  durable state before acting: queue rows are claimed, wakeup events/checkpoints are observations, and status/result
  land in `job:<runId>:status` / `job:<runId>:result`. `test/absurd-queue-push-dogfood.test.ts` demonstrates the
  narrow rule: a ducknng push frame references a recorded wakeup event and accelerates a worker, while an unrecorded
  frame does not create queue work. Over a DuckDB Quack server, the remote DB can be attached, queried, and written
  with DuckDB secret-backed auth, projection/filter pushdown, and transaction forwarding, but there is no visible
  push/notification surface in the local Quack tree. Treat Quack as an ergonomic server-backed `SqlConn` and pair it
  with ducknng or polling for wakeups until Quack grows a real notification stream.
- **NNG compute mode:** the pending mode is a `ComputeRunner` implementation under that generic lifecycle, not a
  new lifecycle: `nngComputeRunner` sends Arrow/file-artifact work to a remote or persistent worker, shared run
  directory/CAS, same receipts, same status/collect/cancel semantics. It should not become a separate
  reproducibility model.
- **Stateful kernels:** persistent Python/R/Julia sessions are useful for iteration, but they need explicit session
  handles, environment attestation, variable/artifact capture, and replay boundaries. A stateful REPL is a host
  service over the compute ports, not a reason to let ambient interpreter state leak into runs.
- **Conversation/run trace as substrate data:** chat threads, user/assistant turns, tool calls, code edits, images,
  plots, artifacts, approvals, and review labels are not UI logs. They are the audit trail and later
  training/evaluation corpus. The concrete input format is Pi's JSONL session log; public/redacted exports such as
  `pi-share-hf` are downstream JSONL views, not a replacement source of truth. The correct shape is a session
  ingester, not a new session table family: raw session JSONL goes to CAS; `session:`, `turn:`, `msg:`,
  `toolcall:`, `cas:`, and `run:` subjects plus edge-like
  observations express containment, input/output, calls, writes, citations, produced artifacts, and displayed
  graphics. Projection helpers can materialize timeline, tool-trajectory, artifact, graphic, and training-example
  views when a UI/export needs them, but the source of truth remains `bio_observations`.

  A chat turn has run anatomy but should not be recorded as a deterministic `RunObservation`: provider/model calls
  are host/model effects with live output, not `runBioQueryFromManifest` or `runBioOperationFromManifest` payloads.
  The turn records context/model/tool-registry/message digests and a live-source-style reproducibility verdict.
  Child scientific queries/operations it calls remain normal `run:<id>` facts with receipts/replay/CAS. The Pi
  extension now syncs persisted session JSONL at lifecycle boundaries and records controlled
  `toolcall:<id> executes run:<id>` / `run:<id> invoked_by toolcall:<id>` links for bio tools after confirming the
  target run fact exists. Do not reconstruct run links by scanning transcript text. Remaining work: add richer
  training-example projections and expand graphics metadata beyond embedded images to plots, reports, notebooks, and
  rendered scientific views.
- **DuckDB `VARIANT` fit for observation/session payloads:** keep `value_json` as the live ledger contract, but do
  not reduce `VARIANT` to a someday storage swap. The immediate fit is the export/training-corpus path: partitioned
  Parquet views can store payloads as typed `VARIANT` values and let DuckDB shred common fields, making agent
  trajectories, tool calls, graphics metadata, and later review labels columnar and pushdown-friendly. The live
  ledger should not migrate yet because the current Node API path does not cleanly materialize raw `VARIANT` values
  back into JS, and core helpers still assume JSON text for redaction, as-of projections, and CAS-root scans. Build
  export first; migrate the base ledger only after the round-trip path is ordinary.
- **Direct Pi-core use:** some projects may use the Pi agent loop directly with this library as tools/resources,
  rather than a separate application wrapper. The boundary to settle is which capabilities belong in Pi skills/tools
  versus manifests/operations that can run outside Pi.
- **Renderer/artifact surface:** proteins, molecules, alignments, genomic tracks, notebooks, figures, and PDFs need
  artifact handles plus provenance and optional renderers. The core should own handles/receipts, not UI widgets.
- **Reproducibility proof:** competitors can claim "fully reproducible" at the UX layer. Our stricter claim should
  be machine-checkable: replay spec + input/output digests + env attestation + graph-recorded conversation/tool
  provenance, with explicit `not_reproducible` when a live source is not pinned.
- **Ambitious application projects:** choose applications that force these contracts: one graph-heavy app, one
  connector-heavy app, one long-running compute app, one artifact/renderer-heavy app, and one chat-thread-as-graph
  app. Each should be allowed to fail the abstraction and feed back into the library only when it proves a missing
  primitive.

## Retrieval and semantic search

Settled direction: a **tiered retrieval ladder, cheapest deterministic tier first**. Search
returns *candidates (data)* that feed `decideGrounding` (rank, abstain below threshold, never invent a CURIE);
the engine is a swappable adapter. Climb a tier only when a real corpus/recall failure forces it.

- Tier 0, exact: SQL equality on label/exact-synonym (`statements`). Deterministic, offline. In place.
- Tier 1, lexical BM25: DuckDB FTS over labels/synonyms/notes/docs. In-DB, offline. Next real add (already
  planned for grounding misses).
- Tier 2, dense single-vector: DuckDB VSS (HNSW) over an embedding column for paraphrase recall. Still in-DB.
  Add only if Tier 1 recall is insufficient on a real corpus.
- Tier 3, late-interaction multivector ([ColBERT](https://github.com/stanford-futuredata/ColBERT) /
  [TACHIOM](https://github.com/TusKANNy/tachiom)-style): SOTA high-recall, but a large-corpus / research-grade
  runtime (TACHIOM exists to fix the k-means index bottleneck at ~600M-vector scale). Overkill
  for ontology grounding (MONDO ~25k, HPO ~17k, SO ~2k terms: tiny candidate spaces) and for our notes. If
  literature-scale retrieval ever forces it, it enters as an external retrieval service behind a resolver/HTTP
  boundary returning ranked candidates as data: never a multivector engine baked into core. Absorb the
  function (ranked candidates), not the runtime.

Tiers 0–2 live in the DuckDB substrate (SQL/FTS/VSS), consistent with graph-as-SQL; only Tier 3 goes external.

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
  - application-operation request generation
  - resource/CAS integrity
  - skill boundary rules
- Treat `validateReadOnlySelect()` as a preflight helper only. The eventual execution adapter must also use a genuinely read-only/scoped DuckDB connection or equivalent sandbox.

## Distributed CAS garbage collection (metadata-driven GC)

Two GCs ship, by safety regime:

- **Node-local** (`src/hosts/gc.ts`, `collectGarbage` default `casMode: "node-local"`): mark-and-sweep: CAS =
  heap, retained run receipts = roots, unreachable bytes swept. Correct when this process is the sole writer (a
  GC pass leaves no dangling pointers; the cross-db remote index is best-effort + subordinate to receipt roots).
- **Shared / distributed** (`src/hosts/cas-metadata.ts`): the metadata-driven GC. This is a library, so the
  advertised shared/cross-db CAS + the NNG/ducknng topologies must ship a *correct* shared GC, not a warning
  label: "no in-repo consumer" is the wrong test when downstream users are the consumers. `collectGarbage` with
  `casMode: "shared"` either delegates to this (when given a `metadata` authority) or fails closed (it refuses to
  sweep a shared CAS from an incomplete local root set).

The shared GC is our own substrate shape ([[semantic-sql-graph-substrate]]): roots are rows, GC is a SQL
anti-join, owned by a metadata authority that is just a DuckDB: local file or ducknng-served shared db, the same
SQL runs over either ([[duckdb-process-boundary-locking]]). Transport is orthogonal; correctness is SQL.

- `cas_object(algorithm, digest, size_bytes, state{committed|tombstoned|deleted}, committed_at, tombstoned_at)`
- `cas_ref(ref_id, ref_type{run|artifact|remote_index|fs_version|manual_pin}, algorithm, digest, expires_at)`: durable (or TTL'd) references = the root set as rows. `addCasRef` / `dropCasRefs`.
- `cas_lease(lease_id, holder, algorithm, digest, expires_at)`: in-flight reads/writes; the **reuse-race** fix.
  `withCasObject` acquires a lease, re-checks state, resurrects a tombstoned-but-unswept object (revive under the
  lease) or returns a clean miss on a deleted one. `minAgeMs`/grace is a fallback margin, not the mechanism.
- `gcMark` = tombstone committed objects past cutoff with no live ref and no live lease (returning the rows);
  `gcSweep` = after a grace, delete tombstoned bytes (`cas.remove`) + mark deleted; `gcMarkSweep` = both, one
  `minAgeMs` knob. State transitions, not "hope a local view is complete."

This subsumes the three shared-sweeper hazards: incomplete roots (→ `cas_ref` is the global root set), the
write/reuse race (→ `cas_lease` + `withCasObject`), and the remote-index race (→ the remote index becomes a
`cas_ref` of `ref_type='remote_index'`, leased while a 304-reuse is in flight). Tested deterministically over a
single in-memory DuckDB authority (`test/cas-metadata-gc.test.ts`), which exercises the exact SQL a
ducknng-served authority runs.

Run and artifact roots are wired into this path: `run-store` registers result/receipt/replay/run-object bytes as
`cas_object` rows and replaces durable `run:<id>` refs when `casMetadata` is supplied, while
`recordArtifactReference` can register an artifact `cas_ref` after the caller has written the bytes to the shared
CAS. Still open (integration, not core): resolvers taking a `withCasObject` lease around a cross-db `cas.pathFor`
reuse; a `gc_epoch` row + a published tombstone/delete event for cross-node observers; the
ducknng-served-authority dogfood script. A `utimes` LRU-touch on CAS hit is a cheap node-local nicety (cache
semantics, not a lease): only if a real workload wants it.

## Documentation cleanup

- Keep `docs/design.md` as the positive architecture note.
- Keep this file as the scratchpad for things to refine.
- When a refinement is resolved, move the stable decision into the appropriate design doc and delete the scratch item.
