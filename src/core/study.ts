import type { BioArtifact, Provenance } from "./types.js";
import type { BioGraphEdge, BioGraphNode, BioGraphSnapshot } from "./knowledge-graph.js";

export type StudyArtifactKind =
  | "corpus_map"
  | "cheatsheet"
  | "concept_map"
  | "question_bank"
  | "rubric"
  | "worked_example"
  | "failure_case"
  | "memory_note"
  | "skill_draft"
  | "index";

export interface StudyCorpus {
  id: string;
  label: string;
  roots: BioArtifact[];
  description?: string;
  version?: string;
  provenance?: Provenance[];
}

/**
 * Note-navigation predicates. Deliberately narrow and *distinct from* KG evidence/provenance
 * predicates: note links carry no `supersedes`/`derived_from`/`supports` semantics — those belong on
 * KG facts, not procedural memory. This is a note-reference surface, not a general KG edge-authoring API.
 */
export const STUDY_NOTE_LINK_PREDICATES = ["references", "see_also", "depends_on", "contrasts_with"] as const;

export type StudyNoteLinkPredicate = typeof STUDY_NOTE_LINK_PREDICATES[number];

function isStudyNoteLinkPredicate(value: unknown): value is StudyNoteLinkPredicate {
  return typeof value === "string" && (STUDY_NOTE_LINK_PREDICATES as readonly string[]).includes(value);
}

/** A typed cross-reference from one note to another note's slug. Untyped `[[slug]]` body links default their predicate. */
export interface StudyNoteLink {
  to: string;
  predicate?: StudyNoteLinkPredicate;
}

export interface StudyNote {
  schema: "pi-bio.study_note.v1";
  /** Stable, human-meaningful identity and upsert/link key. A slug is mutable in place; edits keep the slug and bump updatedAt. */
  slug: string;
  /** Opaque uniqueness/provenance tag, stable across edits. Not the identity or upsert key — the slug is. */
  id: string;
  kind: StudyArtifactKind;
  title: string;
  hook: string;
  body: string;
  tags: string[];
  /** Typed cross-references to other notes. Optional; `[[slug]]` links in the body are also honored. */
  links?: StudyNoteLink[];
  sources: Array<{ path?: string; url?: string; locator?: string; quote?: string; provenance?: Provenance }>;
  createdAt: string;
  updatedAt: string;
}

export interface StudySession {
  schema: "pi-bio.study_session.v1";
  id: string;
  corpus: StudyCorpus;
  objective: string;
  budget?: { tokens?: number; wallClockMinutes?: number; toolCalls?: number };
  artifacts: StudyNote[];
  openQuestions?: string[];
  nextStudyActions?: string[];
}

export interface ExpertiseProbe {
  schema: "pi-bio.expertise_probe.v1";
  id: string;
  question: string;
  expectedEvidence?: string[];
  rubric?: Array<{ criterion: string; weight: number; deterministicCheck?: string }>;
  budgetHints?: Array<{ label: string; maxTokens?: number; maxToolCalls?: number }>;
}

export const STUDY_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Derive a stable kebab slug from arbitrary text (title or explicit slug). Throws if nothing usable remains. */
export function normalizeStudySlug(input: string): string {
  const slug = (input ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  if (!slug) throw new Error("study note slug cannot be derived from empty input");
  return slug;
}

export const STUDY_ARTIFACT_KINDS: StudyArtifactKind[] = [
  "corpus_map",
  "cheatsheet",
  "concept_map",
  "question_bank",
  "rubric",
  "worked_example",
  "failure_case",
  "memory_note",
  "skill_draft",
  "index",
];

/** Non-throwing, fail-closed validator following the validateX pattern. Accepts unknown so corrupt/legacy input is reported, not thrown. The hook is the retrieval contract, so it is enforced. */
export function validateStudyNote(note: unknown): string[] {
  if (!note || typeof note !== "object") return ["study note must be an object"];
  const n = note as Partial<StudyNote>;
  const errors: string[] = [];
  if (n.schema !== "pi-bio.study_note.v1") errors.push("schema must be pi-bio.study_note.v1");
  if (typeof n.slug !== "string" || !STUDY_SLUG_RE.test(n.slug) || n.slug.length > 64) errors.push("slug must be lowercase kebab-case (max 64 chars)");
  if (typeof n.id !== "string" || !n.id.trim()) errors.push("id is required");
  if (typeof n.kind !== "string" || !STUDY_ARTIFACT_KINDS.includes(n.kind as StudyArtifactKind)) errors.push("kind is invalid");
  if (typeof n.title !== "string" || !n.title.trim()) errors.push("title is required");
  if (typeof n.hook !== "string" || !n.hook.trim()) errors.push("hook is required");
  else if (n.hook.trim().length > 280) errors.push("hook must be <= 280 chars");
  else if (typeof n.title === "string" && n.hook.trim().toLowerCase() === n.title.trim().toLowerCase()) errors.push("hook must say when to read the note, not just restate the title");
  if (typeof n.body !== "string" || !n.body.trim()) errors.push("body is required");
  if (typeof n.createdAt !== "string" || !n.createdAt.trim()) errors.push("createdAt is required");
  if (typeof n.updatedAt !== "string" || !n.updatedAt.trim()) errors.push("updatedAt is required");
  if (!Array.isArray(n.tags)) errors.push("tags must be an array");
  if (!Array.isArray(n.sources)) errors.push("sources must be an array");
  if (n.links !== undefined) {
    if (!Array.isArray(n.links)) errors.push("links must be an array");
    else if (n.links.some((l) => {
      const link = l as StudyNoteLink;
      return !l || typeof l !== "object" || typeof link.to !== "string" || !STUDY_SLUG_RE.test(link.to) || link.to.length > 64
        || (link.predicate !== undefined && !isStudyNoteLinkPredicate(link.predicate));
    })) errors.push("each link needs a slug `to` (max 64 chars) and a known predicate");
  }
  return errors;
}

/** Untyped `[[slug]]` body links default to this predicate. A note-to-note reference is not an ontology "about" edge, so it gets its own name. */
export const STUDY_DEFAULT_LINK_PREDICATE: StudyNoteLinkPredicate = "references";

// Case-sensitive: body links must already be lowercase slugs, matching what validateStudyNote accepts.
const WIKILINK_RE = /\[\[([a-z0-9][a-z0-9-]*)\]\]/g;

/** Knowledge-graph node id for a study note. Rejects non-slug input rather than minting a malformed node id. */
export function memoryNodeId(slug: string): string {
  if (typeof slug !== "string" || !STUDY_SLUG_RE.test(slug) || slug.length > 64) throw new Error(`invalid memory slug: ${slug}`);
  return `memory:${slug}`;
}

/**
 * Collect a note's links from its explicit `links` field and `[[slug]]` body links, de-duplicated by
 * (to, predicate). Pure; dangling targets are allowed and not resolved here. Accepts `unknown` and is
 * fully defensive: a target is taken only if it is *already* a valid slug — the parser agrees with
 * `validateStudyNote` and never silently rewrites a bad target (normalization happens once, in
 * `makeStudyNote`, at authoring time). Unknown predicates fall back to the default.
 */
export function parseStudyNoteLinks(input: unknown): Required<StudyNoteLink>[] {
  if (!input || typeof input !== "object") return [];
  const note = input as Partial<StudyNote>;
  const out = new Map<string, Required<StudyNoteLink>>();
  const add = (to: unknown, predicate?: unknown) => {
    if (typeof to !== "string" || !STUDY_SLUG_RE.test(to) || to.length > 64) return; // not a slug: skip, don't rewrite
    const pred = isStudyNoteLinkPredicate(predicate) ? predicate : STUDY_DEFAULT_LINK_PREDICATE;
    out.set(JSON.stringify([to, pred]), { to, predicate: pred });
  };
  for (const link of Array.isArray(note.links) ? note.links : []) {
    if (link && typeof link === "object") add((link as StudyNoteLink).to, (link as StudyNoteLink).predicate);
  }
  if (typeof note.body === "string") {
    for (const match of note.body.matchAll(WIKILINK_RE)) add(match[1]);
  }
  return [...out.values()];
}

/** Project a note's links into knowledge-graph edges (`memory:<slug>` -> `memory:<to>`). Pure: no I/O, no existence check, so dangling links project too. */
export function studyNoteLinkEdges(note: Pick<StudyNote, "slug" | "body" | "links">): BioGraphEdge[] {
  const from = memoryNodeId(note.slug);
  return parseStudyNoteLinks(note).map((link) => ({ from, to: memoryNodeId(link.to), predicate: link.predicate }));
}

/** Project a note into its knowledge-graph node (`memory` family). Pure; the retrieval hook becomes the node description. */
export function studyNoteNode(note: Pick<StudyNote, "slug" | "kind" | "title" | "hook" | "tags">): BioGraphNode {
  return {
    id: memoryNodeId(note.slug),
    family: "memory",
    type: note.kind,
    label: note.title,
    description: note.hook,
    attrs: { slug: note.slug, kind: note.kind, tags: note.tags ?? [] },
  };
}

/**
 * Fold a set of notes into a knowledge-graph snapshot: one `memory` node per note plus their link edges.
 * Pure: no I/O. Edges may reference `memory:<to>` ids absent from `nodes` (dangling links by design); a
 * later effectful KG-ingest adapter decides whether to materialize stub nodes for those targets.
 */
export function studyNoteGraph(notes: StudyNote[]): BioGraphSnapshot {
  return {
    schema: "pi-bio.graph_snapshot.v1",
    nodes: notes.map(studyNoteNode),
    edges: notes.flatMap((note) => studyNoteLinkEdges(note)),
  };
}

export function studyNoteIndex(notes: StudyNote[]): Array<Pick<StudyNote, "slug" | "id" | "kind" | "title" | "hook" | "tags" | "updatedAt">> {
  return notes.map(({ slug, id, kind, title, hook, tags, updatedAt }) => ({ slug, id, kind, title, hook, tags, updatedAt }));
}

export function deriveStudyPlan(corpus: StudyCorpus, objective = "develop operational expertise over this corpus"): string[] {
  return [
    `Map corpus '${corpus.label}' into source families and authoritative entry points.`,
    "Extract stable contracts: schemas, typed objects, APIs, CLI/tool surfaces, data layouts, and invariants.",
    "Build ontology/concept maps for domain terms, synonym sets, identifiers, and versioned definitions.",
    "Write compact study notes with hooks: what to search for, where it lives, what priors to distrust.",
    "Generate expertise probes: questions that require the corpus-specific abstractions, not generic recall.",
    "Promote only stable repeated workflows to skills; keep volatile knowledge as indexed study notes.",
    `Objective: ${objective}`,
  ];
}

// ── Study scaffold: "machine studying" as a DAG (Fugu piece 2 — scaffold-as-data with access lists) ──────────
// deriveStudyPlan is a flat list of strings. A scaffold lifts it to a DAG: each step produces a note of a given
// kind and declares an ACCESS LIST — which upstream notes + sources feed its context (Sakana Fugu's
// communication topology). Execution: topological order; each step reads ONLY its access list (the isolation
// boundary) and writes its note (the shared memory = studyNoteIndex). The accessList.notes edges are the SAME
// shape as a produced note's `links: depends_on` — a scaffold step and its note share one dependency model.

export interface StudyStep {
  /** Step identity AND the slug of the note it will produce (kebab-case). */
  id: string;
  /** What to study/extract in this step. */
  subtask: string;
  /** The note kind this step writes. */
  produces: StudyArtifactKind;
  /** Which upstream step ids (their produced notes) + external sources feed this step's context. */
  accessList: { notes?: string[]; sources?: StudyNote["sources"] };
}

export interface StudyScaffold {
  schema: "pi-bio.study_scaffold.v1";
  corpusId: string;
  objective: string;
  steps: StudyStep[];
}

/** Fail-closed validator (validateX pattern). Enforces: valid step slugs, known kinds, unique ids, and that every
 *  accessList note reference points at an EARLIER step — so the DAG is acyclic by construction. */
export function validateStudyScaffold(scaffold: unknown): string[] {
  if (!scaffold || typeof scaffold !== "object") return ["study scaffold must be an object"];
  const s = scaffold as Partial<StudyScaffold>;
  const errors: string[] = [];
  if (s.schema !== "pi-bio.study_scaffold.v1") errors.push("schema must be pi-bio.study_scaffold.v1");
  if (typeof s.corpusId !== "string" || !s.corpusId.trim()) errors.push("corpusId is required");
  if (typeof s.objective !== "string" || !s.objective.trim()) errors.push("objective is required");
  if (!Array.isArray(s.steps) || s.steps.length === 0) return [...errors, "steps must be a non-empty array"];
  const seen = new Set<string>();
  s.steps.forEach((step, i) => {
    const st = step as Partial<StudyStep>;
    if (typeof st.id !== "string" || !STUDY_SLUG_RE.test(st.id) || st.id.length > 64) errors.push(`step[${i}].id must be a kebab-case slug`);
    else if (seen.has(st.id)) errors.push(`step[${i}].id '${st.id}' is duplicated`);
    if (typeof st.subtask !== "string" || !st.subtask.trim()) errors.push(`step[${i}].subtask is required`);
    if (typeof st.produces !== "string" || !STUDY_ARTIFACT_KINDS.includes(st.produces as StudyArtifactKind)) errors.push(`step[${i}].produces is not a valid note kind`);
    if (!st.accessList || typeof st.accessList !== "object") errors.push(`step[${i}].accessList must be an object`);
    else if (st.accessList.notes !== undefined) {
      if (!Array.isArray(st.accessList.notes)) errors.push(`step[${i}].accessList.notes must be an array`);
      else for (const ref of st.accessList.notes) {
        // a forward/self/unknown reference would allow a cycle — only earlier steps are visible
        if (!seen.has(ref)) errors.push(`step[${i}] accessList references '${ref}' which is not an earlier step`);
      }
    }
    if (typeof st.id === "string") seen.add(st.id);
  });
  return errors;
}

/** Topological execution order (Kahn). Returns step ids so every step's accessList notes precede it; throws on a
 *  cycle (which validateStudyScaffold already precludes for scaffolds it accepts). */
export function scaffoldExecutionOrder(scaffold: StudyScaffold): string[] {
  const ids = scaffold.steps.map((s) => s.id);
  const deps = new Map(scaffold.steps.map((s) => [s.id, new Set((s.accessList.notes ?? []).filter((n) => ids.includes(n)))]));
  const order: string[] = [];
  const ready = ids.filter((id) => deps.get(id)!.size === 0);
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const [other, d] of deps) if (d.delete(id) && d.size === 0 && !order.includes(other) && !ready.includes(other)) ready.push(other);
  }
  if (order.length !== ids.length) throw new Error("study scaffold has a cycle");
  return order;
}

/** The depends_on links a step's produced note carries — making explicit that a scaffold step's access list IS
 *  the produced note's dependency edges (Fugu piece 2 meeting our existing note graph, one dependency model). */
export function stepNoteLinks(step: StudyStep): StudyNoteLink[] {
  return (step.accessList.notes ?? []).map((to) => ({ to, predicate: "depends_on" }));
}

/** Derive a study scaffold (the DAG form of deriveStudyPlan): map -> contracts/concepts -> probes -> synthesize,
 *  each step's access list naming the upstream notes + corpus sources that feed it. Non-breaking: deriveStudyPlan
 *  is unchanged; this is the structured sibling. */
export function deriveStudyScaffold(corpus: StudyCorpus, objective = "develop operational expertise over this corpus"): StudyScaffold {
  const sources = corpus.roots.map((r) => ({ path: (r as { path?: string }).path })).filter((src): src is { path: string } => typeof src.path === "string");
  const steps: StudyStep[] = [
    { id: "corpus-map", subtask: `Map corpus '${corpus.label}' into source families and authoritative entry points.`, produces: "corpus_map", accessList: { sources } },
    { id: "contracts", subtask: "Extract stable contracts: schemas, typed objects, APIs, CLI/tool surfaces, data layouts, and invariants.", produces: "cheatsheet", accessList: { notes: ["corpus-map"], sources } },
    { id: "concept-map", subtask: "Build ontology/concept maps for domain terms, synonym sets, identifiers, and versioned definitions.", produces: "concept_map", accessList: { notes: ["corpus-map"] } },
    { id: "probes", subtask: "Generate expertise probes that require the corpus-specific abstractions, not generic recall.", produces: "question_bank", accessList: { notes: ["contracts", "concept-map"] } },
    { id: "study-index", subtask: `Synthesize an index of what was learned and what to distrust. Objective: ${objective}`, produces: "index", accessList: { notes: ["corpus-map", "contracts", "concept-map", "probes"] } },
  ];
  return { schema: "pi-bio.study_scaffold.v1", corpusId: corpus.id, objective, steps };
}
