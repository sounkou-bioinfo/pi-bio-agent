---
type: Reference
title: Design notes
description: "Read before changing core boundaries, adapters, storage, skills, or the harness-adaptation surface."
tags: [architecture, boundaries, adapters, harness]
---

# Design notes

`pi-bio-agent` should remain a lean, provider-agnostic substrate for biomedical agents. The core should define the durable primitives; adapters, operation packs, skills, and study notes compose those primitives for particular workflows.

## Main boundary

```text
Host surfaces
  Pi extension
  MCP server surface later
  CLI/service surface later

Core contracts
  BioToolSpec
  BioOperationSpec / operation descriptor
  ResourceHandle / BioResolverSpec / VirtualResourceSpec / CAS handle
  BioRunSpec / run record / events
  ontology and KG rows
  study notes / OKF-compatible bundles

Execution adapters
  restricted code runtime
  DuckDB read-only SQL
  HTTP / OpenAPI / GraphQL
  MCP transport
  shell / R / Python, where explicitly enabled

Storage/index adapters
  filesystem study bundles
  local CAS/cache
  DuckDB catalog, FTS, KG, ontology, run ledger
```

A Pi tool is a **host surface**, not the same kind of thing as HTTP, DuckDB, MCP, or code execution. The host surface exposes registered capabilities to the current agent. Execution adapters do the actual work behind the contracts.

### Core boundary

> Core may define **identities, schemas, registries, and validators**. It must **not** grow bespoke SQL
> builders (or equivalent hand-coded logic) for individual biomedical questions.

A per-question filter ("is this variant rare?", "is this consequence high-impact?") is the agent
composing SQL over a stable view, or **declarative data** — a predicate-registry entry, an ontology term
set, a study-note caveat, a generated view/operation spec — not a `frequencyPredicateSql()` in core.
The moment core answers a *question* instead of defining a *primitive*, it has reproduced ClawBio-style
skill sprawl in a different shape. (`variants.ts` was trimmed to variant identity for exactly this
reason; the question-level builders were removed.)

> **Pre-1.0 core has no compatibility promise.** Remove speculative types rather than maintain unclear
> abstractions — clarity over hodgepodge. Concrete biomedical behavior enters through operation/extension
> **manifests with tests**, never through convenience helpers in core. Keep only: (1) true primitives
> (identity, coordinates, CURIEs, content addresses); (2) contracts with real boundaries (`BioToolSpec`,
> `BioOperationSpec`, `ResourceHandle`, `BioRunSpec`, graph node/edge snapshot, study note); (3) adapters
> with tests (DuckDB sync/report, Pi extension, CLI, project helpers). Everything else is removed until a
> real consumer demands it.

**Real abstraction, not idealist abstraction** (this sharpens "until a real consumer demands it", which is too
crude). An abstraction may be built *ahead of any downstream consumer* when it is **immanent in the concrete** —
the expressed essence of ≥2–3 things already built and nameable. `duckdb.sql_materialize` qualified: it was
latent in `file_scan` + `read_bcf` + `http.get` (shared form = "materialize a table from a declared read"), so
building it was *revealing* a real general, not imagining one. An *idealist* abstraction is imagined a priori
from outside the work — a shape you can merely picture future things fitting (`ExecutionPolicy` hooks,
`validateSql` mode-enums, fast/CAS/airgapped "modes", a `process` transport with one instance). Those are the
sprawl to refuse. The discipline that stops "emergent" from becoming a loophole: **name the existing instances
the abstraction abstracts, never the future ones it might serve.**

### Powerful by default, host-controlled effects, provenance-aware not policy-obsessed

> **The library is a substrate + receipt system, not a network/filesystem sandbox.** Like Pi, it gives
> powerful local execution and leaves the *risk boundary* to the host/deployment — container, seccomp,
> Firecracker, the Pi runtime, corporate egress, or a user-supplied sandbox extension. DuckDB's replacement
> scans (`FROM 'x.parquet'`), httpfs remote reads, and extension autoloading are **features to ride, not
> threats to police**; fighting them with brittle SQL regexes is fighting the substrate.

What the library *does* enforce is **accountability, not access**: every answer-producing run records the query
that ran (a digest of the SQL **and** its bound params), the resources/sources it declared, the resolver
receipts, and the artifacts it produced.
`validateReadOnlySelect` is therefore **statement-class only** (one read-only `SELECT`/`WITH`, no writes/DDL —
because that is what an "operation" *is*), not an egress firewall. The **primary** network path is SQL-native:
`ducknng_ncurl_table` (a DuckDB table function) inside `duckdb.sql_materialize`, with the URL/headers/body
composed in SQL and the JSON parsed into a table — no TS resolver (the `ols4-grounding` GET and
`variant-annotation` POST examples). `http.get` (a TS resolver needing a host-supplied `fetch`) is the
**fallback** for a DuckDB build with no ducknng, plus the host-driven multi-request retry/fanout seam. Either
way network is a **host-injected capability** (`file_scan`/`read_bcf`/`sql_materialize` may read remote URIs if
the environment allows) — the host decides whether egress is possible, the library records that it happened. A
strict "no external I/O / CAS-snapshot-first" profile is an **optional host policy**, not the default stance.

**The host-control surface is the injected ports — not a separate hook framework.** Pi-agent-core makes
lifecycle hooks (before/after, context transforms) central, and that pattern is real — but in *our* shape it is
already spelled as dependency injection, so a second hook system would be sugar over composition we have. A
host that wants policy wraps the port it already supplies: decorate `SqlConn` and you have `validateSql` /
`beforeQuery` over every execution (a strict no-external-I/O profile is a ~5-line `SqlConn` decorator —
[`host-policy-via-ports.test.ts`](../test/host-policy-via-ports.test.ts) proves it enforces what the library
deliberately stopped enforcing); decorate a bound `BioResolverImpl` for `beforeResolve` / `afterResolve`;
`runOperation` returns `{run, result, receipts}`, so before/after the call *is* `beforeRun` / `afterRun`. An
explicit `ExecutionPolicy` facade earns its place only when a real host needs cross-cutting, phase-aware policy
across all resolves + SQL + runs at once that decorating individual ports cannot express cleanly — and then it
is a thin facade over those ports, with a named consumer, not a speculative interface.

## Integration surfaces

`pi-bio-agent` should not be Pi-only. Pi is the first and most important host adapter because it is where this package is used today, but the stable product is a small core library with multiple thin surfaces over the same registries.

Model-provider integration should use `pi-ai` and the Pi auth stack rather than bespoke provider code. If a surface needs model calls, it should resolve providers through `pi-ai` and credentials through Pi's modular model services: `ModelRegistry`, `AuthStorage`, OAuth helpers, and extension-level `registerProvider` when a provider must be added or overridden. The bio substrate should not grow its own model-provider registry, token store, or provider-specific fallback logic. `auth.json` remains one backend used by AuthStorage, not a bio-agent-owned file format.

Priority order:

1. **TypeScript library API** — importable core contracts, validators, registries, and adapters. This is the source of truth.
2. **Pi extension** — exposes registry inspection, study-note operations, skill drafting, SQL validation, and later operation execution inside Pi.
3. **CLI** — scriptable local entry point for validation, indexing, operation-pack testing, and resource/CAS utilities. CLI output should support `--json` for automation.
4. **JSON-RPC over stdio** — machine interface for editors, other agents, or wrappers that do not run inside Pi. Start with stdio rather than a daemon.
5. **MCP server surface** — optional later wrapper that projects selected BioToolSpecs/resources as MCP tools/resources. MCP is a transport, not the core architecture.

All surfaces should call the same internal functions. The CLI must not reimplement Pi logic; the Pi extension must not hide logic that the CLI/JSON-RPC cannot exercise. This keeps tests surface-independent.

Initial command/RPC families:

```text
registry.listToolSpecs
registry.resolveResource
registry.snapshot
registry.listDuckdbExtensions
spec.validateToolSpec
spec.validateDomainPackManifest
sql.validateReadOnlySelect
study.plan
study.writeNote
study.listNotes
study.readNote
skill.draft
resource.resolveMetadata
operation.describe
operation.dryRun
```

Execution that can reach the network, run code, or materialize data should remain opt-in and policy-explicit even in CLI/JSON-RPC mode.

## Pi coding-agent extension target

The Pi coding-agent extension is the first concrete integration target. It should prove that the substrate is useful inside a real agent loop without making Pi the only interface.

The extension should provide:

- **resource discovery** for project-local bio skills and study bundles
- **registry inspection** for BioToolSpecs, resolvers/resources, operation packs, DuckDB extensions, and ontology/KG contracts
- **validation tools** for specs, read-only SQL, resource handles, and operation descriptors
- **study tools** for planning, writing, listing, reading, and eventually indexing notes
- **skill drafting** for project-local procedural skills, with `/reload` as the activation boundary
- **progressive disclosure**: compact indexes first, full specs/notes/skills only on demand
- **dry-run tools** before execution: show request shape, cache key, provenance plan, and policy requirements

The Pi extension should avoid becoming a second core. Its tools should call shared library functions that are also callable from CLI and JSON-RPC. If a Pi tool contains substantial logic, that logic belongs in `src/` with tests. When the Pi extension needs model-provider access, it should use the `modelRegistry`/`AuthStorage` services provided by Pi's extension context or `pi.registerProvider(...)` for provider registration, not package-local credential machinery.

Initial Pi extension execution policy:

```text
safe by default:
  list / describe / validate / study / draft

explicit opt-in later:
  network operation execution
  code runtime execution
  resource materialization
  DuckDB query execution beyond validation
```

## HTTP/API integrations

Many biomedical APIs are mostly the same shape: HTTP or GraphQL plus a thin layer of biomedical semantics. OpenTargets, Monarch, Ensembl REST/VEP REST, BioThings, ClinVar-style APIs, and similar services should not each become bespoke framework code.

Target shape:

```text
BioOperationSpec
  id
  transport: duckdb.sql            # executable today; widen only when a transport ships with a runner
  input schema
  output schema / normalizer
  sql: { sqlTemplate, readOnly, requiredResources }   # the SQL returns the answer; counts are GROUP BY, not TS
  identifier namespaces
  cache key policy
  provenance policy

BioToolSpec
  biomedical meaning
  domains
  inputs/outputs/effects
  safety notes
  operation references
```

Then derive:

```text
BioOperationSpec
  -> typed operation client
  -> BioToolSpec surface
  -> BioResolverSpec/VirtualResourceSpec when it resolves content
  -> Pi/MCP/CLI host exposure
  -> tests and docs
```

The thin description is still valuable when it encodes identifier namespaces, provenance expectations, versioning, cache policy, query limits, and whether patient-specific data may be sent. It should not become hand-written client sprawl.

## Execution beyond SQL: shell, R, and workflows as process operations

A `duckdb.sql` operation is one transport. Long-running external work — a shell command, an `Rscript`, a
Nextflow/Snakemake pipeline, an alignment or a variant caller — enters the **same way the question always
does: as DATA, not a new TypeScript client.** A *process operation* declares a **command + inputs + declared
outputs + tool/version**; a host-bound **executor** runs it; the result is **artifacts** (files → CAS), a
streamed run record, and a receipt — not rows. Those artifacts re-enter as resolved resources for a downstream
`file_scan` / `sql_materialize` → SQL operation, so a pipeline is just `op → artifact → resource → op`: the
resource/artifact chain *is* the composition, no DAG engine required.

Three things keep this consistent with the rest of the substrate:

- **Invoke, don't reimplement.** A [Nextflow](https://www.nextflow.io)/[Snakemake](https://snakemake.github.io)
  run is a command that runs a DAG; an R analysis is
  `Rscript x.R`. We shell out, receipt it, and ingest the outputs — we never embed a workflow engine or an R
  runtime, exactly as we never embed an ontology runtime (we read its SQL) or a graph engine (we materialize
  closure). Absorb the function, not the runtime.
- **Host-bound and host-gated effects.** The executor is injected by the host (like `http.get`'s `fetch`), and
  whether shell/R/containers/SLURM are even possible — and any timeout, output cap, or egress — is the
  **host's sandbox decision** (container, namespace, seccomp, cluster). The library **records** what ran
  (command digest, tool + version, input handles, output CAS digests, exit code, duration); it does **not**
  impose the limits. Same posture as the network: accountability, not access control.
- **Long-running is already modeled.** `BioRunSpec.mode` is `inline | background | subagent | service | batch`
  and `BioRunRecord` streams `started → progress → checkpoint → completed/failed`. A six-hour job is a
  `background`/`batch` run whose record accrues progress + checkpoints and ends in output artifacts.
- **Out-of-process compute is BUILT (table-producing case).** The `process.compute` resolver
  (`src/duckdb/resolvers/process-compute.ts`) + the injected `ProcessRunner` port
  (`src/process/node-process-runner.ts`) already run an out-of-process child (R/Python/Go/shell) over Arrow IPC
  and materialize a TABLE — DuckDB → Arrow → child → Arrow → table — with a script-bytes provenance digest,
  detached process-group kill on timeout/abort, and fail-closed-without-runner (example
  `examples/process-compute`, tests `process-compute-example`/`process-compute-guards`). What is still missing is
  the *operation-level* artifact executor — the `process` **BioOperationTransport** that runs an argv command in
  a run dir, captures stdout/stderr/exit, and registers declared FILE outputs as CAS artifacts (the six-hour
  batch / Nextflow-Snakemake case). The compute pillar's table path exists; its long-running artifact path does not.

**One general backend, not a backend zoo.** When the first executor is built, it is `process` (run an argv
command in a run dir, capture stdout/stderr/exit, register declared outputs as artifacts). `Rscript`,
`python`, `nextflow`, `snakemake` are **argv presets over `process`** (`["Rscript", script, …]`,
`["nextflow", "run", …]`), *not* separate transports — exactly as `duckdb.sql_materialize` subsumed the
reader resolvers rather than spawning one per format. One backend per tool (`runDeseq2()`, `runGatk()`,
`runNextflowRnaseq()`) would recreate the skill/API sprawl the substrate exists to avoid; the tool-specific
part stays **manifest data** (command template, inputs, expected outputs, version probes, post-load SQL,
fixtures). A genuinely new *transport* (beyond `duckdb.sql` and `process`) is earned only when execution needs
semantics `process` cannot express — polling/resume/cancel of a remote job — and even then proven against ≥2
instances, not imagined.

**Discipline — do not build the transport ahead idealistically.** Speculative non-SQL transports were already
deleted once (http/graphql/mcp/local with no runner). The table-producing out-of-process case is now served by
the `process.compute` RESOLVER (above); the OPERATION-level `BioOperationTransport` stays `duckdb.sql` until a
real pipeline forces a `process` **transport** that captures FILE artifacts (e.g. a Snakemake/Nextflow step or a
DESeq2 run whose outputs are files, not a single table). A full `BioExecutionSpec` (a backend enum,
`container`/`env`/`resources`/`effects`/`capture` fields) is the *sketch of the destination*, not core surface —
add fields when an executor consumes them. CAS-of-bytes itself is **built** (`src/core/cas.ts` + `src/hosts/fs-cas.ts`,
proven by `http.get` byte-reuse across DBs in `test/http-cas-reuse.test.ts`); what that artifact transport still
needs is the wiring of a code op's FILE outputs INTO CAS — those bytes are exactly what CAS exists to address.

## Storage story

The storage model is layered. Core should store handles, indexes, facts, and provenance; it should not eagerly ingest every byte into a monolithic database.

### 1. Filesystem: human-editable knowledge and package assets

Use the filesystem for things humans and agents should be able to read, diff, and edit:

- repo docs and operation-pack docs
- skills (`SKILL.md`) as procedural playbooks
- study notes / OKF-style concepts
- generated examples and fixtures

Study bundles may be OKF-compatible markdown with frontmatter. DuckDB can index them, but the files remain the source of truth.

### 2. CAS/cache: immutable bytes and external snapshots

Materialized external content should use content-addressed storage when practical:

```text
cas/<algorithm>/<digest>
```

A `ResourceHandle` points to the digest and metadata. This is appropriate for downloaded API responses, reference snapshots, VCFs, tables, PDFs, ontology release files, and generated artifacts that need integrity/reproducibility.

CAS is not a consent or retention policy. Sensitive deployments can add deletion/retention policy in adapters. The single-user Pi substrate only needs the primitive.

### 3. Virtual resources: live or expensive data

Not everything should be materialized. A virtual handle records:

```text
resolver name + query + expected media type + provenance/freshness policy
```

Examples:

- query a local VEP cache
- read a genomic interval from a BGZF/tabix-backed source
- resolve an OpenTargets evidence query
- expose a DuckDB view over a Parquet or extension-backed dataset

Virtual handles must fail closed if no resolver is registered. Avoid global catch-all fallbacks that mask a missing or misrouted resolver.

### 4. DuckDB: query substrate, index, and graph projection

DuckDB is the default local analytical store:

- resource catalog and CAS index
- ontology terms, edges, mappings, term sets
- KG nodes/edges/observations/evidence
- operation/run ledger and provenance receipts
- FTS indexes over study notes, docs, operation descriptions, ontology labels/synonyms
- stable views over extension-backed data

DuckDB should hold hot structured facts and indexes. Large raw bytes stay in CAS/object storage or virtual resources unless there is a deliberate reason to import them.

#### The SemanticSQL shape: statements + `entailed_edge` (one substrate for graph, ontology, and scales)

The graph layer follows [SemanticSQL](https://github.com/INCATools/semantic-sql) (how Bioconductor's
[ontoProc2](https://github.com/vjcitn/ontoProc2) serves OBO ontologies): a tiny fixed relational shape, queried
by plain SQL, with no graph runtime.
Two tables carry it, and **the same shape serves imported ontologies and our own committed graph** —
distinguished only by scope:

- **`bio_edges(from_id, predicate, to_id, attrs, trust)`** — the statement/edge base (`subject=from_id,
  predicate, object=to_id`). Labels, synonyms, definitions, and relations are all just rows; the predicate is
  an open CURIE vocabulary (`rdfs:subClassOf`, `BFO:0000050` part_of, our own `references`/`measures`/…).
- **`entailed_edge(from_id, predicate, to_id)`** — the *precomputed transitive closure* over the transitive
  predicates (`materializeEntailedEdges(conn, transitivePredicates)`, a recursive CTE). With it,
  descendants / ancestors / subsumption / graph-walk are **one indexed JOIN**, no bespoke walker:
  `SELECT from_id FROM entailed_edge WHERE to_id = ? AND predicate = 'rdfs:subClassOf'`.

This makes **order the unifying idea, expressed as data and queried by SQL**, at three layers:

```text
analysis       operation SQL over resolver-materialized tables
total order    an ordinal scale = a ranked TermSet -> scale_members(scale_id, member_id, rank)
partial order  subsumption / graph = bio_edges + entailed_edge closure
```

A scale is a *total* order (`scale_members.rank`); an ontology or graph is a *partial* order (`entailed_edge`);
`decideGrounding` membership is unchanged — closure and rank are just another table/column. We absorb the
SemanticSQL *shape*, never a graph or ontology runtime.

**Grounding has two tiers.** A *projection* tier — deterministic, offline, fail-closed: cached CURIEs +
`entailed_edge` + FTS over labels/synonyms answer "text→CURIE (already known)" and "descendants of X" as pure
SQL. A *judgment* tier — `decideGrounding` over a fresh [OLS4](https://www.ebi.ac.uk/ols4)/search candidate
set, used only on a projection miss, which **abstains below threshold and never invents a CURIE**.

#### Resolved vs derived tables (and why only one kind carries a receipt)

Every table the operation SQL sees is one of two kinds, and the distinction *is* the provenance model:

- **Resolved** — produced by a resolver from an **external source** (`file_scan`, `sql_materialize`,
  `read_bcf`, `http.get`, an ingested ontology's `statements`/`bio_edges`). It touched the world, so it carries
  a **receipt** (resolver version, params digest, source snapshot).
- **Derived** — a **pure function of the program plus already-resolved tables** (`scale_members` from ordered
  TermSets, `entailed_edge` as the closure of `bio_edges`). It touched nothing external, so it carries **no
  receipt** — it is fully **recomputable** from the manifest + the resolved inputs, and that recomputability is
  its provenance.

The operation SQL does not care which it queries — that is the point. This is a real distinction *immanent in
what we built* (two derived tables already exist), and it earns documentation, not a `Projection` framework:
the two derivations share a lifecycle (runner materializes them, idempotent) but not a computation (recursive
closure vs flat rank insert), so unifying them in code would be the idealist move. (A process operation's
**output artifact** is a third kind — *produced*, CAS-addressed — which re-enters as a *resolved* resource
downstream.)

#### The substrate is a lazy, content-addressed evaluation graph

Seen from the R / [dbplyr](https://dbplyr.tidyverse.org) / [targets](https://docs.ropensci.org/targets/) world
(the latter's design rationale collected in [targeted-learning](https://github.com/mdsumner/targeted-learning)),
the whole design is **lazy evaluation**: a manifest is a *lazy expression*, a resource is a **thunk**
(`resolver + params` is a recipe for a table, not the table), and
`runQuery`/`runOperation` is the **force** — the `collect()` boundary that resolves the referenced thunks and
runs the SQL. Receipts (`paramsDigest` + source content digest) are **memoization keys**: a resource is a pure
function of its params plus source state, so an unchanged digest is a cache hit — which means **CAS is the memo
table**, not just storage. Derived tables are pure lazy derivations (recomputed from inputs, like a `mutate`),
which is precisely why they carry no receipt — `scale_members` is recomputed on every force (the runner
materializes it before the SQL), while `entailed_edge` is materialized on demand by `materializeEntailedEdges`
when a graph query needs it. Composition
(`op → artifact → resource → op`) is a lazy DAG — [targets](https://docs.ropensci.org/targets/) /
[Nextflow](https://www.nextflow.io)-shaped.

The discipline is the same as everywhere else: **the laziness lives in DATA** (the declared manifest/SQL is the
lazy expression), interpreted by thin TS. It is **dbplyr/targets, not [Effect-TS](https://effect.website) /
fp-ts** — pulling in a TS
lazy/effect monad would be the idealist move (a monad with no instances we need; the laziness is already in the
data). The frame makes the deferred work *obvious rather than invented*, and the first piece is now **built**:
**resolution memoization** (`src/duckdb/resolution-memo.ts`) — a per-table freshness token + stored receipt;
on re-resolve over a persistent `dbPath`, an unchanged token + a still-present table replays the receipt and
skips the work. `file_scan` opts in with `mtime+size`. It is correct, not a stale-cache footgun, because the
memo key is **content freshness, not the request** — params/URL is the *call*, not the *value*. The remaining
pieces land when a concrete re-run forces them: content-addressed byte storage (CAS) for cross-db reuse; remote
freshness via HTTP cache validation (ETag / Last-Modified, `If-None-Match` → `304`) once the `FetchLike` port
exposes headers; `sql_materialize` freshness over its `declaredSources`' mtimes. Derived tables (`scale_members`,
`entailed_edge`) are pure and trivially safe (recompute). Also pending: "as_of" as a graph parameter, and lazy
resolution forcing only the resources a query names.

### 5. Provenance graph: every claim has a source path

Every fact-like row should be able to answer:

- source system or file
- source version/date/hash
- operation or code that produced it
- parameters and query
- whether the fact is measured, imported, computed, attested, or model-suggested
- which prior fact/artifact it derives from or supersedes

This is essential for ACMG-style evidence, variant reanalysis, ontology grounding, and addenda.

### 6. Runtime artifacts and runs

Long-running or background work should write a run record:

```text
BioRunSpec -> BioRunRecord -> BioRunEvent[] -> BioArtifact[]
```

Artifacts are resources. A report, JSON evidence pack, SQL result, plot, or addendum should be registered with a handle and provenance rather than only pasted into chat.

## Skills: proper use

Skills are procedural memory, not primitives. They should say **when and how to compose capabilities**.

Good skills:

- rare-disease reanalysis addendum workflow
- ACMG evidence review workflow
- HPO phenotype grounding checklist
- VEP/local annotation workflow
- how to study a new biomedical API and promote stable notes

Bad skills:

- OpenTargets API client implementation
- Monarch request schema
- VEP REST transport details
- credential policy
- SQL guard implementation
- PHI authorization logic

If it is executable, security-sensitive, schema-bearing, or provenance-bearing, it belongs in specs/code/tests. If it is stable procedural guidance for the agent, it can be a skill.

Promotion path:

```text
raw source / API docs
  -> CAS/resource snapshot
  -> study note / OKF concept
  -> indexed study bundle
  -> operation spec or resolver/resource spec
  -> workflow skill only after repeated use stabilizes
```

## Harness adaptation

Extending the harness is core to the Pi lineage (packages, extensions, custom tools, skills, prompts,
provider registration, reload/install boundaries). `pi-bio-agent` inherits that but makes it
biomedical-safe and provenance-aware. The lineage is **agent-mediated extension through explicit harness
surfaces, not arbitrary self-mutation.** The invariant, which every surface must satisfy from the start
even before adaptation tooling exists:

> Safe adaptation is **declarative, validated, reversible, recorded, and never edits core in place.**
> The agent may *propose* an extension/spec/skill; tests and the `/reload`/install boundary decide
> whether it becomes real. Core updates happen through package/git, not self-modification.

Concretely: `declare → validate → test → record → activate → rollback`. Forbidden: editing core runtime
files in place, monkey-patching tools, silent behavior changes, hidden env/process activation. See
[`roadmap.md`](./roadmap.md#6-harness-adaptation-doctrine-mods-vs-hooks) for the full doctrine and the
graph model of harness state.

## Progressive disclosure

Context should carry compact indexes, not every body/schema/result:

- skill index -> read full skill on demand
- operation index -> describe operation/client on demand
- study index -> read selected note on demand
- graph shape -> query/walk selected parts
- large result -> artifact/resource handle plus compact summary

Do not solve context overload by hiding capabilities that the agent legitimately needs. Preserve capability, but make disclosure cheap and explicit.

## Long-running work

Core should define run contracts, not implement a bespoke subagent system. Execution can be delegated to Pi, `pi-subagents`, local workers, or external queues later.

Deep study workflows should produce durable artifacts:

- study notes / OKF bundle
- operation specs or resolver/resource specs
- validation fixtures
- summary/index files
- optional skill drafts

## Testing story

Keep tests deterministic and lean:

- TypeScript typecheck
- Node `node:test`
- temp DuckDB databases for storage/KG/index tests
- injected `fetch` or local HTTP servers for network tests
- no live provider/API dependency by default
- live integration tests only behind explicit command arguments or config objects; no hidden environment-flag activation

Test what matters:

- spec validation
- fail-closed resolver behavior
- read-only SQL guard
- operation request shape and error mapping
- cache/provenance receipts
- code runtime sandbox limits
- KG lineage/trust/as-of behavior
- skill boundaries and frontmatter
- synthetic biomedical workflow fixtures with no diagnosis claim

## Sources

External projects and references cited above, with URLs (cite sources as links, not bare prose):

- [SemanticSQL](https://github.com/INCATools/semantic-sql) — OBO ontologies as flat SQL (`statements` + `entailed_edge`); the graph shape we borrow.
- [ontoProc2](https://github.com/vjcitn/ontoProc2) — Bioconductor ontology access over SemanticSQL.
- [OLS4](https://www.ebi.ac.uk/ols4) (EBI Ontology Lookup Service) — fresh text→CURIE search (the grounding judgment tier).
- [MONDO](https://mondo.monarchinitiative.org), [HPO](https://hpo.jax.org), [Sequence Ontology](http://www.sequenceontology.org), [OBO Graphs](https://github.com/geneontology/obographs) — ontologies / interchange formats.
- [targets](https://docs.ropensci.org/targets/) + [targeted-learning](https://github.com/mdsumner/targeted-learning), [dbplyr](https://dbplyr.tidyverse.org) — the lazy / content-addressed evaluation precedents.
- [Effect-TS](https://effect.website) — typed effect system; we steal the discipline, not the monad.
- [Nextflow](https://www.nextflow.io), [Snakemake](https://snakemake.github.io) — workflow engines a `process` operation would invoke, not reimplement.
- [DuckDB](https://duckdb.org) + [DuckDB community extensions](https://community-extensions.duckdb.org) (incl. DuckHTS) — the execution substrate.
- [ColBERT](https://github.com/stanford-futuredata/ColBERT), [TACHIOM](https://github.com/TusKANNy/tachiom) — late-interaction retrieval (Tier 3; deferred).
- [Machine Studying](https://jacobxli.com/blog/2026/machine-studying/) — the studying/expertise-per-budget framing.
