# NEWS

Changes to **pi-bio-agent**, newest first (GNU/R changelog convention). Pre-1.0: the
API and manifest schema may still move. The roadmap ([`docs/roadmap.md`](docs/roadmap.md))
is the plan of record; [`docs/refinments.md`](docs/refinments.md) tracks open items.

# pi-bio-agent (development version)

## Concurrency, security, and correctness

- Typed memory links are now canonicalized and validated at the public SDK write boundary before DuckDB is touched;
  recalled revisions and temporal graph edges therefore cannot disagree about a target or predicate. A live Quarto
  pattern runs separate writer and reader Pi agents, then verifies their session trajectories, history, and graph.
- Concurrent same-slug memory writes are now **linearized** by a compare-and-set
  (`insertObservationIfSlotMax`): one atomic `INSERT … WHERE NOT EXISTS(row ≥ instant)
  … RETURNING` that, on ducknng's serialized lane, commits only if the slot has not
  advanced, else re-reads and retries. `remember` / `forget` route through it. Verified
  live at 8 and 32 concurrent writers, no ties or lost writes (requires the serialized
  execution model; see [`docs/concurrency.md`](docs/concurrency.md)).
- Read-only SQL guard rejects the dynamic-SQL executors `query()` / `query_table()` in
  every spelling (bare, quoted, catalog-qualified), parser-based via `json_serialize_sql`.
- Cache-memoization hermeticity proven by physical-plan + AST introspection, retiring a
  leaky regex denylist.
- Networked-adapter response byte cap enforced on both the streaming and non-streaming paths.

## Documentation

- Consolidated the conceptual model into one architecture checksum and one lineage reference; removed overlapping
  design histories, status ledgers, and the speculative core clinical document. Memory documentation now describes
  the implemented single `bio_observations` source of truth without proposing a second memory system.
- The clinical-genomics narrative is now an executable downstream application QMD. It runs the hermetic eight-step
  workflow, exercises transient DuckNNG/VEP retry, verifies exact checkpoint resume, and renders bounded evidence.
- Generic topology, shared-state, SDK-host, skill-only, and map/reduce examples now execute their implementation
  directly in QMD files. Copied wrapper scripts and the catch-all "bring it home" proof were removed. Example pages
  distinguish contract mechanics, live compatibility, applications, and biomedical validity.
- The Quarto engine has one generated workspace artifact and its own README is executable QMD. Private workspace
  packages now consume the root checkout in lockstep instead of pinned historical Git revisions.

- README redesigned demo-first, with a live NNG-topology demo (a worker reporting job
  status over ducknng RPC into the ledger) and re-rendered with real output. The render
  is now hermetic (the render agent is read-only, so a render cannot mutate the repo).
- Docs and example READMEs de-staled against the current shape (dropped a fictional
  backend-zoo type, quack as a current transport, pynng as lineage, proposed-vs-built
  drift). Em-dash density cut about 90% across docs (README 87 → 15).
- Dropped a stray committed genomic index; roadmap rewritten for length.

## Substrate (foundational)

- One temporal store: memory notes, skills, facts, and run records are append-only,
  as-of, attributed observations in a single `bio_observations` DuckDB store, a
  Datomic-style immutable time-indexed fact log.
- Content-addressed storage (CAS) with an ActionCache (input → output CASID) and a
  run-object DAG for hash dedup and no-recompute replay.
- SQL-native network: `ducknng_ncurl_table` composes an HTTP call and parses JSON into a
  table, so a new REST / GraphQL / MCP endpoint is a manifest, not new code. `http.get`
  is the injected-fetch fallback (fail-closed).
- Out-of-process compute: `compute.run` runs R / Python / shell over Arrow IPC with
  timeouts, output caps, process-group kill, and environment attestation; declared file
  outputs are captured into CAS.
- Reproducibility: runtime-agnostic environment identity, a `replay.json` seed, and
  `reproduceRun()` (reproduced / diverged / not_reproducible, never fake confidence).

## Flagships

- Rare high-impact variants: the abstention walking skeleton (a SQL filter, not a bespoke
  skill; "no frequency data" is not "rare").
- coloc: multi-tissue post-GWAS colocalization over Arrow IPC.
- WGS chr22: ClinVar region annotation live over HTTP via `duckhts` + ducknng.

## Governance

- **Coloc records its judgment (roadmap 4.1).** The production `examples/coloc` run now records its
  per-tissue `coloc.abf` posteriors as time-versioned KG facts: every posterior a scalar observation and
  the thresholded PP.H4 call an edge into `bio_edges_as_of`. The mapping lives once in
  `src/producers/coloc-record.ts` (shared by the example CLI `examples/coloc/record.mjs` and the test) and
  uses only the generic `recordObservation` — coloc is one producer, no `PP.Hk` logic in `src/core`.
- Durable `declare → validate → test → record → activate → rollback` with a park + resume
  approval gate; the human or policy sign-off is hosted, not computed.
