---
type: Proposal
title: Memory and knowledge unification
description: "The temporal memory unification: memory, facts, jobs, and runs are one append-only bio_observations store (Datomic-style, as-of/history/tombstone). Read before changing the memory store or its graph projection."
tags: [memory, temporal, bio-observations, unification]
---

# Memory and knowledge unification

Notes on what a coding agent's file-based memory system teaches us, and a proposal to
unify `pi-bio-agent`'s currently-separate memory representations under one knowledge-unit
abstraction.

This is now **IMPLEMENTED** (2026-07-02) — see [Implemented: temporal memory in one
store](#implemented-2026-07-02-temporal-memory-in-one-store) below (the store, the agent-tool rewire + rename, and
temporal skills are all done). The rest of this document remains the design rationale it sharpens, alongside
[`abstraction-derivation.md`](./abstraction-derivation.md) and the storage/skill items in
[`refinments.md`](./refinments.md).

## Implemented (2026-07-02): temporal memory in one store

Memory is **the same temporal store as facts** — append-only, as-of, attributed — which honors the
unified-data-model bet instead of sitting beside it as flat last-write-wins files.

**Temporal, non-destructive, attributed.** A memory note is observation(s) in `bio_observations` under the
`agent:memory:<slug>` namespace (`src/hosts/memory-store.ts`):
- `remember(conn, note, now, author)` appends a content observation (a re-write **supersedes** by
  subject+predicate; prior revisions are retained). `author` is stamped as `source`, which is **part of
  observation identity** — so two agents writing one slug are two attributed rows, never a clobber.
- `recall(conn, slug, asOf?)` reads the content **as of** a time (default now), carrying its `author`.
- `memoryHistory(conn, slug)` is the change trail — *what changed, when, by whom*.
- `forget(conn, slug, now, author)` is a **temporal retraction**: a tombstone (null content) so `recall(now)` is
  null but `recall(earlier)` still sees it. Memory is never destroyed.
- Each `[[slug]]`/typed link is an **edge-like** observation that `materializeBioEdgesAsOf(t)` projects into
  `bio_edges_as_of`, so the memory graph is walkable **as of t** through the *same* SemanticSQL closure as facts.

**ONE store, not a `memory.duckdb`.** Facts, jobs, activation, and memory are all rows in the **same
`bio_observations` table in the same DuckDB** as the graph (`src/hosts/bio-store.ts` `openBioStore`). A separate
memory database would re-fragment the ledger and break the single `entailed_edge` closure that walks
**observation-backed** memory, ontology, and fact edges together. Tested: a memory note and a `gene→disease` fact
coexist in one store and one graph closure crosses both namespaces. (`materializeBioEdgesAsOf` projects the
as-of observation edges into `bio_edges_as_of`, so ontology terms *ingested as statements* join the same closure;
the atemporal compiled `bio_edges` navigation graph is a separate closure source, not auto-unioned into the as-of
projection.)

**Sharing is a host-chosen boundary** (`openBioStore` is the seam — the library records; the host decides where
the store lives). Because every memory row carries its **author** (`source`) and an **as-of** time, a *shared*
store stays attributed and consistent:

| Scope | Mechanism | Semantics |
|---|---|---|
| Runs of one project | project-local `store.duckdb` (default) | runs open→write→**close** in sequence; memory/facts accumulate. Proven: a later run reads the earlier run's *authored* memory. |
| Across projects / users | `openBioStore(cwd, { path })` → a shared path | same file, wider audience |
| Concurrent / cross-host / cross-agent | a **DuckDB server** — ducknng `run_rpc` (exec opt-in) **or a duckdb quack server** | one writer, many concurrent clients — lifts the process-exclusive-writer lock (not serialize-forever) |
| Immutable snapshots / archival | **CAS** by digest | shareable, content-addressed |

Access stays host-gated (ducknng mTLS / peer-allowlists / exec opt-in). This is **Fugu's inter-workflow shared
memory** (report §3.2.2) made literal — the same transport story the substrate already had, not a new invention.

**Tool wire-up + rename — DONE (2026-07-02).** The agent tools now use the store, not files: `bio_remember` =
`remember(author)` + a legible file view; `bio_recall`/`bio_list_memory` = `recall`/`listMemory` with an `asOf`
time-travel param; `bio_forget` = `forget` (retraction); `bio_walk_memory` + the always-on recall index read the
store. Skills are temporal too (`bio_create_skill` → `skill:<name>` observations, `src/hosts/skill-store.ts`), and
`pi-bio-agent memory list/show/history` reads the store from the CLI. When the host supplies a `cas` (CAS mode),
run receipts/replay bytes and result rows live in CAS (referenced by digest) and runs fold in as run-object DAGs and
recall is memoized by input digest; with no `cas` those bytes stay in the run's JSON files instead.

## Where this comes from

The agent driving this repo carries a persistent file-based memory. Its shape is worth
copying because it solves the same problem `pi-bio-agent` solves with study notes, skill
drafts, and the knowledge graph: **keep durable knowledge cheap to recall and honest about
where it came from.** The vocabulary also follows the machine-studying lineage summarized in
[`machine-studying-lineage.md`](./machine-studying-lineage.md): studying means agent-side
expertise acquisition over a corpus, not a biomedical study/trial/cohort.

That memory system is, stripped to its contract:

```text
one fact per file
  frontmatter:
    name         -> stable kebab-slug, the addressable identity
    description  -> one-line retrieval hook; recall matches on THIS, not the body
    metadata.type-> user | feedback | project | reference   (role, not form)
  body:
    the fact; feedback/project add explicit **Why:** and **How to apply:** lines
    [[name]] wikilinks to related units (dangling links allowed = future work marker)
a single loaded index file (MEMORY.md): one line per unit -> "[Title](file) — hook"
recall: only the index is always in context; full units are read on demand
discipline:
    update-don't-duplicate; delete what turns out wrong
    don't store what the substrate already records; store the non-obvious
    recalled units reflect what was true WHEN WRITTEN -> verify before acting
```

Every one of those properties has a direct analog already living somewhere in this repo —
just split across three types that don't know about each other.

## The same idea, three times, unreconciled

This table is the original diagnosis. **✓** marks rows the shipped subset (below) has since
addressed; unmarked rows are still steps 3–4.

| Memory-system property | `pi-bio-agent` analog | Lives in |
|---|---|---|
| one fact per file | `StudyNote` (JSON file) | `src/core/study.ts`, `src/hosts/pi-project.ts` |
| **✓** `name` (stable slug identity) | was `StudyNote.id` = `date-uuid` → now `StudyNote.slug` | `pi-project.ts:makeStudyNote` |
| **✓** `description` (retrieval hook) | `StudyNote.hook` (now required, validated) | `study.ts:validateStudyNote` |
| `metadata.type` (role taxonomy) | `StudyArtifactKind` (form taxonomy) | `study.ts` |
| **✓** loaded `MEMORY.md` index | was `studyNoteIndex()` per call → now generated `INDEX.md` | `pi-project.ts:writeStudyIndex` |
| `[[name]]` wikilinks | edge observations → `bio_edges_as_of` closure | `memory-store.ts` / `observations.ts` |
| body Why/How-to-apply | `StudyNote.body` (unstructured) | `study.ts` |
| write-time truth + verify | `TrustBlock.provenanceClass`, `supersedes` edge (on KG facts, not notes) | `knowledge-graph.ts` |
| **✓** update-don't-duplicate / delete | was new-uuid-per-write → now upsert-by-slug + `deleteStudyNote` | `pi-project.ts:writeStudyNote` |
| recall by description match | `scoreStudyNote` / `listStudyNotes` | `pi-project.ts` |
| promote source -> note -> skill | promotion path | `design.md`, `SkillDef`/`recordSkill` in `skill-store.ts` |

Three representations of "agent memory" — `StudyNote`, a skill (`SkillDef`,
`src/hosts/skill-store.ts`), and the `memory`/`concept` node families in the KG
(`knowledge-graph.ts:BioNodeFamily`) — none of which share an identity, an index, a link
model, or a provenance story. A study note cannot link to a skill; a skill draft has no
hook and no provenance; neither projects into the KG the repo already designed.

## Lessons to transfer

1. **Recall matches the hook, not the body.** In the memory system, a vague `description`
   means a dead memory. `StudyNote.hook` exists but is not enforced. A note whose hook
   restates its title is invisible. The hook is the contract.

2. **Identity should be a stable, human-meaningful slug.** `StudyNote.id` is `date-uuid`:
   not memorable, not stable across edits, useless as a link target. The memory system's
   kebab-slug `name` is what makes `[[links]]` and dedup possible at all.

3. **Links are first-class, and they are the bridge to the KG.** `[[name]]` is exactly a
   memory edge — and this is now realized, not hypothetical: `remember` writes each link as an
   edge observation and `materializeBioEdgesAsOf` folds them into the `bio_edges_as_of` closure,
   so memory and knowledge graph are one system walked by the same SemanticSQL closure.

4. **The index is a materialized, loaded artifact — not a recompute.** `MEMORY.md` is
   durable, human-editable, and the only thing always in context. `studyNoteIndex()`
   re-reads every file per call and is never persisted. A materialized index is also the
   natural FTS target that Stage 2 of `refinments.md` already wants.

5. **Memory notes ARE temporal — they live in the same append-only ledger as facts.**
   (This reverses an earlier draft that argued notes should stay plain-mutable with git as
   their only history.) A note is a `bio_observations` observation in the `agent:memory:`
   namespace: `remember` appends a revision that SUPERSEDES the slot (a re-write never
   destroys the prior text), `forget` tombstones it, `recall(slug, asOf)` reads it as of any
   time, and `memoryHistory` returns the full trail — the same as-of / history / retraction
   story facts get, attributed to the authoring agent. This is what makes memory shareable
   and auditable across agents, not a per-workstation git log. The file view (`MEMORY.md` +
   note JSON) is a legible EXPORT of the current revision, not the source of truth.

6. **Hygiene is a feature: upsert and delete.** `writeStudyNote` always mints a new uuid
   file, so the store only grows and silently duplicates. "Update-don't-duplicate; delete
   what's wrong" needs upsert-by-slug and an explicit delete path. (Note-level *supersede*
   is deliberately excluded — see decision 1 below; it belongs on KG facts, not notes.)

7. **Two axes, not one overloaded enum.** Memory `type` is *role* (user / feedback /
   project / reference — about-what). `StudyArtifactKind` is *form* (cheatsheet /
   concept_map / failure_case). Today `memory_note` and `index` sit in the same enum as
   `cheatsheet`, conflating the axes. Split them.

8. **Don't store what the substrate already records.** The memory rule "don't save what the
   repo/git already encode" is the bio promotion-path discipline restated: a "study note"
   whose body is a schema or an API client is mis-filed — it should be an operation spec,
   ontology mapping, or SQL view. Make it a lint, matching the "bad skills" list in
   `design.md`.

## Resolved design decisions

The first sketch of this proposal carried a wide `KnowledgeUnit` with `role`, `trust`,
`knownAt`, `supersedes`, and `lifecycle` all in the base. That is the god-record smell: a
universal type where half the fields are null for any given row. The enemy here is bloat,
so these are settled before any type is introduced:

1. **A slug is a stable identity; a re-write is an append-only supersession.** (This reverses
   an earlier draft that treated a slug as a plain-mutable, in-place overwrite with git as its
   only history.) Re-writing a slug appends a new `bio_observations` revision that SUPERSEDES
   the slot; every prior revision is retained, `recall(slug, asOf)` reads any point in time,
   and `memoryHistory` returns the trail — the note's own history lives in the ledger,
   attributed to the author, not in a per-workstation git log. The file view is a legible
   export of the current revision.
2. **No `trust`/`TrustBlock` on notes.** The existing `sources[]` (`path`/`url`/`locator`/
   `quote`) is the right grain for "where this note came from." `TrustBlock` is for *facts
   in the graph*. On model-authored procedural memory, `provenanceClass`/`confidence`
   would be theater.
3. **No `lifecycle` field.** Nothing reads it. `WorkflowState` already owns run lifecycle;
   a static note has no busy/error/expired state. Add it only when a consumer exists.
4. **`role` is not imported wholesale.** `user`/`feedback` are *agent-operator* memory and
   have no meaning for a note about OpenTargets identifiers. The bio axis is at most
   `project | reference | domain`; extra values get added only when a note needs them.
5. **`role` × `form` are orthogonal and are *never* cross-validated.** If a validator ever
   rejected a combination, they would not be orthogonal and should be one enum. They are
   independent, so no combination check is written, ever.
6. **`INDEX.md` and the `.json` files are BOTH derived views — the store is the source of
   truth.** The authoritative record is the append-only `bio_observations` ledger
   (`store.duckdb`); the note `.json` files are a legible export of the current revision, and
   `INDEX.md` is regenerated from them on every write/delete (safe to delete). (Unlike a
   coding agent's hand-maintained `MEMORY.md` — our notes are structured, so the index is
   derived, not edited.) **One** index surface for now; a DuckDB FTS table is added only when
   linear scan over notes is actually slow (Stage 2), not preemptively.

The net effect is a *subtraction*: the unified core is smaller than the three things it
replaces. If the line count goes up, the unification was done wrong.

## What is implemented now (steps 1, 2, 5)

The low-risk, no-new-type subset is shipped on `StudyNote` directly — it does **not**
commit to the full `KnowledgeUnit`:

- `StudyNote.slug` — stable kebab identity and upsert/link key; `id` is an opaque
  uniqueness/provenance tag, not the identity (`src/core/study.ts`).
- `normalizeStudySlug` + a **fail-closed** `validateStudyNote` (accepts `unknown`; checks
  `slug` shape+length, `id`, `kind`, timestamps, that `tags`/`sources`/`links` are arrays
  with slug-shaped link targets, and a **required hook that must not merely restate the
  title**) — both in `src/core/study.ts`. It guards every field readers later dereference;
  it does not deep-validate `tags`/`sources` *elements* (not load-bearing yet). Because
  `readStudyNotes` uses it as the **admission gate**, only valid notes enter the typed
  system. `makeStudyNote` (`src/hosts/pi-project.ts`) derives the slug and throws on an
  invalid note. Pre-slug notes are dropped, not migrated (working memory is unversioned).
- **Upsert by slug** in `writeStudyNote` (`src/hosts/pi-project.ts`) — same slug overwrites
  the same `<slug>.json`, preserving the original `createdAt` **and `id`**; the **write
  layer owns `updatedAt`** via a `now` parameter (defaulted for runtime, injected for
  deterministic tests). The write may change the note, so the boundary is honest: it
  returns `StudyNoteWriteResult { path, note, created }` — the **persisted** note, not the
  caller's input — and the Pi tool reports that persisted note (not the pre-write one).
- **`INDEX.md` generated cache** via `renderStudyIndex`/`writeStudyIndex`, rewritten on
  every write and delete (`src/hosts/pi-project.ts`).
- **`deleteStudyNote`** plus a `bio_forget` Pi tool — hygiene: prefer updating
  by slug, delete only rotten units (`extensions/pi-coding-agent/index.ts`).
- **Links → graph edges (step 3).** An optional `StudyNote.links` field plus `[[slug]]`
  body links, both collected by the pure `parseStudyNoteLinks` (dedup by `(to, predicate)`,
  dangling-tolerant) and projected by the pure `studyNoteLinkEdges` into `BioGraphEdge`
  records (`memory:<slug>` → `memory:<to>`, default predicate `references`) —
  `src/core/study.ts`. Predicates are a **narrow, closed note-navigation set**
  (`StudyNoteLinkPredicate`: `references | see_also | depends_on | contrasts_with`),
  deliberately excluding KG evidence/provenance predicates — note links are a
  note-reference surface, **not** a general KG edge-authoring API, and carry no
  `supersedes`/`derived_from` semantics (those live on KG facts, per decision 1). No I/O,
  no `KnowledgeUnit`; the projection is just a function the KG substrate can consume.
  Closes lessons 3, 5.
- **Note → graph projection (step 3, completion).** `studyNoteNode` projects a note into a
  `memory`-family `BioGraphNode` (hook → description), and `studyNoteGraph` folds a note set
  into a `BioGraphSnapshot` (`memory` nodes + their link edges) — `src/core/study.ts`. Pure,
  dangling-tolerant (edges may reference target ids absent from `nodes`); `walkMemoryGraph`
  (same file) does a bounded neighbourhood walk over these edges, run over temporal-store memory
  content by the `bio_walk_memory` Pi tool (see "Memory → graph projection" below).

`studyNoteIndex` now includes `slug`, and `bio_remember` takes an optional `slug`;
it returns the stored subject id (`agent:memory:<slug>`), the `author`, the `materialized`
file path, and a `note` summary (slug/kind/title/hook/tags).

## Memory → graph projection

`remember` (`src/hosts/memory-store.ts`) writes a note's `[[links]]` as edge observations into the ONE
`bio_observations` log; `materializeBioEdgesAsOf` (`src/duckdb/observations.ts`) folds them into the
`bio_edges_as_of` closure as of the recall clock; `walkMemoryGraph` (`src/core/study.ts`) does a bounded
neighbourhood walk over that graph, exposed as the `bio_walk_memory` Pi tool. The projections
(`studyNoteLinkEdges` / `studyNoteNode` / `studyNoteGraph`) stay pure and dangling-tolerant (an edge may
reference an absent target). The CLI is `src/cli/memory.ts` (`memory list/show/history`, as-of by default),
compiled via `src/cli/bin.ts` to the `pi-bio-agent` bin.

## Still to do (step 4)

- **Introduce the minimal `KnowledgeUnit` core** — `slug, role, form, title, hook, body,
  tags, links, sources, createdAt, updatedAt`, nothing more — and make `StudyNote` and
  `BioSkillDraft` thin views over it; a skill is `form: "skill"` rendered to `SKILL.md`
  with `/reload` still the activation boundary. Add the promotion lint (lesson 8: a note
  whose body is a schema or API client should become an operation spec, not a note). Do
  this only once a second real consumer (e.g. a path that materializes
  `studyNoteLinkEdges` into the temporal store's `bio_edges_as_of` closure) actually shares the core.

## Non-goals

- Not a new storage engine: this rides the existing DuckDB store in `design.md`. The
  append-only `bio_observations` ledger (the `agent:memory:` namespace) is the SOURCE OF
  TRUTH — `bio_remember`/`recall`/`pi-bio-agent memory list` read it, not files. Any note JSON
  files are an optional legible EXPORT/view, not authoritative: deleting `store.duckdb` and
  keeping only files loses the memory (there is no re-index-from-files path); editing a file
  does not change what the store returns.
- Not making memory model-authoritative: a unit is procedural guidance, never a measured
  fact — facts stay tool-derived, with provenance; a note is never itself evidence.
- Not blurring the activation boundary: a skill changes agent behavior on `/reload`; a note
  is pulled on demand. Shared storage shape, different lifecycle.
