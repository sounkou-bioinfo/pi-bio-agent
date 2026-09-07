# AGENTS.md

## Product boundary

Pi Bio is a scientific application built on Pi, with API, browser, and Electron presentations.

- `@earendil-works/pi-agent-core` AgentHarness v2 owns agent operations, lanes, transcripts, retries, cancellation, and recovery.
- Pi's provider catalog, `CredentialStore`, and `AuthInteraction` own model/authentication semantics. Register Pi’s built-in providers and configure the default model independently. Reuse the canonical Pi auth file.
- DuckDB owns durable scientific tables. SQLite owns mutable application state. Pi session storage owns transcripts and recovery; do not duplicate that log or use a lossy fork as a storage migration.
- R is a persistent scratch interpreter reached through nanonext/NNG. Worker restart discards its heap; durable results belong in tables or artifacts.
- Large results belong in DuckDB or artifacts, not model context.
- The API owns credentials and effects. Browser and Electron renderer code are presentation only.

## Layout

- `apps/api`: Harness host, HTTP/SSE API, and supervised scientific worker.
- `apps/web`: browser UI consuming only the API.
- `apps/desktop`: Electron shell that launches the same API and serves the same web build.
- `packages/protocol`: runtime-validated DTOs shared by API and web.

Keep application composition in these packages and execution lifecycle in Pi. Add an abstraction only after two concrete application call sites require the same behavior.

## Runtime rules

- R, DuckNNG, generated C, and other crash-prone native execution run outside the Harness/API process.
- Process separation is failure containment, not a sandbox. Remote or multi-tenant deployments require an external container or VM boundary, read-only mounts, scoped credentials, and controlled egress.
- Serialize mutations to one R workspace and writable DuckDB connection.
- Record code, SQL, runtime identity, bounded previews, and durable result references. Never silently replay an interrupted mutating cell.
- `pi-ducknng` owns the DuckNNG RPC frame and R endpoint. Do not copy that protocol here.
- `pi-cplugins` may be added only through a supervised native worker and a Harness-native tool adapter; never load generated native code in the API process.

## API and UI

- Use Pi TUI interactions as the UX reference. Preserve command meanings, ordered thinking/text, explicit failures, keyboard discovery, and estimated-versus-billed usage semantics.
- Use Svelte and maintained Markdown/syntax renderers. Build the workspace around analysis, durable results, and inspectable evidence. Keep unsupported capabilities explicit.
- Keep API inputs runtime-validated with `packages/protocol` schemas.
- Project live state with Pi’s browser-safe reducer. Start each SSE connection with a fresh snapshot, then apply ordered events through a bounded delivery queue. Use cursors and connection ownership to reject stale responses.
- Electron uses context isolation, renderer sandboxing, a CommonJS preload, no renderer Node integration, and a random bearer token for its loopback API. Verify the real entrypoint with `npm run test:desktop` after building (use `xvfb-run -a` on headless Linux).
- A non-loopback API must refuse startup without authentication.

## Checks

Run:

```sh
npm run check
npm run test:integration   # requires the R imports in pi-ducknng/DESCRIPTION and a native DuckNNG build toolchain
npm audit
```

The integration test must prove state across separate DuckDB calls and separate R-over-NNG calls. Keep unsupported capabilities explicit rather than adding fallbacks.
