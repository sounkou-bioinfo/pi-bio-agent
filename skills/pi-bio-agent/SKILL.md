---
name: pi-bio-agent
description: "Use pi-bio-agent as a host-neutral substrate for agentic bioinformatics: write manifests, inspect DuckDB tables, compose read-only SQL, run pi-bio-agent query/run through the CLI or Pi tools, and avoid per-question skill sprawl. Use for Codex, ClawBio-like systems, Pi, or any agent host that needs biomedical answers from declared resources, receipts, CAS, and observations rather than model-generated facts."
---

# Pi Bio Agent

Use this skill when a bioinformatics question should become declared data plus SQL, not a bespoke script or a new
per-question skill. The substrate is host-neutral: Pi's `bio_*` tools are convenient when present, but the default
portable path is the `pi-bio-agent` CLI.

## Core Rule

The model may route, inspect schemas, write manifests, write SQL, and explain results. It is not the source of
biomedical facts. Facts must come from declared resources, deterministic compute, receipts, CAS artifacts, and
recorded observations or approvals.

## Default CLI Loop

1. Create or update a `manifest.json` that declares resources and, for repeated workflows, operations.
2. Inspect resolved tables with small read-only queries:

   ```sh
   pi-bio-agent query manifest.json --db :memory: --sql "DESCRIBE table_name"
   pi-bio-agent query manifest.json --db :memory: --sql "SUMMARIZE table_name"
   pi-bio-agent query manifest.json --db :memory: --sql "SELECT * FROM table_name LIMIT 5"
   ```

3. Answer the question with one read-only `SELECT` or `WITH` statement:

   ```sh
   pi-bio-agent query manifest.json --db :memory: --sql "<WITH/SELECT/DESCRIBE/SUMMARIZE>"
   ```

4. For stable workflows, put the SQL in a declared manifest operation and run:

   ```sh
   pi-bio-agent run manifest.json --db :memory: --operation operation.id
   ```

5. When provenance matters, add `--ledger auto` so the run becomes a `run:<id>` fact in the project observation
   store. Report the manifest path, SQL or operation id, run id, and the answer rows.

## Manifest Pattern

Start with a thin manifest. Add code only when a new reusable resolver/adapter is genuinely needed.

```json
{
  "schema": "pi-bio.manifest.v1",
  "id": "task-name",
  "version": "0.1.0",
  "title": "Task name",
  "description": "Declared resources for an agent-authored SQL answer.",
  "provides": {
    "resolvers": [
      {
        "id": "duckdb.file_scan",
        "version": "0.1.0",
        "title": "DuckDB file scan",
        "description": "Read a DuckDB-native file into a table.",
        "output": { "mode": "table" }
      }
    ],
    "resources": [
      {
        "id": "variants",
        "title": "Variants",
        "kind": "virtual",
        "resolver": "duckdb.file_scan",
        "params": { "path": "data/variants.csv", "table": "variants" }
      }
    ]
  }
}
```

For examples, inspect `examples/variant-counts/manifest.json`, `examples/rare-high-impact/manifest.json`,
`examples/connectors/clinvar-region.json`, and `examples/monarch-kg-http/manifest.json`.

## Resolver Choice

Prefer DuckDB-native surfaces:

- local tabular files: `duckdb.file_scan`
- reusable SQL projections/views: `duckdb.sql_materialize`
- HTTP-shaped data when the host grants network: `http.get` or ducknng-backed manifests
- VCF/BAM/BCF/tabix ranges when provisioned: `duckhts.read_bcf`
- graph/ontology work: load edge-shaped tables and query them with SQL

Fail clearly when the host has not granted a needed effect. Do not silently fetch, install extensions, read files, or
call network endpoints outside the manifest and host policy.

## Answering Style

Return the result and the method, not a story:

- manifest path
- SQL or operation id
- run id when available
- concise result rows or counts
- abstentions and unsupported capabilities when relevant

For rare/high-impact or clinical-style questions, treat missing evidence as an abstention unless the declared data
supports a stronger claim. Do not call missing population frequency "rare".

## Skills Are Graduation

Do not create a new skill for a new natural-language question. First solve it as manifest + SQL.

Create or update a skill only when the workflow has already stabilized across repeated use and the skill is merely a
thin playbook: where the manifest lives, which operation or query pattern to run, which fixtures prove it, and what
output contract to report. A skill must not become the biomedical computation or a hidden script pack. If the skill
needs facts, it should point back to declared resources and `pi-bio-agent query/run`.

For ClawBio-like systems, the migration path is: keep the host's intent/routing layer, replace per-question scripts
with manifests and SQL operations, and call `pi-bio-agent query/run` as the compute substrate.
