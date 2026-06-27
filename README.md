# pi-bio-agent

Lean provider-agnostic bioinformatics primitives for Pi agents.

This repo is an early core plus Pi coding-agent integration. The goal is not a pile of bespoke genomics scripts. The goal is the right substrate:

- `BioToolSpec` contracts for executable domain tools
- content-addressed and virtual resources
- ontology tables and term sets
- typed knowledge graphs with provenance/trust blocks
- DuckDB-backed SQL surfaces over bio-data
- indexed study notes for machine studying
- project-local skill authoring when a workflow stabilizes

## Install in Pi

```sh
pi install /root/pi-bio-agent
/reload
```

## Pi tools

- `bio_describe_model`
- `bio_list_tool_specs`
- `bio_list_resource_resolvers`
- `bio_list_duckdb_extensions`
- `bio_validate_select`
- `bio_study_plan`
- `bio_write_study_note`
- `bio_list_study_notes`
- `bio_read_study_note`
- `bio_delete_study_note`
- `bio_create_skill`

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

- [Roadmap, success, and testing contract](docs/roadmap.md)
- [Domain model](docs/domain-model.md)
- [Resources and BioToolSpec](docs/resources-and-tool-specs.md)
- [Ontologies and knowledge graphs](docs/ontology-and-knowledge-graphs.md)
- [DuckDB substrate](docs/duckdb-substrate.md)
- [Deriving abstractions](docs/abstraction-derivation.md)
- [Machine studying lineage](docs/machine-studying-lineage.md)

## Development

```sh
npm install
npm run typecheck
```

Runtime Pi APIs are peer dependencies supplied by Pi itself.
