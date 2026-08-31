---
type: Reference
title: Conceptual architecture
description: "The canonical system model for agent-authored programs, durable control, execution, evidence, memory, and host composition."
tags: [architecture, agents, control-plane, execution, evidence, memory]
---

# Conceptual architecture

This document is the conceptual checksum for `pi-bio-agent`. It defines the small set of ideas that shared code,
hosts, and applications must preserve.

## The system bet

`pi-bio-agent` is not a collection of tools presented to a model. It is one queryable scientific world in which
declarations, available actions, current execution state, constraints, evidence, artifacts, and legal interventions
are linked by stable identifiers.

A new scientific question should usually require schema inspection and SQL or a declared compute program, not a new
question-specific helper or skill. A long-running question should use the same declarations, receipts, replay,
observations, and graph relations as an immediate query; durability does not create a second scientific substrate.

```text
declared resources and operations
  -> bounded schema and capability discovery
  -> explicit run intent, success criteria, constraints, and budgets
  -> preflighted execution plan over existing primitives
  -> durable job attempts and capacity allocations
  -> effects through host-granted ports
  -> results, artifacts, receipts, replay, and environment evidence
  -> temporal observations and graph projections
  -> typed judgment or approval where evidence cannot decide
  -> candidate promotion into a versioned reusable operation
```

The actor may be a human, model, service, or group of agents. The substrate does not assign facts according to the
actor's cognitive status. It gives every actor the same inspectable state, bounded effects, durable evidence, and
explicit judgment points.

## Agent operating objective

An effective agent should be able to answer these questions without repository archaeology or broad prompt context:

1. What goal is currently being pursued, and what counts as success?
2. What declared data, operations, compute, credentials, and execution capacity are available?
3. What is running, queued, blocked, waiting, terminal, or stale?
4. Why is an object in its current state?
5. Which actions are legal now, what capabilities do they require, and what are their expected costs?
6. What changed since the last observation?
7. Which evidence supports the result, what remains unknown, and can the run be reproduced?
8. Which successful work should become a named, tested, reusable operation?

The system therefore optimizes for **progressive disclosure**:

```text
compact situation snapshot
  -> stable object handles
  -> bounded relational drill-down
  -> exact receipts, plans, logs, artifacts, and history by reference
```

Large relations, logs, graphs, and artifacts remain outside prompt context. Summaries never silently replace the
complete scientific result, and truncation is always presentation metadata.

## Agent decision principle

The control plane does not merely expose actions. It makes the decision problem explicit:

```text
satisfy the recorded success criteria
  subject to safety, evidence, capability, placement, and budget constraints
  then minimize expected total cost, uncertainty, irreversible effects, and human intervention
```

When the current evidence cannot distinguish valid plans, the next action should maximize expected information gain
per unit of cost. Cheap, selective, reversible observations normally precede broad materialization or expensive
compute. The planner may compare alternatives, but every estimate carries its source, confidence or range, and
unknown fields. A hidden scalar "best" score is not sufficient.

Relevant cost dimensions include model tokens, tool calls, bytes read, API calls, CPU time, elapsed time, peak or
reserved memory, accelerator occupancy, money, and expected review effort. Hard budgets reject a plan; soft
preferences rank otherwise valid plans. The selected plan records the alternatives considered and the decisive
constraints without storing private chain-of-thought.

## Invariants

1. **The model is not a biomedical fact source.** Facts come from declared data, deterministic computation, receipts,
   or recorded approval. An actor may inspect, compose, explain, propose, and abstain.
2. **Manifests and SQL are the program.** TypeScript, R, and other hosts interpret declarations and bind capabilities.
   They do not accumulate question-specific biomedical logic.
3. **DuckDB is the common scientific work surface.** Files, extension table functions, remote responses, graph edges,
   observations, and reductions become relations that SQL can inspect and join.
4. **The durable control plane is relational but backend-aware.** SQLite, PostgreSQL, embedded DuckDB, and a
   server-owned DuckDB/Quack lane may implement one logical protocol, but their locking and transaction semantics are
   not treated as interchangeable syntax.
5. **Effects are injected and fail closed.** Network, compute, credentials, extension loading, filesystem policy,
   clocks, isolation, and process containment belong to the host.
6. **One lifecycle, one ledger.** Immediate runs, durable jobs, attempts, checkpoints, approvals, and control actions
   reuse the existing run and temporal-observation grammar. Operational queue tables are coordination indexes, not a
   competing audit store.
7. **Intent is distinct from observation.** A request to cancel, pause, reprioritize, or alter a budget is recorded
   separately from evidence that the underlying process actually stopped or the policy actually changed.
8. **Every mutable execution write is fenced.** Attempt identity and lease ownership gate status, result, checkpoint,
   allocation, and terminal writes. Stale workers cannot publish after a claim is lost.
9. **Capacity, budgets, and placement are different.** Simultaneous capacity (`cpu`, memory, GPU, licenses), cumulative
   budgets (time, bytes, calls, money), and worker eligibility constraints are never collapsed into one scalar.
10. **Evidence is structural.** Runs retain declarations, plans, receipts, replay material, CAS references,
    environment evidence, resource decisions, and temporal links when those facilities are supplied.
11. **Memory and knowledge share one temporal store.** `bio_observations` is append-only; graph tables, current-state
    views, note files, and control summaries are projections.
12. **Graph work is action over data.** Query or write code over graph relations instead of serializing large
    neighborhoods into prompts.
13. **Judgment is narrow and typed.** Mechanical work stays in SQL or code. Ambiguous choices are validated against
    explicit candidates and may abstain.
14. **Reproducibility verdicts are honest.** Live sources and volatile functions remain visibly non-reproducible
    unless the relevant bytes and environment are pinned.
15. **Agent guidance is deterministic where possible.** Legal transitions, blocked reasons, retryability, and required
    capabilities are derived from state and policy. Free-form model advice is not the control protocol.
16. **Applications pull abstractions into core.** Domain policy stays downstream. Shared primitives enter core only
    after repeated concrete use exposes the same mechanism.

## The tower of linked abstractions

Each layer has one responsibility and links to adjacent layers through stable handles and content digests.

| Layer | Question it answers | Durable identity |
|---|---|---|
| Scientific resource | What data or external object is available? | resource id, source snapshot, content address |
| Declaration | What resolver, operation, term set, or policy is registered? | manifest id/version, operation id/version |
| Intent | What outcome is requested, under which success criteria and limits? | intent id |
| Plan | Which existing primitives would satisfy the intent, and what will they consume or produce? | plan digest |
| Run | Which admitted execution of the plan is being tracked? | run id and replay digest |
| Attempt | Which leased execution currently owns the right to make progress? | run id, attempt number, fencing token |
| Step/effect | Which content-pinned unit or host effect was performed? | checkpoint name/digest, effect receipt |
| Allocation | Which simultaneous capacity is occupied, where, and by which attempt? | pool id plus attempt identity |
| Artifact/result | What immutable output was produced? | CAS digest or stable external reference |
| Observation | What was recorded, by whom, at what valid and recorded time? | observation digest |
| Promotion | Which evidenced ad-hoc work became a reusable declaration revision? | operation/manifest version and approval |

A plan is a **compiled read model**, not a second workflow language. It references existing resources, resolvers,
operations, compute specifications, checkpoints, and dependencies. It may be stored for explanation and replay, but
the authoritative effects remain the ordinary run/job/step records.

## The epistemic frame

An agent should resume from durable state rather than reconstructing its reasoning from a transcript. Each active
intent therefore has a compact epistemic frame containing:

- the objective and falsifiable success criteria;
- declared assumptions or hypotheses, explicitly marked as unverified;
- required evidence and acceptable missingness or abstention conditions;
- known unknowns, contradictions, and unresolved choices;
- hard constraints, preferences, budgets, and deadlines;
- invalidation conditions that require replanning;
- links to the current plan, observations, decisions, and results.

Assumptions are not facts. They remain typed intent or observation payloads until evidence supports, rejects, or
retracts them. A new observation can deterministically mark a plan stale when it violates an invalidation condition.
This gives another host or agent enough state to continue accurately without importing hidden conversational memory.

## The control loop

All stateful hosts should present the same conceptual loop even when their transport differs.

### 1. Sense

Return a compact situation snapshot: actor and grants, manifests, data/resource freshness, active and blocked work,
capacity pools, budget risk, evidence gaps, changes since a cursor, and stable handles for detail.

### 2. Frame

Record a run intent with an objective, success criteria, hard constraints, optional preferences, and explicit budgets.
The prompt or UI may help author it, but the persisted intent is typed data rather than conversational implication.

### 3. Plan

Compile the smallest plan that can satisfy the success criteria. Prefer existing deterministic results, exact cache
hits, selective SQL/range reads, and resumed checkpoints before new broad computation. Unknown estimates stay unknown.

### 4. Preflight

Validate manifests, schemas, SQL, required capabilities, replay material, source pins, environment declarations,
placement eligibility, capacity feasibility, and budgets. Preflight errors do not masquerade as scientific runs.

### 5. Commit

Admit the plan idempotently, enqueue replayable work, and atomically reserve capacity when a worker claims an attempt.
A committed action returns stable handles immediately.

### 6. Observe

Read deltas from the append-only observation stream using a cursor. Push transports may reduce latency, but cursor
replay and relational state remain the truth.

### 7. Intervene

Issue a typed control intent such as cancel, park, resume, reprioritize, or change a future budget. The response records
whether the request was admitted; an observed state change later proves whether it took effect.

### 8. Reconcile

Compare intent, plan, observed effects, result, budgets, receipts, and replay verdict. Surface divergence, missing
evidence, unconsumed artifacts, leaked allocations, and stale claims as structured findings.

### 9. Accrete

Derive empirical operation profiles from completed runs: duration and memory quantiles, output sizes, failure codes,
cache behavior, and source compatibility. Repeated successful ad-hoc work may become a promotion candidate, but
activation requires a versioned declaration, fixtures or regression evidence, and the applicable approval.

## Agent-facing control grammar

The exact CLI, MCP, R, or Pi function names may differ, but they adapt this small action grammar:

```text
describe    inspect capabilities, schemas, objects, and current state
plan        compile and preflight without mutating execution state
submit      admit an idempotent plan or run
observe     read current state or deltas since a cursor
intervene   request a legal state or policy transition
collect     resolve a terminal result and its evidence bundle
replay      reproduce from a recorded replay specification
compare     explain differences between runs, plans, or source snapshots
promote     propose evidenced work as a versioned reusable declaration
```

Each response should contain:

- a schema/version tag;
- stable handles for affected objects;
- the observed state and timestamp;
- structured reason codes and blocked constraints;
- legal next actions and required grants;
- compact summaries with explicit detail references;
- receipt, replay, artifact, or observation references when created.

Errors are not prose-only. They identify the layer, violated invariant, retryability, relevant handles, and the next
safe inspection or action. Hosts may add human-readable explanation without changing those fields.

## Ownership

| Layer | Owns | Must not own |
|---|---|---|
| Core | validators, registries, run/replay contracts, CAS identities, observations, graph projection, async execution shapes | disease policy, scheduler deployment, UI workflow, source-specific product behavior |
| Scientific DuckDB adapters | materialization, schema discovery, SQL checks, extensions, relation and graph projection | transactional semantics of every control-store backend |
| Durable-control adapters | queue transactions, leases, fencing, attempts, capacity pools, allocations, control intents, backend conformance | scientific question logic, process containment policy |
| Host adapters | credentials, network admission, process execution, stores, clocks, approvals, isolation, resource discovery and enforcement | hidden scientific fallbacks |
| Applications | manifests, SQL, fixtures, rankings, review policy, packets, API and UI composition | duplicate runners, ledgers, queues, or graph substrates |
| Skills | thin procedural onboarding over public SDK surfaces | a separate executable client or one skill per question |
| Documents | concise explanations linked to implementation and proof | a second implementation, work diary, or unsupported claim |

The public SDK is the shared scientific implementation. The CLI, Pi extension, R client, Quarto engine, workbench,
MCP server, and future hosts adapt it or the same relational control protocol rather than reimplementing scientific
semantics.

## Program model

A manifest declares available resolvers, scientific resources, term sets, table names, and stable operations. It is
serializable and remains thin; it is not an imperative workflow diagram.

An ad-hoc query answers the current question. The actor describes the manifest, inspects relation schemas and bounded
samples, then writes read-only SQL. This is the default path for novel questions.

A query or compute program becomes a named operation when stable identity is useful for regression tests, replay,
repeated workflows, or a public interface. Naming does not make an analysis scientifically valid; declarations,
evidence, and the analysis do.

Execution capacity is not a scientific resource. Use separate names:

```text
scientific resource    data/knowledge handle declared by a manifest
capacity request       simultaneous execution occupancy
budget                 cumulative limit over a run or intent
placement constraint   worker/pool eligibility predicate
```

See [resources-and-tool-specs.md](resources-and-tool-specs.md), [domain-model.md](domain-model.md), and
[guide.md](guide.md).

## Execution, evidence, and identity

### Data

Files and domain formats enter through DuckDB readers, extensions, or general SQL materialization. CAS stores immutable
bytes; a resource records how bytes or live data become a relation. Large evolving catalogs remain in suitable
relational storage, while the temporal ledger records their control-plane identity, snapshots, runs, and approvals.

DuckDB also holds the actor's working set. Temporary relations, graph projections, control-store attachments, and CAS
handles stay outside prompt context and are inspected through bounded queries.

### Network

DuckNNG provides SQL-visible HTTP, RPC, and NNG communication when the host provisions it. Host-injected `http.get`
remains a fallback. One-response materialization, bounded fanout, retry, credentials, and service admission are
separate concerns; applications reuse the existing generic paths rather than adding API-specific clients.

### Compute

Compute uses `submit`, `status`, `collect`, and `cancel`. A local process, R worker, remote node, scheduler, durable
queue, or stateful session is an implementation of that shape. `compute.run` materializes one declared result because
a relation-producing resolver needs a value.

Durable execution enriches this shape with replay, attempts, leases, fencing, checkpoints, capacity allocations, and
control intents. It remains a host adapter behind `ComputeRunner`/`JobRunner`; core does not acquire a database or
process manager. Resume continues from the first missing content-pinned step rather than introducing another
workflow lifecycle.

### Runs and commits

Human-readable identifiers aid discovery. Content digests establish byte identity. Schema or version tags belong at
real serialization, persistence, or IPC boundaries, not on every internal value.

A request is admitted before it becomes a run. Missing resources, unbound capabilities, invalid SQL, or infeasible
hard constraints are preflight errors. Once execution starts, success, failure, cancellation, and claim loss preserve
auditable evidence.

For a successful run with CAS and a ledger, the host commit sequence is:

1. execute the query or operation and collect resolver, effect, allocation, and environment receipts;
2. write immutable result, receipt, replay, plan, and run-object bytes to CAS;
3. establish GC roots and atomic human-readable views;
4. record declaration, run, artifact, and decision observations; required projection failure is surfaced;
5. write an action-cache entry only after live-source and hermeticity checks pass;
6. release the attempt allocation only after the executor confirms that execution stopped.

Failed and cancelled runs omit result content when none exists but preserve receipts, replay, diagnostics, and control
history. A cancellation request alone is not terminal evidence.

Files are legible views. CAS digests and ledger references are the durable identities when configured. CAS proves byte
identity, not freshness or truth. Replay distinguishes reproduced, diverged, and not reproducible.

Memoization is a scientific claim: a cache entry is allowed only when pinned inputs determine the result. The physical
plan must read resolved tables rather than ambient sources, SQL must avoid non-deterministic functions, and
introspection failure disables caching.

## Temporal state, decisions, and judgment

`bio_observations` records revisions rather than mutating history. Current state is the latest valid row for a
`statement_key` at the requested time. Retraction and rollback append new observations. Graph edges, memory recall,
run state, approvals, control intents, job checkpoints, and decision receipts project from the same temporal mechanics
without becoming semantically identical.

A decision receipt records the objective, chosen action, relevant evidence handles, constraints, expected cost, and
actor. It is a concise auditable summary, not hidden chain-of-thought.

Deterministic code mints identifiers, parses formats, computes candidates, applies mappings, validates legal
transitions, and produces diffs. When ambiguity remains, a model or human chooses from a typed candidate set. The host
validates and records the choice and may require approval before activation. Generated prose does not become measured
data.

## Host and application boundaries

The package records and gates effects; it is not a sandbox. A deployment that requires stronger isolation supplies a
container, microVM, scheduler policy, credential broker, SQL authorizer, resource-control backend, or network proxy and
injects only approved capabilities.

Browser conversation state is separate from scientific and control evidence. Interactive hosts own prompts, steering,
abort, and ephemeral activity. Durable continuity moves through intent, plan, run, attempt, checkpoint, allocation,
CAS, replay, observation, and graph handles.

The MCP adapter proves the scientific host boundary without adding conversation state. Pi-specific interactive control
stays in the Pi adapter until another stateful host repeats it. A portable R durable-control implementation is a host
adapter and reference protocol consumer; it does not move scheduler or database policy into core.

Rendering is a view. Quarto or browser renderers consume content-addressed results and figure specifications; they do
not own scientific provenance or create facts.

## How the system grows

1. Express the need in an application using existing manifests, SQL, ports, evidence, and control relations.
2. Observe the same friction in another real use or executable pattern.
3. Name the shared mechanism without importing either application's policy.
4. Reconcile it with existing surfaces and delete the weaker boundary.
5. Promote the smallest general primitive with conformance tests and public examples.
6. Return all consumers to the public SDK or relational protocol and remove private workarounds.

Self-extension follows the same rule. The agent may propose a manifest, operation, compute program, schema migration,
or skill revision. It cannot silently mutate core, permissions, or active policy. Promotion is a versioned,
evidence-gated action.

## Proof and documentation

The proof hierarchy is:

1. focused tests establish one invariant;
2. executable manifests or QMD examples establish public composition;
3. backend conformance tests establish identical control semantics;
4. hermetic application runs establish cross-boundary execution, evidence, resource release, resume, and abstention;
5. pinned live-source runs establish current source compatibility;
6. budgeted benchmarks establish measured quality or cost improvement against a baseline.

A runnable example proves mechanics, not clinical validity or universal superiority. Generated Markdown is committed
for ordinary readers; QMD is the source when execution is part of the claim.

## Further reading

- [domain-model.md](domain-model.md): kernel types and admission rules.
- [duckdb-substrate.md](duckdb-substrate.md): the scientific query plane and control-store attachment boundary.
- [concurrency.md](concurrency.md): writer authority, durable claims, capacity allocation, and backend semantics.
- [roadmap.md](roadmap.md): success criteria, proof levels, and active priorities.
- [refinments.md](refinments.md): demonstrated unresolved edges.
- [lineage.md](lineage.md): historical influences and the limits of comparisons.
