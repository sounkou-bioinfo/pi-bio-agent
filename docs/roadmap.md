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
- graph projection and closure, durable replay jobs, checkpoint resume, a public SDK, and first-party CLI, Pi, Quarto,
  and workbench consumers.

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

### 1. Measure the anti-sprawl claim

Build a budgeted comparison between per-question skills and manifest-plus-schema-plus-SQL composition across genuinely
new questions. Measure correctness, evidence quality, tokens, tool calls, wall time, human review, and new TypeScript.
The central metric is how little implementation code a supported new question requires.

### 2. Make large result delivery explicit

The current runner materializes complete results through `SqlConn.all`. Add caller-selected delivery such as inline
rows, a materialized relation, or a Parquet/CAS artifact only when a consumer requires it. Preserve the complete
scientific result and keep UI/model truncation as presentation metadata.

### 3. Test a second interactive host

The SDK is provider-neutral, but the mature interactive adapter is Pi-first. A second host should exercise session
control, memory mutation, transcript ingestion, capability binding, and evidence handoff before any more interactive
control behavior is promoted into shared code.

### 4. Harden shared deployment from real use

Add shared-CAS read leases, production store transport, worker admission, artifact retrieval, or stronger source pins
only for deployments that exercise the relevant concurrency and failure modes. Do not prebuild a generic distributed
platform.

### 5. Keep application policy downstream

The workbench remains the main pressure surface. Phenotype policy, clinical ranking, review packets, browser workflow,
and source-specific evaluation stay in the application unless another consumer repeats the same mechanism.

Concrete active gaps and their evidence links live in [refinments.md](refinments.md). Remove stalled items from living
docs; reintroduce them only with a named consumer, failing test, or executable proof.

## Repository gate

`npm run check:all` is the workspace gate. It covers core, workbench, Quarto engine, generated documentation,
examples, skills, type checking, and tests. Run focused owning checks first, then the full gate for shared changes.

Executable claims are authored in QMD and rendered to committed Markdown. Design prose links to code, tests, or
application runs. Keep the generated docs index current.
