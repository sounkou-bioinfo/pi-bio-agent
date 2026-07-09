# Query, Run, Bindings, And Operations

The CLI wraps the same runner used by the Pi extension.

## Ad-Hoc Query

Use `query` when the agent is composing SQL for a user question. This is the normal path for new questions: manifests
declare tables; ad-hoc SQL asks the question.

Find candidate manifests first when you do not already know the path:

```sh
pi-bio-agent catalog --query uniprot
pi-bio-agent describe <manifestPath>
```

```sh
pi-bio-agent query <manifest.json> \
  --db <path|:memory:> \
  --sql "<SELECT/WITH/DESCRIBE/SUMMARIZE>"
```

Optional flags:

- `--resources a,b`: materialize only selected resources.
- `--bindings '{"case_id":"case-1"}'`: bind DuckDB session variables used as `getvariable('case_id')`.
- `--init-sql "INSTALL duckhts FROM community; LOAD duckhts;"`: host provisioning SQL run before resource resolution.
- `--ledger auto`: record the run into the project observation ledger.
- `--run-id id`: caller-chosen run identity for correlation, idempotent orchestration, or external audit references.
- `--network fetch`: explicitly bind the capped WHATWG-fetch adapter for `http.get`.
- `--compute local`: explicitly bind the local async process runner for `compute.run`.
- `--cas-root <dir>`: capture results and declared process outputs in a filesystem CAS.

## Host Inputs In The Plain CLI

The plain CLI is a visible host surface, not a full application host.

- Ordinary parameters: pass JSON with `--bindings`; manifests and SQL read them with `getvariable('name')`.
- SQL templates: prefer `getvariable(...)` inside manifest SQL or operation SQL. Do not string-concatenate user values
  into SQL text when a binding works.
- DuckDB provisioning: use `--init-sql` for non-secret host bootstrap such as `INSTALL/LOAD` extension statements or
  non-secret `SET` statements.
- Ledger: use `--ledger auto` to record a run into `.pi/bio-agent/store.duckdb`.
- Remote cache isolation: use `--remote-cache-scope <scope>` when a host wants scoped shared HTTP/CAS reuse.

The plain CLI binds no network or process capability by default. `--network fetch` and `--compute local` are explicit
grants; the operating-system/container policy remains the real isolation layer. Use `--cas-root` for declared file
outputs. Host-owned values can come from `--protected-bindings-file`; DuckDB startup settings from
`--duckdb-config-file`; secret-free policy receipts from `--host-receipts-file`. The CLI can also commission declared
ducknng HTTP profiles with `--ducknng-http-profile`; credential values come from a named environment variable or
stdin and only the redacted profile receipt is pinned. Keep secrets out of manifests, `--bindings`, and shell history.

Inspect first:

```sh
pi-bio-agent query manifest.json --db :memory: --sql "DESCRIBE variants"
pi-bio-agent query manifest.json --db :memory: --sql "SUMMARIZE variants"
pi-bio-agent query manifest.json --db :memory: --sql "SELECT * FROM variants LIMIT 5"
```

## Declared Operation

Use `run` when the manifest already declares a stable operation. This is for repeated workflows, regression fixtures,
or published output contracts, not for every new natural-language question.

Before writing or trusting an operation, inspect the resource tables the same way you would for an ad-hoc query:

```sh
pi-bio-agent query <manifest.json> --db :memory: --sql "DESCRIBE variants"
pi-bio-agent query <manifest.json> --db :memory: --sql "SUMMARIZE variants"
pi-bio-agent query <manifest.json> --db :memory: --sql "SELECT * FROM variants LIMIT 5"
```

Then promote the known-good SQL into the manifest operation.

```sh
pi-bio-agent run <manifest.json> \
  --db <path|:memory:> \
  --operation variants.summary \
  --bindings '{"case_id":"case-1"}'
```

Operation shape:

```json
{
  "id": "variants.summary",
  "version": "0.1.0",
  "title": "Variant summary",
  "description": "Summarize declared variant rows.",
  "transport": "duckdb.sql",
  "inputSchema": { "type": "object" },
  "sql": {
    "sqlTemplate": "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence",
    "readOnly": true,
    "requiredResources": ["variants"]
  }
}
```

Only `duckdb.sql` operations are executable today. For most new questions, prefer `query`; promote to an operation
only when the workflow is stable and tested.

## Output

Successful CLI calls print JSON with:

- `runId`
- `status`
- `rowCount`
- `runDir`
- `artifacts`
- `rows`

Report the SQL or operation id plus the rows. Do not present model memory as a biomedical source.
