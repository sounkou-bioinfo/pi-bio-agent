# AGENTS.md

## Product boundary

This repository is the Pi Bio application. It is not a host-neutral SDK and does not support alternative agent harnesses.

- `@earendil-works/pi-agent-core` AgentHarness v2 owns agent operations, lanes, transcripts, retries, cancellation, and recovery.
- DuckDB owns durable scientific tables. Harness storage and DuckDB scientific state are separate authorities.
- R is a persistent scratch interpreter reached through nanonext/NNG. Never claim that its heap survives worker restart.
- Large results belong in DuckDB or artifacts, not model context.
- The API owns credentials and effects. Browser and Electron renderer code are presentation only.

## Layout

- `apps/api`: Harness host, HTTP/SSE API, and supervised scientific worker.
- `apps/web`: browser UI consuming only the API.
- `apps/desktop`: Electron shell that launches the same API and serves the same web build.
- `packages/protocol`: runtime-validated DTOs shared by API and web.

Do not recreate `packages/workbench`, a host adapter layer, a general manifest framework, or a second job/session lifecycle. Add an abstraction only after two concrete application call sites require the same motion.

## Runtime rules

- R, DuckNNG, generated C, and other crash-prone native execution run outside the Harness/API process.
- Process separation is failure containment, not a sandbox. Remote or multi-tenant deployments require an external container or VM boundary, read-only mounts, scoped credentials, and controlled egress.
- Serialize mutations to one R workspace and writable DuckDB connection.
- Record code, SQL, runtime identity, bounded previews, and durable result references. Never silently replay an interrupted mutating cell.
- `pi-ducknng` owns the DuckNNG RPC frame and R endpoint. Do not copy that protocol here.
- `pi-cplugins` may be added only through a supervised native worker and a Harness-native tool adapter; never load generated native code in the API process.

## API and UI

- Keep API inputs runtime-validated with `packages/protocol` schemas.
- SSE is a projection of live Harness events. On reconnect, clients obtain a fresh Harness snapshot; the SSE buffer is not scientific or agent state.
- Electron uses context isolation, renderer sandboxing, no Node integration, and a random bearer token for its loopback API.
- A non-loopback API must refuse startup without authentication.

## Checks

Run:

```sh
npm run check
npm run test:integration   # requires the R imports in pi-ducknng/DESCRIPTION and a native DuckNNG build toolchain
npm audit
```

The integration test must prove state across separate DuckDB calls and separate R-over-NNG calls. Keep unsupported capabilities explicit rather than adding fallbacks.
