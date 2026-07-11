

# Cross-process shared MUTABLE state over ducknng RPC — evidence

`scripts/ducknng-rpc-mutate.mjs` is a **dogfood** and the **replacement
for the old quack demo** — and it does what quack *cannot*. Separate
agent **processes** mutate one shared table **in place** (`UPDATE` /
`DELETE` / `ON CONFLICT` upsert) over `ducknng_run_rpc(url, sql, tls)`.

**Why ducknng can and quack can’t (architectural, verified at quack HEAD
`29fc039` / DuckDB 1.5.4):** quack makes the remote table a **local
catalog entry**, so DuckDB’s planner calls `GetStorageInfo` /
`PlanUpdate` / `PlanDelete` on quack’s storage shim — all still
`throw NotImplementedException`. So quack remote writes are
**append-only**. ducknng instead sends a **SQL string to a server
running native DuckDB** (no shim), so the full write surface works. Exec
is **opt-in**: the server must
`ducknng_register_exec_method(false|true)` (the host security boundary,
vs quack’s open-by-ATTACH).

Run: `npm run dogfood:ducknng-rpc-mutate`

## Recorded run (2026-06-30)

    === SHARED MUTABLE STATE over ducknng RPC: separate processes UPDATE/DELETE one table (quack can't) ===

      [server pid 2150760] owns table 'shared' (seed: k1=10,k2=20); exec method registered
      [agent inserter pid 2150842] OK INSERT INTO shared VALUES (3, 30)  (rows_changed=1)
      [agent updater  pid 2150904] OK UPDATE shared SET v = 99 WHERE k = 1  (rows_changed=1)
      [agent deleter  pid 2150966] OK DELETE FROM shared WHERE k = 2  (rows_changed=1)
      [agent upserter pid 2151028] OK INSERT INTO shared VALUES (3, 5) ON CONFLICT (k) DO UPDATE SET v = excluded.v  (rows_changed=1)
      [server] FINAL shared table (mutated in place by SEPARATE client processes): k1=99, k3=5

**What it proves:** four distinct processes mutated one shared table in
place over ducknng RPC — an `UPDATE`, a `DELETE`, and an `ON CONFLICT`
upsert, none of which quack supports. The server ran each SQL string on
native DuckDB; exec was opt-in. Final state `k1=99` (updated), `k2` gone
(deleted), `k3=5` (inserted 30 → upserted 5) is exactly right. This is
the **mutate-in-place** shared-state primitive that a fact-superseding
KG — Phase-4 `activate`/`rollback`, revising/expiring facts as judgments
change — actually needs, and it’s why we **own ducknng and drop quack**:
quack gives ergonomic shared *append*; ducknng RPC gives shared
*mutate*, opt-in and explicit, on a stack we control and backport across
DuckDB versions.
