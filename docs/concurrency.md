---
type: Reference
title: Concurrent memory — running the store over a ducknng/quack server
description: "Read before running pi-bio-agent memory across projects, processes, agents, or machines. Explains the three store access modes and how to inject a server-backed store."
tags: [memory, store, concurrency, ducknng, sharing]
---

# Concurrent memory: inter-project / inter-agent / inter-process / inter-machine

The one temporal store (`bio_observations` in a DuckDB, `src/hosts/bio-store.ts`) is where memory, facts, and runs
live. DuckDB's local-file store is a **process-exclusive writer**: while one process holds it open read-write, any
*other process* that opens the same file gets `IO Error: Could not set lock … Conflicting lock` (verified —
cross-process open throws in ~10 ms, it does **not** block). That is correct for a single project run serially,
but it is the wrong substrate for concurrent agents. This page is the map of how to run concurrently.

## Three access modes

| Mode | Opener | Semantics |
|---|---|---|
| **Single project, serial** | `openBioStore(cwd)` (default) | the project-local file. Owner's open — **throws** on a lock conflict (a memory write must not be silently dropped). Runs share it open→write→close in sequence. |
| **Best-effort read under contention** | `tryOpenBioStore(cwd)` | returns **null** on a lock conflict (a concurrent agent holds it) so a reader/logger degrades instead of failing; a *real* error (corruption/permissions) still throws. Used by the always-on recall index and the run-log — they are conveniences, not hard dependencies. `isBioStoreLocked(err)` is the discriminator. |
| **Concurrent (the real answer)** | a **server-backed store** injected via the extension's `openStore` seam | one **DuckDB server** is the single writer; many clients read/write through it over RPC — **no file lock, so no contention**. This is how inter-project / inter-agent / inter-process / inter-machine memory works. |

`tryOpenBioStore` only makes a *single-file* deployment degrade gracefully. It is **not** how you get real
concurrency — for that you move the store to a server.

## Running over a ducknng (or quack) server

The extension takes an injectable store opener:

```ts
createBioExtension({ author: "agent:worker-3", openStore: myServerStore });
```

`openStore(cwd)` returns a `BioStore` = `{ conn: SqlConn, close() }`. Because every memory op (`remember`,
`recall`, `listMemory`, …) and every run recorder is written against the `SqlConn` port (`all` / `run`), a
server-backed `conn` is a drop-in: route its `run(sql)` and `all(sql)` through the **owned ducknng** RPC
(`ducknng_run_rpc` / `ducknng_query_rpc`) to a `ducknng_start_server`, or through a **duckdb quack** server. The
client opens only a throwaway `:memory:` DuckDB to reach the RPC functions — it owns **no** shared state, holds
**no** file lock; the *server* is the single writer.

**This mode is a RUNNABLE example: [`scripts/memory-over-ducknng.mjs`](../scripts/memory-over-ducknng.mjs)**
(`node scripts/memory-over-ducknng.mjs`, [evidence](../scripts/memory-over-ducknng.md)). It starts a ducknng
server owning the store and spawns **two separate agent processes**; `agent:A` `remember`s and `agent:B` (a
distinct OS process) `recall`s it — `"null variant in a LoF gene" by agent:A`, attributed, **no file lock**. The
memory-store functions are reused unchanged: they take a `SqlConn`, and there the conn routes over RPC:

```js
function ducknngConn(local, url) {              // `local` = a throwaway :memory: DuckDB with ducknng loaded
  return {
    run: async (sql, params) => { await local.runAndReadAll(`SELECT * FROM ducknng_run_rpc('${url}', ?, 0::UBIGINT)`, [inline(sql, params)]); },
    all: async (sql, params) => (await local.runAndReadAll(`SELECT * FROM ducknng_query_rpc('${url}', ?, 0::UBIGINT)`, [inline(sql, params)])).getRowObjects(),
  };
}
```

**Parameters**: ducknng RPC sends a SQL *string*, so the params are inlined into it (escape values, or use
server-side prepared statements). The example inlines with escaping as a dogfood; a production `openStore` over
ducknng does robust param handling — host code, not a library default. **Security is opt-in**: the server only accepts writes after `ducknng_register_exec_method(...)`,
with mTLS / peer-allowlists ([[honest-boundary]]); reads need no extra grant.

Because every row carries its **author** (`source`, part of observation identity) and an **as-of** time, a shared
store stays attributed and consistent — two agents writing the same memory slug are two attributed revisions, not
a clobber. That is Fugu's inter-workflow shared memory (report §3.2.2) made literal.

## This is proven, not aspirational

The transport is dogfooded end to end:

- `scripts/blackboard-shared.mjs` — **four distinct OS processes** coordinate a diamond DAG through **one shared
  table on a ducknng server**; no process opens the db file, no coordinator, and the pub/sub order emerges from the
  shared writes. (Run: `node scripts/blackboard-shared.mjs`.)
- `scripts/ducknng-rpc-mutate.mjs` — `UPDATE` / `DELETE` / `ON CONFLICT` upsert run on the **server's native
  DuckDB** (mutate-in-place shared state — exactly what supersession/tombstones need), exec opt-in.
- `scripts/nng-job-runner.mjs` — a separate worker process writes a `job:<id>:status` observation over RPC that
  the coordinator reads back with the same `observationAsOfKey` — a language-agnostic distributed backend.

So: the local file is the default for one project; a ducknng/quack **server** is the store when memory must be
shared across projects, processes, agents, or machines — the same owned transport the topology scripts already use.
