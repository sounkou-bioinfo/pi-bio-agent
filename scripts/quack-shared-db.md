# quack shared-mutable-db across processes — evidence

`scripts/quack-shared-db.mjs` is a **dogfood** demonstrating the case the host-single-writer and CAS demos
deliberately avoid: **multiple agent processes sharing one LIVE MUTABLE DuckDB**, which native DuckDB forbids
(its file lock is process-exclusive-writer — a RW holder blocks all others). `quack`
([github.com/duckdb/duckdb-quack](https://github.com/duckdb/duckdb-quack)) resolves it with a client/server
protocol: one server process runs `quack_serve()` and **owns the file**; client processes (each with their own
`:memory:` db — they never open the shared file) `ATTACH` over the protocol and read **and write** the shared
table. In the substrate a client attaches via the host-owned connection-init hook (`duckdbInitSql`:
`LOAD quack; CREATE SECRET (TYPE quack, ...); ATTACH 'quack:host' AS shared`).

Run: `node scripts/quack-shared-db.mjs serve` (one terminal) + `node scripts/quack-shared-db.mjs client A`
(others, while the server holds).

## Recorded run (2026-06-29)

```
server pid 1572849: quack_serve on quack:localhost:9876; owns /tmp/quack-shared.duckdb; holding ~9s
client agentA (pid 1573056): WROTE to the shared db via quack; shared row count now = 1
client agentB (pid 1573160): WROTE to the shared db via quack; shared row count now = 2
server: FINAL shared table (rows written by SEPARATE client processes via quack):
  agentA: hello from agentA pid 1573056
  agentB: hello from agentB pid 1573160
```

**What it proves:** three distinct OS processes (server 1572849, clients 1573056 + 1573160). Both clients
**wrote** to one shared mutable database concurrently with **no lock conflict**, and `agentB` saw row count `2`
— it observed `agentA`'s write, i.e. genuinely *shared* state. This is the complement to CAS: quack = a live
shared **mutable** db (one owner, many client agents); CAS = durable **immutable** content-addressed sharing.
Together they cover the multi-agent state-sharing space across the process boundary.
