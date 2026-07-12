# Scientific-database connectors — each is a manifest, zero TypeScript

Hosted AI-for-science products advertise "60+ connected scientific databases." Here a connector is a
**manifest** over a host-provisioned DuckDB extension or fetch port. HTTP JSON commonly uses
`ducknng_ncurl_table(...)`; a foreign SQL catalog uses DuckDB's MySQL/Postgres extension and ordinary SQL.
**No client code, no new `.ts`** — a new database is usually a new file.

Starter pack (each reaches a real public source; the identifier is the agent's binding):

| connector | database | binding | endpoint |
|---|---|---|---|
| [`uniprot.json`](uniprot.json) | UniProt | `{uniprot_acc}` | `rest.uniprot.org/uniprotkb/{acc}.json` |
| [`pdb.json`](pdb.json) | RCSB PDB | `{pdb_id}` | `data.rcsb.org/rest/v1/core/entry/{id}` |
| [`mygene.json`](mygene.json) | MyGene / BioThings | `{gene_id}` | `mygene.info/v3/gene/{id}` |
| [`reactome.json`](reactome.json) | Reactome | `{reactome_id}` | `reactome.org/ContentService/data/query/{id}` |
| [`opentargets-graphql.json`](opentargets-graphql.json) | OpenTargets Platform GraphQL | `{ensembl_id}` | `api.platform.opentargets.org/api/v4/graphql` |
| [`ensembl-mysql.json`](ensembl-mysql.json) | Ensembl 116 core | `{gene_symbol}` | `ensembldb.ensembl.org/homo_sapiens_core_116_38` |

Add another (ClinVar, ChEMBL, GEO, …) by declaring the source through an existing DuckDB or host port. See
[`variant-annotation`](../variant-annotation/) for a POST/batch connector (Ensembl VEP) and
[`ols4-grounding`](../ols4-grounding/) for an ontology-service connector.

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

Foreign catalogs follow the same host boundary. This live Ensembl query requires the host to provision DuckDB's
official `mysql` extension, admit egress to the public server, attach the release database read-only, and pin that
database name in the manifest receipt:

```sh
pi-bio-agent query examples/connectors/ensembl-mysql.json --db :memory: \
  --init-sql "LOAD mysql; SET mysql_experimental_filter_pushdown=true; ATTACH 'host=ensembldb.ensembl.org user=anonymous port=3306 database=homo_sapiens_core_116_38 ssl_mode=disabled' AS ensembl (TYPE mysql, READ_ONLY)" \
  --bindings '{"gene_symbol":"BRCA2"}' \
  --sql "SELECT * FROM ensembl_gene"
```

The filter-pushdown setting keeps the selective gene-symbol predicate on the public MySQL server instead of reading
the source tables in full. The attached catalog remains available to schema-discovery SQL during the run. Release `116`, database
`homo_sapiens_core_116_38`, and assembly `GRCh38` are data identity; `latest` would not be a reproducible source pin.

## Auth, MCP, and streaming (the reach)

These REST manifests hardcode a plain `Accept: application/json` header. Auth is still a host boundary, and the
safe order is:
- **token-gated APIs** — prefer a **host-commissioned ducknng HTTP profile** for SQL-native connectors. The host
  registers the profile on the DuckDB connection (for local hosts, use `registerDucknngHttpProfile`), pins its
  scheme/host/port/path/method/TLS scope, optionally admits only named execution subjects, and keeps the secret
  header value inside ducknng. Agent-visible SQL supplies only the non-secret `profile_id` to
  `ducknng_ncurl(...)`, `ducknng_ncurl_aio(...)`, or `ducknng_ncurl_table(...)`. The profile resolver injects the
  credential after scope/admission checks and rejects caller headers that collide with the injected auth header. The
  registration helper returns a secret-free profile receipt for run provenance; record that receipt, not the token. For
  hosts that deliberately choose the JS-fetch resolver path, **`http.get` + `withAuth`** calls the host's auth
  supplier per request, so Pi-style `AuthStorage` / OAuth refresh can rotate the access token immediately before use.
  `SET VARIABLE` header
  composition is no longer the recommended auth integration point; it is SQL-visible and should stay limited to
  legacy isolated host-authored operations;
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
summary. The resource region selects index blocks efficiently; answer SQL should still state the exact coordinate
predicate because pushdown is not the semantic filter. Secrets stay on the host boundary; the manifest names the
shape, the host supplies the auth.
