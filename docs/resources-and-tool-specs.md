---
type: Reference
title: Resources, capacity, and tool contracts
description: "Read before defining scientific resources, resolvers, execution capacity, or agent-facing operation contracts."
tags: [resources, capacity, cas, resolvers, operation-spec, agents]
---

# Resources, capacity, and tool contracts

The core never assumes a model provider, agent harness, HTTP client, shell runner, scheduler, or database binding. A
manifest declares scientific resources, resolvers, operations, and term sets as data; a host binds executable adapters
and control capabilities at runtime.

## Keep the vocabulary unambiguous

The word “resource” covers two unrelated concepts in many workflow systems. This project does not overload it.

| Term | Meaning | Example |
|---|---|---|
| Scientific resource | data or knowledge made addressable by a manifest | VCF range, ontology release, Parquet table |
| Resource handle | durable reference to scientific content | CAS digest, stable external reference, virtual recipe |
| Capacity request | simultaneous execution occupancy | 8 CPU, 32 GiB, 1 GPU, one license token |
| Budget | cumulative run/intent limit | 2 hours, 50 GB read, 1,000 API calls, USD 5 |
| Placement constraint | eligibility predicate over workers or pools | Linux, A100/H100, data zone UAE |
| Capability grant | permission to invoke one host effect or control action | `compute.run`, cancel, approve, promote |

Scientific resources belong in manifests. Capacity, budget, placement, priority, deadline, and control grants belong
to the run intent, plan, job, or host policy.

## Scientific resource handles

A resource handle is a durable reference to data without forcing core to know where bytes live:

- `inline`: small JSON payload;
- `reference`: file, object-store URI, database table, URL, accession, or other stable pointer;
- `content_address`: algorithm plus digest and optional size/media type;
- `virtual`: resolver id plus parameters.

Content-addressed resources make caching and reproducibility explicit. The same digest means the same bytes regardless
of local path. A content address proves identity, not freshness or scientific truth.

## Resolvers and resources

A `BioResolverSpec` declares a capability that turns a `VirtualResourceSpec` into a `ResourceHandle`. Resolution is
resource-centered (`registry.resolveResource(resourceId, ctx)`); the registry stamps a `ResolutionReceipt` so an
implementation cannot forge identity or provenance.

A resolver may be backed by:

- DuckDB SQL or an extension table function;
- local filesystem or object-store access admitted by the host;
- DuckNNG HTTP/RPC;
- host-injected `fetch`;
- MCP or another service;
- process compute through `compute.run`.

Many source integrations are SQL-native. `ducknng_ncurl_table` or a foreign-catalog attachment can materialize a
declared response into relations without a source-specific TypeScript client. A new source should not create a new
framework lifecycle.

## Execution capacity and budgets

Capacity is an arbitrary non-negative named numeric vector:

```json
{
  "slots": 1,
  "cpu": 8,
  "memory_bytes": 34359738368,
  "gpu": 1,
  "license:vep": 1
}
```

A capacity request is reserved as one unit for an attempt. Missing pool keys mean zero available capacity; unknown
telemetry stays unknown rather than becoming zero.

Budgets are cumulative and use explicit units:

```json
{
  "max_wall_ms": 7200000,
  "max_cpu_seconds": 28800,
  "max_bytes_read": 50000000000,
  "max_api_calls": 1000,
  "max_cost_usd": 5
}
```

Hosts record observed consumption when available. Declared capacity is not evidence of observed peak use, and observed
usage is not automatically a hard OS limit.

Placement constraints are typed predicates over declared worker/pool labels. Secrets, credentials, and hidden machine
facts do not enter the manifest or prompt; the host returns only admitted non-secret capability and placement
receipts.

## Agent-facing object handles

Every inspectable object has one stable typed handle:

```text
manifest:<id>@<version>
resource:<id>
operation:<id>@<version>
intent:<id>
plan:sha256:<digest>
run:<id>
attempt:<run-id>:<number>
pool:<id>
allocation:<run-id>:<attempt>
artifact:sha256:<digest>
observation:sha256:<digest>
```

Transports may encode handles differently, but they must preserve type, identity, and round-trip resolution. An agent
should not pass ephemeral database row numbers, temporary file paths, or UI-only identifiers when a durable handle
exists.

## Agent-facing operation contract

The public grammar is small: describe, plan, submit, observe, intervene, collect, replay, compare, and promote. CLI,
MCP, Pi, R, and browser adapters may expose transport-appropriate names, but they return the same semantic envelope.

A successful response should include:

```json
{
  "schema": "pi-bio.control_response.v1",
  "action": "submit",
  "at": "2026-08-31T00:00:00Z",
  "handles": ["run:...", "plan:sha256:..."],
  "state": {"phase": "queued"},
  "summary": {},
  "detail_refs": [],
  "receipts": [],
  "next_actions": []
}
```

The exact fields vary by action, but the following rules are stable:

1. **Stable identity.** Return handles for every created or affected durable object.
2. **Observed time.** State is labeled with the time at which it was read or recorded.
3. **Progressive disclosure.** Compact summaries link to exact plans, results, logs, receipts, artifacts, and history.
4. **No hidden truncation.** A presentation may return a bounded preview only with an explicit complete-result
   reference and truncation metadata.
5. **Deterministic affordances.** `next_actions` lists legal transitions derived from state and host grants. It is not a
   model-generated recommendation.
6. **Explicit unknowns.** Missing estimates, telemetry, freshness, or replayability are represented as unknown.
7. **Attribution.** Control, judgment, approval, and promotion responses identify the actor and host capability used.
8. **Idempotency.** Mutating actions accept an idempotency key or stable plan/run identity where repetition is
   possible.
9. **Set-oriented inspection.** `describe` accepts several handles, field selection, row/byte limits, and cursors so an
   agent can orient in one bounded call instead of an N+1 tool loop.
10. **Comparable alternatives.** `plan` may return several valid candidates with explicit cost ranges, evidence gaps,
    reversibility, and decisive constraints. Unknown estimates remain unknown.

## Structured failure contract

Errors are machine-readable and may also carry human explanation:

```json
{
  "schema": "pi-bio.control_error.v1",
  "code": "CAPACITY_MEMORY",
  "layer": "admission",
  "message": "The job does not fit the selected pool.",
  "retryable": true,
  "violated_constraint": {
    "requested": 68719476736,
    "available": 34359738368,
    "unit": "bytes"
  },
  "related_handles": ["run:...", "pool:local"],
  "next_actions": [
    {"action": "observe", "target": "pool:local"},
    {"action": "intervene", "target": "run:...", "requires": "control.cancel"}
  ],
  "detail_refs": []
}
```

The system does not ask the agent to infer retryability or recoverability from log prose. Raw logs remain available by
reference, but common failures are normalized into stable codes and linked evidence.

## Situation snapshots

A situation snapshot is the preferred orientation surface. It is a bounded read model, not a new store.

It includes:

- actor identity and granted capabilities;
- active intent, success criteria, budgets, and deadline;
- declared manifests, source freshness, and required missing capabilities;
- running, queued, waiting, blocked, and terminal work;
- pools, allocations, free capacity, and budget risk;
- evidence gaps, live-source warnings, and replay verdicts;
- changes since a durable cursor;
- legal next actions and stable detail references.

The agent can then drill into exact objects through one set-oriented `describe(handles, fields, limits)` call or SQL.
Large tables, logs, and graph neighborhoods stay relational. The snapshot may include an attention budget (maximum
objects, bytes, or rows for the next drill-down), but it never drops scientific data from the durable result.

## Planning and preflight

A plan is a content-addressed explanation of how existing primitives would satisfy an intent. It may include:

- resources to resolve and expected source snapshots;
- operation or compute specifications and dependency edges;
- expected outputs and evidence requirements;
- capacity, budget, placement, and capability requirements;
- cache/resume opportunities;
- known unknowns and cost estimates.

Planning and preflight do not mutate execution state. A plan is not a second workflow DSL; it is compiled from existing
declarations and may be regenerated and compared by digest. Plan comparison follows a lexicographic rule: reject any
plan that violates a hard constraint; among valid plans, prefer sufficient evidence and reproducibility; then minimize
expected cost and irreversible effects. When uncertainty dominates, prefer the cheapest action with useful expected
information gain.

## Multi-agent attribution; authorization remains host-owned

Every observation carries author/source attribution. Shared stores can therefore remain time-consistent and auditable
when many agents write to them.

RBAC and capability grants remain host policy. A sensitive deployment decides who may inspect, submit, cancel,
reprioritize, approve, or promote. The situation snapshot exposes the grants that apply to the current actor without
exposing secrets.

DuckNNG, PostgreSQL, Quack, or another transport may provide TLS and peer identity. The protocol does not mistake
transport authentication for scientific evidence.

## Accretive extension

Self-extension means producing a versioned, validated, evidenced declaration revision:

```text
successful ad-hoc SQL/compute
  -> promotion candidate
  -> declared schemas and dependencies
  -> replay and fixture checks
  -> benchmark or regression evidence
  -> approval where required
  -> activation of a new manifest/operation version
```

An agent may prepare the candidate, tests, and diff. It may not silently mutate core code, active permissions,
scientific facts, or host policy.

Empirical cost and failure profiles are derived from run observations. They inform planning without becoming hidden
behavior in the operation specification.

## Design rules

1. Prefer a DuckDB relation or registered resolver before adding a source-specific client.
2. Prefer bounded schema inspection and SQL before copying data into prompt context.
3. Keep scientific resources, execution capacity, budgets, placement, and grants as distinct types.
4. Return stable handles, structured errors, legal next actions, and exact detail references.
5. Record control intent separately from observed effect.
6. Keep complete results and evidence durable even when a UI or model receives only a preview.
7. Reuse the existing run, replay, CAS, observation, and graph substrates.
8. Fail closed on missing adapters, grants, pins, schemas, or capabilities.
