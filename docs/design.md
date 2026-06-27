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
  ResourceHandle / resolver spec / CAS handle
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
registry.listResourceResolvers
registry.listDuckdbExtensions
spec.validateToolSpec
spec.validateResourceResolver
sql.validateSelect
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
- **registry inspection** for BioToolSpecs, resource resolvers, operation packs, DuckDB extensions, and ontology/KG contracts
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
  transport: http | graphql | openapi | duckdb_sql | mcp | local_code
  input schema
  output schema / normalizer
  identifier namespaces
  cache key policy
  network policy
  provenance policy
  PHI/PII policy

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
  -> ResourceResolverSpec when it resolves content
  -> Pi/MCP/CLI host exposure
  -> tests and docs
```

The thin description is still valuable when it encodes identifier namespaces, provenance expectations, versioning, cache policy, query limits, and whether patient-specific data may be sent. It should not become hand-written client sprawl.

## Code execution as the composition layer

A mature agent substrate should not force the model to reason over giant raw API responses in prose. Many workflows are better expressed as small code fragments that call trusted clients, page/loop/filter/join in the execution environment, and return only the compact result.

Target pattern:

```ts
const hits = await bio.opentargets.search({ query: "BRCA1", entities: ["target"] });
const evidence = await bio.opentargets.geneDiseaseEvidence({ targetId, diseaseId });
return evidence.rows
  .filter((row) => row.score > 0.3)
  .map((row) => ({ source: row.datasourceId, score: row.score }));
```

This is not trust in arbitrary ambient code. It is trust in **bounded, inspectable, replayable code over scoped clients**.

Code runtime requirements:

- no ambient raw `fetch` unless explicitly granted through registered operation clients
- no ambient secrets
- no raw DuckDB handle; use scoped read-only clients or views
- no filesystem except an explicit workspace/artifact API
- fixed timeout and output cap
- provenance receipt for every operation call
- result filtering before model context
- live network only under explicit network policy

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
  -> operation spec or resolver spec
  -> workflow skill only after repeated use stabilizes
```

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
- operation specs or resolver specs
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
