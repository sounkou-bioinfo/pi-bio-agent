# pi-bio-agent

Lean, provider-agnostic bioinformatics **substrate** for Pi agents — not a pile of bespoke genomics scripts.

The bet: **manifests, SQL, resources, and ontology data are the PROGRAM; TypeScript is only the interpreter.**
A new bio question or data source is a new *manifest* (data), never a new `.ts` file. The substrate ships a
small set of generic primitives and the agent writes the SQL.

## How it works

A resolver turns a declared resource into a DuckDB table and stamps a receipt (resolver version, params
digest, source snapshot). Today that means reading a file natively (`duckdb.file_scan` over csv/tsv/parquet/
json), a VCF/BCF (`duckhts.read_bcf`), or an HTTP/JSON endpoint (`http.get`, whose fetch is host-supplied).
An operation is then a single read-only `SELECT`/`WITH` over those tables, and whatever it returns is the
result — there is no separate report layer. A run bundles the result with its run record and the resolver
receipts (a failed run still leaves an auditable receipt), written under `.pi/bio-agent/runs/<runId>/`.

The substrate is deliberately thin: it enforces statement class (a read-only query with no writes or DDL),
manifest shape, and receipt integrity, but it is not a network or filesystem sandbox. DuckDB's remote reads,
replacement scans, and extensions are features; whether egress is possible is the host's decision (container,
seccomp, the Pi runtime). The library records what ran; the host decides what may run.

Ontologies and the knowledge graph share one shape, borrowed from
[SemanticSQL](https://github.com/INCATools/semantic-sql): `bio_edges(from_id, predicate,
to_id)` is the statement/edge base and `entailed_edge` is its transitive closure, so descendants, subsumption,
and graph-walks are a single indexed join — the same SQL grounds an imported ontology and walks our own graph.
Grounding a free-text term runs deterministically first (exact and synonym match plus closure, all SQL) and
falls back to a model only on a miss, where the model may propose a candidate but never invent a CURIE and
abstains below a confidence threshold. Ordered TermSets become a `scale_members` table so SQL can threshold on
rank (ACMG, variant impact, clinical stage). Manifests are validated against a strict allowlist, so cut
surface cannot ride back in as inert keys.

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
- `bio_query` — Run an ad-hoc bio query
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

## Docs

New here? Start with the [user guide](docs/guide.md) — write a manifest, run an operation. For the why,
see the [design notes](docs/design.md) and the [roadmap](docs/roadmap.md). The full
[docs index](docs/INDEX.md) is generated from each doc's frontmatter (`npm run docs:index`; `npm run check`
fails if it is stale).

## Development

```sh
npm install
npm run check     # typecheck + tests + docs-index staleness gate (the single gate)
```

`npm run provision:duckhts` installs the DuckHTS community extension for the `duckhts.read_bcf` resolver
(explicit; never auto-installed during `check`). Runtime Pi APIs are peer dependencies supplied by Pi itself.
