# pi-bio-agent

Lean, provider-agnostic bioinformatics **substrate** for Pi agents — not a pile of bespoke genomics scripts.

The bet: **manifests, SQL, resources, and ontology data are the PROGRAM; TypeScript is only the interpreter.**
A new bio question or data source is a new *manifest* (data), never a new `.ts` file. The substrate ships a
small set of generic primitives and the agent writes the SQL.

## What the substrate provides

- **Resolvers** — turn a declared resource into a DuckDB table: `duckdb.file_scan` (csv/tsv/parquet/json,
  native), `duckhts.read_bcf` (VCF/BCF), `http.get` (any REST/JSON endpoint; fetch is injected, opt-in,
  fail-closed). Each stamps a **resolution receipt** (resolver version, params digest, source snapshot).
- **Operations** — an operation is a read-only `SELECT`/`WITH` over the resolved tables; the result IS the
  report. A single guard rejects writes/DDL and any unreceipted I/O (external readers, remote URIs).
- **Runs** — `runOperation` → `run` + `result` + `receipts` (a failed run still persists an auditable
  receipt); the host writes them under `.pi/bio-agent/runs/<runId>/`.
- **Ordinal scales** — an `ordered` TermSet (ranked members) projects to a `scale_members` table, so SQL
  thresholds/compares on rank (ACMG, variant impact, clinical stage, …) with no per-scale code.
- **Graph + ontology (SemanticSQL shape)** — `bio_edges(from_id, predicate, to_id)` is the statement/edge
  base; `entailed_edge` is its transitive closure, so descendants/subsumption/graph-walk are one indexed JOIN.
  The same SQL grounds an imported ontology and walks our own graph.
- **Grounding** — two tiers feeding `decideGrounding`: a deterministic *projection* tier (exact/synonym
  match + closure, all SQL) and a *judgment* tier (fresh `http.get` candidates ranked by a model that may
  propose but never invent a CURIE — abstain below threshold).
- **Strict, fail-closed admission** — a manifest is validated against a strict allowlist; unknown/sprawl keys
  are rejected, not silently honored.

## Install in Pi

```sh
pi install git:github.com/sounkou-bioinfo/pi-bio-agent
/reload
```

## Pi tools

This list is generated from the extension's `registerTool()` calls (`npm run readme`); `npm run check`
fails if it is stale.

<!-- BEGIN GENERATED:tools (scripts/generate-readme.mjs — do not edit by hand) -->
- `bio_create_skill` — Create bio skill
- `bio_delete_study_note` — Delete bio study note
- `bio_describe_model` — Describe Pi Bio model
- `bio_list_duckdb_extensions` — List bio DuckDB extensions
- `bio_list_study_notes` — List bio study notes
- `bio_list_tool_specs` — List BioToolSpec contracts
- `bio_read_study_note` — Read bio study note
- `bio_run_operation` — Run a bio operation
- `bio_study_plan` — Plan bio study
- `bio_validate_select` — Validate bio SQL SELECT
- `bio_write_study_note` — Write bio study note
<!-- END GENERATED:tools -->

Generated project-local skills and study notes live under `.pi/bio-agent/` in the current project.

## CLI

Project study notes (under `.pi/bio-agent/study-notes`) project into the memory subgraph
(`bio_nodes`/`bio_edges`) of a DuckDB database. `sync` is a dry run unless `--write`; output and
`--json` go to stdout, usage/errors to stderr.

```sh
pi-bio-agent notes sync   --db graph.duckdb --create-schema   # dry run (counts only)
pi-bio-agent notes sync   --db graph.duckdb --write           # apply
pi-bio-agent notes report --db graph.duckdb --json            # counts + dangling/inbound rows
```

The bin is compiled to `dist/` via `npm run build` (run by `prepare`); the package also ships `src`
for Pi to consume directly.

## Design notes

See the generated [docs index](docs/INDEX.md) — one line per doc, from each doc's frontmatter
(regenerate with `npm run docs:index`; `npm run check` fails if it is stale). Start with the
[roadmap](docs/roadmap.md) and [design notes](docs/design.md).

## Development

```sh
npm install
npm run check     # typecheck + tests + docs-index staleness gate (the single gate)
```

`npm run provision:duckhts` installs the DuckHTS community extension for the `duckhts.read_bcf` resolver
(explicit; never auto-installed during `check`). Runtime Pi APIs are peer dependencies supplied by Pi itself.
