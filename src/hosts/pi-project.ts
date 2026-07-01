import { randomUUID } from "node:crypto";
import { systemClock } from "../core/clock.js";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { bioProjectLayout } from "../core/storage.js";
import { normalizeStudySlug, validateStudyNote, type StudyArtifactKind, type StudyNote, type StudyNoteLink } from "../core/study.js";

export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function runtimeSkillRoot(cwd: string): string {
  return bioProjectLayout(cwd).skillsDir;
}

export function runtimeStudyRoot(cwd: string): string {
  return bioProjectLayout(cwd).studyNotesDir;
}

export function validateSkillInput(name: string, description: string, body: string): void {
  if (!SKILL_NAME_RE.test(name) || name.length > 64) throw new Error("skill name must be lowercase kebab-case, max 64 chars");
  if (!description.trim() || description.length > 1024) throw new Error("description is required and must be <= 1024 chars");
  if (!body.trim()) throw new Error("body is required");
  if (body.length > 100_000) throw new Error("skill body too large");
}

/** YAML double-quoted scalar: safe for free text that may contain `:` (which otherwise reads as a mapping). */
function yamlQuoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export async function writeProjectSkill(cwd: string, name: string, description: string, body: string): Promise<string> {
  validateSkillInput(name, description, body);
  const dir = join(runtimeSkillRoot(cwd), name);
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  // Quote the description: agent-authored text routinely contains ':' (e.g. "Use before X: do Y"), which
  // breaks unquoted YAML frontmatter and stops the skill from loading.
  const content = `---\nname: ${name}\ndescription: ${yamlQuoted(description.replace(/\s+/g, " ").trim())}\n---\n\n${body.trim()}\n`;
  await fs.writeFile(path, content, "utf8");
  return path;
}

export async function readStudyNotes(cwd: string): Promise<StudyNote[]> {
  const root = runtimeStudyRoot(cwd);
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }
  const notes: StudyNote[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(join(root, entry), "utf8"));
      // Fail-closed admission gate: only fully valid notes enter the typed system, so downstream
      // (scoreStudyNote, studyNoteIndex, bio_recall) can dereference fields safely.
      // Pre-slug notes are dropped, not migrated — acceptable while .pi/bio-agent is unversioned working memory.
      if (validateStudyNote(parsed).length === 0) notes.push(parsed as StudyNote);
    } catch {
      // Ignore corrupt notes; they are project-local working memory, not source code.
    }
  }
  notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return notes;
}

export interface StudyNoteWriteResult {
  path: string;
  /** The note as actually persisted. May differ from the input note (preserved id/createdAt, write-layer updatedAt). */
  note: StudyNote;
  /** false when an existing note with this slug was overwritten. */
  created: boolean;
}

export async function writeStudyNote(cwd: string, note: StudyNote, now = systemClock()): Promise<StudyNoteWriteResult> {
  const errors = validateStudyNote(note);
  if (errors.length) throw new Error(`invalid study note ${note.slug || "<unnamed>"}: ${errors.join("; ")}`);
  const root = runtimeStudyRoot(cwd);
  await fs.mkdir(root, { recursive: true });
  const path = join(root, `${note.slug}.json`);
  // Upsert by slug: the slug is a mutable identity. An edit preserves the original createdAt and id
  // (so older id references still resolve); the write layer owns updatedAt.
  let createdAt = note.createdAt;
  let id = note.id;
  let created = true;
  try {
    const existing = JSON.parse(await fs.readFile(path, "utf8")) as StudyNote;
    // Only inherit identity from a prior note that is itself valid and actually shares this slug;
    // a corrupt-but-parseable file is treated as a fresh create rather than poisoning the new record.
    if (validateStudyNote(existing).length === 0 && existing.slug === note.slug) {
      created = false;
      createdAt = existing.createdAt;
      id = existing.id;
    }
  } catch {
    // No prior note for this slug (or it was unreadable); this is a fresh create.
  }
  const persisted: StudyNote = { ...note, id, createdAt, updatedAt: now };
  await fs.writeFile(path, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  await writeStudyIndex(cwd);
  return { path, note: persisted, created };
}

export function scoreStudyNote(note: StudyNote, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = [note.title, note.hook, note.body, ...note.tags].join("\n").toLowerCase();
  return terms.reduce((score, term) => score + (hay.includes(term) ? 1 : 0), 0);
}

export async function listStudyNotes(cwd: string, options: { query?: string; limit?: number } = {}): Promise<StudyNote[]> {
  let notes = await readStudyNotes(cwd);
  if (options.query?.trim()) {
    notes = notes
      .map((note) => ({ note, score: scoreStudyNote(note, options.query!) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.note.updatedAt.localeCompare(a.note.updatedAt))
      .map((x) => x.note);
  }
  return notes.slice(0, options.limit ?? 25);
}

export function makeStudyNote(params: {
  kind: StudyArtifactKind;
  title: string;
  hook: string;
  body: string;
  slug?: string;
  tags?: string[];
  links?: StudyNoteLink[];
  sources?: StudyNote["sources"];
}, now = systemClock()): StudyNote {
  const note: StudyNote = {
    schema: "pi-bio.study_note.v1",
    slug: normalizeStudySlug(params.slug ?? params.title),
    id: `${now.slice(0, 10)}-${randomUUID()}`,
    kind: params.kind,
    title: params.title,
    hook: params.hook,
    body: params.body,
    tags: params.tags ?? [],
    ...(params.links ? { links: params.links.map((l) => ({ to: normalizeStudySlug(l.to), predicate: l.predicate })) } : {}),
    sources: params.sources ?? [],
    createdAt: now,
    updatedAt: now,
  };
  const errors = validateStudyNote(note);
  if (errors.length) throw new Error(`invalid study note ${note.slug || "<unnamed>"}: ${errors.join("; ")}`);
  return note;
}

/** Generated-cache index. Source of truth is the .json files; this file is regenerated on every write/delete and is safe to delete. */
export function renderStudyIndex(notes: StudyNote[]): string {
  const lines = notes.map((note) => `- [${note.title}](${note.slug}.json) — ${note.hook} _(${note.kind})_`);
  return [
    "<!-- generated cache; source of truth is the .json files; safe to delete and regenerate -->",
    "# Study notes index",
    "",
    lines.join("\n") || "_(no notes yet)_",
    "",
  ].join("\n");
}

export async function writeStudyIndex(cwd: string): Promise<string> {
  const root = runtimeStudyRoot(cwd);
  await fs.mkdir(root, { recursive: true });
  const notes = await readStudyNotes(cwd);
  const path = join(root, "INDEX.md");
  await fs.writeFile(path, renderStudyIndex(notes), "utf8");
  return path;
}

export async function deleteStudyNote(cwd: string, slug: string): Promise<boolean> {
  const safeSlug = normalizeStudySlug(slug);
  const path = join(runtimeStudyRoot(cwd), `${safeSlug}.json`);
  try {
    await fs.unlink(path);
  } catch {
    return false;
  }
  await writeStudyIndex(cwd);
  return true;
}
