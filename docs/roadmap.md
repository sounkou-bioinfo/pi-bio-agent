---
type: Reference
title: Roadmap and success contract
description: "Current substrate closure, agent-native success criteria, proof levels, and consumer-pulled next work."
tags: [roadmap, testing, agents, control-plane, applications]
---

# Roadmap and success contract

This roadmap records demonstrated closure, falsifiable success criteria, and current work. It is not a catalogue of
possible agent features. Core grows only when a real application or host cannot express a repeated mechanism through
existing manifests, SQL, injected capabilities, evidence, replay, temporal state, and the durable-control protocol.

## Current closure

The public substrate currently provides:

- validated manifests, resource resolution, schema discovery, ad-hoc read-only SQL, and named operations;
- DuckDB file and extension materialization, parser/AST-backed SQL checks, and physical-plan hermeticity checks;
- host-granted network and async compute, including bounded retry/cancellation and declared environment evidence;
- CAS, run-object identities, replay specifications, explicit reproduction verdicts, and guarded action caching;
- one temporal observation store for memory, facts, runs, sessions, jobs, checkpoints, approvals, and graph links;
- graph projection and closure, durable replay jobs, leased claims, stale-write rejection, heartbeat-based claim loss,
  checkpoint resume, and a public SDK shared by CLI, Pi, Quarto, the workbench, and stateless MCP;
- cross-process shared-store and remote-worker proofs through a server-owned DuckDB/DuckNNG lane.

This is enough to build applications. It does not yet provide one compact agent situation model, portable
SQLite/PostgreSQL/Quack control backends, multidimensional capacity allocation, or evidence-driven operation
promotion.

## Falsifiable success

The project succeeds when an actor can orient, plan, control, verify, and improve a previously unprogrammed scientific
task through a small stable grammar, while producing stronger evidence at lower implementation or inference cost than
a per-question skill baseline.

Correctness remains the gate:

- claims come from declared data, deterministic compute, or explicit typed judgment;
- missing evidence becomes missingness or abstention;
- receipts, replay, environment evidence, and allocation history match what the host actually supplied;
- live sources are not presented as byte-reproducible without pins;
- large data and graph state remain queryable rather than copied into prompts;
- cancellation intent is not confused with observed process termination;
- stale workers cannot publish results or release another attempt's resources;
- clinical interpretation is not presented as model-generated fact.

Agent ergonomics are measurable:

- initial orientation requires one bounded situation snapshot, not repository archaeology;
- any queued or blocked job can be explained through one deterministic drill-down;
- a terminal result exposes complete evidence and exact detail references without hidden truncation;
- legal next actions and required grants are machine-readable;
- reconnecting from another host requires stable handles, not conversational history;
- a useful repeated ad-hoc analysis can be promoted without adding question-specific core code.

After correctness, compare scientific accuracy, evidence completeness, wall-clock time, token and tool-call budgets,
bytes read, compute cost, human review effort, and growth in non-test implementation code.

## Proof levels

| Level | Establishes | Does not establish |
|---|---|---|
| Focused test | one validator, state transition, or invariant is enforced | useful end-to-end composition |
| Backend conformance test | equivalent durable-control semantics across adapters | deployment operations or scientific validity |
| Executable QMD or manifest | public surfaces compose and generated claims are current | production deployment or biomedical validity |
| Hermetic application run | cross-boundary execution, evidence, allocation release, resume, and abstention | live-source compatibility |
| Pinned live-source run | current source schema and host capability compatibility | future endpoint stability |
| Agent-control benchmark | measured orientation/control cost and decision accuracy | universal superiority |
| Scientific benchmark | measured quality or cost difference against a baseline | validity outside the benchmark scope |

Examples state their proof level. Copied output in prose is not additional evidence.

## Active priorities

### 1. One agent situation model

Provide a bounded read model over declarations, runs, jobs, attempts, pools, allocations, evidence gaps, and legal
interventions.

Acceptance criteria:

- one schema-tagged snapshot includes `as_of`, actor/grants, the active epistemic frame, current work, blocked reason
  codes, capacity/budget risk, change cursor, and stable detail references;
- set-oriented `describe(handles, fields, limits)` works consistently for manifests, resources, operations, runs,
  attempts, artifacts, and observations without an N+1 tool loop;
- status deltas replay from a durable cursor after push-stream disconnect;
- assumptions, evidence gaps, contradictions, and plan invalidation conditions are explicit and never presented as
  facts;
- errors identify the violated invariant, retryability, related handles, and next safe action;
- the snapshot is a projection, not a new state store.

The first consumers are the Pi extension and workbench. The R client and MCP adapter should consume the same contract
when their stateful control surfaces are implemented.

### 2. Portable relational durable-control protocol

Factor the current DuckDB job queue semantics into a backend conformance contract without moving database or scheduler
policy into core.

Implementation order:

1. define schema/versioned envelopes and deterministic state-machine tests;
2. implement the pure-R DBI reference adapter over SQLite/WAL;
3. implement PostgreSQL transactions for distributed workers;
4. expose embedded DuckDB and server-owned DuckDB/Quack adapters where their writer model is explicit;
5. let DuckDB attach SQLite/PostgreSQL control stores for joined inspection, not for pretending their transactions are
   identical.

Acceptance criteria:

- idempotent admission, claims, leases, fencing, park/resume, terminal recovery, and observation envelopes are
  behaviorally identical across adapters;
- no transaction remains open while user computation runs;
- migration plans are versioned, inspectable, and destructive changes are explicit;
- R, TypeScript, CLI, Pi, and MCP exchange stable handles and JSON-safe protocol objects.

### 3. Resource-aware admission

Extend replayable jobs with execution capacity, cumulative budgets, placement constraints, priority, and deadline.

Acceptance criteria:

- capacity is an arbitrary non-negative named vector reserved atomically per attempt;
- pool capacity is never exceeded under generated claim races;
- waiting or parked jobs release capacity and reacquire on resume;
- a cancel request releases capacity only after executor-confirmed stop or a host fencing guarantee;
- blocked jobs expose deterministic reason codes and relevant pool/allocation handles;
- existing scalar worker concurrency is representable as `slots`;
- CPU/memory/GPU enforcement remains an executor/OS concern rather than a database claim.

### 4. Cost- and evidence-aware planning

Compare valid plan candidates under explicit hard constraints and transparent cost/evidence dimensions. The planner
should reuse exact results and checkpoints first, then prefer selective reversible observations with useful expected
information gain before expensive broad effects.

Acceptance criteria:

- every estimate carries units, source, confidence/range, and explicit unknown fields;
- no plan is admitted when a hard safety, capability, evidence, placement, or budget constraint fails;
- selected plans retain a concise decision receipt and references to alternatives, not private chain-of-thought;
- actual cost and evidence are reconciled against estimates after execution;
- plan ranking can be replayed deterministically from the recorded policy and inputs.

### 5. Evidence-driven accretion

Make execution history improve future agent planning without silently changing scientific policy.

Derived operation profiles should expose, when evidence exists:

- duration and observed-memory quantiles;
- output size and bytes-read summaries;
- failure codes and retry outcomes;
- cache hit/replay verdict rates;
- source and environment compatibility;
- human intervention and approval history.

Promotion workflow:

```text
ad-hoc SQL or compute program
  -> evidenced successful runs
  -> candidate named operation
  -> schema and replay validation
  -> fixtures/regression/benchmark
  -> typed approval
  -> versioned activation
```

The system may identify a candidate and prepare a diff. It may not silently activate code, grant capabilities, or turn
generated prose into fact.

### 6. Measure the anti-sprawl and agent-control claims

Build budgeted comparisons between:

- per-question tools/skills;
- manifest plus schema inspection plus SQL/compute composition;
- the same substrate with situation snapshot, planning, replay, and empirical operation profiles.

Measure correctness, evidence quality, tokens, tool calls, wall time, bytes read, compute cost, human review, new
TypeScript/R code, number of context objects inspected, number of irreversible actions, and calibration of predicted
versus actual cost. The central metric remains how little new implementation code and prompt context a supported
question requires.

### 7. Make large result delivery explicit

The MCP adapter exposes the semantic distinction between complete inline results and durable result references, but the
core query runner still materializes every row through `SqlConn.all`. Add relation, Parquet, Arrow, or CAS delivery at
the SDK boundary when a real consumer needs it. Preserve the complete scientific result and keep UI/model truncation
as presentation metadata.

### 8. Derive stateful interactive parity only from another stateful host

The stateless MCP adapter closes the provider-neutral scientific execution surface; it deliberately does not model
conversation sessions, transcript ingestion, steering, or dynamic tools. Promote host-neutral interactive control only
where the R client or another stateful host repeats Pi's behavior. Do not infer a session framework from a per-request
protocol.

## Milestone sequence

### M1 — Legible control

Situation snapshot, stable handles, structured errors, blocked reasons, and cursor-based deltas over the current
DuckDB queue.

### M2 — Portable local reference

Pure-R DBI implementation over SQLite with the same replay, lease, fencing, checkpoint, and observation envelopes.

### M3 — Capacity-aware single node

Priority plus named capacity vectors, budgets, placement labels, explainable admission, process-stop-aware release, and
property-based conformance tests.

### M4 — Distributed backend

PostgreSQL adapter, multi-worker race tests, remote CAS/staging contract, and operational recovery documentation.

### M5 — DuckDB bridge

DuckDB inspection views over SQLite/PostgreSQL control state and a server-owned DuckDB/Quack adapter marked according
to proven protocol maturity.

### M6 — Accretive planning

Empirical operation profiles, value/cost-aware plan comparison, promotion candidates, and budgeted agent-control
benchmarks.

Each milestone must delete or reconcile older duplicate boundaries before adding another API.

## Repository gate

`npm run check:all` is the workspace gate. It covers core, MCP, workbench, Quarto engine, generated documentation,
examples, skills, type checking, and tests. Run focused owning checks first, then the full gate for shared changes.

The R reference package requires its own DB-backend conformance matrix, deterministic clock, race/failure injection, and
package checks. A protocol version is not complete until at least one cross-language fixture is consumed identically by
R and TypeScript.

Executable claims are authored in QMD and rendered to committed Markdown. Design prose links to code, tests, or
application runs. Keep the generated docs index current.
