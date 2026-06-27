import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { summarizeBioContext, type BioContext } from "../../src/core/context.js";
import { findToolSpecs, toolSpecIndex } from "../../src/core/tool-spec.js";
import { validateReadOnlySelect } from "../../src/core/knowledge-graph.js";
import { deriveStudyPlan, studyNoteIndex, type StudyArtifactKind, type StudyCorpus, type StudyNote } from "../../src/core/study.js";
import { deleteStudyNote, listStudyNotes, makeStudyNote, readStudyNotes, runtimeSkillRoot, runtimeStudyRoot, writeProjectSkill, writeStudyNote } from "../../src/hosts/pi-project.js";
import { ontologySqlContract } from "../../src/core/ontology.js";
import { defaultDuckDbExtensionCatalog, findDuckDbExtensions } from "../../src/duckdb/extensions.js";
import { bioSqlContract } from "../../src/duckdb/sql-contract.js";
import { defaultBioToolRegistry } from "../../src/primitives/bio-tool-specs.js";
import { defaultBioResourceRegistry, findResourceResolvers } from "../../src/primitives/resources.js";

function text(payload: unknown) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text: body }], details: payload };
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
    description: "Persist an indexed project-local study note under .pi/bio-agent/study-notes. Upserts by slug, so re-writing the same slug updates the note in place. Use for corpus maps, cheatsheets, concept maps, probes, and memories that are too volatile or broad to become skills.",
    parameters: Type.Object({
      kind: Type.String({ description: "corpus_map | cheatsheet | concept_map | question_bank | rubric | worked_example | failure_case | memory_note | skill_draft | index" }),
      title: Type.String(),
      hook: Type.String({ description: "One-line retrieval hook: when this note should be read. Must say when to read it, not just restate the title." }),
      body: Type.String(),
      slug: Type.Optional(Type.String({ description: "Stable kebab-case identity and upsert key. Derived from the title when omitted." })),
      tags: Type.Optional(Type.Array(Type.String())),
      sources: Type.Optional(Type.Array(Type.Object({
        path: Type.Optional(Type.String()),
        url: Type.Optional(Type.String()),
        locator: Type.Optional(Type.String()),
        quote: Type.Optional(Type.String()),
      }))),
    }),
    async execute(_id, params: { kind: StudyArtifactKind; title: string; hook: string; body: string; slug?: string; tags?: string[]; sources?: StudyNote["sources"] }, _signal, _onUpdate, ctx) {
      const { path, note, created } = await writeStudyNote(ctx.cwd, makeStudyNote(params));
      return text({ path, created, note: { slug: note.slug, id: note.id, kind: note.kind, title: note.title, hook: note.hook, tags: note.tags } });
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
      const notes = await listStudyNotes(ctx.cwd, params);
      return text({ notes: studyNoteIndex(notes), root: runtimeStudyRoot(ctx.cwd) });
    },
  });

  pi.registerTool({
    name: "bio_read_study_note",
    label: "Read bio study note",
    description: "Read a full project-local study note by slug (or id) after finding it with bio_list_study_notes.",
    parameters: Type.Object({ id: Type.String({ description: "Note slug or id (prefix match allowed)." }) }),
    async execute(_id, params: { id: string }, _signal, _onUpdate, ctx) {
      const notes = await readStudyNotes(ctx.cwd);
      const note = notes.find((x) => x.slug === params.id || x.id === params.id || x.slug.startsWith(params.id) || x.id.startsWith(params.id));
      if (!note) throw new Error(`no study note found for slug or id '${params.id}'`);
      return text(note);
    },
  });

  pi.registerTool({
    name: "bio_delete_study_note",
    label: "Delete bio study note",
    description: "Delete a project-local study note by slug when it is wrong or stale. Memory hygiene: prefer updating by slug via bio_write_study_note; delete only rotten units.",
    parameters: Type.Object({ slug: Type.String({ description: "Slug of the note to delete." }) }),
    async execute(_id, params: { slug: string }, _signal, _onUpdate, ctx) {
      const deleted = await deleteStudyNote(ctx.cwd, params.slug);
      if (!deleted) throw new Error(`no study note found for slug '${params.slug}'`);
      return text({ deleted: true, slug: params.slug });
    },
  });
}
