# pi-bio-agent MCP adapter

This package exposes the public `pi-bio-agent` scientific SDK through the final MCP `2026-07-28` protocol.

The HTTP path is sessionless. `createMcpHandler()` creates a fresh server instance for each modern request, and every
request carries its protocol version, client identity and client capabilities in `_meta`. There is no MCP session table,
no `initialize`/`initialized` dependency, and no `Mcp-Session-Id`. Durable state remains where it belongs: run evidence,
CAS objects and the optional temporal observation store.

## Embed the web-standard handler

```ts
import { fsCasStore } from "pi-bio-agent";
import { createBioMcpHandler } from "pi-bio-agent-mcp";

const handler = createBioMcpHandler({
  cwd: process.cwd(),
  catalogRoot: "examples",
  cas: fsCasStore(".pi/bio-agent/cas"),
  profile: "exploratory",
});

export default handler;
```

`handler.fetch(request, { authInfo })` accepts authentication information that the embedding host has already
verified. The adapter never derives trust from an `Authorization` header. When no explicit `author` is configured,
`authInfo.clientId` becomes the run attribution; if `authInfo.clientId` is absent, runs are attributed to `mcp:anonymous`.

The default legacy posture is `reject`. A host may explicitly set `legacy: "stateless"` to enable the SDK's
per-request 2025 compatibility fallback. That does not create sessions.

## Run the loopback entrypoint

```sh
pi-bio-mcp --cwd . --catalog-root examples --port 8765
```

The endpoint is `http://127.0.0.1:8765/mcp`. The CLI deliberately grants no network or process-compute capability. It
uses a local CAS by default. Remote or multi-user deployment still needs authentication, TLS, Host/Origin validation,
credentials and process/network isolation supplied by the deployment host.

## Scientific tools

| Tool | Contract |
|---|---|
| `bio_list_sources` | Lists validated manifests from one fixed host-approved catalog. |
| `bio_describe_model` | Validates and describes one manifest by ID and reports host capability admission. |
| `bio_query` | Runs one core-validated read-only result statement; available only in `exploratory`. `DESCRIBE` and `SUMMARIZE` provide schema discovery. |
| `bio_run_operation` | Runs a named `duckdb.sql` operation through the same public implementation used by Pi. |
| `bio_get_run` | Reads exact persisted run/result/receipt/replay/CAS-reference JSON. |
| `bio_reproduce_run` | Replays a persisted run on a fresh database and compares outcome, receipts, result and environment evidence. |

Tool arguments use `manifestId`, never caller-selected filesystem paths. The host fixes the catalog root and the
adapter resolves and realpaths each matching manifest beneath it.

## Resources

- `pi-bio://manifests/{manifestId}` returns exact manifest JSON from the approved catalog.
- `pi-bio://runs/{runId}/{part}` returns `run`, `result`, `receipts`, `replay` or `cas-refs` JSON.

The run-id grammar is the public pi-bio grammar and evidence reads are realpath-confined beneath the run root.

## Result delivery

Query and operation calls require an explicit semantic choice:

- `reference` is the default. It returns row count, CAS references and durable MCP evidence URIs, without copying the
  result rows into the protocol response.
- `inline` returns the complete result. There is no hidden row cap.

The persisted scientific result is complete in either mode. Presentation delivery never changes the run.

## Permission profiles

- `exploratory`: ad-hoc read-only SQL and named operations.
- `operations-only`: named operations and evidence/replay tools; no model-authored SQL tool.
- `sealed-offline`: operations-only, requires CAS, and refuses explicit network, process-compute, DuckNNG profile and
  injected-resolver grants.

`sealed-offline` is a capability profile, not an OS sandbox. DuckDB extension provisioning, remote filesystem access,
credentials and egress still belong to the host's deployment boundary.

## Proof

`test/stateless-mcp.test.ts` sends independent final-protocol HTTP requests to:

1. call `server/discover` without initialization;
2. list tools and manifests;
3. execute and persist a query;
4. read its replay as an MCP resource;
5. reproduce it from a later request and verify its pinned result digest.

The tests assert that no response creates `Mcp-Session-Id`. `test/conformance.test.ts` sends adversarial requests for
dynamic SQL, protected variables, undeclared relations, manifest path confusion, permission profiles and legacy
initialization. The adapter delegates scientific SQL and replay semantics to the public `pi-bio-agent` package rather
than reimplementing them.
