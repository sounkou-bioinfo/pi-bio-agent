---
type: Reference
title: Design notes
description: "Read before changing core boundaries, adapters, storage, skills, or the harness-adaptation surface."
tags: [architecture, boundaries, adapters, harness]
---

# Design notes

`pi-bio-agent` should remain a lean, provider-agnostic library for agent-controlled scientific computation, with
biomedical workflows as the first domain. The core should define durable primitives; application code, adapters,
operations, skills, and study notes compose those primitives for particular workflows.

## Architecture bets

1. **The manifest is the program; TypeScript is the interpreter.** Manifests, SQL, resources, and ontology data
   are the program; core is a small set of generic primitives that runs them. A new question or data source is a
   new application-owned manifest or operation spec, not a new core file. If a question needs bespoke TypeScript instead of a
   manifest, SQL, or adapter, the design has failed at its own boundary and should be redesigned as data.

2. **In SQL we trust: four legs on one DuckDB substrate.**
   - **Data**: files and formats as SQL (`file_scan`, `duckhts` for VCF/BAM/BED/…). The bet includes the large DuckDB community extension ecosystem: new formats should usually arrive as extensions/table functions, not bespoke framework parsers.
   - **Network**: HTTP, cross-process shared state, and multi-agent coordination as SQL, via **ducknng**:
     `ncurl_table` (HTTP is a table function), `run_rpc` (a live shared mutable DB many processes write through),
     and NNG topologies (pub/sub, push/pull, survey, bus, pair). ducknng is the DuckDB extension that carries the
     network/RPC/topology leg.
   - **Compute (code execution)**: code SQL is poor at (an `lm()` fit, an R/Python/Go tool) runs **out-of-process over Arrow IPC** (`process.compute`); only the data contract is SQL/Arrow, the computation is a contained child. The payload contract and lifecycle contract are layered: local immediate execution and durable async jobs share replay/receipt semantics.
   - **Knowledge + memory**: ontologies and our own KG share one shape (`bio_edges` + `entailed_edge` closure, from SemanticSQL); grounding is deterministic-SQL-first with fail-closed model fallback. **Memory is machine studying**: the agent studies a corpus before a task is known and retains expertise as *study notes* projected into the KG: data it queries, distinct from *skills* (activated behavior) and *facts* (measured, tool-derived).

3. **The discipline that keeps the bet honest.** Interfaces are the contract for in-process code; DI injects host
   **effects** (SQL conn, fetch, ProcessRunner, CAS), which **fail closed** when unbound. Identity is a **digest**;
   a human `version` is only a label; a `schema`/`.v1` tag lives only where bytes cross a real serialization/IPC
   boundary, never on every nested value. Manifests pass a **strict allowlist** so removed surface cannot ride
   back as inert keys. The **judgment / approval decision** (model or human) is the one irreducible boundary: the
   substrate records and gates it, never computes it.

4. **Actions over prompts for graph inference.** The ICLR 2026 study
   ["Actions Speak Louder than Prompts"](https://arxiv.org/abs/2509.18487) is directly aligned with the
   substrate bet: LLMs do better on text-rich graph inference when they generate executable code over graph state
   than when graph neighborhoods are serialized into a prompt. That is exactly this repo's graph posture:
   keep nodes, edges, labels, memory, and provenance in DuckDB/SemanticSQL/CAS, then let the agent write bounded
   SQL or host-approved code to inspect them. Prompt text is for intent and judgment boundaries, not for carrying
   high-degree neighborhoods, long features, ontology closures, or the run ledger.

5. **Metacurator's determinism gradient closes over the same shape.** Its implementation splits publication
   metadata curation into deterministic tools for lookup, archive, acquire, table loading, ontology grounding,
   diffing, and reporting, plus a narrow `judge` boundary for table classification, schema mapping, and ontology
   disambiguation. The code-level contract is the important part: models do not mint identifiers or values; they
   emit typed choices that deterministic code validates, applies, records, or rejects. That reconciles with this
   library without adding a new primitive: deterministic work is resolver/materialization/SQL, while the
   irreducible model call is a typed judgment recorded and validated by the substrate.

## Hard-Learned Lessons

These are not slogans; they are constraints learned in implementation and tests. Keep them visible when changing
the related code.

- **SQL safety needs parser help, but is still only statement-class safety.** The string guard rejects obvious
  writes and stacked statements; DuckDB's `json_serialize_sql` catches dynamic SQL calls like
  `query()` / `query_table()` across quoted and qualified spellings. This protects the operation boundary, not
  host egress or filesystem access. See `src/core/sql-guard.ts`, `src/core/operations.ts`,
  `src/duckdb/resolvers/duckdb-sql-materialize.ts`, and `test/operations-readonly.test.ts`.
- **Memoization is proven from plans and ASTs, not from resolver names.** A run is cacheable only when the physical
  plan reads resolved tables or pure sources and the AST avoids volatile/consistent-within-query functions. Table
  functions, replacement scans, live sources, or introspection drift fail closed. See
  `src/duckdb/plan-hermeticity.ts`, `src/hosts/run-store.ts`, `test/plan-hermeticity.test.ts`, and
  `test/action-cache.test.ts`.
- **`duckdb.sql_materialize` is the materialization primitive.** It generalized `file_scan`, `read_bcf`, and
  HTTP-shaped resources into "declared read -> table"; it is not a generic escape hatch for writes. See
  `src/duckdb/resolvers/duckdb-sql-materialize.ts` and `test/duckdb-sql-materialize.test.ts`.
- **Graph inference should be graph-as-SQL/code, not graph-as-prompt.** Prompting can work when the relevant
  neighborhood is small enough to fit in context, but long text, high degree, noisy structure, and partial labels
  favor generated code over typed graph state. For this repo, the generated program should usually be SQL over
  `bio_edges_as_of`, `entailed_edge`, resolver-materialized tables, and run/memory observations. This is why the
  graph substrate must stay queryable and receipted instead of becoming prose context.
- **A typed judgment boundary is the model's proper home.** Metacurator's `judge` shape is a useful constraint:
  table choice, column mapping, candidate disambiguation, and clinical interpretation may need judgment, but the
  model emits typed objects from bounded candidates and deterministic code validates, applies, records, or rejects
  them. Its grounding path performs lookup, round-trip confirmation, branch checks, and obsolete checks before a
  candidate can be chosen. Do not let a model invent identifiers or silently mutate tables.
- **ducknng HTTP fanout is a real boundary, not an implementation detail.** `ducknng_ncurl_table` is right for one
  response table. Whole-VCF or paginated annotation needs per-row scalar AIO launch, repeated any-ready drain, and
  status-as-value retry logic; permanent `4xx` terminates, transient `429`/`5xx` retries. See
  `src/duckdb/ncurl-fanout.ts`, `src/duckdb/ncurl-retry.ts`, `test/ncurl-fanout.test.ts`, and
  `examples/wgs-chr22-annotation/README.md`.
- **RPC shared state means a single writer owns the DB.** Clients should hold only throwaway `:memory:` DuckDB
  connections that call `ducknng_run_rpc` / `ducknng_query_rpc`. Same-slot memory writes rely on the server's
  serialized execution and `insertObservationIfSlotMax`; do not silently swap in a concurrent pool. See
  `docs/concurrency.md`, `src/duckdb/observations.ts`, `scripts/memory-over-ducknng.mjs`, and
  `scripts/blackboard-shared.mjs`.
- **CAS is storage and deduplication, not freshness.** A digest proves bytes; freshness comes from a source
  validator such as ETag or from an explicit snapshot policy. Range readers and DuckDB-owned remote I/O do not
  become whole-object CAS just because they are reproducible enough for a receipt. See `src/core/cas.ts`,
  `test/http-cas-reuse.test.ts`, and the CAS section in `docs/refinments.md`.
- **Process payload and job lifecycle are layered.** `process.compute` defines the Arrow/file-artifact boundary
  for one execution; `JobRunner` defines submit/status/collect/cancel over the ledger. Local immediate execution
  should still be shape-compatible with the durable async path. See `src/core/jobs.ts`,
  `src/duckdb/resolvers/process-compute.ts`, `examples/process-compute/`, `examples/process-artifacts/`, and
  `scripts/nng-job-runner.mjs`.

## Main boundary

```text
Host surfaces
  Pi extension                                   (built)
  CLI (pi-bio-agent bin)                         (built)
  SDK (importable: ., ./core, ./duckdb, ./hosts) (built)
  JSON-RPC / MCP server surface                  (later)

Core contracts
  BioManifest (the program: provides resources/resolvers/operations/termSets)
  BioOperationSpec / operation descriptor
  ResourceHandle / BioResolverSpec / VirtualResourceSpec / CAS handle
  BioRunSpec / run record / events
  ontology and KG rows
  study notes / OKF-compatible bundles

Execution adapters
  DuckDB read-only SQL                          (the substrate)
  ducknng    network as SQL (ncurl_table/_aio), cross-process shared-DB RPC (run_rpc),
             and NNG topologies (pub/sub, push/pull, survey, bus, pair) — the
             DuckDB extension that makes network/distributed/multi-agent coordination SQL-native
  duckhts    HTS readers (VCF/BCF, BAM/CRAM, BED/GFF, tabix) as SQL table functions
  process    out-of-process R / Python / Go / shell over Arrow IPC (the compute pillar)
  http.get   TS resolver + injected fetch — the fallback where a DuckDB build has no ducknng

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
composing SQL over a stable view, or **declarative data**, a predicate-registry entry, an ontology term set, a study-note caveat, a generated view/operation spec, not a `frequencyPredicateSql()` in core.
The moment core answers a *question* instead of defining a *primitive*, it has reproduced ClawBio-style
skill sprawl in a different shape. (`variants.ts` holds only variant identity for exactly this reason: no
question-level builders in core.)

> **Pre-1.0 core has no compatibility promise.** Remove speculative types rather than maintain unclear
> abstractions. Concrete biomedical behavior enters through operation/extension
> **manifests with tests**, never through convenience helpers in core. Keep only: (1) true primitives
> (identity, coordinates, CURIEs, content addresses); (2) contracts with real boundaries (`BioManifest`,
> `BioOperationSpec`, `ResourceHandle`, `BioRunSpec`, graph node/edge snapshot, study note); (3) adapters
> with tests (DuckDB sync/report, Pi extension, CLI, project helpers). Everything else is removed until a
> real consumer demands it.

Application code has the same obligation. Downstream connectors or case workflows that fetch, normalize, or
score data beside the substrate are integration debt unless they are deliberately proving a missing primitive. The
default path is application manifest or operation spec -> resolver/adapter -> DuckDB table -> recorded run. If
application code keeps running around that path, the framework is not dogfooding itself.

**Real abstraction, not idealist abstraction** (this sharpens "until a real consumer demands it", which is too
crude). An abstraction may be built *ahead of any downstream consumer* when it is **immanent in the concrete**: the expressed essence of ≥2–3 things already built and nameable. `duckdb.sql_materialize` qualified: it was
latent in `file_scan` + `read_bcf` + `http.get` (shared form = "materialize a table from a declared read"), so
building it was *revealing* a real general, not imagining one. An *idealist* abstraction is imagined a priori
from outside the work: a shape you can merely picture future things fitting (`ExecutionPolicy` hooks,
`validateSql` mode-enums, fast/CAS/airgapped "modes", a `process` transport with one instance). Those are the
sprawl to refuse. The discipline that stops "emergent" from becoming a loophole: **name the existing instances
the abstraction abstracts, never the future ones it might serve.**

### Host-Controlled Effects

> **The library is a substrate + receipt system, not a network/filesystem sandbox.** Like Pi, it gives
> powerful local execution and leaves the *risk boundary* to the host/deployment: container, seccomp,
> Firecracker, the Pi runtime, corporate egress, or a user-supplied sandbox extension. DuckDB's replacement
> scans (`FROM 'x.parquet'`), httpfs remote reads, and extension autoloading are host-provisioned capabilities;
> brittle SQL regexes are not a reliable sandbox.

What the library *does* enforce is **accountability, not access**: every answer-producing run records the query
that ran (a digest of the SQL **and** its bound params), the resources/sources it declared, the resolver
receipts, and the artifacts it produced.
`validateReadOnlySelect` is therefore **statement-class only** (one read-only `SELECT`/`WITH`, no writes/DDL: because that is what an "operation" *is*), not an egress firewall. The **primary** network path is SQL-native:
`ducknng_ncurl_table` (a DuckDB table function) inside `duckdb.sql_materialize`, with the URL/headers/body
composed in SQL and the JSON parsed into a table: no TS resolver (the `ols4-grounding` GET and
`variant-annotation` POST examples). `http.get` (a TS resolver needing a host-supplied `fetch`) is the
**fallback** for a DuckDB build with no ducknng, plus the host-driven multi-request retry/fanout seam. Either
way network is a **host-injected capability** (`file_scan`/`read_bcf`/`sql_materialize` may read remote URIs if
the environment allows): the host decides whether egress is possible, the library records that it happened. A
strict "no external I/O / CAS-snapshot-first" profile is an **optional host policy**, not the default stance.

**The host-control surface is the injected ports, not a separate hook framework.** Pi-agent-core makes
lifecycle hooks (before/after, context transforms) central, and that pattern is real, but in *our* shape it is
already spelled as dependency injection, so a second hook system would be sugar over composition we have. A
host that wants policy wraps the port it already supplies: decorate `SqlConn` and you have `validateSql` /
`beforeQuery` over every execution (a strict no-external-I/O profile is a ~5-line `SqlConn` decorator: [`host-policy-via-ports.test.ts`](../test/host-policy-via-ports.test.ts) proves it enforces what the library
deliberately stopped enforcing); decorate a bound `BioResolverImpl` for `beforeResolve` / `afterResolve`;
`runOperation` returns `{run, result, receipts}`, so before/after the call *is* `beforeRun` / `afterRun`. An
explicit `ExecutionPolicy` facade earns its place only when a real host needs cross-cutting, phase-aware policy
across all resolves + SQL + runs at once that decorating individual ports cannot express cleanly, and then it
is a thin facade over those ports, with a named consumer, not a speculative interface.

## Integration surfaces

`pi-bio-agent` should not be Pi-only. Pi is the first host adapter because it is where this package is used today,
but the stable product is a small core library with multiple thin surfaces over the same registries.

Model-provider integration should use `pi-ai` and the Pi auth stack rather than bespoke provider code. If a surface needs model calls, it should resolve providers through `pi-ai` and credentials through Pi's modular model services: `ModelRegistry`, `AuthStorage`, OAuth helpers, and extension-level `registerProvider` when a provider must be added or overridden. The bio substrate should not grow its own model-provider registry, token store, or provider-specific fallback logic. `auth.json` remains one backend used by AuthStorage, not a bio-agent-owned file format.

Priority order:

1. **TypeScript library API**: importable core contracts, validators, registries, and adapters. This is the source of truth.
2. **Pi extension**: exposes registry inspection, study-note operations, skill drafting, SQL validation, and later operation execution inside Pi.
3. **CLI**: scriptable local entry point for validation, indexing, application-operation testing, and resource/CAS utilities. CLI output should support `--json` for automation.
4. **JSON-RPC over stdio**: machine interface for editors, other agents, or wrappers that do not run inside Pi. Start with stdio rather than a daemon.
5. **MCP server surface**: optional later wrapper that projects selected operations/resources as MCP tools/resources. MCP is a transport, not the core architecture.

All surfaces should call the same internal functions. The CLI must not reimplement Pi logic; the Pi extension must not hide logic that the CLI/JSON-RPC cannot exercise. This keeps tests surface-independent.

Initial command/RPC families:

```text
registry.resolveResource
registry.snapshot
registry.listDuckdbExtensions
spec.validateBioManifest
spec.validateBioOperationSpec
sql.validateReadOnlySelect
study.plan
memory.remember   (bio_remember — append a temporal memory note)
memory.list       (bio_list_memory)
memory.recall     (bio_recall — read a note as-of a time)
skill.draft
resource.resolveMetadata
operation.describe
operation.dryRun
```

Execution that can reach the network, run code, or materialize data should remain opt-in and policy-explicit in
every host surface, including CLI and JSON-RPC.

## Pi coding-agent extension target

The Pi coding-agent extension is the first concrete integration target. It should prove that the substrate is useful inside a real agent loop without making Pi the only interface.

The extension should provide:

- **resource discovery** for project-local bio skills and study bundles
- **registry inspection** for operations, resolvers/resources, manifests, DuckDB extensions, and ontology/KG contracts
- **validation tools** for specs, read-only SQL, resource handles, and operation descriptors
- **study tools** for planning, writing, listing, reading, and eventually indexing notes
- **skill drafting** for project-local procedural skills, with `/reload` as the activation boundary
- **progressive disclosure**: compact indexes first, full specs/notes/skills only on demand
- **dry-run tools** before execution: show request shape, cache key, provenance plan, and policy requirements

The Pi extension should avoid becoming a second core. Its tools should call shared library functions that are also callable from CLI and JSON-RPC. If a Pi tool contains substantial logic, that logic belongs in `src/` with tests. When the Pi extension needs model-provider access, it should use the `modelRegistry`/`AuthStorage` services provided by Pi's extension context or `pi.registerProvider(...)` for provider registration, not package-local credential machinery.

Pi extension execution policy (as shipped):

```text
enabled by default (local, no ambient capability):
  list / describe / validate / study / draft
  resource materialization + local DuckDB query/operation execution
    (bio_query / bio_run_operation over an explicit dbPath)

fails closed unless the host explicitly injects the capability:
  network (the `fetch` port — http.get; default entrypoint injects none)
  out-of-process code runtime (`process.compute` — the ProcessRunner grant)
  extension INSTALL + egress config on the connection (host-owned `duckdbInitSql`
    / `duckdbConfig`, never an agent tool param)
```

Precise on extension loading: the host-owned `duckdbInitSql`/`duckdbConfig` (connection bootstrap,
never an agent tool param) is where a host runs `INSTALL`/`LOAD`. A *manifest* may ALSO request a
`LOAD` via `params.extensions` (both `duckdb.sql_materialize` and `process.compute`), but it is
**LOAD-only and fails closed** if the host has not already provisioned that extension, so it grants no
new capability the host didn't install. Whether an agent can author such a manifest is the host's
call. And DuckDB's *own* reachability (httpfs / replacement scans / htslib) once an extension IS
loaded is a host-provisioned capability: egress confinement is the host's boundary (container /
seccomp / OS): the library is deliberately not the network/filesystem sandbox. See `docs/refinments.md`.

## HTTP/API integrations

Many biomedical APIs are mostly the same shape: HTTP (REST or GraphQL) plus a thin layer of biomedical semantics.
OpenTargets, Monarch, Ensembl REST/VEP REST, BioThings, ClinVar-style APIs, and similar services should not each
become bespoke framework code. They belong in the **network pillar**: a REST GET or a GraphQL POST is a
`ducknng_ncurl_table` call whose URL/body composes in SQL, so a new API is an application-owned manifest or
operation spec, not a new client.

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
```

Then derive:

```text
BioOperationSpec
  -> typed operation client
  -> BioResolverSpec/VirtualResourceSpec when it resolves content
  -> Pi/MCP/CLI host exposure
  -> tests and docs
```

The thin description is still valuable when it encodes identifier namespaces, provenance expectations, versioning, cache policy, query limits, and whether patient-specific data may be sent. It should not become hand-written client sprawl.

## Execution beyond SQL: shell, R, and workflows as process operations

A `duckdb.sql` operation is one transport. Long-running external work, a shell command, an `Rscript`, a Nextflow/Snakemake pipeline, an alignment or a variant caller, enters the **same way the question always
does: as data, not a new TypeScript client.** A *process operation* declares a **command + inputs + declared
outputs + tool/version**; a host-bound **executor** runs it; the result is **artifacts** (files → CAS), a
streamed run record, and a receipt, not rows. Those artifacts re-enter as resolved resources for a downstream
`file_scan` / `sql_materialize` → SQL operation, so a pipeline is just `op → artifact → resource → op`: the
resource/artifact chain *is* the composition, no DAG engine required.

Three things keep this consistent with the rest of the substrate:

- **Invoke, don't reimplement.** A [Nextflow](https://www.nextflow.io)/[Snakemake](https://snakemake.github.io)
  run is a command that runs a DAG; an R analysis is
  `Rscript x.R`. We shell out, receipt it, and ingest the outputs: we never embed a workflow engine or an R
  runtime, exactly as we never embed an ontology runtime (we read its SQL) or a graph engine (we materialize
  closure). Absorb the function, not the runtime.
- **Host-bound and host-gated effects.** The executor is injected by the host (like `http.get`'s `fetch`), and
  whether shell/R/containers/SLURM are even possible, and any timeout, output cap, or egress: is the
  **host's sandbox decision** (container, namespace, seccomp, cluster). The library **records** what ran
  (command digest, tool + version, input handles, output CAS digests, exit code, duration); it does **not**
  impose the limits. Same posture as the network: accountability, not access control.
- **Long-running is already modeled.** `BioRunSpec.mode` is an **open host/backend label** (`string`: `inline`/
  `background`/`subagent`/`service`/`batch`, or `slurm`/`k8s`/`modal`/`nng-worker`/…; nothing branches on it), while
  `BioRunStatus`/`BioRunEventType` stay closed because the state machine branches on them. `BioRunRecord` streams
  `started → progress → checkpoint → completed/failed`. A six-hour job is a `background`/`batch` run whose record
  accrues progress + checkpoints and ends in output artifacts.
- **Out-of-process compute is built: table, file, and files-only outputs.** The `process.compute` resolver
  (`src/duckdb/resolvers/process-compute.ts`) + the injected `ProcessRunner` port
  (`src/process/node-process-runner.ts`) run an out-of-process child (R/Python/Go/shell) over Arrow IPC with a
  script-bytes provenance digest, detached process-group kill on timeout/abort, and fail-closed-without-runner.
  Three output shapes exist: a **table** read back from the child's Arrow IPC (DuckDB → Arrow → child → Arrow →
  table, `examples/process-compute`); declared **file outputs** captured content-addressed into **CAS**
  (`resultTable: "artifacts"` + `captureDeclaredOutputsToCas` in `src/duckdb/artifact-capture.ts`: relative-path-only, symlink/non-regular-file rejecting, realpath-confined to the work dir, byte-capped,
  fail-closed-without-CAS; `examples/process-artifacts`); and the **files-only** case where the resource's table
  is the captured-artifacts listing (`examples/process-files-only`). What is still missing is only the
  *operation-level* executor: a `process` **BioOperationTransport** (the OPERATION transport is still
  `duckdb.sql` only, `BioOperationTransport = "duckdb.sql"`), the argv-in-a-run-dir path for the six-hour batch /
  Nextflow-Snakemake case. The compute pillar's resolver path, table AND file artifacts, exists; the
  operation-transport wrapper does not.

  This is a payload boundary, not a separate synchronous compute world. A host may run it immediately for a small
  local call, or dispatch the same replayable work through `JobRunner` so status and result live in the ledger. New
  compute transports should preserve that layering instead of creating different semantics for long-running work.

**One general backend, not a backend zoo.** When the first executor is built, it is `process` (run an argv
command in a run dir, capture stdout/stderr/exit, register declared outputs as artifacts). `Rscript`,
`python`, `nextflow`, `snakemake` are **argv presets over `process`** (`["Rscript", script, …]`,
`["nextflow", "run", …]`), *not* separate transports: exactly as `duckdb.sql_materialize` subsumed the
reader resolvers rather than spawning one per format. One backend per tool (`runDeseq2()`, `runGatk()`,
`runNextflowRnaseq()`) would recreate the skill/API sprawl the substrate exists to avoid; the tool-specific
part stays **manifest data** (command template, inputs, expected outputs, version probes, post-load SQL,
fixtures). A genuinely new *transport* (beyond `duckdb.sql` and `process`) is earned only when execution needs
semantics `process` cannot express: polling/resume/cancel of a remote job, and even then proven against ≥2
instances, not imagined.

**Discipline: do not build the transport ahead idealistically.** Speculative non-SQL transports were already
deleted once (http/graphql/mcp/local with no runner). The out-of-process case, table AND file artifacts, is now
served by the `process.compute` RESOLVER (above); the OPERATION-level `BioOperationTransport` stays `duckdb.sql`
until a real pipeline forces a `process` **transport** (a Snakemake/Nextflow step or a DESeq2 run driven as an
*operation*, not a resolved resource). A full `BioExecutionSpec` (a backend enum,
`container`/`env`/`resources`/`effects`/`capture` fields) is the *sketch of the destination*, not core surface: add fields when an executor consumes them. CAS-of-bytes itself is **built** (`src/core/cas.ts` + `src/hosts/fs-cas.ts`,
proven by `http.get` byte-reuse across DBs in `test/http-cas-reuse.test.ts`), and the FILE-outputs-into-CAS wiring
is **built too** (`captureDeclaredOutputsToCas`); what the operation transport still needs is only to reuse that
same capture from an argv-in-a-run-dir executor.

## Storage story

The storage model is layered. Core should store handles, indexes, facts, and provenance; it should not eagerly ingest every byte into a monolithic database.

### 1. Filesystem: human-editable knowledge and package assets

Use the filesystem for things humans and agents should be able to read, diff, and edit:

- repo docs and application-operation docs
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

CAS is not a consent or retention policy. Sensitive deployments can add deletion/retention policy in adapters. The substrate only needs the primitive; retention/consent is a host concern.

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

#### The SemanticSQL shape: source spec -> local graph tables

The graph layer follows the [SemanticSQL](https://github.com/INCATools/semantic-sql) source spec: LinkML schemas
compile to SQL base tables and views. The load-bearing source tables are `statements(subject, predicate, object,
value, datatype, language)`, `prefix(prefix, base)`, and `entailed_edge(subject, predicate, object)`; `edge` is a
generated view over statements/OWL-derived views, not a separate framework noun. Bioconductor's
[ontoProc2](https://github.com/vjcitn/ontoProc2) and the [op2workshop](https://github.com/vjcitn/op2workshop)
workflow are the lineage that made this source spec the right port target.

Locally, the same shape serves imported ontologies and our own committed graph, distinguished only by scope. The
projection contract is symmetric: a remote KG table, a SemanticSQL staging table, an app producer result, a memory
link, or an edge-like `bio_observations` row can all declare how it projects into the same graph columns. That
declaration is the graph projection profile: source columns, CURIE-prefix registry, generated-view policy,
transitive-predicate policy, temporal/as-of policy, and provenance fields.

- **`bio_edges(from_id, predicate, to_id, attrs, trust)`**: the statement/edge base (`subject=from_id,
  predicate, object=to_id`). Labels, synonyms, definitions, and relations are all just rows; the predicate is
  an open CURIE vocabulary (`rdfs:subClassOf`, `BFO:0000050` part_of, our own `references`/`measures`/…).
- **`entailed_edge(from_id, predicate, to_id)`**: the *precomputed transitive closure* over the transitive
  predicates (`materializeEntailedEdges(conn, transitivePredicates[, {sourceTable, targetTable}])`, a recursive
  CTE). With it, descendants / ancestors / subsumption / graph-walk are **one indexed JOIN**, no bespoke walker:
  `SELECT from_id FROM entailed_edge WHERE to_id = ? AND predicate = 'rdfs:subClassOf'`.
- **`bio_observations(observation_id, statement_key, subject_id, predicate, object_id, value_json, recorded_at,
  valid_from, valid_to, source, digest, attrs, trust)`**: the **append-only temporal** statement log (Phase 4),
  kept *separate* from the atemporal `bio_edges` (whose `UNIQUE(from_id,to_id,predicate)` is the compiled-graph
  contract). A row is edge-like (`object_id`) or scalar (`value`); `statement_key` is the *state slot* a later
  row supersedes; `observationsAsOf(t)` is latest-per-`statement_key`; edge-like rows project into
  `bio_edges_as_of(t)` over which the *same* closure runs. record = append, current = as-of, rollback = append.

This makes **order the unifying idea, expressed as data and queried by SQL**, at three layers:

```text
analysis       operation SQL over resolver-materialized tables
total order    an ordinal scale = a ranked TermSet -> scale_members(scale_id, member_id, rank)
partial order  subsumption / graph = bio_edges + entailed_edge closure
```

A scale is a *total* order (`scale_members.rank`); an ontology or graph is a *partial* order (`entailed_edge`);
`decideGrounding` membership is unchanged: closure and rank are just another table/column. We absorb the
SemanticSQL *shape*, never a graph or ontology runtime.

**Grounding has two tiers.** A *projection* tier, deterministic, offline, fail-closed: cached CURIEs +
`entailed_edge` + FTS over labels/synonyms answer "text→CURIE (already known)" and "descendants of X" as pure
SQL. A *judgment* tier: `decideGrounding` over a fresh [OLS4](https://www.ebi.ac.uk/ols4)/search candidate
set, used only on a projection miss, which **abstains below threshold and never invents a CURIE**.

#### Resolved vs derived tables (and why only one kind carries a receipt)

Every table the operation SQL sees is one of two kinds, and the distinction *is* the provenance model:

- **Resolved**: produced by a resolver from an **external source** (`file_scan`, `sql_materialize`,
  `read_bcf`, `http.get`, an ingested ontology's `statements`/`bio_edges`). It touched the world, so it carries
  a **receipt** (resolver version, params digest, source snapshot).
- **Derived**: a **pure function of the program plus already-resolved tables** (`scale_members` from ordered
  TermSets, `entailed_edge` as the closure of `bio_edges`). It touched nothing external, so it carries **no
  receipt**: it is fully **recomputable** from the manifest + the resolved inputs, and that recomputability is
  its provenance.

The operation SQL does not care which it queries: that is the point. This is a real distinction *immanent in
what we built* (two derived tables already exist), and it earns documentation, not a `Projection` framework:
the two derivations share a lifecycle (runner materializes them, idempotent) but not a computation (recursive
closure vs flat rank insert), so unifying them in code would be the idealist move. (A process operation's
**output artifact** is a third kind, *produced*, CAS-addressed, which re-enters as a *resolved* resource
downstream.)

#### The substrate is a lazy, content-addressed evaluation graph

Seen from the R / [dbplyr](https://dbplyr.tidyverse.org) / [targets](https://docs.ropensci.org/targets/) world
(the latter's design rationale collected in [targeted-learning](https://github.com/mdsumner/targeted-learning)),
the whole design is **lazy evaluation**: a manifest is a *lazy expression*, a resource is a **thunk**
(`resolver + params` is a recipe for a table, not the table), and
`runQuery`/`runOperation` is the **force**: the `collect()` boundary that resolves the referenced thunks and
runs the SQL. Receipts (`paramsDigest` + source content digest) are **memoization keys**: a resource is a pure
function of its params plus source state, so an unchanged digest is a cache hit, which means **CAS is the memo
table**, not just storage. Derived tables are pure lazy derivations (recomputed from inputs, like a `mutate`),
which is precisely why they carry no receipt: `scale_members` is recomputed on every force (the runner
materializes it before the SQL), while `entailed_edge` is materialized on demand by `materializeEntailedEdges`
when a graph query needs it. Composition
(`op → artifact → resource → op`) is a lazy DAG: [targets](https://docs.ropensci.org/targets/) /
[Nextflow](https://www.nextflow.io)-shaped.

The discipline is the same as everywhere else: **the laziness lives in data** (the declared manifest/SQL is the
lazy expression), interpreted by thin TS. It is **dbplyr/targets, not [Effect-TS](https://effect.website) /
fp-ts**: pulling in a TS
lazy/effect monad would be the idealist move (a monad with no instances we need; the laziness is already in the
data). The frame makes the deferred work *obvious rather than invented*, and the first piece is now **built**:
**resolution memoization** (`src/duckdb/resolution-memo.ts`): a per-table freshness token + stored receipt;
on re-resolve over a persistent `dbPath`, an unchanged token + a still-present table replays the receipt and
skips the work. `file_scan` opts in with the file's **content digest** (sha256, not mtime+size: a same-size
change with a preserved mtime can't false-hit). It is correct, not a stale-cache footgun, because the memo key is
**content freshness, not the request**: params/URL is the *call*, not the *value*. **Built:** content-addressed
byte storage (CAS) for cross-db reuse, and remote freshness via HTTP cache validation (ETag `If-None-Match` →
`304`, the shared index scoped per host `remoteCacheScope`). Scope note: `remoteCacheScope` is a
`ResolutionContext` field, so the cross-db shared-remote reuse is active for a host that drives resolvers directly;
the packaged run tools (`bio_query`/`bio_run_operation` → `runQuery`/`runOperation`) do not yet thread it, so
that path does per-db 304 revalidation without the cross-db shared remote index. Threading `remoteCacheScope`
through the run requests is a named, host-owned leftover, not an advertised default. `sql_materialize` reads arbitrary SQL/live sources
and can't cheaply content-pin its inputs, so it is deliberately not memoized (it declares `live_source`; a run
over a live source is not put in the ActionCache and is `not_reproducible` without a CAS output pin). Derived tables (`scale_members`,
`entailed_edge`) are pure and trivially safe (recompute). **`as_of` is now built** (Phase 4.0a): the temporal
facts live in the append-only `bio_observations` (`src/duckdb/observations.ts`), `observationsAsOf(t)` is
latest-per-`statement_key`, and edge-like rows project into `bio_edges_as_of(t)` over which the *same*
`entailed_edge` closure runs (`entailedEdgesAsOf`). Still pending: lazy resolution forcing only the resources a
query names.

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

### Where the human stays in the loop (the judgment/approval boundary)

The substrate covers the **executable middle** (data → SQL → process). What it deliberately does **not** compute, the **irreducibly human** parts, clusters in three places, and that is by design, not a gap. The substrate now
**records and gates** each (the temporal `bio_observations` store and the Phase-4 governance loop are built); it
never **decides** them. Locate them precisely so they are never quietly automated away:

- **Judgment** (B: *recording results/judgments as KG facts*). A pathogenicity call, a grounding decision, an
  "this evidence supports X" is a human-or-model *judgment*. The substrate's job is to **record** it as a
  provenance-bearing fact (who/what decided, when, on what evidence, at what confidence): never to **compute**
  it. SQL can deterministically run the *rule* once a human has fixed it (the rare-high-impact abstention is a
  pinned, tested operation), but the choice of rule and the calls SQL can't decide remain judgments.
- **Approval / policy** (the Phase-4 `activate` / `rollback` gate). `validate`/`test`/`record` are mechanical;
  what is not is **promoting** a new skill/spec into active use, or **reverting** one: a policy/approval gate a
  human (or a human-set policy) owns. `rollback` is also *why* temporal anchoring exists: you can only revert to a
  prior state if facts are time-versioned (as-of). The **mechanism**, submit → validate → test → record → `activate`/`rollback`, with durable park/resume for a pending approval, is **built** (Phase 4.3/4.4,
  `src/hosts/harness-adaptation.ts` + `src/duckdb/activation.ts`); the injected `ApprovalPolicy` is exactly where
  the human/host decision plugs in, and the substrate never fabricates it.
- **Curation**: *ontology-ingest*, and *pipeline/tool/version selection*. Which ontology, which release, which
  tool at which version, how to reconcile conflicting sources: authored into a manifest by a human, not
  derivable. The projection (statements → `bio_edges`) and the run (argv → artifacts) are mechanical; the *trust
  decision* is curatorial.

**These three are one governance loop, and its rails are built.** An executor **produces** (run a pipeline,
ingest an ontology); the substrate **records** the human/model *judgment about that output* as a
provenance-bearing, as-of-versioned fact; the Phase-4 `activate`/`rollback` gate (with durable park/resume
approval) promotes or reverts on those judgments. So the human is threaded through as *judgment → approval*, and
the substrate's contribution is to make that loop **explicit, accountable, time-versioned, and reversible**: rails for the human decision, not a replacement for it. This is the sharp form of the honest boundary (the
executable middle is ours; semantic judgment and human/policy workflows are deliberately *hosted*, not
*computed*).

**The boundary is narrower than "services/auth/streaming are out."** Much of what looks non-SQL is already in
reach by composition: API **credentials/auth** = DuckDB's `CREATE SECRET` secret manager (host-owned, the same
path as our `cache_httpfs`/S3 config) + ducknng mTLS/peer-allowlists + Pi's auth storage/token-refresh;
**stateful-async** interactions = ducknng query **sessions** (`open_query`/`fetch`/`close`, result handles,
incremental chunks); **streaming / SSE / websockets** = ducknng `wss` + Pi-mono patterns; a **GraphQL** endpoint
is an HTTP POST + JSON that `ncurl_table` hits SQL-native (subscriptions = wss/sessions). So the genuinely
irreducible residue is just the two non-mechanical acts, the **judgment** (the model/human decision) and the **approval** (the policy gate), which the substrate records and gates, never computes. Everything executable is
in the middle or borrowable.

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

- [SemanticSQL](https://github.com/INCATools/semantic-sql): OBO ontologies as flat SQL (`statements` + `entailed_edge`); the graph shape we borrow.
- [ontoProc2](https://github.com/vjcitn/ontoProc2). Bioconductor ontology access over SemanticSQL.
- [OLS4](https://www.ebi.ac.uk/ols4) (EBI Ontology Lookup Service): fresh text→CURIE search (the grounding judgment tier).
- [MONDO](https://mondo.monarchinitiative.org), [HPO](https://hpo.jax.org), [Sequence Ontology](http://www.sequenceontology.org), [OBO Graphs](https://github.com/geneontology/obographs): ontologies / interchange formats.
- [targets](https://docs.ropensci.org/targets/) + [targeted-learning](https://github.com/mdsumner/targeted-learning), [dbplyr](https://dbplyr.tidyverse.org): the lazy / content-addressed evaluation precedents.
- [Effect-TS](https://effect.website): typed effect system; we steal the discipline, not the monad.
- [Nextflow](https://www.nextflow.io), [Snakemake](https://snakemake.github.io): workflow engines a `process` operation would invoke, not reimplement.
- [DuckDB](https://duckdb.org) + [DuckDB community extensions](https://community-extensions.duckdb.org) (incl. DuckHTS): the execution substrate.
- [ColBERT](https://github.com/stanford-futuredata/ColBERT), [TACHIOM](https://github.com/TusKANNy/tachiom): late-interaction retrieval (Tier 3; deferred).
- [Machine Studying](https://jacobxli.com/blog/2026/machine-studying/): the studying/expertise-per-budget framing.
