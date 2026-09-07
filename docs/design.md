---
title: Pi Bio design
---

# Pi Bio design

Pi Bio is one Pi-specific application with three presentations: HTTP/SSE API, browser UI, and Electron desktop. It does not wrap the legacy coding-agent SDK and does not implement a host-neutral tool layer.

## Runtime topology

```text
browser or Electron renderer
          |
          v
HTTP/SSE API process
  AgentHarness v2 --- JSONL session storage
          |
          v
supervised scientific worker
  DuckDB connection --- science.duckdb
  DuckNNG client ----- NNG ----- persistent R process
```

The Electron main process launches the same API used by the web application. Its renderer has no Node integration and receives only a loopback endpoint and random bearer token through a preload bridge. The current package leaves ASAR disabled because the external R process must read the endpoint script and DuckNNG build artifacts as ordinary files; enable ASAR only after that runtime has an explicit unpacked-resource path contract.

## Authorities

AgentHarness v2 is the only authority for prompts, transcript entries, tool calls, lanes, operation outcomes, retry state, cancellation, and recovery. The API's bounded SSE history is an ephemeral delivery optimization; clients recover with a new lane snapshot.

DuckDB is the authority for durable scientific tables. R is a process-local scratch environment. A successful R result is not durable merely because the process remains alive. Analyses that matter must write declared tables or artifacts and retain code and runtime evidence in the Harness tool result.

## Direct RLM composition

`delegate` creates a blank child Harness lane and records its deterministic lane and operation identifiers in the parent tool invocation memo before admitting work. Safe replay therefore targets the same child operation. The child can use `duckdb_sql`, `r_eval`, and `r_reset`; it cannot recursively delegate in the first implementation.

This removes the need for a Jupyter kernel, Python control package, Python-to-TypeScript host requests, or a second agent daemon. Interpreter execution and recursive model execution are separate concerns:

- `r_eval` reaches a session-scoped environment in a persistent R process through nanonext/NNG and DuckNNG.
- `duckdb_sql` reaches the session's persistent scientific database.
- `delegate` uses AgentHarness directly.

## Native boundary

The scientific worker contains DuckDB and the DuckNNG native extension. It starts the R endpoint owned by the pinned `pi-ducknng` package. The API process contains neither interpreter. Cancellation may terminate the worker; DuckDB tables survive while the R heap does not.

This is failure containment, not hostile-code isolation. A remote deployment must place each tenant or trusted workspace in a separately constrained container or VM. Generated C through `pi-cplugins` requires another supervised native worker or an extension of this one; it must not enter the API process.

## Current vertical slice

The application supports:

- durable Harness sessions and a main lane;
- asynchronous prompt admission, abort, snapshots, and live events;
- persistent DuckDB SQL;
- persistent R evaluation over nanonext/NNG;
- one-level direct Harness delegation;
- one web build shared by browser and Electron.

Biomedical network resources and richer artifact views are deliberately not represented by a generic connector catalog. They should enter as concrete Harness tools backed by declared evidence and application tests.
