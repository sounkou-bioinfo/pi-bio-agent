# Resources and BioToolSpec

## BioToolSpec

`BioToolSpec` is the provider-agnostic executable contract. It describes:

- name, version, title, description
- domains
- determinism: deterministic, judgment, or hybrid
- typed inputs and outputs
- parameter schema
- execution surfaces: DuckDB SQL, DuckDB extension, process, R, Python, HTTP, MCP, Pi, memory, study
- effects: read, write, network, execute, index, persist, prompt
- safety and provenance

The core never assumes a model provider, agent harness, HTTP client, shell runner, or database binding. Adapters bind a `BioToolSpec` to the current runtime.

## Resource handles

A resource handle is a durable reference to data without forcing the core to know where bytes live:

- `inline` — small JSON payload
- `reference` — file, object-store URI, database table, URL, etc.
- `content_address` — algorithm + digest + optional size/media type
- `virtual` — resolver name + query payload

Content-addressed resources make caching and reproducibility explicit. The same digest means the same bytes regardless of local path.

## Resolver specs

A resolver spec describes how a handle can become bytes, JSON, or another pointer. Resolvers may be implemented by:

- a Pi extension
- local filesystem cache
- HTTP request adapter
- MCP server
- DuckDB query
- shell process

Many bio tools are just HTTP requests plus validation. They should be modeled as resolver specs or BioToolSpecs with an HTTP surface, not custom framework code.

## Single-user default

This repo assumes a personal/single-user Pi environment. No multi-user authorization model belongs in core. Sensitive deployments can add policy in adapters, but the primitive contracts remain the same.
