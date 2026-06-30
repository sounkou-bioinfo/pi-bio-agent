# Shared-write blackboard (pub/sub × shared writes, cross-process) — evidence

`scripts/blackboard-shared.mjs` is a **dogfood** composing two earlier ones: the decentralized **blackboard**
(pub/sub) topology of `blackboard-run.md` and the **cross-process shared-mutable db** of `quack-shared-db.md`.
Each agent is a **separate OS process** that coordinates *only* through one shared blackboard table on a `quack`
server (publish = `INSERT`, await = poll `SELECT`) — no coordinator, and no client ever opens the db file (quack
owns it; clients `ATTACH`). It uses the **same `sqlBlackboard`** the unit test uses, now genuinely cross-process.

This closes the last cell of the topology matrix: **chain** (`live-multi-agent`) / **survey** (`live-debate`) /
**pub-sub** (`blackboard-run`) / **push-pull** (`pipeline-fanout`) / **shared-write** (this).

Run: `npm run build && node scripts/blackboard-shared.mjs`

## Recorded run (2026-06-30)

```
=== SHARED-WRITE BLACKBOARD: a decentralized pub/sub DAG across SEPARATE processes via quack ===

  [server pid 2123464] quack_serve up; owns the shared blackboard table
  [agent extract pid 2123663] published (root)
  [agent qc pid 2123665] published after [extract]
  [agent annotate pid 2123664] published after [extract]
  [agent classify pid 2123666] published after [annotate, qc]
  [server] FINAL board (rows written by SEPARATE client processes): extract, qc, annotate, classify
```

**What it proves:** five distinct OS processes (one server, four agents — distinct pids) coordinated a diamond DAG
(`extract → {annotate, qc} → classify`) through ONE shared mutable table. `extract` published first because the
other three blocked on it via poll-`SELECT`; `classify` published **last** because it blocked on *both* `annotate`
and `qc` — with no coordinator and no shared file handle. The pub/sub order emerged from the shared **writes**.

## The real finding this dogfood drove

`sqlBlackboard` documented itself as "the cross-process blackboard with a quack-attached conn" — but its publish
was `INSERT … ON CONFLICT (slug) DO NOTHING`, and **quack rejects that** (`GetStorageInfo not implemented`), as it
also rejects `INSERT … SELECT … WHERE NOT EXISTS` (`multiple streaming scans`). Only plain parametrized
`INSERT … VALUES` works over quack. So the documented capability was an over-claim until this dogfood exercised
it. Fix: `publish` is now a **check-then-plain-INSERT** (first-writer-wins, idempotent re-publish) that works over
both quack and plain DuckDB; the `PRIMARY KEY` stays as the backstop. Verified by `test/sql-blackboard.test.ts`
(in-process) and this dogfood (cross-process).

## quack's write surface is APPEND-ONLY (verified against HEAD), and ducknng RPC is the mutate-in-place answer

This is **not** a 1.5.2 wart — it is architectural. quack makes the remote table a LOCAL CATALOG ENTRY, so
DuckDB's planner calls `GetStorageInfo` / `PlanUpdate` / `PlanDelete` on quack's storage shim, and at quack HEAD
(commit `29fc039`, 2026-06-30, DuckDB 1.5.4) those still `throw NotImplementedException`. So over quack:
`INSERT … VALUES` and `CREATE TABLE AS` work, but `INSERT … ON CONFLICT`, `UPDATE`, `DELETE`, and `CREATE INDEX`
do **not** — remote writes are effectively append-only. The blackboard's monotonic first-writer-wins publish is
therefore the *right fit*, not a workaround.

When you genuinely need mutate-in-place across processes (revise/expire/upsert a shared row — e.g. superseding a
fact as a judgment changes, the Phase-4 `activate`/`rollback` shape), use **ducknng RPC** instead of quack ATTACH.
`ducknng_run_rpc(url, sql, tls)` sends a SQL string to a server running NATIVE DuckDB (no catalog shim), so
`UPDATE`/`DELETE`/`ON CONFLICT` all work — verified live (a client mutated a server table to `[[1,99],[3,5]]`
via remote `UPDATE`/`DELETE`/upsert). Exec is OPT-IN — the server must `ducknng_register_exec_method(false|true)`
(the host security boundary; supports auth + peer/IP allowlists), unlike quack's open-by-ATTACH. The trade is the
ATTACH ergonomics: explicit RPC SQL strings, and no single-query local⨝remote join (fetch via `query_rpc`, then
join locally). So: **quack ATTACH = ergonomic shared APPEND; ducknng RPC = full shared mutate, opt-in & explicit.**
