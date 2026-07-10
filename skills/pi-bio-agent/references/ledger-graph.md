# Ledger And Graph Inspection

Runs can be recorded into the project observation ledger. The ledger stores run facts, links, memory, host events, and
graph-shaped observations in one DuckDB store.

## Record A CLI Run

Use `--ledger auto`:

```sh
pi-bio-agent query manifest.json \
  --db :memory: \
  --ledger auto \
  --sql "<WITH/SELECT ...>"
```

The output includes `runId`. The project store is `.pi/bio-agent/store.duckdb` unless the host configured another
path.

## Import A Persisted Agent Session

Pi's extension syncs Pi sessions automatically. From Codex, Pi skill-only mode, or another host, import a persisted
Pi session or Codex rollout with the CLI:

```sh
pi-bio-agent session import <session.jsonl> --format pi
pi-bio-agent session import <rollout.jsonl> --format codex
```

Omit `--format` when the first record is the normal Pi `session` or Codex `session_meta` header. Use `--db` and
`--cas-root` to target non-default stores. The raw private transcript is retained in CAS; queryable ledger rows store
content and payload digests rather than message text. A complete import has a terminal `session:<id>` / `session`
fact. Runtime events absent from JSONL cannot be reconstructed by this command.

## Inspect With DuckDB

When DuckDB CLI is available and the store is not locked:

```sh
duckdb .pi/bio-agent/store.duckdb \
  "SELECT subject_id, predicate, object_id, recorded_at, source
   FROM bio_observations
   ORDER BY recorded_at DESC
   LIMIT 20"
```

Graph edges:

```sh
duckdb .pi/bio-agent/store.duckdb \
  "SELECT from_id, predicate, to_id, attrs
   FROM bio_edges_as_of
   ORDER BY recorded_at DESC
   LIMIT 20"
```

For a specific run:

```sh
duckdb .pi/bio-agent/store.duckdb \
  "SELECT subject_id, predicate, value_json, attrs
   FROM bio_observations
   WHERE subject_id = 'run:<runId>'
   ORDER BY recorded_at"
```

## Inspect With `graph-window`

For graph-shaped rows, prefer a bounded window over dumping a neighborhood into context:

```sh
pi-bio-agent graph-window \
  --db .pi/bio-agent/store.duckdb \
  --table bio_edges_as_of \
  --start "run:<runId>" \
  --direction both \
  --limit 50
```

If `omittedCount` is nonzero, the result includes a continuation handle:

```sh
pi-bio-agent graph-window \
  --db .pi/bio-agent/store.duckdb \
  --continuation "graph-window:table=bio_edges_as_of&startId=run%3A..."
```

## Inspect In Pi

When Pi extension graph tools are available:

- `bio_graph_window` over `bio_edges_as_of` to walk run/toolcall/memory links.
- `bio_list_memory`, `bio_recall`, and `bio_walk_memory` for study notes.

For session-linked runs, query for an `executes` edge from `toolcall:<session>:<callId>` to `run:<runId>` and the
inverse `invoked_by` edge. Recorded runs also link to their manifest/resources through `uses_manifest` and
`uses_resource`.

## If The Store Is Locked

DuckDB is a process-exclusive writer. If the live agent holds `.pi/bio-agent/store.duckdb`, direct CLI inspection may
fail with a lock error. Use Pi graph tools if available, retry after the session exits, or inspect run artifacts under
`.pi/bio-agent/runs/<runId>/`.
