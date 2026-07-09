---
name: pi-bio-agent
description: "Use pi-bio-agent as a host-neutral substrate for agentic bioinformatics: write manifests, inspect DuckDB tables, compose read-only SQL, run Pi bio_* tools or pi-bio-agent query/run, inspect the ledger/graph when present, and avoid per-question skill sprawl. In Pi, prefer extension tools; in Codex, Claude Code, OpenCode, GitHub Copilot CLI, or other hosts, use the CLI. Use when biomedical answers must come from declared resources, receipts, CAS, and observations rather than model-generated facts."
---

# Pi Bio Agent

Pi Bio Agent turns biomedical questions into declared resources, DuckDB SQL, optional process compute, receipts, CAS
artifacts, and observation-ledger facts. The model may route, inspect schemas, write manifests, compose SQL, and
explain results. The model is not the source of biomedical facts.

## What This Is

Pi Bio Agent is a substrate for agent-authored scientific computation:

- **Manifests + SQL are the program**: the agent can write code/SQL, but facts come from declared resources and
  deterministic execution.
- **DuckDB is the work surface**: files, remote tables, ontology edges, reductions, and many bio formats should become
  queryable relations.
- **Provenance is structural**: runs record receipts, replay specs, artifacts, and optional `run:<id>` facts.
- **Knowledge and memory are graph-shaped**: when a ledger exists, inspect `bio_edges_as_of` / graph windows instead
  of relying on hidden chat context.
- **Host capabilities fail closed**: network, compute, credentials, filesystem policy, and extension provisioning are
  host-granted, not assumed.

You can trust agent-authored SQL/code only to the extent it is inspected, executed through the substrate, and tied to
declared inputs, receipts, and replayable evidence.

## Manifest Versus Ad-Hoc Query

- **Manifest**: declares resources, resolvers, table names, host capabilities, and stable operations. It answers:
  "what data is available, and how is it resolved?"
- **Ad-hoc query**: the SQL for the current user question, written after inspecting manifest tables. It answers:
  "what should be computed from those tables now?"
- Default for a new question: reuse or write a manifest, inspect tables, then call `pi-bio-agent query --sql ...`.
  Promote SQL into a manifest operation only after it becomes a repeated, tested workflow.

## Choose The Surface

- **Pi with `bio_*` tools**: use `bio_describe_model`, `bio_query`, `bio_run_operation`, and graph/memory tools.
  The extension provides richer onboarding than this skill and links tool calls to recorded runs.
- **Any other host, or Pi skill-only**: use the `pi-bio-agent` CLI.
- **Do not create a new skill for a new question**. First express the question as manifest + SQL or a declared
  operation.

## Minimal Working Loop

1. Verify the CLI:

   ```sh
   pi-bio-agent --help
   ```

   If unavailable, use the package directly:

   ```sh
   npx --yes github:sounkou-bioinfo/pi-bio-agent --help
   ```

2. Discover existing manifest-backed sources/templates before inventing a task-specific manifest:

   ```sh
   pi-bio-agent catalog --query clinvar
   ```

   Pick one returned `manifestPath`, validate it, and inspect this CLI host's admission before resolving data:

   ```sh
   pi-bio-agent describe <manifestPath>
   ```

   In Pi, use `bio_list_sources` then `bio_describe_model` for the same steps.

3. Run one real packaged query before inventing a task-specific manifest:

   ```sh
   pi-bio-agent query examples/variant-counts/manifest.json \
     --db :memory: \
     --sql "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence"
   ```

4. For the user's task: write or reuse a manifest, inspect tables, then answer with ad-hoc SQL.

   ```sh
   pi-bio-agent describe manifest.json
   pi-bio-agent query manifest.json --db :memory: --sql "DESCRIBE table_name"
   pi-bio-agent query manifest.json --db :memory: --sql "SUMMARIZE table_name"
   pi-bio-agent query manifest.json --db :memory: --sql "SELECT * FROM table_name LIMIT 5"
   pi-bio-agent query manifest.json --db :memory: --sql "<WITH/SELECT over declared tables>"
   ```

5. When provenance matters, add `--ledger auto` and inspect the run/graph afterward.

   ```sh
   pi-bio-agent query manifest.json --db :memory: --ledger auto --sql "<WITH/SELECT ...>"
   ```

   Verify a persisted run by re-executing its replay against a fresh database:

   ```sh
   pi-bio-agent reproduce .pi/bio-agent/runs/<runId>/replay.json
   ```

   In Pi, call `bio_reproduce_run` with the same replay path.

6. When a DuckDB database already contains edge-shaped graph rows, page them instead of serializing a whole
   neighborhood:

   ```sh
   pi-bio-agent graph-window --db store.duckdb --table bio_edges_as_of --start "run:<id>" --direction both
   ```

   If the result includes a `continuation.pointer.uri`, resume with:

   ```sh
   pi-bio-agent graph-window --db store.duckdb --continuation "graph-window:..."
   ```

## Load References As Needed

- Manifest syntax and resolver semantics: [references/manifests.md](references/manifests.md)
- Query/run CLI, bindings, and operations: [references/query-run.md](references/query-run.md)
- HTTP, GraphQL, and remote data patterns: [references/http-and-remote.md](references/http-and-remote.md)
- `compute.run` for R/Python/bash/process work: [references/compute.md](references/compute.md)
- Ledger and graph inspection: [references/ledger-graph.md](references/ledger-graph.md)

Read only the reference needed for the current task.

## Answer Contract

Return the manifest path, SQL or operation id, run id when available, and concise result rows. Include abstentions or
unsupported host-capability errors when relevant. For clinical or high-stakes questions, missing evidence is an
abstention unless declared data supports a stronger claim.

## Skill Graduation Rule

A workflow may become a skill only after it has stabilized as manifest + SQL/operation with fixtures and an output
contract. A skill is a thin playbook over the substrate, not the biomedical computation.

For ClawBio-like systems, keep the host's intent/routing layer and replace per-question scripts with manifests,
ad-hoc SQL, declared operations, and `pi-bio-agent query/run` as the compute surface.
