# AGENTS.md

Instructions for coding agents working in this repository.

## Core Bets And Lineage

- This repository exists as a response to skill sprawl. The motivating ClawBio / ConversationalGenome exchange is concrete: a reasonable question like "how many rare high-impact variants are there?" failed until a new per-question skill was added. `pi-bio-agent` should make that class of work manifest + SQL over declared resources, not another bespoke skill every time.
- Metacurator is part of the lineage, not just a reference. Reading its code matters: deterministic stages produce identifiers, grounded terms, diffs, and reports; the `judge` boundary has exactly typed table-choice, column-mapping, and candidate-disambiguation calls. That sharpened the local pattern: use code/SQL/specs for mechanical work, let the model decide only where judgment is irreducible, and validate the typed output deterministically.
- The model is not the source of biomedical facts. The agent may route, compose, inspect schemas, write SQL, and ask for a typed judgment at the boundary; facts must come from declared resources, deterministic computation, receipts, and recorded approvals.
- Code is the interpreter and host boundary. Manifests, SQL, resources, ontology data, operation specs, and observations are the program. Add TypeScript only when it reveals a reusable primitive or adapter that existing examples already demand.
- In SQL we trust. DuckDB is the execution substrate for files, formats, joins, graph closure, HTTP-shaped data through ducknng, and exact reductions. The larger bet is the DuckDB ecosystem and its community extensions; `ducknng` is a sibling extension we maintain, so fixes should usually happen as PRs there rather than workaround code here. Prefer a query, table function, or extension over a new parser or prompt.
- Actions speak louder than prompts for graph work. The graph should be external, typed, queryable, and acted on by generated SQL/code; do not serialize large neighborhoods, ontology closures, memory graphs, or run ledgers into prompt text when a query over `bio_edges_as_of`, `entailed_edge`, or DuckDB tables can compute the answer.
- CAS and receipts are not optional polish. Runs must be explainable by content digests, resolver receipts, replay specs, and durable observations wherever the host supplies the store/CAS.
- SemanticSQL is the graph answer to skill sprawl: `bio_edges`, `bio_edges_as_of`, and `entailed_edge` make ontology traversal, facts, memory links, and domain relations queryable as one SQL graph instead of scattered tool logic.
- Reproducibility is a design constraint, not a tagline. Be honest about live sources, volatile functions, host-provisioned effects, and memoization eligibility.

## Start Here

- Read `docs/INDEX.md` before opening random docs. Use it to find the existing home for an idea.
- For architecture work, start with `docs/design.md`, the conceptual checksum. Then read only the focused document
  that owns the change: `docs/domain-model.md`, `docs/duckdb-substrate.md`, `docs/lineage.md`, or
  `docs/refinments.md`.
- For memory, graph, and provenance work, read `docs/memory-and-knowledge-unification.md`, `docs/ontology-and-knowledge-graphs.md`, and `docs/concurrency.md`.
- For user-facing behavior, check `README.qmd` and the rendered `README.md`; keep them consistent when editing README prose.

## Monorepo Layout And Boundary Discipline

- The repository root is the public `pi-bio-agent` package. `packages/workbench` is the first-party application
  package and `packages/quarto-engine` is the first-party rendering adapter in this same repository, each with its
  own manifests/code and tests. There is no second canonical workbench checkout or repository to keep in sync.
- Keep the package boundary real: the workbench consumes the root package surface, never `src/` internals. Its package
  metadata retains the GitHub package contract for external consumers; local lockstep development happens in this
  workspace and is not a reason to publish sibling filesystem paths or duplicate the core.
- Core owns reusable execution and evidence primitives. The workbench owns clinical composition and policy. If a
  workbench need is generic, stop and add the smallest tested primitive to core; if it is a domain choice, keep it in
  manifests, SQL, fixtures, or host composition. Do not hide a core gap behind an application helper.
- A broad application action catalog is not the same as skill sprawl. Biomni-like descriptors may be generated into
  application manifest/catalog relations and expose one stable operation per reusable method when the metadata and
  output contract support it. The anti-sprawl rule rejects handwritten per-question logic and duplicate runners; it
  does not reject a large composable action space or require an engineer to hand-author every generated manifest.
- Self-extension is allowed through durable specifications and artifacts: an actor may author a manifest, operation,
  compute program, action descriptor, or skill revision. The host must validate and test it, record implementation,
  input, and environment digests, and apply typed/human approval before activation. Do not let an agent silently
  mutate core executable code or host capabilities and call that self-extension.
- Do not add a second lifecycle, resolver, transport, graph model, auth layer, or schema merely because the first
  consumer finds the existing surface inconvenient. Name the concrete consumers, reconcile the contracts, then add
  one shared primitive with pattern and tests.
- `npm run check` checks core. `npm run check:all` checks core, workbench, and Quarto engine. Root CI is the canonical
  workspace gate; do not add nested package workflows.
- npm scripts are a flat namespace; the existing `check:`, `build:`, `readme:`, `provision:`, `install:`, and
  `pattern:` prefixes are sufficient grouping. Keep one parameterized installer (`npm run install:skill -- --host …`)
  rather than adding an alias for every host.

## Avoid Docs Sprawl

- Do not add a new docs file unless no existing doc has the right ownership.
- Prefer updating an existing doc, shortening stale prose, or deleting duplicated claims over creating another note.
- If a new doc is truly needed, add frontmatter, link it from a relevant existing doc, and run `npm run docs:index`.
- Avoid dated status headings like `Implemented (date)`. Dates are fine for recorded-run evidence, release notes, or source-citation context; they are poor anchors for living design docs.
- Keep docs professional: no assistant mannerisms, no hype slogans, no all-caps emphasis, no private-review shorthand, and no claims stronger than the repo demonstrates.
- Treat external READMEs as positioning, not proof. When a reference informs architecture, read its code, tests, schemas, or specs and cite the implemented pattern rather than the marketing paragraph.

## Executable Documentation

- Documentation is a woven view of executable source, not a second implementation. A user-facing workflow claim must
  point to a test, script, manifest, operation, or generated example that exercises it.
- `README.qmd` is the executable README source and `README.md` is its generated artifact. Example READMEs and tool
  inventories follow the same source/generator/check pattern; do not hand-edit their output.
- Treat pattern literate docs as generated artifacts: `examples/patterns/*.md` are sourced from sibling
  `examples/patterns/*.qmd` files. Edit the `.qmd` source. `npm run patterns:qmd` regenerates deterministic documents;
  credentialed live-agent QMDs are deliberately skipped there and rendered by their dedicated `npm run pattern:*`
  command, which must commit the resulting Markdown evidence.
- Put logic used only by an executable document directly in its QMD. Keep code in `scripts/` only when it is a shared
  executable or a stable non-Quarto entry point, and expose runnable patterns through `npm run pattern:*` in prose and
  tables. A wrapper must not exist merely to keep the real implementation outside the literate source.
- The workspace-level `pi-bio` Quarto engine is the persistent local Node/TypeScript execution surface. It may call
  the existing CLI/SDK and host ports; it must not implement a second scientific runtime, ledger, CAS, or compute
  lifecycle. R, Python, and shell cells are explicit host processes.
- A `text` fence or explicitly labeled pseudocode/diagram is illustrative. A `ts`, `sql`, or `sh` block should be
  runnable or included from the source that the checks execute. Never paste live JSON/results into docs when a renderer
  or example generator can produce them.

## Core Boundary

- `pi-bio-agent` is a library for agent-controlled scientific computation, not a collection of application packs.
- Core owns primitives, contracts, validators, registries, receipts, replay, CAS, graph/memory substrate, and host-injected effect ports.
- Application behavior belongs in application code: manifests, operation specs, producers, fixtures, adapters, host policy, and tests.
- Do not add per-question biomedical helpers to core. A question should become manifest data, SQL, a term set, an operation spec, or an adapter with tests.
- The library records and gates effects; it is not the sandbox. Network, filesystem, credentials, process isolation, and deployment policy are host responsibilities.
- If a downstream application needs a real VM boundary, use a host-level microVM control plane such as Gondolin and inject only the approved ports. Do not turn core SQL validation into a sandbox story.
- Silent fallbacks are not acceptable here. If a resolver, extension, CAS, compute runner, network capability, or graph feature is unavailable, fail clearly or record an explicit non-reproducible / unsupported reason.
- This is pre-1.0 library work with no obligation to preserve unclear legacy surfaces. Prefer clarity and deletion over backward-compatibility contortions.
- Prefer interfaces and dependency-injected host ports over config-file sprawl. New behavior should enter through typed contracts and explicit host composition, not ambient env flags or scattered JSON settings.

## Pattern Rule

- The point of pattern-based proofing is to reveal immanent primitives and exercise the library.
- Applications are the primary pressure surface. Express a need downstream first, observe the same motion in another
  application or generic pattern, reconcile it with existing contracts, then promote the smallest policy-free
  primitive to core. Move both consumers back to the public surface and delete their workarounds.
- A primitive is justified by concrete instances already in the repo, ideally two or three of them. Name those instances before adding the abstraction.
- When two abstractions appear to conflict, reconcile them before adding another surface. Start from concrete cases,
  find the shared motion, delete or collapse the weaker boundary, and document the resulting primitive. Do not
  paper over contradictions with overlay types or compatibility shims.
- Downstream applications should run through the substrate: manifest or operation spec -> resolver/adapter -> DuckDB table -> recorded run -> observations/receipts.
- If application code bypasses the runner, ledger, receipts, or CAS without a deliberate reason, call that out as integration debt.

## Surface Learned Lessons

- Hard-earned constraints must not live only in comments or tests. When code discovers a subtle boundary, lift it into the owning existing doc with links to the code and test that prove it.
- Keep these lessons especially visible: parser/AST-backed SQL validation and hermeticity, `duckdb.sql_materialize` as the general materialization primitive, ducknng `ncurl` fanout and retry semantics, RPC-backed shared state, CAS versus freshness, and async compute durability versus receipt/CAS evidence.
- Also surface graph-inference lessons: prompting over serialized graph context is the baseline to beat, not the design target. Code/SQL over graph tables is the preferred interaction mode, especially for long text, high-degree graphs, heterophily, partial labels, or noisy/missing structure.
- Prefer a short "lesson" paragraph in `docs/design.md`, `docs/refinments.md`, or the relevant example README over another standalone doc.
- If the lesson depends on a negative result, say that directly. Example: `ducknng_ncurl_table` is right for one response table; chunk fanout needs scalar AIO handles plus host orchestration today.

### DuckNNG is already the network substrate

Do not rediscover this from the one-request connector examples. The maintained DuckNNG surface is already a
SQL-visible async transport and the core has its generic composition:

- `ducknng_ncurl_table` is the one-request, dynamic-schema path for REST, GraphQL, JSON, CSV, and similar body
  reads. Compose URL/body in SQL and let the operation normalize the returned relation.
- `ducknng_ncurl_aio` is the scalar per-row launcher. `ducknng_ncurl_aio_collect` is an any-ready collector, not
  a wait-for-all barrier; `ducknng_aio_cancel` and `ducknng_aio_drop` are required lifecycle operations.
- `src/duckdb/ncurl-fanout.ts` is the reusable bounded batch composition: it launches waves, drains every handle,
  retries transport/429/5xx outcomes, reports permanent failures, and cancels/drops unfinished handles. It is not
  a VEP client. `src/duckdb/ncurl-retry.ts` is the separate single-endpoint SQL-native retry path over the owned
  volatile `ducknng` scalar.
- TLS does not require a filesystem CA assumption. `ducknng_tls_config_from_pem(NULL, NULL, NULL, '', 1)` creates
  a client TLS handle from the runtime's trust configuration; `ducknng_self_signed_tls_config` creates in-memory
  development material. File-backed TLS is an explicit alternative, not the default architecture.
- Credentialed SQL HTTP uses a host-commissioned DuckNNG profile. SQL supplies only the non-secret profile id;
  DuckNNG injects the scoped header and the host records the redacted profile receipt. Never put tokens in a
  manifest or invent an API-specific auth client.

The proof is executable: `test/ncurl-fanout.test.ts` drives deterministic transient failures and cancellation;
`examples/wgs-chr22-annotation/live.mjs` runs indexed DuckHTS -> chunked VEP -> DuckNNG fanout -> SQL reduction
against live sources; `test/ducknng-sql-http.test.ts` covers SQL HTTP/session behavior; the DuckNNG repository owns
the AIO, TLS, profile, and RPC implementations. A downstream application must compose these surfaces before adding
TypeScript. If the application cannot express its transport as declared batch SQL plus this generic fanout, record
the missing core contract and promote only that contract, not an application-specific client.

## Do Not Re-Derive Proven Capabilities

- Before proposing a new HTTP batching, retry, or rate-limit abstraction, inspect the existing implementation and
  pattern. `src/duckdb/ncurl-fanout.ts` owns bounded multi-batch AIO launch/drain/retry;
  `src/duckdb/ncurl-retry.ts` owns single-endpoint SQL-native retry; and
  `src/duckdb/resolvers/http-policies.ts` owns host-fetch `429`/`503`, `Retry-After`, capped backoff, and
  cancellation. Their tests exercise transient and permanent failures.
- `examples/wgs-chr22-annotation/live.mjs` already proves the real online-annotation path: an indexed `duckhts`
  region read, Ensembl VEP `/region` batches of at most 200 variants, bounded `ncurlFanout`, response parsing,
  ClinVar joining, and SQL reduction. `examples/patterns/pipeline-fanout.qmd` separately proves the bounded worker-pool
  topology. Reuse and generalize this path; do not reopen whether an agent can execute rate-limited VEP calls.
- Narrative-to-ontology grounding does not require a phenotype-mapper service or another mandatory package.
  SemanticSQL-generated label/synonym views, DuckDB FTS or ordinary SQL, graph projection/closure, candidate
  `TermSet`s, `decideGrounding`, and the host agent loop already compose the path from text to validated CURIEs.
  External grounding packages may be benchmarks or optional providers only when a measured case demonstrates a
  retrieval/reranking gap; do not add one to the baseline architecture by association.
- Consumers and hosts should coordinate through durable relations, CAS references, checkpoints, and observations.
  Prose handoffs may explain work, but they are not the scientific state and must not become the only record of a
  source, result, or judgment.

## Pillars And Compute Lifecycle

- The current pillars are data, network, compute, and knowledge/memory over DuckDB-centered provenance.
- Data: files, formats, table functions, and SQL materialization.
- Network: DuckNNG's SQL-native `ncurl_table`/AIO/profile/TLS surfaces when provisioned; `ncurlFanout` and
  `ncurlRetry` provide the bounded multi-request and single-request compositions. `http.get` is the host-injected
  JS-fetch fallback, not a reason to duplicate DuckNNG in an application.
- Compute is async from the bottom: `ComputeRunner` is `submit/status/collect/cancel`, future-shaped like
  nanonext/mirai/future. A local child process, an NNG worker, a scheduler, an Absurd-style durable queue, and a
  stateful REPL/session are implementations of that one lifecycle.
- A stateful Python/R or other scientific kernel is a valid compute profile. NNG transport through nanonext, pynng, or
  another client is straightforward; the substantive contract is ordered session evaluation, restart/failure
  semantics, environment and capability evidence, artifact capture, and checkpoint/snapshot policy. Keep the first
  implementation host/application-owned and promote the smallest session contract after a second concrete consumer
  demonstrates the same motion.
- `compute.run` is the current manifest resolver that materializes one compute result into DuckDB tables/artifacts.
  It consumes the async runner by submitting and then collecting because table materialization needs the value.
- The durable run queue/ledger is a run-specialized `AsyncRunner` backend over replay specs, not a second compute
  lifecycle. Integrate queue/checkpoint systems through that shape.
- For workflow-style applications, preserve the task -> step -> checkpoint distinction. A completed step result is
  durable state; code outside a step may replay after crash, compaction, or lease expiry. Model resume by reading
  completed checkpoints and continuing from the first missing step, not by adding another workflow engine to core.

## Checks

- Use `rg` for repo search.
- For docs changes, run `npm run docs:index` and `npm run check:docs`.
- For README tool-list changes, run `npm run check:readme-tools`.
- For code or manifest-contract changes, run `npm run typecheck` and focused tests; broaden to `npm test` when shared behavior changes.
- For repository reviews, use Pi as the local review pal instead of only self-review. Use a reusable review session instead of one-off/no-session runs: `pi --model openai-codex/gpt-5.3-codex-spark --thinking high --tools read,grep,find,ls,bash --session-id pi-pal-review -p "<review prompt>"`. Reuse the same `--session-id` across related review passes so the reviewer carries local context. Do not use Anthropic for routine reviews unless explicitly requested; its billing path is different.
- When a review session gets large, stale, or crosses topics, run an explicit compaction turn before continuing: `pi --model openai-codex/gpt-5.3-codex-spark --thinking high --tools read,grep,find,ls,bash --session-id pi-pal-review -p "Compact this review session into durable notes: repo invariants, commands run, open findings, false positives, and next checks. Keep only facts needed for future review passes."` Then continue with the same session or start a dated `--session-id` seeded from that compacted summary.
- `NEWS.md` is not currently populated by build or check scripts. Update it manually when you want a release-note artifact.
