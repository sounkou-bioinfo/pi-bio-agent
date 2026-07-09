# Compute.run For R/Python/bash/Process Work

`compute.run` is for work that SQL is poor at: R models, Python packages, command-line bioinformatics tools, report
generators, or other processes. It is a manifest resolver, not an ambient escape hatch.

Compute is host-granted. A run fails closed unless the host injects a `ComputeRunner`. The plain CLI binds the local
process runner only when `--compute local` is present; declared file outputs also need `--cas-root`.

## Table Result

```json
{
  "schema": "pi-bio.manifest.v1",
  "id": "compute-run",
  "version": "0.1.0",
  "title": "Out-of-process compute",
  "provides": {
    "resolvers": [
      {
        "id": "duckdb.file_scan",
        "version": "0.1.0",
        "title": "DuckDB file scan",
        "description": "Read a delimited file into a table.",
        "output": { "mode": "table" }
      },
      {
        "id": "compute.run",
        "version": "0.1.0",
        "title": "Out-of-process compute",
        "description": "Run a process over Arrow IPC input and read Arrow IPC output as a table.",
        "output": { "mode": "table" }
      }
    ],
    "resources": [
      {
        "id": "points",
        "title": "Input points",
        "kind": "virtual",
        "resolver": "duckdb.file_scan",
        "params": { "path": "data/points.csv", "table": "points" }
      },
      {
        "id": "lm_fit",
        "title": "OLS regression",
        "kind": "virtual",
        "resolver": "compute.run",
        "params": {
          "table": "lm_fit",
          "inputSql": "SELECT x, y FROM points",
          "command": ["Rscript", "./compute.R"],
          "timeoutMs": 60000
        }
      }
    ]
  }
}
```

Semantics:

- `inputSql`: read-only SQL producing Arrow IPC input for the child process.
- `command`: argv executed by the host compute runner, resolved relative to the manifest directory for `./...`.
- `table`: output table name. The child writes Arrow IPC output that becomes this table.
- `timeoutMs`: host-enforced timeout hint.

## Declared File Outputs

Bioinformatics tools often produce files: reports, plots, VCF/BAM side outputs, logs. Declare outputs so the host can
capture them into CAS and receipts.

```json
{
  "id": "summary",
  "title": "Summary table plus artifacts",
  "kind": "virtual",
  "resolver": "compute.run",
  "params": {
    "table": "summary",
    "inputSql": "SELECT x FROM values",
    "command": ["Rscript", "./summarize.R"],
    "outputs": [
      { "name": "rows_csv", "path": "rows.csv", "kind": "table" },
      { "name": "report", "path": "report.txt", "kind": "file" }
    ],
    "timeoutMs": 120000
  }
}
```

Declared outputs are evidence. Do not hide important output files outside the declared `outputs` list.

```sh
pi-bio-agent query compute-manifest.json \
  --db :memory: \
  --compute local \
  --cas-root .pi/bio-agent/cas \
  --sql "SELECT * FROM summary"
```

## When To Use Compute

Use `compute.run` when:

- a real R/Python/bash/tool process is needed;
- package/environment behavior matters and should be receipted;
- the output is a file/report/plot that should be captured;
- SQL is only the data contract into and out of the process.

Do not use compute for simple filtering, joins, grouping, JSON extraction, or graph walks. Those belong in DuckDB SQL.
