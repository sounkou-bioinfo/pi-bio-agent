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
  --bindings '{"uniprot_acc":"P04637"}' --sql "SELECT * FROM uniprot_entry"
```

The host must provision ducknng once (`INSTALL ducknng FROM community; LOAD ducknng`) via `duckdbInitSql`, and —
for HTTPS — a TLS config bound to `{tls}`. **Network is the host's capability, never the agent's**: the default
CLI/extension entrypoint binds no egress, so a connector fails closed until the host allows it.

## Auth, MCP, and streaming

`ducknng_ncurl_table` takes **host-provided headers**, so the same pattern reaches:
- **token-gated APIs** — the host injects an `Authorization` header (a binding/`duckdbConfig` value, never an agent param);
- **MCP servers** — JSON-RPC over HTTP + SSE is an `ncurl` call;
- **streaming** — SSE / websockets via ducknng `wss`.

Secrets stay on the host boundary; the manifest only names the shape.
