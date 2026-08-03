---
type: Reference
title: Concurrent memory — running the store over a ducknng server
description: "Read before running pi-bio-agent memory across projects, processes, agents, or machines. Explains the three store access modes and how to inject a server-backed store."
tags: [memory, store, concurrency, ducknng, sharing]
---

# Concurrent memory: inter-project / inter-actor / inter-process / inter-machine

The temporal store holds memory, facts, runs, jobs, and links in `bio_observations`. Two concurrency axes must remain
separate.

1. **Within one Node/Pi process**, connections to one DuckDB file must come from one native database instance.
   `openBioStore` therefore uses a process-cached instance and gives each caller an independent connection. Schema
   bootstrap is serialized per canonical file identity.
2. **Across processes or hosts**, the local file remains a process-exclusive writer. Another process receives a lock
   conflict rather than waiting. Shared use requires one server-backed writer authority exposed through `SqlConn`.

Canonical file identity collapses ordinary paths, symlinks, dangling symlinks, and existing hard links. Opening aliases
through independent native instances is unsupported and must not bypass ownership checks.

## Access modes

| Mode | Opener | Semantics |
|---|---|---|
| Same process | `openBioStore(cwd)` | callers share one cached native instance and use independent connections; initialization is serialized |
| Best-effort under cross-process contention | `tryOpenBioStore(cwd)` | returns `null` only for a lock held by another process; corruption, permission, and other errors still throw |
| Cross-process or cross-host | host-supplied `openStore` returning a server-backed `SqlConn` | one service owns mutable state and serializes writes according to the selected server policy |

`tryOpenBioStore` is graceful degradation, not shared concurrency. The CLI also rejects a ledger path that aliases the
scientific database path.

## Scientific database ownership

The ledger and a scientific run have different lifetimes.

- Ledger callers may overlap in one process, so they use the cached shared instance.
- Scientific runs may load different extension sets, so each run creates and closes an isolated instance.
- File-backed scientific runs targeting the same canonical file serialize for their entire lifetime through
  `withDuckDbFileExclusive`.
- `:memory:` scientific runs remain isolated and may execute concurrently.
- A process-wide ownership guard rejects overlap between a cached shared owner and an isolated scientific owner for
  the same file.

Regression coverage is in [duckdb-node-api.test.ts](../test/duckdb-node-api.test.ts),
[bio-store.test.ts](../test/bio-store.test.ts), and [pi-extension.test.ts](../test/pi-extension.test.ts).

## Native package compatibility

Pi may load multiple packages into one Node process. On Linux, native addons can resolve the first loaded
`libduckdb.so`, even when another package contains a different node-api build. `assertDuckDbNativeCompatibility`
compares the installed `@duckdb/node-api` core version with the loaded runtime before opening a database and fails on a
mismatch. First-party packages pin the same node-api version. The guard prevents database access under an unsupported
ABI mix; it does not make mixed native versions safe.

## Server-backed store

The Pi extension accepts an injected store opener:

```ts
createBioExtension({ author: "agent:worker-3", openStore: myServerStore });
```

`openStore(cwd)` returns `{ conn: SqlConn, close() }`. Memory operations, graph projection, job state, and run evidence
all use the same `all(sql, params)` / `run(sql, params)` interface, so the storage topology does not change their API.

`createDucknngSqlConn` sends parameterized SQL through DuckNNG RPC to a server that owns the database. The client uses
a throwaway in-memory DuckDB only to call the RPC functions; it does not open the shared file. The package also ships
a bounded authenticated HTTP reference transport. TLS, peer admission, SQL authorization, credentials, and service
operation remain host responsibilities.

The executable example is
[memory-over-ducknng.qmd](../examples/patterns/memory-over-ducknng.qmd)
(`npm run pattern:memory-over-ducknng`). Separate processes write and recall through one server-owned store without
opening its file locally.

## Same-slot writes

Memory revisions that share a `statement_key` use one compare-and-set statement:

```text
INSERT ...
SELECT ...
WHERE NOT EXISTS (a row for the slot at recorded_at >= candidate time)
RETURNING observation_id
```

On a server that serializes statements, only one candidate can advance the slot at a given instant. A losing writer
re-reads the latest row and retries with a later timestamp. The note observation is the linearization point; linked
edges use its confirmed timestamp.

This guarantee depends on the server execution model. A connection pool that permits concurrent stale snapshots does
not provide the same same-slot semantics merely because it implements `SqlConn`. Keep shared mutable stores on a
serialized writer or provide equivalent transaction behavior.

## Proven scope

The repository demonstrates:

- same-process concurrent ledger writes through one cached instance;
- alias-aware initialization and isolated scientific ownership;
- cross-process memory and graph mutation through a DuckNNG-owned store;
- parameterized remote SQL, durable job claims, and snapshot-based replay across machines.

See [blackboard-shared.qmd](../examples/patterns/blackboard-shared.qmd),
[ducknng-rpc-mutate.qmd](../examples/patterns/ducknng-rpc-mutate.qmd),
[nng-job-runner.qmd](../examples/patterns/nng-job-runner.qmd), and
[pattern-ssh-remote-worker.mjs](../scripts/pattern-ssh-remote-worker.mjs).

These proofs establish the storage and execution mechanics. A production deployment still owns worker lifecycle,
input staging, CAS placement, credentials, authorization, TLS, monitoring, backup, and recovery.
