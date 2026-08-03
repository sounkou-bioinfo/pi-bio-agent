---
type: Reference
title: Roadmap and success contract
description: "Current substrate closure, falsifiable success criteria, proof levels, and consumer-pulled next work."
tags: [roadmap, testing, success, applications]
---

# Roadmap and success contract

This roadmap records demonstrated closure, falsifiable success criteria, and current work. It is not a catalogue of
possible agent features. Core grows only when a real application or host cannot express a repeated mechanism through
existing manifests, SQL, injected capabilities, evidence, replay, and temporal state.

## Current closure

The public substrate currently provides:

- validated manifests, resource resolution, schema discovery, ad-hoc read-only SQL, and named operations;
- DuckDB file and extension materialization, parser/AST-backed SQL checks, and physical-plan hermeticity checks;
- host-granted network and async compute, including bounded retry/cancellation and declared environment evidence;
- CAS, run-object identities, replay specifications, explicit reproduction verdicts, and guarded action caching;
- one temporal observation store for memory, facts, runs, sessions, jobs, checkpoints, approvals, and graph links;
- graph projection and closure, durable replay jobs, checkpoint resume, and a public SDK shared by CLI, Pi, Quarto,
  the workbench, and a stateless MCP `2026-07-28` adapter.

The MCP package proves that manifest discovery, query, named operation, exact evidence retrieval, and replay can be
served outside Pi without copying the runner or SQL/security implementation. It creates a fresh protocol server per
HTTP request; durable scientific continuity remains in run IDs, CAS, and the optional observation store.

This is enough to build applications. It does not imply that every deployment adapter, biomedical policy, source pin,
or user interface is complete.

## Falsifiable success

The project succeeds when an actor answers a previously unprogrammed scientific question by inspecting declared
resources and composing SQL or code, while producing stronger evidence at lower implementation or inference cost
than a per-question skill baseline.

Correctness is the gate:

- claims come from declared data, deterministic compute, or explicit typed judgment;
- missing evidence becomes missingness or abstention;
- receipts, replay, and environment evidence match what the host actually supplied;
- live sources are not presented as byte-reproducible without pins;
- large data and graph state remain queryable rather than copied into prompts;
- clinical interpretation is not presented as model-generated fact.

After correctness, compare scientific accuracy, evidence completeness, wall-clock time, token and tool-call budgets,
human review effort, and growth in non-test implementation code. A runnable pattern proves mechanics only.

## Proof levels

| Level | Establishes | Does not establish |
|---|---|---|
| Focused test | one validator or invariant is enforced | useful end-to-end composition |
| Executable QMD or manifest | public surfaces compose and generated claims are current | deployment or biomedical validity |
| Hermetic application run | cross-boundary execution, evidence, resume, and abstention behavior | live-source compatibility |
| Pinned live-source run | current source schema and host capability compatibility | future endpoint stability |
| Budgeted benchmark | measured quality or cost difference against a baseline | universal superiority |

Examples state their proof level. Copied output in prose is not additional evidence.

## Active priorities

### Measure the anti-sprawl claim

Build a budgeted comparison between per-question skills and manifest-plus-schema-plus-SQL composition across genuinely
new questions. Measure correctness, evidence quality, tokens, tool calls, wall time, human review, and new TypeScript.
The central metric is how little implementation code a supported new question requires.

### Make large result delivery explicit

The MCP adapter now exposes the semantic distinction between complete inline results and durable result references,
but the core query runner still materializes every row through `SqlConn.all`. Add relation, Parquet, or CAS delivery at
the SDK boundary only when a real consumer needs to avoid in-memory materialization. Preserve the complete scientific
result and keep UI/model truncation as presentation metadata.

### Derive stateful interactive parity only from another stateful host

The stateless MCP adapter closes the provider-neutral scientific execution surface; it deliberately does not model
conversation sessions, transcript ingestion, steering, or dynamic tools. Promote any host-neutral interactive control
contract only after a second stateful host repeats Pi's motion. Do not infer a session framework from a protocol whose
modern HTTP path is per request.

Other work enters this roadmap only from a current consumer, failing test, or executable proof. Application policy,
production deployment choices, and source-specific integration remain downstream until repeated use exposes a shared
mechanism.

Concrete active gaps and their evidence links live in [refinments.md](refinments.md). Remove stalled items from living
docs; reintroduce them only with a named consumer, failing test, or executable proof.

## Repository gate

`npm run check:all` is the workspace gate. It covers core, the stateless MCP package, workbench, Quarto engine,
generated documentation, examples, skills, type checking, and tests. Run focused owning checks first, then the full
gate for shared changes.

Executable claims are authored in QMD and rendered to committed Markdown. Design prose links to code, tests, or
application runs. Keep the generated docs index current.
