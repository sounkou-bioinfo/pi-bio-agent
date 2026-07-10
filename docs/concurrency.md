---
type: Reference
title: Concurrent memory — running the store over a ducknng server
description: "Read before running pi-bio-agent memory across projects, processes, agents, or machines. Explains the three store access modes and how to inject a server-backed store."
tags: [memory, store, concurrency, ducknng, sharing]
---

# Concurrent memory: inter-project / inter-actor / inter-process / inter-machine

The one temporal store (`bio_observations` in a DuckDB, `src/hosts/bio-store.ts`) is where memory, facts, and runs
live. DuckDB's local-file store is a **process-exclusive writer**: while one process holds it open read-write, any
*other process* that opens the same file gets `IO Error: Could not set lock … Conflicting lock` (verified: cross-process open throws in ~10 ms, it does **not** block). That is correct for a single project run serially,
but it is the wrong substrate for concurrent actors. This page maps the proven mechanics and remaining host
integration.

## Three access modes

| Mode | Opener | Semantics |
|---|---|---|
| **Single project, serial** | `openBioStore(cwd)` (default) | the project-local file. Owner's open: **throws** on a lock conflict (a memory write must not be silently dropped). Runs share it open→write→close in sequence. |
| **Best-effort read under contention** | `tryOpenBioStore(cwd)` | returns **null** on a lock conflict (a concurrent agent holds it) so a reader/logger degrades instead of failing; a *real* error (corruption/permissions) still throws. Used by the always-on recall index and the run-log: they are conveniences, not hard dependencies. `isBioStoreLocked(err)` is the discriminator. |
| **Cross-process sharing** | a **server-backed store** injected through the host's `openStore` seam | one database service is the writer authority. `createSqlConnHttpClient` / `createSqlConnHttpServer` provide a parameterized, authenticated reference transport with serialized execution; ducknng RPC provides the NNG transport lane. Same-slug writes require the serialized execution model described below. |

`tryOpenBioStore` only makes a *single-file* deployment degrade gracefully. It is **not** how you get real
concurrency: for that you move the store to a server.

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

**This mode is a RUNNABLE example: [`scripts/memory-over-ducknng.mjs`](../scripts/memory-over-ducknng.mjs)**
(`node scripts/memory-over-ducknng.mjs`, [evidence](../scripts/memory-over-ducknng.md)). It starts a ducknng
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

The transport is dogfooded end to end:

- `scripts/blackboard-shared.mjs`: **four distinct OS processes** coordinate a diamond DAG through **one shared
  table on a ducknng server**; no process opens the db file, no coordinator, and the pub/sub order emerges from the
  shared writes. (Run: `node scripts/blackboard-shared.mjs`.)
- `scripts/ducknng-rpc-mutate.mjs`: `UPDATE` / `DELETE` / `ON CONFLICT` upsert run on the **server's native
  DuckDB** (mutate-in-place shared state: exactly what supersession/tombstones need), exec opt-in.
- `scripts/nng-job-runner.mjs`: a separate worker process writes a `job:<id>:status` observation over RPC that
  the coordinator reads back with the same `observationAsOfKey`: a language-agnostic distributed backend.
- `npm run dogfood:ssh-remote-worker`: packs the library, installs it in a fresh directory on an SSH host, sends an
  authenticated remote `SqlConn` through a reverse tunnel, claims a durable job, and reproduces a CAS-backed run
  from its manifest snapshot plus staged data. The original manifest is absent; receipt and result digests match.

The local file is the default for one project. Cross-process scripts prove that a serialized ducknng server can own
the mutable DuckDB state while separate processes communicate over RPC. The HTTP reference and SSH dogfood prove
parameterized cross-host queue/ledger composition. A production workbench still operates worker lifecycle, input
staging, CAS placement, credentials, and deployment policy. It terminates TLS for the HTTP reference or configures
ducknng's native in-memory/file-backed TLS handle for an NNG deployment.
