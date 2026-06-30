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
