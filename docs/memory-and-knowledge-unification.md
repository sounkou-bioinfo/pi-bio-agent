---
type: Proposal
title: Memory and knowledge unification
description: "Read before changing study notes, the note-to-graph projection, or the KG-ingest adapter."
tags: [memory, study-notes, knowledge-unit, kg-sync]
---

# Memory and knowledge unification

Notes on what a coding agent's file-based memory system teaches us, and a proposal to
unify `pi-bio-agent`'s currently-separate memory representations under one knowledge-unit
abstraction.

The **core is now IMPLEMENTED** (2026-07-02) — see [Implemented: temporal memory in one
store](#implemented-2026-07-02-temporal-memory-in-one-store) below. The remaining thread is the agent-tool rewire
onto it. The rest of this document remains the design rationale it sharpens, alongside
[`abstraction-derivation.md`](./abstraction-derivation.md) and the storage/skill items in
[`refinments.md`](./refinments.md).

## Implemented (2026-07-02): temporal memory in one store

Memory is no longer flat, last-write-wins files — it is **the same temporal store as facts**, which fixes the one
thing that violated the unified-data-model bet.

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
**memory → ontology → fact** together. Tested: a memory note and a `gene→disease` fact coexist in one store and
one graph closure crosses both namespaces.

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
`pi-bio-agent memory list/show/history` reads the store from the CLI. **Still open:** run receipts/replay bytes →
CAS + run-files opt-in; run-as-object-DAG; retiring the now-superseded `kg-sync`/`study-sync` SDK modules.

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
| `[[name]]` wikilinks | `bio_edges` / KG `derived_from`/`about` | `src/core/knowledge-graph.ts` |
| body Why/How-to-apply | `StudyNote.body` (unstructured) | `study.ts` |
| write-time truth + verify | `TrustBlock.provenanceClass`, `supersedes` edge (on KG facts, not notes) | `knowledge-graph.ts` |
| **✓** update-don't-duplicate / delete | was new-uuid-per-write → now upsert-by-slug + `deleteStudyNote` | `pi-project.ts:writeStudyNote` |
| recall by description match | `scoreStudyNote` / `listStudyNotes` | `pi-project.ts` |
| promote source -> note -> skill | promotion path | `design.md`, `BioSkillDraft` in `extensions.ts` |

Three representations of "agent memory" — `StudyNote`, `BioSkillDraft`
(`src/core/extensions.ts`), and the `memory`/`concept` node families in the KG
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
   `bio_edge`. If study-note links projected into `bio_edges` with `family = memory`,
   memory and knowledge graph stop being two systems.

4. **The index is a materialized, loaded artifact — not a recompute.** `MEMORY.md` is
   durable, human-editable, and the only thing always in context. `studyNoteIndex()`
   re-reads every file per call and is never persisted. A materialized index is also the
   natural FTS target that Stage 2 of `refinments.md` already wants.

5. **As-of versioning is a property of *facts*, not of procedural memory.** The memory
   system warns that recalled units reflect write-time state and must be verified — but the
   place to encode "this was true on date X, superseded by Y" is `bio_observations` /
   `TrustBlock` / the `supersedes` *edge*, which already exist. A cheatsheet does not need
   reanalysis-grade versioning; it needs editing. So notes stay **mutable** (git is their
   history); `knownAt`/`supersedes` live on KG evidence where they are load-bearing. This
   is a *subtraction*: do not bolt as-of fields onto every note.

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

1. **A slug is a *mutable* identity, not a version key.** Re-writing a slug **overwrites**
   in place (upsert); the original `createdAt` and `id` are preserved and `updatedAt` bumps
   (owned by the write layer, not the caller). History
   is **git**, not a chain of files. Therefore notes carry **no `supersedes` and no
   `knownAt`** — those belong on KG evidence (see lesson 5), not on a cheatsheet.
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
6. **`INDEX.md` is a generated cache, not a source of truth.** Truth is the `.json` files;
   the index is regenerated on every write/delete and is safe to delete. (Unlike a coding
   agent's hand-maintained `MEMORY.md` — our notes are structured, so the index is derived,
   not edited.) **One** index surface for now; a DuckDB FTS table is added only when linear
   scan over notes is actually slow (Stage 2), not preemptively.

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
  dangling-tolerant (edges may reference target ids absent from `nodes`); a later **effectful**
  KG-ingest adapter (a new opt-in surface, separately reviewed) decides whether to materialize
  stub nodes and write into `bio_nodes`/`bio_edges`.

`studyNoteIndex` now includes `slug`, and `bio_remember` takes an optional `slug`
and returns the persisted note plus a `created` flag.

## KG-ingest adapter (effectful, gated — implemented)

The pure projection (`studyNoteGraph`) hands off to `syncStudyNoteGraph` in
`src/duckdb/kg-sync.ts`. It is the first **effectful** surface, kept policy-explicit per
`design.md`. The sync writes through the one execution port, `SqlConn` (`all`/`run`, declared in
`src/core/ports.ts` and shared with the operation runner), so the sync logic stays testable (fake
port) and injectable (a host passes its own connection); the concrete `@duckdb/node-api` binding is
a separate file (see below).

- **Ownership scope (exact).** It owns, and only ever deletes:
  - `bio_nodes WHERE family = 'memory'`
  - `bio_edges WHERE from_id LIKE 'memory:%'`
  It does **not** own external edges pointing *into* memory nodes (`to_id` memory, `from_id`
  elsewhere), so a re-sync never tramples future non-memory relationships.
- **Fails closed on scope.** It accepts a generic `BioGraphSnapshot` but refuses (throws,
  even in dry-run) any node that is not `family: "memory"` with a **strict `memory:<slug>`
  id** (prefix alone is not enough — `memory:`, `memory:Bad Slug`, `memory:../x` are
  rejected), or any edge whose `from` is not such a memory node — so it can never write
  outside what it owns.
- **Fails closed on duplicates.** A duplicate node id, or a duplicate edge by
  `(from, to, predicate)`, throws. A normal file-backed note set does not emit duplicates, so
  one reaching the adapter is a caller/input bug — surfaced here rather than silently deduped
  (which would skew the insert counts) or left to a future constraint rollback. Same endpoints
  with a different predicate are distinct, not duplicates.
- **Schema DDL helper.** `createBioGraphSchema(conn, { ifNotExists })` creates `bio_nodes`/
  `bio_edges` through the same port, mirroring the duplicate policy as constraints
  (`node_id PRIMARY KEY`, `UNIQUE (from_id, to_id, predicate)`) and adding indexes for the
  scans/join the sync runs (`family`, `from_id`, `to_id`). **No foreign keys** — dangling link
  targets are allowed, so an edge may reference an absent node id.
- **Concrete DuckDB binding.** `duckdbNodeConn(connection)` (`src/duckdb/node-api.ts`) adapts a
  live `@duckdb/node-api` connection to `SqlConn`. **The core and sync logic stay
  driver-agnostic** (`node-api.ts` imports the driver only as a *type*; the host creates and owns
  the `DuckDBInstance`/connection); the concrete binding, and the package, depend on
  `@duckdb/node-api` as a direct dependency — DuckDB is a first-class substrate here. The port
  still lets a CLI/Pi host inject its own connection. Real in-memory DuckDB tests (explicit
  construction, no ambient activation) exercise the actual dialect: round-trip, idempotent
  re-sync, persisted dangling edges, the `UNIQUE` constraint, and the external-inbound refusal.
- **Read-only report.** `reportStudyNoteGraph(conn)` returns memory node/edge counts plus the full
  rows for the two actionable problem sets — persisted **dangling** links (memory-origin edges with
  no target node) and **external inbound** edges (which would block a write) — so an agent can fix
  graph issues before syncing. No writes, no transaction. Totals (including exact dangling /
  external-inbound counts) are always returned; the fixable problem rows come back capped at an
  optional `{ limit }` (progressive disclosure: summarize totals, sample the rows).
- **Project helper.** `syncProjectStudyNotes(conn, cwd, { dryRun, allowWrite, createSchema })`
  (`src/hosts/study-sync.ts`) is the one call that ties the file layer to the graph layer:
  `readStudyNotes → studyNoteGraph → (optional createBioGraphSchema) → syncStudyNoteGraph`. Explicit
  args only; nothing from ambient process state. **Two independent effect axes:** `createSchema`
  controls schema/index DDL — idempotent, and it **runs even under `dryRun`**; `dryRun`/`allowWrite`
  control the memory-subgraph *row* sync (dry-run by default). A dry run with `createSchema: true`
  still writes the schema; for a run that performs **no database writes**, leave `createSchema` false
  (the schema must already exist) — note a dry run still *reads* (it SELECTs counts).
- **CLI.** `src/cli/memory.ts` — `mainMemory(argv, { cwd, out, err })` (injected sinks, returns an exit code,
  never calls `process.exit`). Surface: `memory list [--as-of <iso>]`, `memory show <slug> [--as-of <iso>]`,
  `memory history <slug>` — reads the ONE temporal store (`.pi/bio-agent/store.duckdb`), as-of by default now.
  The prior `src/cli/notes.ts` (`notes sync/report`, which projected file notes into a separate `graph.duckdb`
  via `kg-sync`) is superseded and removed; the `kg-sync`/`study-sync` SDK modules remain but are candidates for
  retirement.
  The executable is `src/cli/bin.ts` (the only file touching real argv/stdout/driver/`process.exit`),
  compiled to `dist/cli/bin.js` and exposed as the `pi-bio-agent` bin via a `tsc` build
  (`tsconfig.build.json`, run by `prepare`/`npm run build`). `src` still ships for Pi; `dist` is added
  for the bin — not committed, built on pack/install. Verified by running the compiled binary against a
  real DuckDB file, plus unit tests against in-memory DuckDB.
- **Refuses to orphan non-owned edges.** A non-owned edge (origin not `memory:`) pointing at
  a node in the **delete set** (`family='memory'`, found by joining `to_id` to those rows —
  not a `to_id` prefix match, so the guard covers exactly what gets deleted) would be dangled
  or broken by the delete-then-reinsert under future FK constraints. So the write **fails
  closed while any exist**: dry-run reports `externalInboundEdges`, and the write runs that
  check **inside the transaction** (so it can't drift between check and delete) and rolls back
  without touching owned rows when the count is > 0.
- **FK-safe ordering.** Within the transaction: delete memory-origin edges, then memory
  nodes; insert nodes, then edges.
- **Dangling targets:** not materialized as stub nodes; counted in the result
  (`danglingEdges`) and surfaced as future-work markers, mirroring dangling `[[wikilinks]]`.
- **Sync semantics:** full re-sync of the memory subgraph in **one transaction** (delete the
  owned subgraph, insert the projected set; rollback on any failure). Files are the source of
  truth; DuckDB is an index/cache.
- **Effect contract:** writes only the memory subgraph; no network; no arbitrary SQL (fixed,
  parameterized statements); transaction required; **dry-run by default**, writing needs
  `{ dryRun: false, allowWrite: true }`; result returns delete/insert/dangling/external-inbound
  counts. No Pi tool yet — only when a workflow needs it.

### Global KG edge policy

`createBioGraphSchema` creates the **global** `bio_nodes`/`bio_edges` tables, not memory-only ones, so
its constraints are KG-wide decisions: **one edge per `(from, to, predicate)`**. Multiple evidences for
the same relationship aggregate inside the edge's `trust` block (`TrustBlock.evidence[]`), not as
parallel rows — consistent with the existing typed model. If parallel evidence edges with the same
triple are ever needed, the `UNIQUE` constraint must be revisited.

## Still to do (step 4)

- **Introduce the minimal `KnowledgeUnit` core** — `slug, role, form, title, hook, body,
  tags, links, sources, createdAt, updatedAt`, nothing more — and make `StudyNote` and
  `BioSkillDraft` thin views over it; a skill is `form: "skill"` rendered to `SKILL.md`
  with `/reload` still the activation boundary. Add the promotion lint (lesson 8: a note
  whose body is a schema or API client should become an operation spec, not a note). Do
  this only once a second real consumer (e.g. a KG-ingest path that writes
  `studyNoteLinkEdges` into `bio_edges`) actually shares the core.

## Non-goals

- Not a new storage engine: this rides the existing filesystem + DuckDB split in
  `design.md`. Files stay the source of truth; DuckDB indexes them.
- Not making memory model-authoritative: a unit is procedural guidance, never a measured
  fact — facts stay tool-derived, with provenance; a note is never itself evidence.
- Not blurring the activation boundary: a skill changes agent behavior on `/reload`; a note
  is pulled on demand. Shared storage shape, different lifecycle.
