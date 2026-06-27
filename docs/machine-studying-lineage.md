---
type: Reference
title: Machine studying lineage
description: "Read to understand what 'study' means here (machine studying) and how it lands on graphs."
tags: [machine-studying, study-notes, graph-bet, lineage]
---

# Machine studying lineage

Source studied: Jacob Xiaochen Li, Rick Battle, and Omar Khattab, "Machine Studying" (published June 17, 2026), <https://jacobxli.com/blog/2026/machine-studying/>.

Downloaded and locally extracted during development (2026-06-27); the article text is **not** vendored into this repo. The source of record is the URL above; this file is a distilled design note with citation.

## What the term means here

"Study" is the article's **machine studying** sense: an agent is given a corpus `D` and performs work *before* a downstream task is known so it can develop expertise in that corpus. A studying algorithm may change the model or the harness: prompts, tools, indexes, notes, retrieval maps, adapters, or eventually weights.

In `pi-bio-agent`, this is **not** a biomedical study, cohort, trial, GWAS, or publication record. The internal `StudyNote` name means an agent-maintained learning artifact. User-facing surfaces should prefer `notes` to avoid the biomedical collision.

## Key claims extracted

- **Corpus access is not expertise.** Keeping the corpus available at test time is assumed; studying should make later corpus use more targeted and efficient, not replace source access.
- **Search/RAG is not enough.** An agent must know what to search for, where to search, which priors to distrust, and how to interpret what it retrieves.
- **Expertise is compute efficiency.** The article frames expertise as the performance-vs-inference-compute curve, reduced to a weighted area that emphasizes cheaper budgets. A shallow novice may eventually succeed with enough search; an expert gets good answers earlier.
- **Studying intelligence is second-order efficiency.** A strong studying algorithm improves expertise with less study compute.
- **Memorization is not the target.** Weight updates that internalize text or train on synthetic Q&A can improve closed-book recall while failing to improve open-book agent expertise, especially if they increase answer cost or do not improve search/use of evidence.
- **Retrieval reach is not selection expertise.** The article separates finding relevant items from recognizing which found items matter; equal retrieval can still produce different final choices.
- **Three broad studying paradigms matter:** self-supervised objectives over the corpus, synthetic data/environments, and amortized context management. Notes/cheatsheets are in the third group: shallow but useful baselines that can improve low-budget performance.

## Consequences for `pi-bio-agent`

1. **Study notes are harness artifacts, not fact stores.** They help the agent navigate sources and distrust stale priors. Measured biomedical facts still come from tools, resources, KG evidence, or DuckDB-backed data.
2. **The corpus remains authoritative.** Notes should point back to sources and make retrieval/querying cheaper; they should not become a copied replacement for APIs, ontologies, or reference datasets.
3. **Hooks are load-bearing.** A note's hook is the retrieval contract: when should the agent read this note? A body without a good hook does not improve expertise efficiently.
4. **DuckDB/KG projection is justified as amortized context management.** Projecting notes into `memory:<slug>` nodes and queryable edges gives the agent a cheap map before it spends expensive inference/tool budget.
5. **Skills are graduation, not the default.** Stable repeated workflows can become skills; volatile corpus knowledge should remain notes until it proves operational.
6. **Evaluation should prefer cost curves over one-off pass/fail.** Future expertise probes or workflow fixtures should track whether notes reduce tool calls/tokens or improve accuracy at the same budget, not merely whether a final answer is possible.
7. **Weight-update studying is out of scope for now.** The current substrate focuses on harness-level studying: notes, indexes, operation specs, guarded SQL, resources, and runs. That is compatible with future model-side studying but should not be conflated with it.

## Study and the graph bet (the deeper link)

The study/memory framing is the visible half of a deeper choice: see
[the graph bet](./ontology-and-knowledge-graphs.md#the-graph-bet-the-domain-wager). Machine studying
defines expertise as knowing *what to search, where, what to distrust, and how to interpret* — i.e.,
**structure over the corpus**, captured cheaply ("amortized context management"). A graph is exactly
that structure. The two are one bet seen from two sides:

- **Study produces graph.** The durable residue of an agent studying a corpus is graph structure —
  concept nodes, note-links, ontology mappings, provenance edges — not prose alone (a note's prose
  `body` stays, but it hangs on that structure). That residue is what `studyNoteGraph` projects into
  `bio_nodes`/`bio_edges`.
- **Graph makes study cheap.** A queryable map (`memory:<slug>` nodes + edges, joined to ontology and
  KG facts) is consulted *before* spending expensive tool/inference budget — the cost-curve win the
  article measures.

So the agent's notebook and the domain's knowledge graph are the **same substrate** because expertise
*is* navigable structure, and in this domain that structure is a graph. "Study" is therefore not a
memory feature bolted on; it is one way knowledge enters the graph the rest of the system already bets
on. That is why this lineage note lives next to the KG/ontology design, not only next to the memory one.

## Design guardrails

- Do not expose `study sync` as a bio-facing command; prefer `notes sync` / `notes report`.
- Do not let `StudyArtifactKind` grow behavior until a consumer needs it. Today the durable primitive is still slug + hook + body + tags + sources + links.
- Do not turn notes into a parallel evidence model. As-of dates, trust, supersession, and evidence aggregation belong on KG facts/edges, not mutable procedural memory.
- Do not call a note a source of truth. It is an indexable reminder with provenance pointers.
