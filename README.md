

<!-- README.md is generated from README.qmd — please edit this file, then `npm run readme:qmd`. -->

<!-- The marked cells run real commands through the first-party pi-bio engine. Rendering needs built packages, Pi, and model credentials. -->

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
  "significance entries. The SQL must itself filter CHROM = " \
  "'17' and POS BETWEEN 43044295 AND 43125483 instead of " \
  "treating resolver pushdown as the semantic filter. " \
  "Return only the manifest path, the SQL, and a Markdown " \
  "result table."
```

Manifest path: `.pi/bio-agent/readme-clinvar-tp53.json`

``` sql
WITH exploded AS (
  SELECT
    CHROM, POS, ID, REF, ALT,
    TRIM(sig) AS clinical_significance
  FROM clinvar
  CROSS JOIN UNNEST(COALESCE(INFO_CLNSIG, [])) AS sigs(sig)
  WHERE CHROM = '17'
    AND POS BETWEEN 43044295 AND 43125483
    AND sig IS NOT NULL
    AND TRIM(sig) <> ''
),
deduped AS (
  SELECT DISTINCT CHROM, POS, ID, REF, ALT, clinical_significance
  FROM exploded
)
SELECT
  clinical_significance AS clinical_significance_bucket,
  COUNT(*) AS variant_count
FROM deduped
GROUP BY clinical_significance_bucket
ORDER BY variant_count DESC, clinical_significance_bucket;
```

| clinical_significance_bucket                 | variant_count |
|----------------------------------------------|--------------:|
| Pathogenic                                   |          3590 |
| Conflicting_classifications_of_pathogenicity |          2917 |
| Likely_benign                                |          2891 |
| Uncertain_significance                       |          2445 |
| Benign                                       |           704 |
| Likely_pathogenic                            |           263 |
| Pathogenic/Likely_pathogenic                 |           227 |
| Benign/Likely_benign                         |            94 |
| not_provided                                 |            49 |
| no_classification_for_the_single_variant     |             2 |
| no_classifications_from_unflagged_records    |             1 |

The same query with no model in the loop:

``` sh
pi-bio-agent query .pi/bio-agent/readme-clinvar-tp53.json \
  --db :memory: \
  --init-sql "INSTALL duckhts FROM community; LOAD duckhts;" \
  --sql "WITH exploded AS (SELECT CHROM, POS, ID, REF, ALT, TRIM(sig) AS clinical_significance FROM clinvar CROSS JOIN UNNEST(COALESCE(INFO_CLNSIG, [])) AS sigs(sig) WHERE CHROM = '17' AND POS BETWEEN 43044295 AND 43125483 AND sig IS NOT NULL AND TRIM(sig) <> ''), deduped AS (SELECT DISTINCT CHROM, POS, ID, REF, ALT, clinical_significance FROM exploded) SELECT clinical_significance AS clinical_significance_bucket, COUNT(*) AS variant_count FROM deduped GROUP BY clinical_significance_bucket ORDER BY variant_count DESC, clinical_significance_bucket"
```

<details class="pi-bio-output">

<summary>

JSON output: cell-3
</summary>

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
      "clinical_significance_bucket": "Pathogenic",
      "variant_count": 3590
    },
    {
      "clinical_significance_bucket": "Conflicting_classifications_of_pathogenicity",
      "variant_count": 2917
    },
    {
      "clinical_significance_bucket": "Likely_benign",
      "variant_count": 2891
    },
    {
      "clinical_significance_bucket": "Uncertain_significance",
      "variant_count": 2445
    },
    {
      "clinical_significance_bucket": "Benign",
      "variant_count": 704
    },
    {
      "clinical_significance_bucket": "Likely_pathogenic",
      "variant_count": 263
    },
    {
      "clinical_significance_bucket": "Pathogenic/Likely_pathogenic",
      "variant_count": 227
    },
    {
      "clinical_significance_bucket": "Benign/Likely_benign",
      "variant_count": 94
    },
    {
      "clinical_significance_bucket": "not_provided",
      "variant_count": 49
    },
    {
      "clinical_significance_bucket": "no_classification_for_the_single_variant",
      "variant_count": 2
    },
    {
      "clinical_significance_bucket": "no_classifications_from_unflagged_records",
      "variant_count": 1
    }
  ]
}
```

</details>

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
  --run-id readme-variant-counts \
  --ledger .pi/bio-agent/readme-store.duckdb \
  --author readme \
  --sql "SELECT consequence, count(*) AS n FROM variants GROUP BY consequence ORDER BY consequence"
```

<details class="pi-bio-output">

<summary>

JSON output: cell-5
</summary>

``` json
{
  "ok": true,
  "runId": "readme-variant-counts",
  "status": "succeeded",
  "rowCount": 3,
  "artifacts": {
    "run": ".pi/bio-agent/runs/readme-variant-counts/run.json",
    "result": ".pi/bio-agent/runs/readme-variant-counts/result.json",
    "receipts": ".pi/bio-agent/runs/readme-variant-counts/receipts.json"
  },
  "runDir": ".pi/bio-agent/runs/readme-variant-counts",
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

</details>

Verify that run against a fresh database:

``` sh
pi-bio-agent reproduce .pi/bio-agent/runs/readme-variant-counts/replay.json
```

<details class="pi-bio-output">

<summary>

JSON output: cell-6
</summary>

``` json
{
  "runId": "readme-variant-counts",
  "reproductionRunId": "reproduce-readme-variant-counts-<run>",
  "kind": "query",
  "reproduced": true,
  "matched": true,
  "expected": [
    "sha256:503a0f38badbe135aaf78d0893df64ef1f38610ea048d811ee378b7cffaa68c1"
  ],
  "produced": [
    "sha256:503a0f38badbe135aaf78d0893df64ef1f38610ea048d811ee378b7cffaa68c1"
  ],
  "missing": [],
  "extra": [],
  "outcomeMatched": true,
  "expectedOutcome": {
    "status": "succeeded"
  },
  "producedOutcome": {
    "status": "succeeded"
  },
  "runDir": ".pi/bio-agent/runs/reproduce-readme-variant-counts-<run>"
}
```

</details>

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

`npm run check` runs typecheck, tests, docs/example drift checks, skill
conformance, and README tool-list checks. CI provisions real R, pinned
`nanoarrow`, and DuckHTS before the full suite. A separate owned-ducknng
job requires retry, subject-scoped HTTP profiles, upload, TLS, RPC, and
socket behavior.

## How it works

A manifest declares named resources. Resolvers materialize them into
DuckDB tables and stamp receipts: resolver version, parameter digest,
and source snapshot. An operation is one read-only `SELECT`/`WITH` over
those tables. Whatever it returns is the result.

| leg | primitive |
|----|----|
| Data | `file_scan` and `duckdb.sql_materialize` over files, object stores, local DBs, and DuckDB community extensions such as `duckhts`, `anndata`, `duckdb_zarr`, and `plinking_duck`. |
| Network | `ducknng_ncurl_table` and ducknng HTTP profiles for SQL-native HTTP/RPC. `http.get` remains a host-injected JS fetch resolver when an application chooses it. |
| Compute | `compute.run`: a child process over Arrow IPC and declared file artifacts. R, Python, `rv`, Nextflow, or an NNG worker pool are argv/runner choices, not new core APIs. |
| Knowledge | one SemanticSQL-shaped graph: `bio_edges`, `bio_edges_as_of`, and `entailed_edge` for ontology terms, memory, observations, sessions, tool calls, artifacts, and run links. |

Host capabilities are explicit. If no `fetch` is injected, `http.get` is
unavailable. If no `ComputeRunner` is injected, `compute.run` is
unavailable. The library validates manifests, SQL shape, receipts, and
replay. The host owns filesystem, network, credentials, and process
isolation.

The plain CLI keeps those grants explicit: `--network fetch` binds a
capped WHATWG-fetch adapter, `--compute local` binds the local async
runner, `--cas-root` captures outputs, and host-owned config/protected
values come from JSON files rather than manifest data. An embedding host
can replace each port with stricter policy.

Manifest inspection does not infer runnability from an operation’s
transport. It reports declarations separately from this host’s `ready`,
`blocked`, or `unknown` admission status. A bound resolver with an
unattested extension or egress requirement remains `unknown` until the
host proves it.

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

## Browser workbench

The first-party workbench composes a browser, a Pi SDK agent-host
adapter, and the same public evidence substrate:

``` sh
npm run benchmark:acmg --workspace=packages/workbench -- \
  --archive /path/to/scitranslmed.adz4172_tables_s1_to_s13.zip \
  --expected-archive-digest sha256:eedf0d516842e5a1f929606161f61ae8185253d679810abc603d64526bbdd2ee \
  --expected-workbook-digest sha256:4e8c55487dafcf88f4c34c233e52f5fc12860f7a7e9dcef4490f6464535ddbfa \
  --workspace .pi/published-acmg-benchmark
npm run resolve:acmg-variant --workspace=packages/workbench -- \
  --row-id 'ST12_150 ClinGen varinats:39' \
  --workspace .pi/published-acmg-benchmark
npm run serve --workspace=packages/workbench -- .pi/published-acmg-benchmark 8787
```

Open <http://127.0.0.1:8787>. Pi sessions can be opened, resumed,
renamed, prompted, steered, followed up, aborted, and closed. Slash
completion exposes invokable Pi commands. The Variants addon keeps
published workbook decisions separate from independently resolved NCBI
Variation/ClinVar snapshots, receipts, CAS digests, and run ids;
Artifacts renders declared CAS-backed figures/reports. Starting against
an explicitly supplied clinical manifest additionally loads its Evidence
and Reanalysis addons. Tool payloads and raw lifecycle deltas are
collapsible diagnostics. The live conversation/event stream is a
presentation surface, not the scientific source of truth.

The first-party workbench explicitly grants local `compute.run` with its
workspace CAS. Agent-produced figures and reports must be declared
compute outputs so they become run-linked CAS artifacts; an arbitrary
Python/R/shell file write is not a workbench artifact. The reference
host keeps Pi’s built-in `bash` for inspection, authoring, testing, and
CLI work, and captures its command/result digests in the session ledger.
When a command performs scientific computation, the agent must
explicitly declare it under `compute.run` and execute it through
`bio_query` or a declared operation. Inline media returned by any tool
may separately be retained as a `session_image` audit artifact;
arbitrary filesystem side effects are never discovered or promoted
automatically.

The Pi extension reinforces this boundary just in time. Prompts that
imply a plot, figure, external scientific runtime, or workflow receive a
visible `compute.run` reminder before the agent starts. If the host did
not grant compute, the reminder fails closed instead of suggesting raw
bash as a scientific fallback. This is guidance for the agent’s tool
use; Pi’s `user_bash` event remains the separate hook for human-entered
`!` and `!!` commands.

The reference server binds loopback and is not a sandbox. Pi and its
tools run with the permissions of the launching process. Remote or
multi-user deployment requires explicit authentication, TLS,
credential/admission policy, and an operator-chosen isolation boundary.

## Ledger

Runs, facts, memory, job status, session traces, and artifacts are rows
in `bio_observations`, read as of a time. The graph view is derived from
edge-like observations, so these are ordinary SQL questions:

- what is the current fact?
- what did the agent learn?
- what was this job’s status at a time?
- which tool call produced this scientific run?
- which manifest, operation, and resources did it use?

When a host supplies the ledger, run facts, manifest-declaration links,
and declared artifact projections are required evidence. A recording
failure is returned with the already-persisted run path; it is not
silently converted into success. `pi-bio-agent reproduce` and
`bio_reproduce_run` re-execute `replay.json` against a fresh database
and report source, output, or environment drift.

Persisted Pi session JSONL and Codex rollout JSONL are ingested as
`session:`, `turn:`, `msg:`, `toolcall:`, and `cas:` observations
through the same ledger contract. Pi’s extension syncs its active
session; any host can use the CLI importer:

``` sh
pi-bio-agent session import <session.jsonl> --format pi
pi-bio-agent session import <rollout.jsonl> --format codex
```

The original JSONL is streamed into CAS and normalization reads that
immutable snapshot, so a live file growing during import cannot disagree
with its digest. Large traces commit bounded, idempotent batches; the
terminal `session` fact is the completion marker and a retry does not
duplicate prior statements. Persisted transcripts recover messages, tool
trajectories, compaction, and parentage. Runtime-only delivery/interrupt
signals still need a host hook. Bio tools record controlled run links at
execution time; the ingester never scans transcript text for run-looking
strings.

Window an edge-shaped graph table without loading the whole
neighborhood:

``` sh
pi-bio-agent query examples/graph-window/manifest.json \
  --db .pi/bio-agent/readme-graph-window.duckdb \
  --sql "SELECT count(*) AS n FROM bio_edges"
```

<details class="pi-bio-output">

<summary>

JSON output: cell-8
</summary>

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
      "n": 4
    }
  ]
}
```

</details>

``` sh
pi-bio-agent graph-window \
  --db .pi/bio-agent/readme-graph-window.duckdb \
  --table bio_edges \
  --start run:readme \
  --direction both \
  --limit 10
```

<details class="pi-bio-output">

<summary>

JSON output: cell-9
</summary>

``` json
{
  "schema": "pi-bio.graph_query_window.v1",
  "table": "bio_edges",
  "startId": "run:readme",
  "direction": "both",
  "predicates": [],
  "limit": 10,
  "offset": 0,
  "rows": [
    {
      "from_id": "toolcall:readme",
      "predicate": "executes",
      "to_id": "run:readme"
    },
    {
      "from_id": "run:readme",
      "predicate": "invoked_by",
      "to_id": "toolcall:readme"
    },
    {
      "from_id": "run:readme",
      "predicate": "produced",
      "to_id": "artifact:readme-result"
    },
    {
      "from_id": "run:readme",
      "predicate": "used_manifest",
      "to_id": "manifest:graph-window"
    }
  ],
  "totalCount": 4,
  "omittedCount": 0
}
```

</details>

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

<details class="pi-bio-output">

<summary>

JSON output: cell-10
</summary>

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

</details>

## Pi tools

The `pi-coding-agent` extension registers these tools over the
substrate. This list is generated from the extension’s `registerTool()`
calls (`npm run readme:tools`); `npm run check` fails if it drifts.

<!-- BEGIN GENERATED:tools (scripts/generate-readme-tools.mjs — do not edit by hand) -->

- `bio_list_sources` — List manifest-backed sources
- `bio_describe_model` — Describe Pi Bio model
- `bio_run_operation` — Run a bio operation
- `bio_query` — Run an ad-hoc bio query
- `bio_reproduce_run` — Reproduce a bio run
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

The package also ships `skills/pi-bio-agent/`: a procedural guide for
hosts that do not run the Pi extension. It is not a biomedical
computation pack. It tells an agent to discover and describe manifests,
inspect tables with `DESCRIBE` / `SUMMARIZE`, run read-only SQL through
`pi-bio-agent query`, and use `graph-window` for bounded ledger or KG
walks.

Pi users should normally install the full package. That gives Pi the
`bio_*` tools, the plain skill, and session trace integration that links
tool calls to the recorded `run:<id>` they produced:

``` sh
pi install git:github.com/sounkou-bioinfo/pi-bio-agent
/reload
```

Install only the skill, directly from GitHub and without cloning, when
another host should call the CLI:

``` sh
npx --yes github:sounkou-bioinfo/pi-bio-agent install-skill --host codex
npx --yes github:sounkou-bioinfo/pi-bio-agent install-skill --host pi-project
npx --yes github:sounkou-bioinfo/pi-bio-agent install-skill --host claude-project
npx --yes github:sounkou-bioinfo/pi-bio-agent install-skill --host opencode-project
npx --yes github:sounkou-bioinfo/pi-bio-agent install-skill --host copilot-project
npx --yes github:sounkou-bioinfo/pi-bio-agent install-skill --dest /path/to/host/skills
```

Supported `--host` presets include `codex`, `pi`, `pi-project`,
`claude`, `claude-project`, `opencode`, `opencode-project`, `copilot`,
and `copilot-project`. Use `--dest` for any host-specific skill
directory not covered by a preset.

The skill install does not guarantee the CLI is on `PATH`. Install the
CLI persistently when the host should run `pi-bio-agent query` /
`pi-bio-agent run` later:

``` sh
npm install -g github:sounkou-bioinfo/pi-bio-agent
pi-bio-agent install-skill --dest /path/to/host/skills
```

From a checkout, install the skill for local development and optionally
link the CLI:

``` sh
npm install
npm run build
npm run install:skill -- --dest /path/to/host/skills
npm run install:skill -- --dest /path/to/host/skills --link-cli
```

Run `npx --yes github:sounkou-bioinfo/pi-bio-agent install-skill --help`
for all presets and flags. The skill is guidance; manifests, SQL,
receipts, CAS, and observations remain the computation.

## Docs

Start with the [user guide](docs/guide.md): write a manifest, inspect
its schema, and compose a query. Then read the [conceptual
architecture](docs/design.md), [lineage](docs/lineage.md), and
[roadmap](docs/roadmap.md). The full [docs index](docs/INDEX.md) is
generated from frontmatter.

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
- **Recursive Language Models / RLM** (symbolic code and recursive model
  calls over external context; `bio_query` supplies the relational
  data-plane part, not the recursive model loop):
  <https://arxiv.org/abs/2512.24601>
- **ducknng**, an Arrow-native DuckDB extension for NNG/HTTP/RPC
  transport, in the lineage of R’s `nanonext` + `mirai`:
  <https://github.com/sounkou-bioinfo/ducknng> ·
  [NNG](https://nng.nanomsg.org/) ·
  [`nanonext`](https://github.com/r-lib/nanonext) ·
  [`mirai`](https://mirai.r-lib.org/)
- **SemanticSQL** (canonical LinkML source schema for `statements`,
  `prefix`, generated views, and `entailed_edge`):
  <https://github.com/INCATools/semantic-sql>
- Design thread (Sounkou Mahamane Toure × Manuel Corpas):
  [LinkedIn](https://www.linkedin.com/feed/update/urn:li:activity:7473824764575436800)

## Development

``` sh
npm install
npm run check     # typecheck + tests + docs/readme/examples staleness gates (the single gate)
```

`npm run provision:duckhts` installs the DuckHTS community extension for
local `duckhts.read_bcf` tests. `npm run provision:ducknng-owned`
verifies the owned retry/auth/upload/TLS/RPC surface. Runtime Pi APIs
are peer dependencies supplied by Pi itself.

### Executable examples

The deterministic QMD patterns execute their own SDK, DuckDB, and
DuckNNG code and render collapsed results:

``` sh
npm run patterns:qmd
npm run application:clinical
```

The clinical application is downstream policy, while generic patterns
exercise reusable substrate mechanics. The full gate rerenders both and
rejects stale Markdown.

Run the Pi session trace pattern after installing the extension and
configuring an image-capable model:

``` sh
npm run pattern:pi-session-trace
```

It drives a real Pi session through image read, successful shell call,
intentional shell error, manifest discovery, SQL validation,
`bio_query`, and then queries the project ledger for the session
summary, tool trajectory, CAS roots, and the recorded tool-call/run
linkage.

## Status & contributing

Pre-1.0 (`0.1.0`). The public API may still move. Issues and PRs
welcome. Keep new capability manifest/SQL-first: a new question should
become data, a resolver adapter, or SQL, not bespoke core code.

## License

[GPL-2.0-or-later](LICENSE) © Sounkou Mahamane Toure
