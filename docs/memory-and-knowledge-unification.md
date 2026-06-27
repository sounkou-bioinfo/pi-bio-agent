# Memory and knowledge unification

Notes on what a coding agent's file-based memory system teaches us, and a proposal to
unify `pi-bio-agent`'s currently-separate memory representations under one knowledge-unit
abstraction.

This is a design proposal, not yet implemented. It is meant to sharpen
[`abstraction-derivation.md`](./abstraction-derivation.md) and the storage/skill items in
[`refinments.md`](./refinments.md).

## Where this comes from

The agent driving this repo carries a persistent file-based memory. Its shape is worth
copying because it solves the same problem `pi-bio-agent` solves with study notes, skill
drafts, and the knowledge graph: **keep durable knowledge cheap to recall and honest about
where it came from.**

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
- `normalizeStudySlug` + a **fail-closed, full-shape** `validateStudyNote` (accepts
  `unknown`; checks `slug` shape+length, `id`, `kind`, `tags`/`sources` are arrays,
  timestamps, and a **required hook that must not merely restate the title**) — both in
  `src/core/study.ts`. Because `readStudyNotes` uses this as the **admission gate**, it
  validates the *whole* persisted shape so downstream readers can dereference fields
  safely. `makeStudyNote` (`src/hosts/pi-project.ts`) derives the slug and throws on an
  invalid note. Pre-slug notes are dropped, not migrated (working memory is unversioned).
- **Upsert by slug** in `writeStudyNote` (`src/hosts/pi-project.ts`) — same slug overwrites
  the same `<slug>.json`, preserving the original `createdAt` **and `id`**; the **write
  layer owns `updatedAt`** via a `now` parameter (defaulted for runtime, injected for
  deterministic tests). The write may change the note, so the boundary is honest: it
  returns `StudyNoteWriteResult { path, note, created }` — the **persisted** note, not the
  caller's input — and the Pi tool reports that persisted note (not the pre-write one).
- **`INDEX.md` generated cache** via `renderStudyIndex`/`writeStudyIndex`, rewritten on
  every write and delete (`src/hosts/pi-project.ts`).
- **`deleteStudyNote`** plus a `bio_delete_study_note` Pi tool — hygiene: prefer updating
  by slug, delete only rotten units (`extensions/pi-coding-agent/index.ts`).

`studyNoteIndex` now includes `slug`, and `bio_write_study_note` takes an optional `slug`
and returns the persisted note plus a `created` flag.

## Still to do (steps 3–4)

Ordered, each independently shippable — and only after the shipped subset proves out:

3. **Project links into `bio_edges`.** Parse `[[slug]]` / an explicit `links[]` into edges
   with `family = memory`. Closes lessons 3, 5 — memory becomes queryable by the same
   graph-as-SQL substrate as ontology/KG data, with no second retrieval system.
4. **Introduce the minimal `KnowledgeUnit` core** — `slug, role, form, title, hook, body,
   tags, links, sources, createdAt, updatedAt`, nothing more — and make `StudyNote` and
   `BioSkillDraft` thin views over it; a skill is `form: "skill"` rendered to `SKILL.md`
   with `/reload` still the activation boundary. Add the promotion lint (lesson 8: a note
   whose body is a schema or API client should become an operation spec, not a note). Do
   this only once steps 3 proves two real consumers share the core.

## Non-goals

- Not a new storage engine: this rides the existing filesystem + DuckDB split in
  `design.md`. Files stay the source of truth; DuckDB indexes them.
- Not making memory model-authoritative: a unit is procedural guidance, never a measured
  fact — same stance as `factsMustBeToolDerived` in the `BioToolSpec` safety block.
- Not blurring the activation boundary: a skill changes agent behavior on `/reload`; a note
  is pulled on demand. Shared storage shape, different lifecycle.
