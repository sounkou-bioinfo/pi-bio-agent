---
type: Reference
title: Lineage and adjacent systems
description: "The concrete systems and results that shaped the substrate, including the limits of each comparison."
tags: [lineage, metacurator, machine-studying, fugu, rlm, semanticsql]
---

# Lineage and adjacent systems

The architecture did not begin from a generic agent framework. It was derived by comparing concrete failures and
working systems, then retaining the smallest repeated mechanics.

## Skill sprawl and ClawBio

The motivating failure was practical: a conversational genome system could route known questions but could not
answer "how many rare high-impact variants are there?" until a new question-specific skill was added. The later
skill improved the answer by abstaining on variants with missing population frequency rather than silently calling
them rare.

Two lessons survive:

1. abstention and declared evidence matter more than fluent completion;
2. one new script or skill per reasonable query does not scale.

`pi-bio-agent` keeps the first lesson and changes the unit of extension. Variant tables and consequence vocabularies
are declared resources; the actor writes SQL for the current question; repeated SQL may become a tested operation.
The rare-high-impact example is a regression reference, not proof that every question needs a named skill.

## Metacurator and the determinism gradient

Metacurator's code separates deterministic stages from narrow model judgment. Tools perform lookup, archive and
acquisition, table loading, ontology grounding, diffing, and report generation. The `judge` boundary handles typed
choices such as table classification, column mapping, and candidate disambiguation.

That implementation sharpened this repository's central division:

- code, SQL, manifests, and specifications perform mechanical work;
- a model or human chooses only where ambiguity is irreducible;
- deterministic validation accepts, rejects, records, and applies the typed choice;
- generated text does not mint identifiers or measured values.

The pattern maps directly to resolvers, materialized relations, typed judgments, approvals, and observations. It did
not require a separate publication primitive in core; publication curation was Metacurator's application domain.

## DuckDB, R, ducknng, and async compute

DuckDB supplies an embeddable relational work surface across files, extension table functions, SQL transformations,
and analytical reductions. R's data-frame and literate-programming traditions reinforce the same idea: computation
becomes inspectable when data and operations have explicit rectangular boundaries.

`ducknng`, maintained alongside this repository, extends that work surface to HTTP, RPC-backed shared state, NNG
topologies, and in-memory TLS material. `nanonext`, `mirai`, and `future` inform the async compute shape: submit work,
observe status, collect a value, or cancel it. Local processes, remote workers, and durable queues are profiles of
that lifecycle rather than separate execution theories.

## SemanticSQL and foreign graphs

SemanticSQL provides a useful relational vocabulary for RDF-like and semantic-web graphs: canonical nodes and
edges, qualifiers, source metadata, and entailed closure. The value here is source-spec parity. A Monarch snapshot,
Biolink/KGX export, FHIR-shaped relation, GraphQL response, memory graph, and run ledger can be projected into a
compatible SQL shape while retaining source-specific columns and provenance.

This is not a claim that all graphs are semantically identical. Projection makes traversal and joining reusable;
application policy still decides which predicates, qualifiers, evidence, direction, and entailment are admissible.
The workbench's pinned Monarch run is the concrete foreign-graph exercise.

## Actions over prompts

[Actions Speak Louder than Prompts](https://arxiv.org/abs/2509.18487) reports that executable interaction with graph
state can outperform serialized prompt context for text-rich graph inference. The result supports, but does not by
itself prove, this repository's graph posture: leave high-degree neighborhoods, long features, closures, partial
labels, and noisy structure in queryable tables; let the actor write bounded SQL or code over them.

Prompting over serialized graph context remains a baseline to beat, not the target architecture.

## Machine studying

Machine studying asks an agent to construct and reuse an external apparatus for learning a corpus: maps, notes,
relations, queries, evaluations, and revisions. This repository supplies a data plane for that apparatus:

- source material and artifacts in CAS;
- notes and typed links in the temporal observation ledger;
- graph and full-text retrieval through DuckDB;
- runs and checkpoints for provenance and resume;
- training-corpus export over sessions, tools, runs, artifacts, events, and judgments.

It does not yet prove that a particular studying strategy improves accuracy or cost. That requires a budgeted
evaluation against a baseline. Storing notes is mechanics; demonstrated learning is an empirical claim.

Skills remain different. A skill activates procedural behavior. A memory note is authored, temporal content. A
scientific fact is supported by declared evidence. They may link to each other but must not collapse into one type.

## Fugu-like coordination

Fugu contributes a useful control-plane image: workers receive bounded access lists, write shared memory, and form
tree, survey, debate, or synthesis structures. The local study scaffold, blackboard, SQL-backed shared state, and NNG
patterns exercise those mechanics.

The closure is partial and stated narrowly:

- the repository supplies durable shared relations, access-list dependencies, topologies, and evidence;
- a host still chooses workers, prompts, budgets, providers, and stopping policy;
- no learned Fugu orchestrator is implemented or claimed.

## RLM-like decomposition

Recursive Language Models treat long context as data that an actor can inspect, partition, and aggregate through
tools. DuckDB relations, CAS handles, graph windows, and map/reduce patterns provide the corresponding data plane.

The repository does not implement a canonical recursive inference algorithm. A Pi, Codex, or other host may recurse
through subagents and durable checkpoints; the substrate records their work. The distinction matters because a data
plane example is not evidence of model-quality gains.

## Open science workbenches

[OpenScience](https://github.com/synthetic-sciences/openscience) implements a broad local workbench: browser UI,
agent runtime, provider routing, sessions, artifacts, scientific connectors, skills, plugins, MCP, and cloud-compute
adapters. That is useful application precedent. Its large specialist/skill surface also preserves the pressure this
repository is testing: can many scientific questions collapse into schema discovery, manifest data, SQL/code, and a
small number of evidence-aware host ports?

[BioBTree](https://github.com/tamerh/biobtree) is complementary infrastructure rather than a competing agent core.
Its cross-database mappings, REST/MCP service, and Biolink-typed KGX export can enter as declared resources or a
foreign graph projection. A real integration should preserve qualifiers, primary knowledge sources, licensing, and
source versions; a one-line mapping result is not enough evidence for every entailed biomedical relation.

[Claude Science](https://claude.com/product/claude-science) represents the hosted product target: integrated
scientific search, analysis, and collaboration. The first-party workbench can compete at the application layer while
remaining open and host-neutral underneath. It should reuse the same public SDK and evidence plane rather than
forking scientific semantics into UI services.

The opportunity is an open, reproducible workbench for human, model, and automated actors over the same evidence
plane. The differentiator is not a larger tool menu. It is compositional SQL/code over declared sources, portable
receipts and replay, temporal knowledge, typed judgment, and application-derived abstractions.

## Biomni and the scientific action space

[Biomni](https://github.com/snap-stanford/Biomni) makes a different part of the problem concrete: scientists need help
choosing and combining methods under data, software, and task constraints. Its current application catalog contains
hundreds of action descriptions, database adapters, a data lake, software/environment descriptions, know-how documents,
and a benchmark. That breadth is a symptom of the method-selection problem, not a catalog we should reproduce and
maintain. Scientific tools, packages, APIs, environments, and documentation change too quickly for a permanently
curated list of isolated actions to be our central bet.

The correct closure is composability. External catalogs are volatile discovery inputs; the actor should retrieve or
ingest the slice relevant to the current task, inspect its contracts, and compose only the resources and methods it
needs:

```text
external method docs/catalogs + current data/environment
  -> grounded candidate descriptors
  -> agent-authored manifest and operation composition
  -> capability/license/schema inspection
  -> selected SQL, source-spec, or compute action
  -> Arrow relations and declared artifacts
  -> receipts, replay, CAS, and temporal observations
  -> typed comparison or human review
```

The anti-sprawl rule rejects handwritten question-specific helpers and duplicated execution semantics. It does not
reject using a large external action space when a task needs it, nor does it require an engineer to hand-author a
manifest for every possible method. The durable artifact should be the selected, tested, and approved composition;
catalog indexes and generated descriptors may remain ephemeral or be refreshed from their source. The implementation
remains application-owned; generic execution, evidence, and host-capability contracts remain core-owned.

Biomni's database functions are especially suitable for source-spec closure. An application should project their
REST/GraphQL schemas and response shapes into DuckNNG-backed resources, rather than preserve a nested LLM that turns
natural language into an opaque Python request. Numerical, imaging, docking, and R/Python/CLI actions can use the
generic `compute.run` and declared artifact path, with a characterization layer that supplies output schemas where
the upstream action metadata is loose.

Its persistent Python namespace also exposes a useful host surface. An NNG-backed stateful kernel using nanonext,
pynng, or another NNG client is transport-level work, not a new scientific theory. The reusable contract still needs
ordered evaluation per session, session identity, environment and capability receipts, failure/restart semantics,
artifact capture, and a checkpoint or snapshot policy. Implement it as a host/application compute profile first; promote
a session contract to core when the Biomni closure and another real application demonstrate the same lifecycle.

This closes over the method-selection problem directly: the actor searches a declared action space, filters it by
available data, software, licenses, and host capabilities, runs candidate methods, compares durable evidence, and asks
for a typed judgment where the choice is not mechanical. That is a first-class application of the substrate, not a
reason to shrink the action space back to a handful of bespoke skills.

## What each comparison does not justify

- A useful external API does not justify a source-specific TypeScript client when a manifest and general resolver
  suffice.
- A graph export does not justify a second graph store when a projection can be queried in DuckDB.
- A multi-agent topology does not justify another workflow engine.
- A durable queue does not justify another async lifecycle.
- A successful application relation does not belong in core until another concrete use reveals the same primitive;
  this does not prevent an application from querying a large external action space or exposing a transient generated
  action view over the existing primitives.
- A recorded run proves execution and evidence capture, not biomedical validity or model superiority.

These negative constraints are as important as the inherited ideas. They keep lineage from becoming architecture by
association.
