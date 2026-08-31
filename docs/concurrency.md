---
type: Reference
title: Concurrent state and durable control plane
description: "Read before sharing memory, jobs, attempts, or resource pools across processes, agents, or machines."
tags: [memory, jobs, control-plane, concurrency, ducknng, sqlite, postgres, quack]
---

# Concurrent state and durable control plane

The temporal ledger, operational queue, and scientific database have different concurrency requirements. Treating them
as one file-opening problem is the source of most ambiguity.

The system has two linked stores:

```text
evidence/control history                 operational coordination
bio_observations + CAS                   queue + attempts + pools + allocations
append-only audit truth                  mutable indexes for fast atomic decisions
```

The operational tables may be repaired or rebuilt from durable evidence where the protocol permits. They never replace
receipts, replay specifications, results, or temporal observations as the scientific record.

## Current implementation

The repository currently demonstrates a durable queue over a serialized DuckDB SQL lane:

- `pi_bio_job_queue` stores replay JSON, phase, availability, attempt, lease owner, and lease expiry;
- `claimJob()` atomically changes one eligible row to `running` with `UPDATE ... RETURNING`;
- `heartbeatJobClaim()` extends only a still-live lease;
- status and result observations are inserted only while the matching worker and attempt still own the claim;
- a queue worker heartbeats independently of the executor and aborts local work after claim loss;
- `bio_observations` remains the durable status/result ledger.

This proves the leased-job and stale-write semantics. It does not yet provide portable database backends,
multidimensional capacity allocation, compact agent situation snapshots, or a complete distinction between control
intent and observed process termination.

## Writer authority

Every mutable control store needs one well-defined serialization authority.

### Within one Node/Pi process

Connections to one DuckDB file must come from one native database instance. `openBioStore` therefore uses a
process-cached instance and gives each caller an independent connection. Schema bootstrap is serialized per canonical
file identity.

Scientific runs may load different extension sets, so file-backed scientific runs use isolated instances and
serialize for their full lifetime through `withDuckDbFileExclusive`. `:memory:` scientific runs remain isolated and
may execute concurrently.

Canonical file identity collapses ordinary paths, symlinks, dangling symlinks, and existing hard links. Opening aliases
through independent native instances is unsupported and must not bypass ownership checks.

### Across processes or hosts

An embedded DuckDB file remains a process-exclusive writer. Shared use requires one server-owned writer authority,
for example a DuckNNG SQL server or Quack. Clients send parameterized operations to that authority; they do not open
the shared file.

SQLite and PostgreSQL provide different writer models. A portable control-plane adapter must use their native
transaction semantics rather than route correctness through generic SQL text.

## Supported control-store profiles

| Profile | Intended scope | Writer semantics | Status |
|---|---|---|---|
| Embedded DuckDB | one owning process; local ledger and tests | one native writer instance; serialized statements | implemented |
| DuckNNG-owned DuckDB | several processes or machines sharing one writer | server serializes parameterized SQL | implemented proof |
| Quack-owned DuckDB | several language clients sharing a DuckDB server | server-owned transactions; protocol still evolving | active adapter target |
| SQLite/WAL | one node, several local R or other processes | many readers, one writer; short `BEGIN IMMEDIATE` control transactions | reference local target |
| PostgreSQL | distributed workers and production coordination | row locking, compare-and-swap, or `SKIP LOCKED` within transactions | distributed target |

DuckDB can attach SQLite or PostgreSQL for inspection and analytics. `ATTACH` does not erase backend locking,
transaction-abort, or cross-database atomicity differences. The backend that owns the control rows remains explicit.

## Logical control protocol

All adapters implement the same observable invariants even when their SQL differs.

### Durable objects

```text
intent            requested outcome, success criteria, priority, budgets
plan              preflighted composition of existing resources and operations
job               replayable admitted work
attempt           one leased execution with a fencing identity
pool              one schedulable capacity and label set
allocation        capacity held by one live attempt
control intent    requested cancel/park/resume/reprioritize/budget change
observation       durable evidence of state, result, decision, or effect
```

The minimal existing job queue may keep intent and plan inside replay/run objects. Physical tables are introduced only
when atomic decision-making or query pressure requires them.

### Stable identities

A mutable write is accepted only when it names:

- the run/job id;
- the current attempt number or fencing token;
- the worker identity;
- an unexpired lease;
- the expected replay or plan digest when applicable.

A stale process may continue executing after a lease expires. It is therefore denied at the write boundary, aborted by
the worker, and prevented from releasing or consuming another attempt's allocation.

### Desired versus observed state

A control request is not its effect.

```text
cancel requested
  -> durable control-intent receipt
  -> worker/executor observes request
  -> process tree or remote work is stopped
  -> terminal cancelled observation
  -> capacity allocation is released
```

The scheduler must not make capacity available merely because a cancellation row was written. Allocation release
follows executor-confirmed termination or a host-specific fencing/containment guarantee.

## Resource language

Use distinct types and names.

### Capacity request

Simultaneous occupancy reserved atomically for an attempt:

```json
{
  "slots": 1,
  "cpu": 8,
  "memory_bytes": 34359738368,
  "gpu": 1,
  "license:vep": 1
}
```

A capacity vector is all-or-nothing. Independent CPU, memory, and GPU semaphores permit partial acquisition and are not
the control protocol.

### Budget

Cumulative limits over an intent or run:

```json
{
  "max_wall_ms": 7200000,
  "max_cpu_seconds": 28800,
  "max_bytes_read": 50000000000,
  "max_api_calls": 1000,
  "max_cost_usd": 5
}
```

A host records what it can observe. Unknown consumption remains unknown; it is not replaced by a fabricated zero.

### Placement constraint

Predicates that determine worker or pool eligibility:

```json
{
  "os": "linux",
  "arch": "x86_64",
  "gpu_model": ["A100", "H100"],
  "data_zone": "uae"
}
```

Priority orders eligible work. It does not make an infeasible request fit.

## Atomic claim and allocation

The semantic claim operation is:

```text
1. read eligible queued/waiting jobs in priority/FIFO order;
2. compute the first job whose full capacity request fits one eligible pool;
3. atomically advance the job to a new running attempt;
4. atomically reserve the complete capacity vector for that attempt;
5. return the replay specification, fence, allocation, and lease.
```

The default policy is **highest-priority feasible**. A strict-priority policy may intentionally leave capacity idle.
EASY backfill, preemption, and fair-share require additional evidence and are not implied by first-fit scheduling.

A blocked job is explainable on demand through deterministic reason codes:

```text
NOT_YET_AVAILABLE
NO_ELIGIBLE_POOL
CAPACITY_CPU
CAPACITY_MEMORY
CAPACITY_GPU
BUDGET_EXHAUSTED
DEADLINE_INFEASIBLE
WAITING_FOR_APPROVAL
DEPENDENCY_NOT_TERMINAL
```

The explanation includes the violated constraint, relevant pool/allocation handles, and legal next actions. It is a
projection over current state; the scheduler does not persist a verbose skip event on every polling cycle.

## Backend transaction strategies

### SQLite

The reference local R adapter uses short transactions:

```text
BEGIN IMMEDIATE
  -> select candidate and current pool
  -> compare feasibility
  -> update attempt/job state
  -> insert allocation
COMMIT
```

WAL permits concurrent readers, but only one writer mutates control state at a time. Jobs may run for hours; their
database transactions must still last milliseconds. A worker never holds a transaction open during execution.

### PostgreSQL

The distributed adapter may use `FOR UPDATE SKIP LOCKED`, versioned compare-and-swap, or a stored claim function. The
observable result must match the conformance contract: no duplicate live claim, no over-allocation, and no stale
terminal write.

### DuckDB and Quack

Embedded DuckDB is valid when one process owns the writer lane. Cross-process clients use a server-owned lane.
Optimistic conflicts or serialization are retried by the adapter. DuckDB remains especially useful as the inspection
plane: it can join control state to scientific relations, Parquet results, CAS metadata, and graph tables.

## R reference implementation

The pure-R package is a reference host adapter, not a new core lifecycle.

```text
R API
  -> typed intent/plan/job objects
  -> DBI durable-control adapter
       SQLite local
       PostgreSQL distributed
       DuckDB embedded
       Quack/server-owned DuckDB experimental
  -> executor adapter
       callr/processx/mirai/external command/Slurm
  -> existing replay, CAS, receipt, and observation contracts
```

The R implementation owns policy-free state transitions and backend transactions. It does not make the database engine
pure R, and it does not hide process execution inside the store. The same schema/version tags, stable handles, replay
digests, and result envelopes are usable by TypeScript, R, CLI, Pi, and MCP hosts.

## Situation snapshots and deltas

An agent should not reconstruct the system by querying unrelated tables manually. A host exposes a bounded snapshot
projection with:

- active intent and success criteria;
- registered capabilities and grants;
- current jobs/attempts, progress, and blocked reasons;
- capacity pools, allocations, and budget risk;
- evidence gaps, live-source warnings, and replay verdicts;
- changes since an observation cursor;
- legal next actions with required grants;
- stable references for exact plans, logs, artifacts, receipts, and history.

The snapshot is a read model over the same stores. It is not another persistence layer.

Push mechanisms such as SSE, NNG notifications, PostgreSQL `LISTEN/NOTIFY`, or filesystem watches may wake a client.
They are accelerators only. A cursor over durable observations closes gaps after disconnects and remains the source of
truth.

## Same-slot observation writes

Memory revisions that share a `statement_key` use one compare-and-set statement:

```text
INSERT ...
SELECT ...
WHERE NOT EXISTS (a row for the slot at recorded_at >= candidate time)
RETURNING observation_id
```

On a serialized writer, only one candidate advances the slot at a given instant. A losing writer re-reads the latest
row and retries with a later timestamp. The note or control observation is the linearization point; linked edges use
its confirmed timestamp.

A connection pool that permits concurrent stale snapshots does not provide the same semantics merely because it
implements `SqlConn`. Each backend adapter must prove the equivalent transaction behavior.

## Conformance suite

Every durable-control backend runs the same deterministic-clock and failure-injection scenarios:

1. duplicate idempotent submission returns one admitted run;
2. two workers cannot hold the same live attempt;
3. an expired attempt cannot heartbeat, checkpoint, publish, finish, or release capacity;
4. claim plus allocation is atomic and never exceeds pool capacity;
5. launch failure rolls back or releases its allocation exactly once;
6. cancellation request and observed termination remain distinguishable;
7. crash after result write but before queue terminalization is recovered without rerunning a completed effect;
8. crash after claim but before execution becomes reclaimable after lease expiry;
9. waiting/parked work releases capacity and later reacquires it;
10. replay, receipts, and terminal observations are identical across backends;
11. unknown estimates and unavailable telemetry stay explicit;
12. control snapshots and event cursors do not omit a committed transition.

Property-based tests should generate capacity vectors, claim races, clock orderings, and terminal interleavings. Small
reference models may verify allocation and lifecycle invariants.

## Proven scope and active boundary

The repository already demonstrates:

- same-process concurrent ledger writes through one cached DuckDB instance;
- alias-aware initialization and isolated scientific ownership;
- cross-process memory and graph mutation through a DuckNNG-owned store;
- parameterized remote SQL, durable leased claims, stale-write rejection, heartbeats, and replay across machines.

A production deployment still owns worker lifecycle, input staging, CAS placement, credentials, authorization, TLS,
monitoring, backup, recovery, resource discovery, and hard process containment.

The active design work is to make that proven queue a portable, resource-aware, agent-legible control protocol without
creating another runner, ledger, workflow language, or storage substrate.
