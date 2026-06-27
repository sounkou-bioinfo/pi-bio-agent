import type { BioArtifact, Provenance } from "./types.js";

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

export interface StudyNote {
  schema: "pi-bio.study_note.v1";
  /** Stable, human-meaningful identity and upsert/link key. A slug is mutable in place; edits keep the slug and bump updatedAt. */
  slug: string;
  /** Opaque uniqueness id; retained for back-compat and provenance. Not the upsert key. */
  id: string;
  kind: StudyArtifactKind;
  title: string;
  hook: string;
  body: string;
  tags: string[];
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
  if (typeof n.kind !== "string" || !STUDY_ARTIFACT_KINDS.includes(n.kind as StudyArtifactKind)) errors.push("kind is invalid");
  if (typeof n.title !== "string" || !n.title.trim()) errors.push("title is required");
  if (typeof n.hook !== "string" || !n.hook.trim()) errors.push("hook is required");
  else if (n.hook.trim().length > 280) errors.push("hook must be <= 280 chars");
  else if (typeof n.title === "string" && n.hook.trim().toLowerCase() === n.title.trim().toLowerCase()) errors.push("hook must say when to read the note, not just restate the title");
  if (typeof n.body !== "string" || !n.body.trim()) errors.push("body is required");
  if (typeof n.createdAt !== "string" || !n.createdAt.trim()) errors.push("createdAt is required");
  if (typeof n.updatedAt !== "string" || !n.updatedAt.trim()) errors.push("updatedAt is required");
  return errors;
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
