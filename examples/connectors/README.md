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
binds no egress, so a connector fails closed until the host allows it. The `http.get` form (e.g.
[`uniprot-http.json`](uniprot-http.json)) needs no `--init-sql` — the host-supplied `fetch` resolves it, so the
**agent** can drive it directly and compose the SQL itself.

## Auth, MCP, and streaming (the reach)

These starter manifests hardcode a plain `Accept: application/json` header, but the `headers` argument of
`ducknng_ncurl_table` is a SQL value — so it *can be composed from a host-owned variable*. That opens the same
pattern to:
- **token-gated APIs** — the host sets an `Authorization` header from a `duckdbConfig`/bound variable, never an agent param;
- **MCP servers** — the HTTP-shaped JSON-RPC of an MCP endpoint is an `ncurl` call (full session/SSE semantics may need a host wrapper);
- **streaming** — SSE / websockets via ducknng `wss`.

Secrets stay on the host boundary; the manifest names the shape, the host supplies the auth.
