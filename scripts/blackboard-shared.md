# Shared-write blackboard (pub/sub × shared writes, cross-process) — evidence

`scripts/blackboard-shared.mjs` is a **dogfood** composing two others: the decentralized **blackboard** (pub/sub)
topology of `blackboard-run.md` and **cross-process shared state** over **ducknng RPC** (quack is dropped for the
mutable shared-state demos). Each agent is a **separate OS process** that coordinates *only* through one shared blackboard table on a
ducknng server through `createDucknngSqlConn` — publish = remote `INSERT`, await = poll remote `SELECT` until the row
appears. No coordinator, no client opens the db file, exec opt-in.

This closes the last cell of the topology matrix: **chain** (`live-multi-agent`) / **survey** (`live-debate`) /
**pub-sub** (`blackboard-run`) / **push-pull** (`pipeline-fanout`) / **shared-write** (this).

Run: `npm run build && node scripts/blackboard-shared.mjs`

## Recorded run (2026-06-30)

```
=== SHARED-WRITE BLACKBOARD over ducknng RPC: a decentralized pub/sub DAG across SEPARATE processes ===

  [server pid 2152156] ducknng server owns the shared blackboard table
  [agent extract  pid 2152230] published (root)
  [agent qc       pid 2152234] published after [extract]
  [agent annotate pid 2152231] published after [extract]
  [agent classify pid 2152237] published after [annotate, qc]
  [server] FINAL board (rows written by SEPARATE client processes): extract, qc, annotate, classify
```

**What it proves:** five distinct OS processes (one server, four agents) coordinated a diamond DAG
(`extract → {annotate, qc} → classify`) through ONE shared table over ducknng RPC. `extract` published first
because the other three polled for it via `query_rpc`; `classify` published **last** because it blocked on *both*
`annotate` and `qc` — with no coordinator and no shared file handle. The pub/sub order emerged from the shared
**writes**.

## Why ducknng, not quack (the transport decision)

A blackboard publish is **monotonic append** (first-writer-wins, one owner per slug), which is all both quack and
ducknng support. But the moment you need **mutate-in-place** across processes — `UPDATE`/`DELETE`/upsert, e.g.
superseding a fact as a judgment changes (the Phase-4 `activate`/`rollback` shape) — quack **cannot**: it makes
the remote table a local catalog entry, so DuckDB calls `GetStorageInfo`/`PlanUpdate`/`PlanDelete` on quack's
storage shim, which still `throw NotImplementedException` at quack HEAD (`29fc039`, DuckDB 1.5.4). ducknng RPC
runs the SQL string on a server with **native DuckDB** (no shim), so the full write surface works (see
`ducknng-rpc-mutate.md`: a client mutated a server table to `k1=99, k3=5` via remote `UPDATE`/`DELETE`/upsert).

So the ducknng path replaces quack here: one transport covers the whole topology matrix *and* both shared-state
shapes (append for the blackboard, mutate for a fact-superseding KG), with opt-in exec as the host security
boundary. The in-process `sqlBlackboard`
(`src/hosts/sql-blackboard.ts`) remains the single-DB transport for the deterministic unit test.
