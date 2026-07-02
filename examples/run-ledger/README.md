# run-ledger — the substrate's own provenance, as a SQL table

Where does everything the substrate runs get stored? Every run persists a record under
`.pi/bio-agent/runs/<runId>/run.json` (spec, status, timestamps, an event log, resolution receipts), and — when
a store/CAS is granted — a `run:<id>` fact in the one temporal ledger plus the result/receipts/replay bytes in
CAS. This manifest reads the **file** records back with DuckDB `read_json`, so the run graph is itself a queryable
table: the agent (or a UI) inspects its own provenance with the same SQL it uses for data.

```sh
pi-bio-agent query examples/run-ledger/manifest.json --db :memory: \
  --sql "SELECT tool, status, count(*) AS runs, min(createdAt) AS first_run FROM run_ledger GROUP BY 1, 2 ORDER BY runs DESC"
```

The numbers reflect *this* project's local `.pi/bio-agent/runs/` at query time (the directory is gitignored, so a
fresh clone shows only the runs it produces). Because the run graph is a table, a chart is a query — a
grammar-of-graphics layer like posit's [`ggsql`](https://github.com/posit-dev/ggsql) draws the run timeline or a
manifest→run→receipt DAG straight off `run_ledger`. This is the file view; the same runs are also queryable as
`run:<id>` facts in the temporal store (`pi-bio-agent memory` reads memory; the run facts live beside them).

Not a recorded/gated example (its counts are the live local ledger, which drifts by design), so it carries no
pinned run block — unlike the recorded examples whose `check:examples` re-runs and diffs their output.
