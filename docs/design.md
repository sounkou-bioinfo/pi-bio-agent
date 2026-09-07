---
title: Pi Bio design
---

# Pi Bio design

Pi Bio is a Pi application with three presentations: HTTP/SSE API, browser UI, and Electron desktop.

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

The Electron main process launches the same API used by the web application. Its renderer has no Node integration and receives only a loopback endpoint and random bearer token through a preload bridge. Electron permits sanitized clipboard writes from the main application frame and denies other permission requests (`apps/desktop/src/main.mjs`). The CommonJS preload runs in Electron’s sandboxed preload environment. `npm run test:desktop` checks the API connection, renderer isolation, and clipboard permissions. ASAR is disabled because the external R process must read the endpoint script and DuckNNG build artifacts as ordinary files; enable ASAR only after that runtime has an explicit unpacked-resource path contract.

## Credentials

The application registers Pi’s built-in provider catalog and uses its `CredentialStore` contract. Default model selection is independent of provider availability. `CredentialService` transports Pi’s `AuthInteraction` prompts and notifications without choosing provider-specific flows. Provider code owns login, refresh, and cancellation. A file adapter uses Pi-compatible locking and atomic, fsynced replacement of `~/.pi/agent/auth.json`. Credential values are never included in account-status responses. See `apps/api/test/credential-service.test.ts`, `credential-store.test.ts`, and `credential-publication.test.ts`. Browser auth polls are invalidated by provider changes and account actions so a stale response cannot visually undo sign-out (`apps/web/test/account.test.ts`).

## Authorities

AgentHarness v2 is the only authority for prompts, transcript entries, tool calls, lanes, operation outcomes, retry state, cancellation, and recovery. The API and browser project live state with Pi’s `reduceLaneSnapshot`. Every SSE connection starts with a fresh snapshot, followed by ordered events. The serial watch callback completes each resnapshot before delivering subsequent events. Snapshot cursors and connection ownership prevent older HTTP responses or abandoned streams from replacing newer state. A client with more than 128 queued frames is disconnected and reconnects from a fresh baseline. Transport and restart comparisons are exercised in `apps/api/test/app.test.ts` and `apps/api/test/agent-service.test.ts`.

SQLite in `workspace.sqlite` owns mutable application state: draft text and archive markers. An immediate browser recovery copy protects unacknowledged draft edits; it is removed only after the server acknowledges the same text. Pi JSONL stores conversations and recovery state. Changing session backends requires a tested offline transfer preserving entries, values/lists, usage, and recovery state. A conversation fork resets operation/result/usage state, so it cannot serve as an exact storage migration.

Archive and prompt admission are serialized at the application boundary so a hidden session cannot start a new operation concurrently with archival. Restore clears only the marker. The UI blocks conflicting session actions while an archive or restore is pending, while Pi continues to own running operations. Restart tests cover names, drafts, history, archives, and restored operation eligibility (`apps/api/test/agent-service.test.ts`).

DuckDB is the authority for durable scientific tables. R is a process-local scratch environment. A successful R result is not durable merely because the process remains alive. Analyses that matter must write declared tables or artifacts and retain code and runtime evidence in the Harness tool result.

## Delegation and scientific execution

`delegate` creates a blank child Harness lane and records its deterministic lane and operation identifiers in the parent tool invocation memo before admitting work. Safe replay therefore targets the same child operation. Child lanes can use `duckdb_sql`, `r_eval`, and `r_reset`. Delegation is limited to one level.

The execution paths are:

- `r_eval` reaches a session-scoped environment in a persistent R process through nanonext/NNG and DuckNNG.
- `duckdb_sql` reaches the application's shared persistent scientific database. A conversation fork does not clone these tables.
- `delegate` uses AgentHarness directly.

## Native boundary

The scientific worker contains DuckDB and the DuckNNG native extension. It starts the R endpoint owned by the pinned `pi-ducknng` package. The API process contains neither interpreter. Cancellation may terminate the worker; DuckDB tables survive while the R heap does not.

This is failure containment, not hostile-code isolation. A remote deployment must place each tenant or trusted workspace in a separately constrained container or VM. Generated C through `pi-cplugins` requires another supervised native worker or an extension of this one; it must not enter the API process.

Electron and DuckDB ship Windows binaries. DuckNNG source provisioning uses GNU Make. A host-provided extension can be selected with `DUCKNNG_EXTENSION_PATH`; Windows R/NNG execution is unverified.

## Workspace UX

[Claude for Life Sciences](https://claude.com/product/claude-science) and [Rosalind Workbench](https://developers.openai.com/blog/rosalind-workbench) inform the workspace design: connected data, inspectable code, figures, and durable research context. Artifact viewers, checkpoints, and evidence views are planned.

Pi’s interactive code provides the interaction reference: `assistant-message.ts` renders thinking and text in source order, `footer.ts` distinguishes usage estimates from subscription billing, `diff.ts` renders patch changes, and `core/slash-commands.ts` defines distinct name/session/fork/clone/reload semantics. The web application uses Svelte, markdown-it with raw HTML disabled, and highlight.js. Reasoning comes only from provider-supplied blocks. Code copy preserves the source text. See `apps/web/test/message.test.ts`.

Session controls call Pi’s naming, repository fork, transcript tree, and usage projections. `/fork` stops before a selected user message and restores it as a draft; `/clone` copies the current main-branch position. Neither copies the R heap or shared DuckDB database. The tree currently displays branches; full navigation and cross-branch scientific comparison remain pending. Fenced patches are highlighted; this is not an implemented file-edit tool or artifact-diff service.

The composer lists supported commands with keyboard completion. Extension installation, approved-resource reload, and extension command discovery are not yet supported.

The development runner watches API and protocol sources, stops the API child before rebuilding, and starts it after a successful build. API restarts discard R scratch memory; saved DuckDB tables persist. Unknown API routes return JSON 404s, and the client checks response content types. The API emits production CSP headers; Vite supplies development styles.

## Capabilities

The application supports:

- durable Harness sessions and a main lane;
- asynchronous prompt admission, abort, snapshots, and live events;
- persistent DuckDB SQL;
- persistent R evaluation over nanonext/NNG;
- one-level direct Harness delegation;
- one Svelte web build shared by browser and Electron;
- provider-neutral account/model controls, rich chat rendering, persisted drafts, naming, reversible archives, conversation forks, tree projection, and recorded usage estimates.

Add biomedical resources and artifact operations as concrete Harness tools backed by declared evidence and application tests.
