# Scientific-database connectors — each is a manifest, zero TypeScript

Hosted AI-for-science products advertise "60+ connected scientific databases." Here a connector is just a
**manifest**: a `duckdb.sql_materialize` resource whose SQL is a `ducknng_ncurl_table(...)` GET, so the JSON
response is parsed straight into a DuckDB table. **No client code, no new `.ts`** — a new database is a new file.

Starter pack (each hits the real public REST API; the accession is the agent's binding):

| connector | database | binding | endpoint |
|---|---|---|---|
| [`uniprot.json`](uniprot.json) | UniProt | `{uniprot_acc}` | `rest.uniprot.org/uniprotkb/{acc}.json` |
| [`pdb.json`](pdb.json) | RCSB PDB | `{pdb_id}` | `data.rcsb.org/rest/v1/core/entry/{id}` |
| [`mygene.json`](mygene.json) | MyGene / BioThings | `{gene_id}` | `mygene.info/v3/gene/{id}` |
| [`reactome.json`](reactome.json) | Reactome | `{reactome_id}` | `reactome.org/ContentService/data/query/{id}` |

Add another (Ensembl, ClinVar, ChEMBL, GEO, OpenTargets GraphQL, …) by pointing a new manifest at a new URL — the
shape doesn't change. See [`variant-annotation`](../variant-annotation/) for a POST/batch connector (Ensembl VEP)
and [`ols4-grounding`](../ols4-grounding/) for an ontology-service connector.

## Running one

```sh
pi-bio-agent query examples/connectors/uniprot.json --db :memory: \
  --init-sql "INSTALL ducknng FROM community; LOAD ducknng; SET VARIABLE tls = ducknng_tls_config_from_pem(NULL, NULL, NULL, '', 1)" \
  --bindings '{"uniprot_acc":"P04637"}' --sql "SELECT primaryAccession, uniProtkbId FROM uniprot_entry"
```

The `ncurl_table` connectors are pure SQL, so the host provisions ducknng + a TLS config with `--init-sql` (the
DuckDB-native path). **Network is the host's capability, never the agent's**: the default CLI/extension entrypoint
injects no `fetch`, so the `http.get` path fails closed until the host binds one. The `http.get` form (e.g.
[`uniprot-http.json`](uniprot-http.json)) needs no `--init-sql` — the host-supplied `fetch` resolves it, so the
**agent** can drive it directly and compose the SQL itself.

> **DuckDB-level egress is a host-sandbox residue, not a library gate.** The SQL path reaches the network only
> through a DuckDB extension (`httpfs`, community `ducknng`). The resolver does `LOAD` (never `INSTALL`), so a
> clean environment fails closed — but a DuckDB `INSTALL` persists in the extension directory, so once a host has
> installed a network-capable extension there, an agent-authored manifest can `LOAD` it (via `params.extensions`)
> and egress through SQL in a later run, even one that injected no `fetch`. A denylist of "network extensions" can
> never be complete, so the library stays permissive and records what ran; a host that wants strict no-egress must
> not install network extensions into a shared DuckDB home (or must isolate that home per trust boundary) — the
> same egress residue as an `httpfs` replacement scan (see `src/core/sql-guard.ts`).

## Auth, MCP, and streaming (the reach)

These REST manifests hardcode a plain `Accept: application/json` header. Auth is still a host boundary, and the
safe order is:
- **token-gated APIs** — prefer the **`http.get` + `withAuth`** path when the host must keep a token out of SQL:
  `withAuth` calls the host's auth supplier per request, so Pi-style `AuthStorage` / OAuth refresh can rotate the
  access token immediately before use. When a DuckDB table function supports DuckDB's **`CREATE SECRET`** manager,
  use that unreadable secret path. A host-authored declared operation may also compose `ducknng_ncurl_table`
  headers from `SET VARIABLE` with `ducknng_http_headers_build` (proved against a local ducknng route in
  `test/ducknng-sql-http.test.ts`), but that is composition, not secrecy: the same connection can read
  `getvariable()`. Keep that pattern behind an isolated operation connection; never expose it through agent params
  or arbitrary `bio_query`;
- **MCP servers** — an MCP `initialize` / `tools/list` / `tools/call` (JSON-RPC 2.0 over HTTP) **is an `ncurl`
  POST** — see [`mcp.json`](mcp.json). The manifest is structurally validated without network
  (`test/connectors-example.test.ts`), and `test/ducknng-sql-http.test.ts` proves the local session-header loop:
  `initialize` returns `Mcp-Session-Id`, and the following `tools/list` call threads it back as a header. Live
  external execution remains host-gated;
- **streaming** — `test/ducknng-sql-http.test.ts` proves an SSE route served by ducknng and consumed with
  `ducknng_ncurl`; bidirectional `wss` / server-pushed app subscriptions remain a ducknng conformance lane until
  this repo directly needs that transport.

Two connectors go beyond REST: [`mcp.json`](mcp.json) (MCP over SQL) and
[`clinvar-region.json`](clinvar-region.json) — a **ClinVar VCF region read live over HTTP by `duckhts`** (an
htslib tabix range read, not a whole-file download), where the agent discovers the schema and composes the
summary. Secrets stay on the host boundary; the manifest names the shape, the host supplies the auth.
