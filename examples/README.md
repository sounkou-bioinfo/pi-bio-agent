# Examples

Examples show how public `pi-bio-agent` surfaces compose. They are not application packs and do not establish
biomedical validity merely by running.

## Proof levels

- **Manifest example:** declared resources and SQL/operation shape, with fixtures and contract tests.
- **Executable pattern:** a QMD runs public code, asserts mechanics, and renders current bounded output.
- **Live pattern:** a QMD invokes a real model, remote host, or changing source; output is evidence of that run only.
- **Application:** downstream policy composes multiple primitives and may reveal repeated pressure for a future core
  abstraction.

QMD is the source for executable pattern Markdown. `npm run patterns:qmd` reruns deterministic patterns and
`npm run check:executable-docs` rejects stale output.

## Manifest and operation examples

| Example | Contract exercised |
|---|---|
| [variant-counts](variant-counts/) | resource-only manifest; inspect schema, then write ad-hoc SQL |
| [rare-high-impact](rare-high-impact/) | repeated SQL operation with explicit missing-frequency abstention |
| [variant-annotation](variant-annotation/) | batched VEP-shaped JSON materialization and SQL normalization |
| [OLS4 grounding](ols4-grounding/) | candidate retrieval followed by typed choice or abstention |
| [Monarch KG HTTP](monarch-kg-http/) | foreign edge projection into a canonical SQL graph shape |
| [graph window](graph-window/) | bounded graph paging over an existing DuckDB relation |
| [long-context aggregate](long-context-aggregate/) | context as rows and deterministic aggregation; not a recursive model loop |
| [compute run](compute-run/) | DuckDB table to out-of-process R and back over Arrow IPC |
| [compute artifacts](compute-artifacts/) | compute value plus declared file outputs captured in CAS |
| [compute files only](compute-files-only/) | artifact-only process output without a rectangular value |
| [coloc](coloc/) | SQL harmonization plus R `coloc.abf`, with declared output relations |
| [WGS chr22 annotation](wgs-chr22-annotation/) | indexed DuckHTS read, bounded VEP fanout, ClinVar join, SQL reduction |
| [connectors](connectors/) | generic HTTP, GraphQL, MCP, and SQL materialization manifests |

Generated README result blocks come from the runner rather than pasted output:

```sh
npm run readme:examples
```

## Deterministic executable patterns

| Pattern | What it establishes | Explicit limit |
|---|---|---|
| [blackboard](patterns/blackboard-run.md) | access-list publication order without a topo scheduler | in-process mechanics only |
| [shared blackboard](patterns/blackboard-shared.md) | four processes coordinate through one server-owned SQL table | not learned orchestration |
| [bounded pipeline](patterns/pipeline-fanout.md) | concurrency cap and stable result order | not HTTP retry behavior |
| [partitioned labeling](patterns/map-reduce-labeling.md) | isolated map artifacts and deterministic reduce | no recursive model loop |
| [NNG pair](patterns/nng-pair.md) | 1:1 refinement transport | illustrative verdict rule |
| [NNG survey](patterns/nng-survey.md) | broadcast, fan-in, quorum, and abstention shape | no model-quality claim |
| [remote job status](patterns/nng-job-runner.md) | worker status enters the ordinary observation ledger | not the full durable queue lifecycle |
| [RPC mutation](patterns/ducknng-rpc-mutate.md) | separate clients perform native mutable SQL | host must authorize remote exec |
| [memory over DuckNNG](patterns/memory-over-ducknng.md) | separate writer and reader share one temporal ledger | sequential, local-machine run |
| [CAS plus RPC metadata](patterns/ducknng-fs.md) | immutable bytes compose with mutable SQL metadata | no FUSE or production filesystem claim |
| [SDK host embedding](patterns/sdk-host-embedding.md) | public DI surface, custom resolver, receipts, CAS, and ledger | host closures are not replay data |
| [skill-only CLI host](patterns/substrate-skill.md) | packaged onboarding reaches catalog, query, run, ledger, and replay | no weak-model quality claim |

Run one pattern through its named npm command, or render the deterministic set:

```sh
npm run patterns:qmd
```

## Live agent patterns

| Pattern | What it exercises |
|---|---|
| [access-list chain](patterns/live-multi-agent.qmd) | one Pi process per step and bounded upstream note access |
| [survey and synthesis](patterns/live-debate.qmd) | two independent Pi respondents and one synthesis process |
| [typed memory](patterns/typed-memory-agent.qmd) | writer/reader Pi agents, temporal revisions, and current graph links |
| [Pi session trace](patterns/pi-session-trace.qmd) | image, shell error, manifest query, run linkage, and session ingestion |

These require configured model credentials and are excluded from deterministic rerendering. Run them explicitly with
their `npm run pattern:*` commands. Their outputs prove host mechanics and recorded trajectories, not learning gains.

## First-party application

The executable [clinical genomics application](../packages/workbench/examples/clinical-genomics/application.md)
composes grounded phenotype assertions, a foreign graph, indexed VCF reads, bounded VEP retry, SQL evidence,
checkpoints, CAS, and observations. It owns its clinical evidence policy downstream.

```sh
npm run application:clinical
```

Repeated application friction may justify a new core abstraction only after another application or generic pattern
shows the same policy-free motion.
