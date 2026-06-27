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

export function studyNoteIndex(notes: StudyNote[]): Array<Pick<StudyNote, "id" | "kind" | "title" | "hook" | "tags" | "updatedAt">> {
  return notes.map(({ id, kind, title, hook, tags, updatedAt }) => ({ id, kind, title, hook, tags, updatedAt }));
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
