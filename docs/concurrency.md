---
type: Reference
title: Concurrent memory — running the store over a ducknng server
description: "Read before running pi-bio-agent memory across projects, processes, agents, or machines. Explains the three store access modes and how to inject a server-backed store."
tags: [memory, store, concurrency, ducknng, sharing]
---

# Concurrent memory: inter-project / inter-actor / inter-process / inter-machine

The one temporal store (`bio_observations` in a DuckDB, `src/hosts/bio-store.ts`) is where memory, facts, and runs
live. Two different concurrency axes matter:

1. **Within one Node/Pi process**, DuckDB requires concurrent connections to one file to come from one database
   instance. OS file locks do not protect against two instances in the same process. `openBioStore` therefore uses one
   process-wide `DuckDBInstanceCache` and gives each hook/tool its own connection; schema bootstrap DDL is serialized
   per file. Cache and initialization keys canonicalize symlinks and existing hard-link aliases. Opening the same
   file repeatedly with `DuckDBInstance.create(path)` is unsafe and can silently lose writes or corrupt the database.
2. **Across processes**, the local file remains a process-exclusive writer. While one process holds it read-write,
   another process gets `IO Error: Could not set lock … Conflicting lock` rather than blocking. A server-backed
   store is still the required authority for concurrent processes or hosts.

## Three access modes

| Mode | Opener | Semantics |
|---|---|---|
| **Single process, concurrent tools/hooks** | `openBioStore(cwd)` (default) | Independent connections share one process-cached native instance for the resolved project-local file. Concurrent appends are preserved; callers close their own handles promptly. |
| **Best-effort cross-process contention** | `tryOpenBioStore(cwd)` | Same-process opens use the cache. A lock held by another process returns **null** so a reader/logger degrades; corruption/permissions/disk errors still throw. Used by the recall index and run log. `isBioStoreLocked(err)` is the discriminator. |
| **Cross-process/cross-host sharing** | a **server-backed store** injected through the host's `openStore` seam | One database service is the writer authority. `createSqlConnHttpClient` / `createSqlConnHttpServer` provide a parameterized, authenticated reference transport with serialized execution; ducknng RPC provides the NNG transport lane. Same-slug writes require the serialized execution model described below. |

`tryOpenBioStore` only makes a local-file deployment degrade gracefully when another process owns the file. It is
**not** the multi-process concurrency mechanism: for that, move the store behind the server seam. The CLI also
rejects a `--ledger` path that resolves to the scientific `--db` path: execution and required evidence must not share
one catalog accidentally merely because the process cache makes a second connection possible.

## Scientific database ownership

The ledger and a scientific run have different lifetimes. Ledger callers overlap, use one cached instance, and own
independent connections. A scientific run may load a different native-extension set from the next run; retaining its
instance across DuckHTS and DuckNNG phases caused a downstream workflow to hang. `runAndPersist` therefore creates
and closes an isolated instance per scientific run. File-backed scientific runs targeting the same canonical path are
serialized for their whole lifetime by `withDuckDbFileExclusive`, so those isolated instances never overlap;
`:memory:` runs remain isolated and concurrent. A process-wide ownership-mode guard also rejects any attempt to
mix a cached ledger/graph owner with an isolated scientific owner for one file. Symlink, dangling-symlink, and
existing hard-link aliases use the same serialization and ownership key. Regression coverage is in
[`duckdb-node-api.test.ts`](../test/duckdb-node-api.test.ts),
[`bio-store.test.ts`](../test/bio-store.test.ts), and the distinct-replay Pi case in
[`pi-extension.test.ts`](../test/pi-extension.test.ts).

## Native DuckDB package compatibility

Pi loads extensions into one Node process. On Linux, native addons from different package-local `node_modules`
trees all request the same `libduckdb.so` SONAME; the first loaded library can satisfy a later, different
`duckdb.node` addon. That is an unsupported ABI mix. The DuckDB adapter compares the installed
`@duckdb/node-api` core version with `version()` from the loaded native library before opening a database and fails
with an alignment/restart instruction on mismatch. First-party packages pin the same node-api version. This guard
contains failure; it does not make mixed native versions supported.

## Running over a ducknng server (or any host-supplied server `SqlConn`)

The extension takes an injectable store opener:

```ts
createBioExtension({ author: "agent:worker-3", openStore: myServerStore });
```

`openStore(cwd)` returns a `BioStore` = `{ conn: SqlConn, close() }`. Because every memory op (`remember`,
`recall`, `listMemory`, …) and every run recorder is written against the `SqlConn` port (`all` / `run`), a
server-backed `conn` is structurally a drop-in. `createDucknngSqlConn` routes `run(sql, params)` and
`all(sql, params)` through ducknng's typed Arrow-parameter RPC helpers to a `ducknng_start_server`; another host
may inject a different service. The client opens only a throwaway `:memory:` DuckDB to reach the RPC functions: it
owns **no** shared state, holds
**no** file lock; the *server* is the single writer.

**This mode is an executable example: [memory-over-ducknng.qmd](../examples/patterns/memory-over-ducknng.qmd)**
(`npm run pattern:memory-over-ducknng`). It starts a DuckNNG
server owning the store and spawns **two separate agent processes**; `agent:A` `remember`s and `agent:B` (a
distinct OS process) `recall`s it: `"null variant in a LoF gene" by agent:A`, attributed, **no file lock**. The
memory-store functions are reused unchanged: they take a `SqlConn`, and there the conn routes over RPC:

```ts
const conn = createDucknngSqlConn({
  client: duckdbNodeConn(throwawayClient),
  url,
  tlsConfigId,
});
```

Values are carried as one typed Arrow `STRUCT`; quotes and `?` characters remain values, not SQL text. The adapter
uses the same canonical input mapping as `duckdbNodeConn`: JavaScript numbers are `DOUBLE`, 64-bit bigints are
`BIGINT`, larger bigints are `HUGEINT`, and bytes/lists/records are typed recursively. Heterogeneous lists and
empty records have no single inferable DuckDB input type and fail before transport. The package-level HTTP transport
remains the JSON-wire reference with bounded request/response bodies
and required bearer or authorization policy. Ducknng provides native TLS/mTLS handles from generated self-signed
material, in-memory PEM, or files, plus peer-identity allowlists. Query sessions can execute mutating SQL, so a host
must authorize `query_open` as deliberately as unary `exec`; disabling `exec` alone is not a read-only policy.
Hosts select the handle and admission policy when starting the service (see
[`resources-and-tool-specs.md`](./resources-and-tool-specs.md#multi-agent-by-attribution-authorization-stays-the-hosts-job)).

Because every row carries its **author** (`source`, part of observation identity) and an **as-of** time, a shared
store stays attributed: two actors writing the same memory slug become two attributed revisions, not a silent
clobber. A model host decides which revisions enter a worker's context.

> **Concurrent same-slug writes are linearized by a compare-and-set.** `remember`/`forget`
> write the note/tombstone with `insertObservationIfSlotMax` (`src/duckdb/observations.ts`): a single
> `INSERT … SELECT … WHERE NOT EXISTS(a row for the slot at recorded_at ≥ the computed instant) … RETURNING`. Because
> it is **one atomic statement**, on the server's serialized execution lane (ducknng's default
> `shared_serialized_connection`) it commits only if the slot's max has not moved since we read it; a concurrent
> client that advanced the slot fails the precondition, so we re-read and retry with a strictly-later instant. No two
> revisions can share a `recorded_at`, so "current" is never an `observation_id DESC` tiebreak. `withSlotLock` stays
> as an in-process optimization (it makes the CAS succeed first try); linked edges then write at the note's
> confirmed-unique instant, so the note is the linearization point. Verified live: 8 and 32 concurrent same-slot
> writers over a ducknng server each produced that many distinct, ordered revisions, no ties, no lost writes.
> **Caveat:** this relies on the serialized execution model (the default). Under a concurrent connection pool
> (`request_connection`) the precondition could read a stale snapshot, so keep the server on the serialized model
> for shared same-slug writes.

## What is proven

The transport is pattern-driven end to end:

- [blackboard-shared.qmd](../examples/patterns/blackboard-shared.qmd): **four distinct OS processes** coordinate a diamond DAG through **one shared
  table on a ducknng server**; no process opens the db file, no coordinator, and the pub/sub order emerges from the
  shared writes. (Run: `npm run pattern:blackboard-shared`.)
- [ducknng-rpc-mutate.qmd](../examples/patterns/ducknng-rpc-mutate.qmd): `UPDATE` / `DELETE` / `ON CONFLICT` upsert run on the **server's native
  DuckDB** (mutate-in-place shared state: exactly what supersession/tombstones need), exec opt-in.
- [nng-job-runner.qmd](../examples/patterns/nng-job-runner.qmd): a separate worker process writes a `job:<id>:status` observation over RPC that
  the coordinator reads back with the same `observationAsOfKey`: a language-agnostic distributed backend.
- `npm run pattern:ssh-remote-worker`: packs the library, installs it in a fresh directory on an SSH host, sends an
  authenticated remote `SqlConn` through a reverse tunnel, claims a durable job, and reproduces a CAS-backed run
  from its manifest snapshot plus staged data. The original manifest is absent; receipt and result digests match.

The local file is the default for one project. Cross-process scripts prove that a serialized ducknng server can own
the mutable DuckDB state while separate processes communicate over RPC. The HTTP reference and SSH pattern prove
parameterized cross-host queue/ledger composition. A production workbench still operates worker lifecycle, input
staging, CAS placement, credentials, and deployment policy. It terminates TLS for the HTTP reference or configures
ducknng's native in-memory/file-backed TLS handle for an NNG deployment.
