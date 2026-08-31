# AGENTS.md

Instructions for coding agents working in this repository.

## Start here

- Read `docs/INDEX.md` before opening unrelated design notes.
- Read `docs/design.md` before changing a shared boundary. Use the focused document that owns the mechanism:
  `docs/domain-model.md`, `docs/duckdb-substrate.md`, `docs/concurrency.md`,
  `docs/memory-and-knowledge-unification.md`, `docs/ontology-and-knowledge-graphs.md`,
  `docs/resources-and-tool-specs.md`, or `docs/roadmap.md`.
- `README.qmd` is the README source. `README.md` is generated.
- The root package is the public SDK. `packages/workbench` is the first-party application and
  `packages/quarto-engine` is a rendering adapter. Downstream packages consume public exports, not `src/` internals.

## Architectural rules

- Biomedical facts come from declared data, deterministic computation, resolver receipts, or recorded approval.
  A model may inspect, compose, explain, propose, and abstain; it is not a fact source.
- Manifests, scientific resources, SQL, term sets, and observations are the program. TypeScript, R, and other hosts
  interpret them and bind capabilities. Do not add question-specific biomedical logic to core.
- DuckDB is the common scientific work surface for files, extension table functions, remote responses, graph
  relations, observations, and reductions. Prefer SQL, a table function, or an existing extension over another parser
  or source-specific client.
- The durable control plane is relational but backend-aware. SQLite, PostgreSQL, embedded DuckDB, and a server-owned
  DuckDB/Quack lane may implement one logical protocol; never assume generic SQL text erases their transaction and
  writer semantics.
- Network, process execution, credentials, extension provisioning, clocks, filesystem policy, resource discovery,
  process containment, and deployment isolation belong to the host. Missing capabilities fail clearly; there are no
  silent fallbacks.
- Read-only SQL validation is not a sandbox. Strong isolation is a host responsibility.
- Runs remain explainable through intent, plan, declarations, receipts, replay material, CAS references, environment
  evidence, allocation history, and temporal observations whenever the host supplies those facilities.
- CAS proves byte identity, not freshness or scientific truth. Live sources and volatile functions remain visibly
  non-reproducible unless their relevant inputs and environment are pinned.
- `bio_observations` is the append-only temporal source for memory, facts, runs, jobs, approvals, control intents,
  decisions, and links. Graph tables, current-state views, note files, and situation snapshots are projections, not
  competing stores.
- Operational queue, attempt, pool, and allocation tables are mutable coordination indexes. They do not become a
  second audit ledger.
- Query graph and control data with SQL or generated code. Do not serialize large graph neighborhoods, logs, or
  ledgers into prompts.
- Keep judgment narrow and typed. Mechanical parsing, mapping, scoring, transition validation, and diffing stay in
  code or SQL; ambiguous choices are validated against explicit candidates and may abstain.

## Agent-native legibility

- Treat the system as one linked world model, not a bag of tools. Declarations, intent, plan, run, attempt, allocation,
  artifact, observation, and promotion must be connected by stable handles and digests.
- Every public control action returns the affected handles, observed timestamp/state, structured reason codes,
  explicit detail references, and legal next actions where applicable.
- Do not make an agent infer state from prose logs. Normalize common blocked and failure conditions into stable codes;
  retain raw logs by reference.
- Use progressive disclosure: compact bounded summaries first, exact relational/CAS detail on demand. Never silently
  truncate or replace the complete scientific result.
- Record requested control separately from observed effect. `cancel requested` is not `cancelled`; resource release
  follows executor-confirmed stop or a host fencing guarantee.
- Fence every attempt-scoped write. A stale worker may not heartbeat, checkpoint, publish, finish, or release another
  attempt's allocation.
- Keep scientific resources, simultaneous capacity, cumulative budgets, placement constraints, priority, and
  capability grants as distinct concepts. Do not overload `ResourceHandle` with scheduler semantics.
- A plan is a compiled, content-addressed read model over existing primitives. It is not another workflow language or
  lifecycle.
- A situation snapshot is a projection over current stores. It must not become a second persistence layer.
- Push/SSE/NNG/notifications may wake clients, but durable cursors and relational state close gaps and remain truth.
- Decision receipts record objective, action, evidence refs, constraints, expected cost, and actor. They are concise
  audit summaries, not hidden chain-of-thought.
- Self-extension means proposing a validated manifest, operation, compute program, migration, or skill revision with
  replay/regression evidence and approval. It never silently changes core, policy, facts, or permissions.

## Agent operating discipline

- Begin stateful work with one bounded situation snapshot or set-oriented describe call. Do not reconstruct the
  current world from unrelated logs or broad repository reads when a stable handle or projection exists.
- Externalize the objective, success criteria, assumptions, evidence requirements, unknowns, budgets, and invalidation
  conditions before committing expensive or irreversible work. Assumptions are never facts.
- Reject plans that violate hard constraints. Among valid plans, reuse exact results/checkpoints first, then prefer
  selective reversible actions with high expected information gain per cost.
- Batch independent inspections and relational queries. Avoid N+1 tool calls and repeated full-state polling; use
  cursors and deltas.
- Reconcile predicted cost/evidence with observed receipts after execution. Record concise decision receipts and
  stable references, never private chain-of-thought.
- After repeated successful ad-hoc work, propose a versioned operation with fixtures, replay/regression evidence, and
  approval instead of rediscovering the method in every session.

## Change admission

- Express a need in an application or executable pattern first. Promote a shared primitive only after at least two
  concrete uses repeat the same mechanism and existing public surfaces cannot express it cleanly.
- Do not add a second runner, queue, cache, ledger, graph model, resolver lifecycle, transport lifecycle, auth layer,
  situation store, or workflow DSL to avoid using the existing one. Reconcile or delete the weaker boundary.
- A new scientific question should normally require schema inspection and SQL, not a new helper or skill.
- A new source or format belongs in a resolver or DuckDB extension. A new analysis belongs in SQL or a declared
  operation. A new execution/database backend implements the existing injected ports or durable-control protocol.
- Applications own domain policy, rankings, review packets, UI workflow, and source-specific product behavior.
  Core owns reusable execution, evidence, replay, temporal, and graph primitives.
- Resource-aware scheduling, database migrations, and process enforcement remain host/control-adapter concerns unless
  repeated consumers expose a smaller policy-free core contract.
- Pi-specific session control and dynamic-tool behavior stay in the Pi adapter. Promote host-neutral control behavior
  only when another stateful host, such as the R client, repeats it.
- `WorkbenchAddon` is an application-level API/browser pairing, not a general plugin marketplace or storage system.
- Do not preserve speculative architecture in living docs. Unimplemented work needs a named consumer, failing test,
  executable proof, or explicit roadmap milestone.

## Documentation

- Update the existing owning document. Delete duplicate or stale prose instead of adding another note.
- Living design docs describe implemented behavior, active boundaries, and demonstrated gaps. They are not feature
  inventories, work diaries, or holding areas for stalled ideas.
- Claims about behavior must point to code, a test, an executable QMD, a backend conformance fixture, or a recorded
  application run. State explicitly when an example proves mechanics rather than scientific or deployment validity.
- Edit generated sources rather than outputs: `README.qmd` for `README.md`, and `examples/patterns/*.qmd` for generated
  pattern Markdown.
- A `ts`, `sql`, `r`, or `sh` block should run or be included from executed source. Use `text` for pseudocode.
- Keep prose direct. Remove assistant mannerisms, private-review shorthand, hype, repeated doctrine, and versioned
  implementation anecdotes from canonical design documents.
- New docs require frontmatter, an owning link, and regeneration of the docs index. Do not hand-edit generated indexes.

## Implementation discipline

- Prefer explicit interfaces and injected ports over ambient globals and scattered environment switches.
- Preserve package boundaries. Do not hide a missing core primitive behind an application copy.
- Preserve failure evidence. A run that started and failed remains auditable; preflight errors must not masquerade as
  scientific runs.
- Keep large data, graphs, control history, plans, logs, and artifacts in relations or CAS. Prompt and UI truncation
  are presentation choices, not changes to the scientific result.
- Claims and capacity allocations must be atomic within the owning backend transaction. Never hold a database
  transaction open while user computation runs.
- Heartbeats are independent of checkpoints. Claim loss aborts or fences the executor before the allocation is
  released.
- Backend-specific SQL is acceptable when it is the smallest correct implementation of the shared conformance
  contract. Do not pursue false portability through least-common-denominator SQL.
- The pure-R implementation is a reference host/control adapter. It does not make database engines pure R and does not
  move DBI, processx/callr/mirai, Slurm, cgroups, or Windows Job Objects into core.
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
- Durable-control changes require deterministic-clock, stale-write, claim-race, allocation, cancellation, and
  cross-backend conformance tests.
- `NEWS.md` is maintained manually and should record shipped behavior, not design speculation.
