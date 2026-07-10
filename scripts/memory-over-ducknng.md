# Cross-process shared memory over a ducknng server — evidence

`npm run build && node scripts/memory-over-ducknng.mjs` — the inter-process / inter-agent memory mode of
[docs/concurrency.md](../docs/concurrency.md), run for real. A server process owns the ONE `bio_observations`
store; two **separate OS processes** remember/recall through it over the typed ducknng `SqlConn`,
**sequentially** (A writes, then B reads). This is a separate-process *sharing* smoke test — it does **not** prove
concurrent same-slug writes (those need server-side per-`statement_key` serialization; see the residue in
[docs/concurrency.md](../docs/concurrency.md)) nor persistent/inter-machine behavior (the server DB is `:memory:`).

The memory-store functions (`remember`, `recall`, `listMemory`) are reused **unchanged** — they take a `SqlConn`,
and here that conn routes over RPC instead of a local file. No agent opens the store file, so the
process-exclusive-writer lock that blocks concurrent *file* access never applies.

## Recorded run (2026-07-02)

```
=== cross-process shared memory over a ducknng server: server + two SEPARATE agent processes (sequential A→B) ===
  [server pid 355073] ducknng server owns the ONE bio_observations store
  [agent:A pid 355156] REMEMBERED 'acmg-pvs1' through the server (no file opened)
  [agent:B pid 355218] RECALLED over RPC: 'acmg-pvs1' = "null variant in a LoF gene" by agent:A | list=acmg-pvs1
  SHOWN: a SEPARATE process read another agent's attributed memory over the server — no file lock (sequential A→B, not a concurrency test).
```

`agent:B` (a distinct process) read `agent:A`'s memory, carrying `agent:A` as the author (`source` is part of
observation identity) — shared and attributed across processes. Writes are exec-opt-in on the server
(`ducknng_register_exec_method`), the host security boundary. This is the same ducknng extension the topology
scripts (`blackboard-shared`, `ducknng-rpc-mutate`, `nng-job-runner`) use.

The runnable now uses the package's `createDucknngSqlConn` adapter. Parameters cross RPC as a typed Arrow tuple and
are bound by the server's DuckDB; no SQL replacement function sits in the host.
