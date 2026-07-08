
<!-- README.md is generated from README.Rmd — please edit that file, then `npm run readme:rmd`. -->
<!-- The `pi`, `dogfood`, and `biocli` chunks run real commands. Rendering needs a built `dist/`, Pi, and model credentials. -->

# pi-bio-agent

[![CI](https://github.com/sounkou-bioinfo/pi-bio-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/sounkou-bioinfo/pi-bio-agent/actions/workflows/ci.yml)
[![License: GPL
v2+](https://img.shields.io/badge/License-GPL%20v2%2B-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

`pi-bio-agent` is a provider-agnostic bioinformatics agent substrate and
Pi extension for agent-controlled scientific computation: manifests +
SQL over DuckDB are the program. A manifest declares resources,
read-only SQL, optional process compute, receipts, CAS artifacts, and
observations in one DuckDB-backed ledger.

The agent may inspect schemas and write SQL; biomedical facts come from
declared data, deterministic compute, receipts, and recorded approvals.

## Bets

- New biomedical questions should become manifests, SQL, operation
  specs, or graph data, not new per-question tools.
- DuckDB is the substrate: files, formats, HTTP-shaped data, graph
  tables, and reductions should be reached through SQL and extensions
  whenever possible.
- Knowledge belongs in queryable graph tables. `bio_edges`,
  `bio_edges_as_of`, and `entailed_edge` are the interaction surface,
  not serialized graph context.
- CAS, resolver receipts, replay specs, and environment evidence are
  part of the result, not optional metadata.
- Compute is a host-injected async port: submit, status, collect,
  cancel. The core records the contract, durable queue status, step
  checkpoints, replay specs, and evidence; hosts decide what processes,
  credentials, and network access are allowed. Resume is
  checkpoint-based, not a workflow engine.
- The model or human handles routing, schema inspection, SQL
  composition, and typed judgment over an apparatus of manifests,
  tables, graphs, receipts, and gates. It is not the source of
  biomedical facts; constraints are what make the computation auditable.

## See It

The agent starts with the raw ClinVar VCF URL and a TP53 genomic range,
writes the manifest into `.pi/`, runs the query, and returns the SQL
plus results. This is a tabix range read through `duckhts`, so it should
complete in seconds rather than download the whole ClinVar VCF. ClinVar
is live data; the rows below are the result from this README render, not
a pinned truth table.

``` sh
pi \
  --model openai-codex/gpt-5.3-codex \
  --thinking high \
  --no-extensions \
  -e extensions/pi-coding-agent/index.ts \
  --tools read,write,bio_describe_model,bio_query,bio_list_duckdb_extensions \
  -p --no-session \
  "Create .pi/bio-agent/readme-clinvar-tp53.json for the " \
  "raw ClinVar VCF URL " \
  "https://ftp.ncbi.nlm.nih.gov/pub/clinvar/vcf_GRCh38/clinvar.vcf.gz, " \
  "region 17:43044295-43125483, table clinvar, using " \
  "duckhts.read_bcf. Run bio_query to count " \
  "clinical-significance buckets in that region. Inspect " \
  "the schema if needed; avoid double-counting multi-valued " \
  "significance entries. Return only the manifest path, the " \
  "SQL, and a Markdown result table."
```

Manifest path: `.pi/bio-agent/readme-clinvar-tp53.json`

``` sql
WITH distinct_calls AS (
  SELECT DISTINCT CHROM, POS, REF, ALT, significance
  FROM clinvar,
       UNNEST(INFO_CLNSIG) AS u(significance)
  WHERE significance IS NOT NULL
)
SELECT
  significance AS clinical_significance,
  COUNT(*) AS n
FROM distinct_calls
GROUP BY significance
ORDER BY n DESC, significance;
```

| clinical_significance                        |    n |
|----------------------------------------------|-----:|
| Pathogenic                                   | 3593 |
| Conflicting_classifications_of_pathogenicity | 2917 |
| Likely_benign                                | 2891 |
| Uncertain_significance                       | 2445 |
| Benign                                       |  704 |
| Likely_pathogenic                            |  263 |
| Pathogenic/Likely_pathogenic                 |  227 |
| Benign/Likely_benign                         |   94 |
| not_provided                                 |   49 |
| no_classification_for_the_single_variant     |    2 |
| no_classifications_from_unflagged_records    |    1 |

The same query with no model in the loop:

``` sh
pi-bio-agent query .pi/bio-agent/readme-clinvar-tp53.json \
  --db :memory: \
  --init-sql "INSTALL duckhts FROM community; LOAD duckhts;" \
  --sql "WITH distinct_calls AS (SELECT DISTINCT CHROM, POS, REF, ALT, significance FROM clinvar, UNNEST(INFO_CLNSIG) AS u(significance)) SELECT significance, COUNT(*) AS n FROM distinct_calls GROUP BY significance ORDER BY n DESC"
```

``` json
{
  "ok": true,
  "runId": "query-<run>",
  "status": "succeeded",
  "rowCount": 11,
  "artifacts": {
    "run": ".pi/bio-agent/runs/query-<run>/run.json",
    "result": ".pi/bio-agent/runs/query-<run>/result.json",
    "receipts": ".pi/bio-agent/runs/query-<run>/receipts.json"
  },
  "runDir": ".pi/bio-agent/runs/query-<run>",
  "rows": [
    {
      "significance": "Pathogenic",
      "n": 3593
    },
    {
      "significance": "Conflicting_classifications_of_pathogenicity",
      "n": 2917
    },
    {
      "significance": "Likely_benign",
      "n": 2891
    },
    {
      "significance": "Uncertain_significance",
      "n": 2445
    },
    {
      "significance": "Benign",
      "n": 704
    },
    {
      "significance": "Likely_pathogenic",
      "n": 263
    },
    {
      "significance": "Pathogenic/Likely_pathogenic",
      "n": 227
    },
    {
      "significance": "Benign/Likely_benign",
      "n": 94
    },
    {
      "significance": "not_provided",
      "n": 49
    },
    {
      "significance": "no_classification_for_the_single_variant",
      "n": 2
    },
    {
      "significance": "no_classifications_from_unflagged_records",
      "n": 1
    }
  ]
}
```

## Start

Install the Pi extension:

``` sh
pi install git:github.com/sounkou-bioinfo/pi-bio-agent
/reload
```

Use the CLI without Pi:

``` sh
pi-bio-agent query examples/variant-counts/manifest.json \
  --db :memory: \
  --sql "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence"
```

``` json
{
  "ok": true,
  "runId": "query-<run>",
  "status": "succeeded",
  "rowCount": 3,
  "artifacts": {
    "run": ".pi/bio-agent/runs/query-<run>/run.json",
    "result": ".pi/bio-agent/runs/query-<run>/result.json",
    "receipts": ".pi/bio-agent/runs/query-<run>/receipts.json"
  },
  "runDir": ".pi/bio-agent/runs/query-<run>",
  "rows": [
    {
      "consequence": "missense",
      "n": 2
    },
    {
      "consequence": "stop_gained",
      "n": 2
    },
    {
      "consequence": "synonymous",
      "n": 1
    }
  ]
}
```

Run a declared operation:

``` sh
pi-bio-agent run examples/rare-high-impact/manifest.json \
  --db :memory: \
  --operation rare_high_impact.report
```

``` json
{
  "ok": true,
  "runId": "rare_high_impact.report-<run>",
  "status": "succeeded",
  "rowCount": 5,
  "artifacts": {
    "run": ".pi/bio-agent/runs/rare_high_impact.report-<run>/run.json",
    "result": ".pi/bio-agent/runs/rare_high_impact.report-<run>/result.json",
    "receipts": ".pi/bio-agent/runs/rare_high_impact.report-<run>/receipts.json"
  },
  "runDir": ".pi/bio-agent/runs/rare_high_impact.report-<run>",
  "rows": [
    {
      "bucket": "benign",
      "n": 1
    },
    {
      "bucket": "included",
      "n": 1
    },
    {
      "bucket": "no_frequency",
      "n": 1
    },
    {
      "bucket": "not_high_impact",
      "n": 1
    },
    {
      "bucket": "not_rare",
      "n": 1
    }
  ]
}
```

Use it as a library:

``` ts
import { runBioQueryFromManifest } from "pi-bio-agent";

const out = await runBioQueryFromManifest({
  cwd: process.cwd(),
  dbPath: ":memory:",
  manifestPath: "examples/variant-counts/manifest.json",
  sql: "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence",
});
```

Run the full gate:

``` sh
npm install
npm run check
```

`npm run check` runs typecheck, tests, docs/example drift checks, and
README tool-list checks. CI provisions real R and the pinned `nanoarrow`
package so process-compute examples exercise real spawned `Rscript`, not
a mock.

## How it works

A manifest declares named resources. Resolvers materialize them into
DuckDB tables and stamp receipts: resolver version, parameter digest,
and source snapshot. An operation is one read-only `SELECT`/`WITH` over
those tables. Whatever it returns is the result.

| leg       | primitive                                                                                                                                                                        |
|-----------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Data      | `file_scan` and `duckdb.sql_materialize` over files, object stores, local DBs, and DuckDB community extensions such as `duckhts`, `anndata`, `duckdb_zarr`, and `plinking_duck`. |
| Network   | `ducknng_ncurl_table` and ducknng HTTP profiles for SQL-native HTTP/RPC. `http.get` remains a host-injected JS fetch resolver when an application chooses it.                    |
| Compute   | `compute.run`: a child process over Arrow IPC and declared file artifacts. R, Python, `rv`, Nextflow, or an NNG worker pool are argv/runner choices, not new core APIs.          |
| Knowledge | one SemanticSQL-shaped graph: `bio_edges`, `bio_edges_as_of`, and `entailed_edge` for ontology terms, memory, observations, sessions, tool calls, artifacts, and run links.      |

Host capabilities are explicit. If no `fetch` is injected, `http.get` is
unavailable. If no `ComputeRunner` is injected, `compute.run` is
unavailable. The library validates manifests, SQL shape, receipts, and
replay. The host owns filesystem, network, credentials, and process
isolation.

For credentialed SQL-native HTTP, the CLI can commission a ducknng HTTP
profile on the same DuckDB connection as the run. The profile file
contains non-secret policy plus a credential source; the token comes
from env or stdin, and replay records only the redacted profile receipt
digest.

``` json
{
  "profileId": "clinvar-read",
  "scheme": "https",
  "host": "api.example.org",
  "pathPrefix": "/clinvar",
  "method": "GET",
  "tlsRequired": true,
  "authHeaderName": "Authorization",
  "authHeaderValueEnv": "CLINVAR_TOKEN",
  "allowSubjects": ["case:alpha"]
}
```

``` sh
pi-bio-agent query credentialed-manifest.json \
  --db :memory: \
  --init-sql "LOAD ducknng" \
  --ducknng-http-profile ./clinvar-profile.json \
  --sql "SELECT * FROM secured_table LIMIT 5"
```

`credentialed-manifest.json` is the host/app manifest whose
`ducknng_ncurl_table` call names the profile id `clinvar-read`;
`CLINVAR_TOKEN` is supplied by the host environment or secret manager,
and the secret never appears in the manifest, SQL, or argv.

## Ledger

Runs, facts, memory, job status, session traces, and artifacts are rows
in `bio_observations`, read as of a time. The graph view is derived from
edge-like observations, so these are ordinary SQL questions:

- what is the current fact?
- what did the agent learn?
- what was this job’s status at a time?
- which tool call produced this scientific run?

Pi session JSONL is ingested as `session:`, `turn:`, `msg:`,
`toolcall:`, and `cas:` observations. Bio tools record controlled run
links at tool execution time, from Pi’s real tool-call id and only after
the target run fact exists. The ingester does not scan transcript text
for run-looking strings.

Query a recorded run ledger:

``` sh
pi-bio-agent query examples/run-ledger/manifest.json \
  --db :memory: \
  --sql "SELECT tool, status, count(*) n FROM run_ledger GROUP BY 1, 2 ORDER BY n DESC"
```

``` json
{
  "ok": true,
  "runId": "query-<run>",
  "status": "succeeded",
  "rowCount": 6,
  "artifacts": {
    "run": ".pi/bio-agent/runs/query-<run>/run.json",
    "result": ".pi/bio-agent/runs/query-<run>/result.json",
    "receipts": ".pi/bio-agent/runs/query-<run>/receipts.json"
  },
  "runDir": ".pi/bio-agent/runs/query-<run>",
  "rows": [
    {
      "tool": "ad-hoc.query",
      "status": "succeeded",
      "n": 1909
    },
    {
      "tool": "ad-hoc.query",
      "status": "failed",
      "n": 119
    },
    {
      "tool": "rare_high_impact.report",
      "status": "succeeded",
      "n": 107
    },
    {
      "tool": "monarch.disease_phenotypes",
      "status": "succeeded",
      "n": 2
    },
    {
      "tool": "opentargets.associated_diseases",
      "status": "failed",
      "n": 1
    },
    {
      "tool": "opentargets.associated_diseases",
      "status": "succeeded",
      "n": 1
    }
  ]
}
```

## Dogfood

Run the compact all-primitives dogfood:

``` sh
npm run dogfood:bring-it-home
```

``` json
{
  "observationCounts": {
    "executes": 1,
    "invoked_by": 1,
    "tool_call": 1,
    "run": 2,
    "host_event": 4,
    "job_step_checkpoint": 2
  },
  "ducknngProfile": {
    "version": "2",
    "receiptChanged": true,
    "subjectRestriction": {
      "restricted": true,
      "count": 2,
      "digest": "sha256:ceee9bcb816bd665d011958ad04d1fdfdcb0230ac619ea4a59afaedc002dc953"
    }
  },
  "casMetadata": {
    "casMetadataRefs": 4
  },
  "graphProjection": {
    "external": {
      "edgeCount": 3,
      "closureCount": 3
    },
    "internal": {
      "edgeCountAtLeast4": true,
      "closureCountAtLeast3": true
    }
  },
  "trainingCorpus": {
    "toolCalls": 1,
    "runs": 2,
    "hostEvents": 4,
    "parquetReadbackRows": 1
  },
  "sdkConsumer": {
    "publicExportsOnly": true,
    "runtimeImports": true,
    "packageSource": "npm-pack"
  },
  "queueCancel": {
    "staleWriteRejected": true,
    "resumedPhase": "cancelled"
  },
  "renvEnvironment": {
    "rVersion": "4.6.0",
    "bioconductor": "3.22",
    "envStatus": "matched",
    "artifactRows": 1
  }
}
```

It exercises host-event receipts, step checkpoints/resume, SemanticSQL
projection, ducknng profile receipts, SDK exports, and real process
compute when R is available.

Run the Pi session trace dogfood after installing the extension and
configuring an image-capable model:

``` sh
npm run dogfood:pi-session-trace
```

It drives a real Pi session through image read, successful shell call,
intentional shell error, manifest discovery, SQL validation,
`bio_query`, and then queries the project ledger for the session
summary, tool trajectory, CAS roots, and the recorded tool-call/run
linkage.

## Examples

Every [example](examples/) has a recorded run; `npm run check` fails if
generated example blocks drift.

- [`examples/variant-counts`](examples/variant-counts/) - ad-hoc SQL
  over a CSV resource.
- [`examples/rare-high-impact`](examples/rare-high-impact/) - a declared
  operation with explicit abstention.
- [`examples/compute-run`](examples/compute-run/) - DuckDB table -\>
  Arrow IPC -\> R `lm()` -\> DuckDB table.
- [`examples/compute-artifacts`](examples/compute-artifacts/) - compute
  value plus declared files captured into CAS.
- [`examples/compute-files-only`](examples/compute-files-only/) - a
  file-only tool exposed as an artifacts table.
- [`examples/coloc`](examples/coloc/) - post-GWAS colocalization: SQL
  harmonization plus out-of-process R.
- [`examples/connectors`](examples/connectors/) - APIs as manifests,
  including UniProt, RCSB PDB, MyGene, Reactome, Monarch, and
  OpenTargets GraphQL.

Example connector, no TypeScript client:

``` sh
pi-bio-agent query examples/connectors/uniprot.json \
  --db :memory: \
  --init-sql "LOAD ducknng; SET VARIABLE tls = ducknng_tls_config_from_pem(NULL, NULL, NULL, '', 1)" \
  --bindings '{"uniprot_acc":"P04637"}' \
  --sql "SELECT primaryAccession, uniProtkbId, sequence.length aa FROM uniprot_entry"
```

``` json
{
  "ok": true,
  "runId": "query-<run>",
  "status": "succeeded",
  "rowCount": 1,
  "artifacts": {
    "run": ".pi/bio-agent/runs/query-<run>/run.json",
    "result": ".pi/bio-agent/runs/query-<run>/result.json",
    "receipts": ".pi/bio-agent/runs/query-<run>/receipts.json"
  },
  "runDir": ".pi/bio-agent/runs/query-<run>",
  "rows": [
    {
      "primaryAccession": "P04637",
      "uniProtkbId": "P53_HUMAN",
      "aa": 393
    }
  ]
}
```

## Pi tools

The `pi-coding-agent` extension registers these tools over the
substrate. This list is generated from the extension’s `registerTool()`
calls (`npm run readme:tools`); `npm run check` fails if it drifts.

<!-- BEGIN GENERATED:tools (scripts/generate-readme-tools.mjs — do not edit by hand) -->

- `bio_list_sources` — List manifest-backed sources
- `bio_describe_model` — Describe Pi Bio model
- `bio_run_operation` — Run a bio operation
- `bio_query` — Run an ad-hoc bio query
- `bio_list_duckdb_extensions` — List bio DuckDB extensions
- `bio_validate_select` — Validate bio SQL SELECT
- `bio_validate_graph_projection` — Validate graph projection
- `bio_graph_window` — Window graph context
- `bio_create_skill` — Create bio skill
- `bio_study_plan` — Plan bio study
- `bio_remember` — Remember (memory note)
- `bio_list_memory` — List memory
- `bio_walk_memory` — Walk bio memory graph
- `bio_recall` — Recall memory note
- `bio_forget` — Forget memory note

<!-- END GENERATED:tools -->

Project-local skills and the memory store live under `.pi/bio-agent/` in
the current project.

## Host-neutral agent skill

The package also ships a plain agent skill at `skills/pi-bio-agent/`. It
is not a Pi extension and not a per-question biomedical skill. It is a
procedural guide for any agent host: write a manifest, inspect DuckDB
tables with `DESCRIBE` / `SUMMARIZE`, run read-only SQL through
`pi-bio-agent query`, and promote only stable workflows to thin
playbooks. Start with `pi-bio-agent catalog` when the host needs to
discover packaged manifest-backed sources before choosing one to inspect
or run. When a ledger or external KG already exists as a DuckDB graph
table, use
`pi-bio-agent graph-window --db <store.duckdb> --start <node-id> [--table bio_edges_as_of]`
to page one-hop context instead of serializing a whole neighborhood into
the agent prompt.

Install the skill directly from GitHub into any host’s skill/playbook
directory, without cloning:

``` sh
npx --yes github:sounkou-bioinfo/pi-bio-agent install-skill --dest /path/to/host/skills
```

That is the generic path for Claude Code, opencode, GitHub Copilot CLI,
or any other agent system. Use the directory that the host itself
documents or configures. The installer copies `skills/pi-bio-agent/`
into that directory and does not assume the host’s runtime API.

Pi users should normally install the full package. That gives Pi the
`bio_*` extension tools, the plain skill, and the session trace
integration that links a tool call to the recorded `run:<id>` it
produced:

``` sh
pi install git:github.com/sounkou-bioinfo/pi-bio-agent
/reload
```

Install only the skill into Pi’s global skill root when you deliberately
do not want the extension loaded:

``` sh
npx --yes github:sounkou-bioinfo/pi-bio-agent install-skill --host pi
```

Install only the skill project-locally for Pi:

``` sh
npx --yes github:sounkou-bioinfo/pi-bio-agent install-skill --host pi-project
```

`--host pi` uses `$PI_CODING_AGENT_DIR/skills` when set, otherwise
`~/.pi/agent/skills`. `--host pi-project` uses `.pi/skills` under the
current working directory.

Other common agent hosts have presets too:

``` sh
# Claude Code
npx --yes github:sounkou-bioinfo/pi-bio-agent install-skill --host claude
npx --yes github:sounkou-bioinfo/pi-bio-agent install-skill --host claude-project

# OpenCode
npx --yes github:sounkou-bioinfo/pi-bio-agent install-skill --host opencode
npx --yes github:sounkou-bioinfo/pi-bio-agent install-skill --host opencode-project

# GitHub Copilot CLI / Copilot agent skills
npx --yes github:sounkou-bioinfo/pi-bio-agent install-skill --host copilot
npx --yes github:sounkou-bioinfo/pi-bio-agent install-skill --host copilot-project
```

These map to each host’s standard Agent Skills roots: Claude
`~/.claude/skills` and `.claude/skills`; OpenCode
`~/.config/opencode/skills` and `.opencode/skills`; GitHub Copilot CLI
`~/.copilot/skills` and `.github/skills`.

Install the CLI persistently when the host should call
`pi-bio-agent query` / `pi-bio-agent run` later:

``` sh
npm install -g github:sounkou-bioinfo/pi-bio-agent
pi-bio-agent install-skill --dest /path/to/host/skills
```

Codex is only a preset because its skill root is conventional in this
environment:

``` sh
npx --yes github:sounkou-bioinfo/pi-bio-agent install-skill --host codex
```

The older alias still works:

``` sh
pi-bio-agent install-codex-skill
```

From a checkout, install the skill for local development:

``` sh
npm install
npm run build
npm run install:skill -- --dest /path/to/host/skills
```

Link the checkout CLI when you also want `pi-bio-agent` on `PATH`:

``` sh
npm run install:skill -- --dest /path/to/host/skills --link-cli
```

Codex’s generic GitHub skill installer also works, but it installs only
the skill, not the CLI:

``` sh
python ~/.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py \
  --repo sounkou-bioinfo/pi-bio-agent \
  --path skills/pi-bio-agent
```

The skill is guidance; manifests, SQL, receipts, CAS, and observations
remain the computation.

## Docs

Start with the [user guide](docs/guide.md): write a manifest, run an
operation. Then read [design notes](docs/design.md) for the core
contracts and [roadmap](docs/roadmap.md) for current work. The full
[docs index](docs/INDEX.md) is generated from frontmatter.

## References & lineage

Prior art and lineage:

- **ClawBio**, the origin corpus this factors into manifests, resolvers,
  and operations: <https://github.com/ClawBio/ClawBio>
- **metacurator**, deterministic curation stages plus typed model
  judgments: <https://github.com/seandavi/metacurator>
- **op2workshop / ontoProc2**, the workshop lineage that led us back to
  the Semantic SQL source spec: <https://github.com/vjcitn/op2workshop>
- **Machine studying** (Li, Battle, Khattab, 2026):
  <https://jacobxli.com/blog/2026/machine-studying/>
- **Sakana Fugu** (learned orchestration over shared memory and access
  lists): <https://sakana.ai/fugu/>
- **Recursive Language Models / RLM** (REPL-over-context; `bio_query` is
  the SQL REPL): <https://arxiv.org/abs/2512.24601>
- **ducknng**, an Arrow-native DuckDB extension for NNG/HTTP/RPC
  transport, in the lineage of R’s `nanonext` + `mirai`:
  <https://github.com/sounkou-bioinfo/ducknng> ·
  [NNG](https://nng.nanomsg.org/) ·
  [`nanonext`](https://github.com/r-lib/nanonext) ·
  [`mirai`](https://mirai.r-lib.org/)
- **SemanticSQL** (canonical LinkML source schema for `statements`,
  `prefix`, generated views, and `entailed_edge`):
  <https://github.com/INCATools/semantic-sql>
- Design thread (sounkou-bioinfo × Manuel):
  [LinkedIn](https://www.linkedin.com/feed/update/urn:li:activity:7473824764575436800)

## Development

``` sh
npm install
npm run check     # typecheck + tests + docs/readme/examples staleness gates (the single gate)
```

`npm run provision:duckhts` installs the DuckHTS community extension for
the `duckhts.read_bcf` resolver (explicit; never auto-installed during
`check`). Runtime Pi APIs are peer dependencies supplied by Pi itself.

## Status & contributing

Pre-1.0 (`0.1.0`). The public API may still move. Issues and PRs
welcome. Keep new capability manifest/SQL-first: a new question should
become data, a resolver adapter, or SQL, not bespoke core code.

## License

[GPL-2.0-or-later](LICENSE) © sounkou-bioinfo
