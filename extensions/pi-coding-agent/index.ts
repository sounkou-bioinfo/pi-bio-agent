import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { summarizeBioContext, type BioContext } from "../../src/core/context.js";
import { findToolSpecs, toolSpecIndex } from "../../src/core/tool-spec.js";
import { validateReadOnlySelect } from "../../src/core/knowledge-graph.js";
import { deriveStudyPlan, studyNoteIndex, type StudyArtifactKind, type StudyCorpus, type StudyNote } from "../../src/core/study.js";
import { ontologySqlContract } from "../../src/core/ontology.js";
import { defaultDuckDbExtensionCatalog, findDuckDbExtensions } from "../../src/duckdb/extensions.js";
import { bioSqlContract } from "../../src/duckdb/sql-contract.js";
import { defaultBioToolRegistry } from "../../src/primitives/bio-tool-specs.js";
import { defaultBioResourceRegistry, findResourceResolvers } from "../../src/primitives/resources.js";

const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function runtimeSkillRoot(cwd: string): string {
  return resolve(cwd, ".pi", "bio-agent", "skills");
}

function runtimeStudyRoot(cwd: string): string {
  return resolve(cwd, ".pi", "bio-agent", "study-notes");
}

function text(payload: unknown) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text: body }], details: payload };
}

function validateSkillInput(name: string, description: string, body: string): void {
  if (!SKILL_NAME_RE.test(name) || name.length > 64) throw new Error("skill name must be lowercase kebab-case, max 64 chars");
  if (!description.trim() || description.length > 1024) throw new Error("description is required and must be <= 1024 chars");
  if (!body.trim()) throw new Error("body is required");
  if (body.length > 100_000) throw new Error("skill body too large");
}

async function writeProjectSkill(cwd: string, name: string, description: string, body: string): Promise<string> {
  validateSkillInput(name, description, body);
  const dir = join(runtimeSkillRoot(cwd), name);
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  const content = `---\nname: ${name}\ndescription: ${description.replace(/\s+/g, " ").trim()}\n---\n\n${body.trim()}\n`;
  await fs.writeFile(path, content, "utf8");
  return path;
}

async function readStudyNotes(cwd: string): Promise<StudyNote[]> {
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
      const raw = await fs.readFile(join(root, entry), "utf8");
      const parsed = JSON.parse(raw) as StudyNote;
      if (parsed.schema === "pi-bio.study_note.v1" && parsed.id) notes.push(parsed);
    } catch {
      // Ignore corrupt notes; they are project-local working memory, not source code.
    }
  }
  notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return notes;
}

async function writeStudyNote(cwd: string, note: StudyNote): Promise<string> {
  const root = runtimeStudyRoot(cwd);
  await fs.mkdir(root, { recursive: true });
  const safeId = basename(note.id).replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = join(root, `${safeId}.json`);
  await fs.writeFile(path, `${JSON.stringify(note, null, 2)}\n`, "utf8");
  return path;
}

function scoreNote(note: StudyNote, query: string): number {
  const q = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = [note.title, note.hook, note.body, ...note.tags].join("\n").toLowerCase();
  return q.reduce((score, term) => score + (hay.includes(term) ? 1 : 0), 0);
}

export default function piBioAgentExtension(pi: ExtensionAPI): void {
  pi.on("resources_discover", (event) => ({
    skillPaths: [runtimeSkillRoot(event.cwd)],
  }));

  pi.registerTool({
    name: "bio_describe_model",
    label: "Describe Pi Bio model",
    description: "Describe the pi-bio-agent domain model: SQL-first bio primitives, ontology/KG modeling, provenance, BioToolSpec contracts, resources, DuckDB extension substrate, and context contract.",
    parameters: Type.Object({}),
    async execute() {
      const ctx: BioContext = {
        schema: "pi-bio.context.v1",
        sources: [],
        toolRegistry: defaultBioToolRegistry,
        resources: defaultBioResourceRegistry,
        duckdbExtensions: defaultDuckDbExtensionCatalog,
      };
      return text({
        summary: summarizeBioContext(ctx),
        principles: [
          "Do not encode every question as a bespoke skill; expose primitives the agent can compose.",
          "Ontologies are SQL graph tables: terms, edges, synonyms, xrefs, term sets, and mappings to local concepts.",
          "Knowledge graphs are typed nodes and edges with trust/provenance blocks; summaries are expansion handles, not facts.",
          "Use scoped graph-as-SQL for counts, joins, trends, and provenance instead of serializing neighborhoods into prompt context.",
          "BioToolSpec is the provider-agnostic contract; adapters bind it to Pi tools, DuckDB, R, shell, HTTP, MCP, or memory.",
          "The agent may author project-local skills when a repeated workflow emerges; run /reload to expose them.",
        ],
        sql_contract: bioSqlContract(),
        ontology_contract: ontologySqlContract(),
      });
    },
  });

  pi.registerTool({
    name: "bio_list_tool_specs",
    label: "List BioToolSpec contracts",
    description: "List or search the provider-agnostic BioToolSpec registry. Use before claiming a bioinformatics tool surface is missing.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Optional text search over id, label, description, and domains." })),
    }),
    async execute(_id, params: { query?: string }) {
      const matches = params.query ? findToolSpecs(defaultBioToolRegistry, params.query) : toolSpecIndex(defaultBioToolRegistry);
      return text({ schema: defaultBioToolRegistry.schema, tools: matches });
    },
  });

  pi.registerTool({
    name: "bio_list_resource_resolvers",
    label: "List bio resource resolvers",
    description: "List content-addressed and virtual resource resolver specs, including declarative HTTP JSON request surfaces.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Optional text search over resolver names, modes, and descriptions." })),
    }),
    async execute(_id, params: { query?: string }) {
      const resolvers = params.query ? findResourceResolvers(params.query) : defaultBioResourceRegistry.resolvers;
      return text({ schema: defaultBioResourceRegistry.schema, resolvers });
    },
  });

  pi.registerTool({
    name: "bio_list_duckdb_extensions",
    label: "List bio DuckDB extensions",
    description: "List DuckDB extensions useful as bio-data substrates, including HTS, PLINK, AnnData, Zarr, FTS, and remote/object-store access.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Optional text search over name, purpose, and domains." })),
    }),
    async execute(_id, params: { query?: string }) {
      const extensions = params.query ? findDuckDbExtensions(params.query) : defaultDuckDbExtensionCatalog.extensions;
      return text({ schema: defaultDuckDbExtensionCatalog.schema, extensions });
    },
  });

  pi.registerTool({
    name: "bio_validate_select",
    label: "Validate bio SQL SELECT",
    description: "Validate that a graph/ontology DuckDB query is a single read-only SELECT/WITH statement before execution elsewhere.",
    parameters: Type.Object({
      sql: Type.String({ description: "A single read-only SELECT or WITH ... SELECT statement." }),
    }),
    async execute(_id, params: { sql: string }) {
      return text({ ok: true, sql: validateReadOnlySelect(params.sql) });
    },
  });

  pi.registerTool({
    name: "bio_create_skill",
    label: "Create bio skill",
    description: "Create or update a project-local Pi skill under .pi/bio-agent/skills. Use after discovering a reusable workflow; then ask the user to run /reload.",
    parameters: Type.Object({
      name: Type.String({ description: "Lowercase kebab-case skill name." }),
      description: Type.String({ description: "One-line description saying when to use the skill." }),
      body: Type.String({ description: "Markdown instructions for the skill body." }),
    }),
    async execute(_id, params: { name: string; description: string; body: string }, _signal, _onUpdate, ctx) {
      const path = await writeProjectSkill(ctx.cwd, params.name, params.description, params.body);
      return text({ path, message: "Skill written. Run /reload to load it in this Pi session." });
    },
  });

  pi.registerTool({
    name: "bio_study_plan",
    label: "Plan bio study",
    description: "Plan a study pass over a corpus. Use this instead of creating a skill too early: map the corpus, extract contracts, build notes/probes, then promote stable workflows to skills.",
    parameters: Type.Object({
      corpusLabel: Type.String({ description: "Short label for the corpus or domain to study." }),
      roots: Type.Optional(Type.Array(Type.String({ description: "File, directory, URL, or artifact path included in the corpus." }))),
      objective: Type.Optional(Type.String({ description: "What expertise the agent should develop over the corpus." })),
    }),
    async execute(_id, params: { corpusLabel: string; roots?: string[]; objective?: string }) {
      const corpus: StudyCorpus = {
        id: params.corpusLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "corpus",
        label: params.corpusLabel,
        roots: (params.roots ?? []).map((path) => ({ kind: "artifact", role: "input", path })),
      };
      return text({ corpus, plan: deriveStudyPlan(corpus, params.objective) });
    },
  });

  pi.registerTool({
    name: "bio_write_study_note",
    label: "Write bio study note",
    description: "Persist an indexed project-local study note under .pi/bio-agent/study-notes. Use for corpus maps, cheatsheets, concept maps, probes, and memories that are too volatile or broad to become skills.",
    parameters: Type.Object({
      kind: Type.String({ description: "corpus_map | cheatsheet | concept_map | question_bank | rubric | worked_example | failure_case | memory_note | skill_draft | index" }),
      title: Type.String(),
      hook: Type.String({ description: "One-line retrieval hook: when this note should be read." }),
      body: Type.String(),
      tags: Type.Optional(Type.Array(Type.String())),
      sources: Type.Optional(Type.Array(Type.Object({
        path: Type.Optional(Type.String()),
        url: Type.Optional(Type.String()),
        locator: Type.Optional(Type.String()),
        quote: Type.Optional(Type.String()),
      }))),
    }),
    async execute(_id, params: { kind: StudyArtifactKind; title: string; hook: string; body: string; tags?: string[]; sources?: StudyNote["sources"] }, _signal, _onUpdate, ctx) {
      const now = new Date().toISOString();
      const note: StudyNote = {
        schema: "pi-bio.study_note.v1",
        id: `${now.slice(0, 10)}-${randomUUID()}`,
        kind: params.kind,
        title: params.title,
        hook: params.hook,
        body: params.body,
        tags: params.tags ?? [],
        sources: params.sources ?? [],
        createdAt: now,
        updatedAt: now,
      };
      const path = await writeStudyNote(ctx.cwd, note);
      return text({ path, note: { id: note.id, kind: note.kind, title: note.title, hook: note.hook, tags: note.tags } });
    },
  });

  pi.registerTool({
    name: "bio_list_study_notes",
    label: "List bio study notes",
    description: "List or search project-local study notes. This is the cheap memory index to scan before reading full notes or creating new skills.",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, params: { query?: string; limit?: number }, _signal, _onUpdate, ctx) {
      let notes = await readStudyNotes(ctx.cwd);
      if (params.query?.trim()) notes = notes.map((note) => ({ note, score: scoreNote(note, params.query!) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.note.updatedAt.localeCompare(a.note.updatedAt)).map((x) => x.note);
      notes = notes.slice(0, params.limit ?? 25);
      return text({ notes: studyNoteIndex(notes), root: runtimeStudyRoot(ctx.cwd) });
    },
  });

  pi.registerTool({
    name: "bio_read_study_note",
    label: "Read bio study note",
    description: "Read a full project-local study note by id after finding it with bio_list_study_notes.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params: { id: string }, _signal, _onUpdate, ctx) {
      const notes = await readStudyNotes(ctx.cwd);
      const note = notes.find((x) => x.id === params.id || x.id.startsWith(params.id));
      if (!note) throw new Error(`no study note found for id '${params.id}'`);
      return text(note);
    },
  });
}
