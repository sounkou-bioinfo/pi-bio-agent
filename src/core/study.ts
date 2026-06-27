import type { BioArtifact, Provenance } from "./types.js";
import type { BioGraphEdge } from "./knowledge-graph.js";

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

const WIKILINK_RE = /\[\[([a-z0-9][a-z0-9-]*)\]\]/gi;

/** Knowledge-graph node id for a study note. Rejects non-slug input rather than minting a malformed node id. */
export function memoryNodeId(slug: string): string {
  if (typeof slug !== "string" || !STUDY_SLUG_RE.test(slug) || slug.length > 64) throw new Error(`invalid memory slug: ${slug}`);
  return `memory:${slug}`;
}

/** Collect a note's links from both its explicit `links` field and `[[slug]]` body links, normalized and de-duplicated by (to, predicate). Pure; dangling targets are allowed and not resolved here. */
export function parseStudyNoteLinks(note: Pick<StudyNote, "body" | "links">): Required<StudyNoteLink>[] {
  const out = new Map<string, Required<StudyNoteLink>>();
  const add = (to: string, predicate?: unknown) => {
    let slug: string;
    try {
      slug = normalizeStudySlug(to);
    } catch {
      return; // unusable target, skip
    }
    // Defensive: this is exported core and can receive unvalidated JSON, so an unknown predicate
    // falls back to the default rather than projecting a bogus edge.
    const pred = isStudyNoteLinkPredicate(predicate) ? predicate : STUDY_DEFAULT_LINK_PREDICATE;
    out.set(JSON.stringify([slug, pred]), { to: slug, predicate: pred });
  };
  for (const link of note.links ?? []) add(link.to, link.predicate);
  for (const match of (note.body ?? "").matchAll(WIKILINK_RE)) add(match[1]);
  return [...out.values()];
}

/** Project a note's links into knowledge-graph edges (`memory:<slug>` -> `memory:<to>`). Pure: no I/O, no existence check, so dangling links project too. */
export function studyNoteLinkEdges(note: Pick<StudyNote, "slug" | "body" | "links">): BioGraphEdge[] {
  const from = memoryNodeId(note.slug);
  return parseStudyNoteLinks(note).map((link) => ({ from, to: memoryNodeId(link.to), predicate: link.predicate }));
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
