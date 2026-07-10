---
type: Reference
title: Resources and resolvers
description: "Read before defining resources, resolvers, or operation contracts."
tags: [resources, cas, resolvers, operation-spec]
---

# Resources and resolvers

The core never assumes a model provider, agent harness, HTTP client, shell runner, or database binding. A
manifest declares resources/resolvers/operations as data; a host binds the executable adapters at runtime.

## Resource handles

A resource handle is a durable reference to data without forcing the core to know where bytes live:

- `inline`, small JSON payload - `reference`, file, object-store URI, database table, URL, etc.
- `content_address`, algorithm + digest + optional size/media type - `virtual`, resolver name + query payload

Content-addressed resources make caching and reproducibility explicit. The same digest means the same bytes regardless of local path.

## Resolvers and resources

A `BioResolverSpec` declares a capability that turns a `VirtualResourceSpec` (an opaque `params` bundle) into a `ResourceHandle`: bytes, JSON, a table, or another pointer. Resolution is resource-centered (`registry.resolveResource(resourceId, ctx)`); the registry stamps a `ResolutionReceipt` so an impl cannot forge identity/provenance. A `BioResolverImpl` may be backed by:

- a Pi extension
- local filesystem cache
- HTTP request adapter
- MCP server
- DuckDB query
- shell process

Many bio tools are just an HTTP request plus validation, and network is a SQL table function, so the **primary**
shape is SQL-native: `ducknng_ncurl_table` inside `duckdb.sql_materialize`, with the URL/headers/body composed in
SQL and the JSON parsed into columns: **no TS resolver at all** (the `ols4-grounding` GET, `variant-annotation`
POST). A `BioResolverSpec` + `VirtualResourceSpec` backed by `http.get` is a separate TS resolver path: the host
injects `fetch` when an application chooses JS fetch policy instead of SQL-native ducknng. Either way it is a
declared resource with a receipt, never custom framework code.

## Multi-agent by attribution; authorization stays the host's job

The core carries no multi-user authorization model, but it is **not** single-user by design. Every observation in
the temporal store (`bio_observations`, including the `memory:` namespace) carries an `author`/`source` that
is **part of its identity**, so a shared store stays attributed and time-consistent when many agents write to it,
and the durable governance/approval loop (submit → validate → test → record → approve → `activate`/`rollback`, with
park/resume) gates promotion of specs/skills. What stays out of core is **RBAC/policy**: who may read, write, or
approve: a sensitive deployment adds that in the host/adapters and in the transport (ducknng mTLS / peer-allowlists
/ exec-gating). The primitive contracts are unchanged whether one agent or many share the store.
