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
- For architecture work, read `docs/design.md`, `docs/abstraction-derivation.md`, `docs/duckdb-substrate.md`, `docs/closes-over.md`, and `docs/refinments.md`.
- For memory, graph, and provenance work, read `docs/memory-and-knowledge-unification.md`, `docs/ontology-and-knowledge-graphs.md`, and `docs/concurrency.md`.
- For user-facing behavior, check both `README.Rmd` and the rendered `README.md`; keep them consistent when editing README prose.

## Avoid Docs Sprawl

- Do not add a new docs file unless no existing doc has the right ownership.
- Prefer updating an existing doc, shortening stale prose, or deleting duplicated claims over creating another note.
- If a new doc is truly needed, add frontmatter, link it from a relevant existing doc, and run `npm run docs:index`.
- Avoid dated status headings like `Implemented (date)`. Dates are fine for recorded-run evidence, release notes, or source-citation context; they are poor anchors for living design docs.
- Keep docs professional: no assistant mannerisms, no hype slogans, no all-caps emphasis, no private-review shorthand, and no claims stronger than the repo demonstrates.
- Treat external READMEs as positioning, not proof. When a reference informs architecture, read its code, tests, schemas, or specs and cite the implemented pattern rather than the marketing paragraph.

## Core Boundary

- `pi-bio-agent` is a library for agent-controlled scientific computation, not a collection of application packs.
- Core owns primitives, contracts, validators, registries, receipts, replay, CAS, graph/memory substrate, and host-injected effect ports.
- Application behavior belongs in application code: manifests, operation specs, producers, fixtures, adapters, host policy, and tests.
- Do not add per-question biomedical helpers to core. A question should become manifest data, SQL, a term set, an operation spec, or an adapter with tests.
- The library records and gates effects; it is not the sandbox. Network, filesystem, credentials, process isolation, and deployment policy are host responsibilities.
- Silent fallbacks are not acceptable here. If a resolver, extension, CAS, process runner, network capability, or graph feature is unavailable, fail clearly or record an explicit non-reproducible / unsupported reason.
- This is pre-1.0 library work with no obligation to preserve unclear legacy surfaces. Prefer clarity and deletion over backward-compatibility contortions.
- Prefer interfaces and dependency-injected host ports over config-file sprawl. New behavior should enter through typed contracts and explicit host composition, not ambient env flags or scattered JSON settings.

## Dogfood Rule

- The point of dogfooding is to reveal immanent primitives and exercise the library.
- A primitive is justified by concrete instances already in the repo, ideally two or three of them. Name those instances before adding the abstraction.
- Downstream applications should run through the substrate: manifest or operation spec -> resolver/adapter -> DuckDB table -> recorded run -> observations/receipts.
- If application code bypasses the runner, ledger, receipts, or CAS without a deliberate reason, call that out as integration debt.

## Surface Learned Lessons

- Hard-earned constraints must not live only in comments or tests. When code discovers a subtle boundary, lift it into the owning existing doc with links to the code and test that prove it.
- Keep these lessons especially visible: parser/AST-backed SQL validation and hermeticity, `duckdb.sql_materialize` as the general materialization primitive, ducknng `ncurl` fanout and retry semantics, RPC-backed shared state, CAS versus freshness, and process payload versus job lifecycle.
- Also surface graph-inference lessons: prompting over serialized graph context is the baseline to beat, not the design target. Code/SQL over graph tables is the preferred interaction mode, especially for long text, high-degree graphs, heterophily, partial labels, or noisy/missing structure.
- Prefer a short "lesson" paragraph in `docs/design.md`, `docs/refinments.md`, or the relevant example README over another standalone doc.
- If the lesson depends on a negative result, say that directly. Example: `ducknng_ncurl_table` is right for one response table; chunk fanout needs scalar AIO handles plus host orchestration today.

## Pillars And Compute Lifecycle

- The current pillars are data, network, compute, and knowledge/memory over DuckDB-centered provenance.
- Data: files, formats, table functions, and SQL materialization.
- Network: `ducknng_ncurl_table` and related primitives from the sibling `ducknng` extension when available; `http.get` is the host-injected fallback.
- Compute has two layers, not two separate worlds: `process.compute` describes the payload boundary for out-of-process work (Arrow/table input, file artifacts, env attestation), while `JobRunner` describes the durable async lifecycle (submit/status/collect/cancel through the ledger).
- All execution paths should be designed so they can be lifted into the durable async job shape from the beginning. A local immediate run is just the simplest host policy, not a different semantics.
- Gap to be explicit about: NNG can become a stateful compute/REPL lifecycle for non-DuckDB workers and interactive services. Do not pretend that is already a general operation transport; define it only when a real consumer exercises it.

## Checks

- Use `rg` for repo search.
- For docs changes, run `npm run docs:index` and `npm run check:docs`.
- For README tool-list changes, run `npm run check:readme-tools`.
- For code or manifest-contract changes, run `npm run typecheck` and focused tests; broaden to `npm test` when shared behavior changes.
- For repository reviews, use Pi as the local review pal instead of only self-review. Run it non-interactively with at least high thinking and a subscription-backed OpenAI Codex model, for example `pi --provider openai-codex --thinking high -p "<review prompt>"`. Do not use Anthropic for routine reviews unless explicitly requested; its billing path is different.
