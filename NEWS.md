# NEWS

Notable changes to **pi-bio-agent**, newest first. Pre-1.0: the API and manifest
schema may still change; the roadmap ([`docs/roadmap.md`](docs/roadmap.md)) is the
plan of record and [`docs/refinments.md`](docs/refinments.md) tracks open items.

## Unreleased

### Substrate
- **One temporal store.** Memory notes, skills, facts, and run records are
  append-only, as-of, attributed observations in a single `bio_observations`
  DuckDB store — a Datomic-style immutable time-indexed fact log.
  `remember` / `recall(asOf)` / `memoryHistory` / `forget`; `[[wikilinks]]`
  project into an as-of graph.
- **Content-addressed storage (CAS).** When the host injects a `cas`, result /
  receipts / replay bytes live outside the DB by digest; an LLVM-style
  ActionCache (input → output CASID) plus a run-object DAG give hash dedup and
  no-recompute replay.
- **SQL-native network.** `ducknng_ncurl_table` composes an HTTP call
  (URL / headers / body) and parses JSON → table inside a `duckdb.sql_materialize`
  query — a new REST / GraphQL / MCP endpoint is a *manifest*, not new code.
  `http.get` is the injected-fetch fallback (fail-closed, host opt-in).
- **Out-of-process compute.** `process.compute` runs R / Python / shell over
  Arrow IPC with timeouts, output caps, process-group kill, and environment
  attestation; declared file outputs are captured into CAS.
- **Reproducibility.** Runtime-agnostic environment identity, a `replay.json`
  seed, and `reproduceRun()` (reproduced / diverged / not_reproducible — never
  fake confidence).

### Flagships
- **Rare high-impact variants** — the abstention walking skeleton (a SQL filter,
  not a bespoke skill; "no frequency data" ≠ rare).
- **coloc** — multi-tissue post-GWAS colocalization over Arrow IPC (DATA + COMPUTE).
- **WGS chr22** — ClinVar region annotation live over HTTP via `duckhts` + ducknng.

### Governance
- Durable `declare → validate → test → record → activate → rollback` with a
  park + resume approval gate — the human / policy sign-off is hosted, not computed.

### Security & correctness
- Read-only SQL guard hardened with a parser-based (`json_serialize_sql`) check
  that rejects the dynamic-SQL executors `query()` / `query_table()` in every
  spelling (bare, quoted, catalog-qualified).
- Hermeticity for cache memoization proven by physical-plan + AST introspection,
  retiring a leaky regex denylist.
- Networked-adapter response byte cap enforced on both the streaming and
  non-streaming paths.
- Concurrent same-slug writes to a server-backed store are now **linearized** by
  a compare-and-set (`insertObservationIfSlotMax`): one atomic `INSERT … WHERE
  NOT EXISTS(row ≥ instant) … RETURNING` that, on ducknng's serialized lane,
  commits only if the slot has not advanced, else re-reads and retries. Verified
  live at 8 and 32 concurrent writers with no ties or lost writes. `remember` /
  `forget` route through it. (Requires the serialized execution model; see
  [`docs/concurrency.md`](docs/concurrency.md).)
