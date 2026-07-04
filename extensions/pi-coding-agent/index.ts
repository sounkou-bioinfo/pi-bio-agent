import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { summarizeBioContext, type BioContext } from "../../src/core/context.js";
import { validateReadOnlySelect } from "../../src/core/knowledge-graph.js";
import { graphProjectionPolicyWarnings, graphProjectionSql, validateGraphProjectionProfile, type GraphProjectionProfile } from "../../src/core/graph-projection.js";
import { deriveStudyPlan, normalizeStudySlug, walkMemoryGraph, type StudyArtifactKind, type StudyCorpus, type StudyNote } from "../../src/core/study.js";
import { deleteStudyNote, makeStudyNote, runtimeSkillRoot, runtimeStudyRoot, validateSkillInput, writeProjectSkill, writeStudyNote } from "../../src/hosts/pi-project.js";
import { defaultDuckDbExtensionCatalog, findDuckDbExtensions } from "../../src/duckdb/extensions.js";
import { queryGraphWindow } from "../../src/duckdb/graph-window.js";
import { entailedEdgesAsOf, materializeBioEdgesAsOf } from "../../src/duckdb/observations.js";
import { describeBioManifestFromPath, isRunDbOpenError, runBioOperationFromManifest, runBioQueryFromManifest } from "../../src/hosts/run-store.js";
import type { CasStore } from "../../src/core/cas.js";
import { bioStorePath, isBioStoreLocked, openBioStore, type BioStore } from "../../src/hosts/bio-store.js";
import { isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { forget, listMemory, recall, remember, memorySubjectId, normalizeAsOf, MEMORY_NOW, type MemoryContent } from "../../src/hosts/memory-store.js";
import { recordSkill, skillSubjectId } from "../../src/hosts/skill-store.js";
import { systemClock } from "../../src/core/clock.js";
import type { SqlConn, ProcessRunner } from "../../src/core/ports.js";
import type { FetchLike } from "../../src/duckdb/resolvers/http-table-scan.js";

function text(payload: unknown) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text" as const, text: body }], details: payload };
}

// Network is an EXPLICIT injected capability, never ambient. createBioExtension takes the host's network port
// (a fetch) by composition; nothing is read from process.env — an env var inherits across forks/embeddings, is
// invisible to the model, and is exactly the hidden global the substrate's injected-effect discipline forbids.
// The default entrypoint (index.ts) injects NO network, so http.get stays unbound and every networked manifest
// fails closed. The operator grants network by loading the explicit networked entrypoint (index-networked.ts),
// which composes a fetch in — a visible, auditable choice the agent can never make for itself.
// A concise, TRUE, drift-resistant primer injected into the system prompt each turn. It names the model and the
// author→describe→run loop, and points at DISCOVERY tools (bio_describe_model, bio_list_duckdb_extensions) and the
// examples/ dir instead of enumerating specifics that would rot — the substrate's anti-hardcoded-self-description rule.
const BIO_ORIENTATION = [
  "[pi-bio-agent] You are running with the pi-bio-agent extension: a SQL-first, provider-agnostic bioinformatics",
  "substrate where MANIFESTS ARE PROGRAMS — a manifest (JSON) declares `provides.resolvers`, `provides.resources`",
  "(virtual DuckDB tables bound to a resolver + params), and `provides.operations` (named read-only duckdb.sql",
  "workflows). TypeScript is only the interpreter; the agent writes the SQL.",
  "",
  "How to work:",
  "- DISCOVER cheaply: your MEMORY is the index — check `bio_list_memory` / `bio_walk_memory` FIRST. For",
  "  manifests, list `examples/` for names, then call `bio_describe_model` with ONE `manifestPath` (a local path OR",
  "  an http(s) URL) to learn its resources, resolvers, and RUNNABLE operation ids. Never read every example, and",
  "  never parse raw manifest JSON. With no argument `bio_describe_model` describes the global model;",
  "  `bio_list_duckdb_extensions` shows the readable-format surface.",
  "- RUN: `bio_run_operation(dbPath, manifestPath, operationId)` runs a declared operation and receipts it under",
  "  `.pi/bio-agent/runs/` (with `replay.json` recording the exact SQL). `bio_query` runs an ad-hoc read-only SELECT",
  "  over a manifest's resolved resources. Check SQL first with `bio_validate_select`.",
  "- AUTHOR (the pi spirit): you can WRITE a new manifest JSON yourself and run it — write the file, call",
  "  `bio_describe_model` on it to validate + discover its operation ids, then `bio_run_operation`. `bio_run_operation`",
  "  binds the built-in resolvers `duckdb.file_scan`, `duckdb.sql_materialize`, `duckhts.read_bcf`; the host-granted",
  "  `http.get` (injected-fetch network) and out-of-process `process.compute` fail closed unless the operator granted",
  "  them (`ncurl_table` is not a resolver — it is SQL inside a `duckdb.sql_materialize` query). (Caveat: a",
  "  file_scan/read_bcf `path` or SQL that hits a REMOTE URI can still reach the network via DuckDB/httpfs — that",
  "  egress is the host's sandbox to police, not a library gate.)",
  "- REMEMBER (machine studying): memory is an append-only, as-of, ATTRIBUTED store (the same temporal ledger as",
  "  facts) — `bio_remember` (link with `[[slug]]`; re-writing supersedes, never clobbers) / `bio_list_memory`",
  "  / `bio_walk_memory` (walk the graph) / `bio_recall`. list/read take an `asOf` time (time-travel), and",
  "  `bio_forget` is a RETRACTION (recall as-of earlier still sees it) — memory is never erased. Prefer",
  "  walking your own memory over re-reading the corpus. Promote a stable workflow to a skill with `bio_create_skill`.",
  "- GRAPH: validate graph projection profiles with `bio_validate_graph_projection`; inspect bounded graph context",
  "  with `bio_graph_window` instead of dumping high-degree neighborhoods into the prompt.",
].join("\n");

// The always-on RECALL INDEX: a compact, current list of memory notes (slug — hook) injected into the system
// prompt each turn, so recall is cheap and the agent reaches for existing memory before re-deriving — the trick
// that makes a MEMORY.md-style index useful. Bounded to keep the token cost small; failures are swallowed (an
// index is a convenience, never a hard dependency).
async function memoryIndexBlock(open: OpenStore, cwd: string): Promise<string> {
  // tryOpen → undefined when a concurrent agent holds the store (degrade to no index, never break the turn).
  const store = await tryOpen(open, cwd).catch(() => undefined);
  if (!store) return "";
  try {
    const mems = await listMemory(store.conn, MEMORY_NOW);
    if (mems.length === 0) return "";
    const lines = mems.slice(0, 30).map((m) => `- ${m.slug} — ${m.hook}${m.author ? ` (${m.author})` : ""}`);
    return `\n\n[memory index] Your current memory (recall with bio_recall / bio_walk_memory before re-deriving):\n${lines.join("\n")}`;
  } catch {
    return "";
  } finally {
    store.close();
  }
}

// Open the ONE store to record a run's `run:<id>` fact — but ONLY when it is safe to. Returns undefined (run
// proceeds without shared-ledger logging) in exactly two cases, never swallowing anything broader:
//   1. the run's own db IS the store file — a second open would lock-conflict (DuckDB is a process-exclusive
//      writer), so skip logging rather than break the run;
//   2. the store cannot be opened (locked by another process / unavailable) — logging is a convenience, not a
//      hard dependency of the query. A genuinely broken store still surfaces on the next memory op (withStore).
// True iff both paths name the SAME underlying file (same device + inode) — unmasks a symlink/hardlink alias that a
// pure path compare misses. Best-effort: a missing file (ENOENT) or stat error means "not provably the same" -> false
// (the resolved-path check above still catches the same-intended-path case before either file exists).
async function isSameFile(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)]);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

async function openRunLog(open: OpenStore, cwd: string, dbPath: string): Promise<BioStore | undefined> {
  const runDb = dbPath === ":memory:" ? "" : isAbsolute(dbPath) ? dbPath : resolve(cwd, dbPath);
  const storePath = resolve(bioStorePath(cwd));
  // (1) covers the DEFAULT local-file store path. A host that injects a CUSTOM file-backed openStore must not run
  // queries against that same file (we can't see the injected store's path here); a server-backed store (the
  // intended concurrency answer) has no such conflict. `open()` throwing on a lock is still caught below.
  // Catch the run-uses-the-store case two ways: (a) same RESOLVED path (works even before either file exists —
  // resolve() both sides since bioStorePath(cwd) is relative when cwd is), and (b) same underlying FILE by
  // device+inode, so a SYMLINK or HARDLINK alias of the store file (which resolve() alone won't unmask) is still
  // caught — else the run opens the same inode and DuckDB's process-exclusive-writer lock makes the run fail.
  if (runDb && (resolve(runDb) === storePath || (await isSameFile(runDb, storePath)))) return undefined; // (1)
  // (2) tryOpen returns undefined on a lock conflict (a concurrent agent holds it — the EXPECTED degrade). A REAL
  // store error (corruption/permissions) is NOT expected: best-effort logging must still not fail the run, so we
  // degrade — but SURFACE it (a warning to stderr) rather than swallow it silently, so an operator can fix a broken
  // store instead of silently losing every run-ledger entry.
  try {
    return await tryOpen(open, cwd);
  } catch (e) {
    console.warn(`bio-agent: run-log store unavailable (${e instanceof Error ? e.message : String(e)}); continuing without run logging`);
    return undefined;
  }
}

// Run a bio run WITH best-effort logging into the run-log store, closing the store exactly once. If the run itself
// fails with a DuckDB LOCK conflict, the run's own db likely ALIASES the store file (a custom-store path openRunLog
// couldn't detect up front): release the store and RETRY the run WITHOUT logging, rather than fail the query on a
// logging convenience. Any other error propagates.
async function withRunLog<T>(open: OpenStore, cwd: string, dbPath: string, run: (storeConn: SqlConn | undefined) => Promise<T>): Promise<T> {
  const store = await openRunLog(open, cwd, dbPath);
  if (!store) return run(undefined);
  let closed = false;
  const close = () => { if (!closed) { closed = true; store.close(); } };
  try {
    return await run(store.conn);
  } catch (e) {
    // Retry unlogged ONLY for a lock error at the run's DB OPEN (isRunDbOpenError) — that is BEFORE any resource
    // resolution / process.compute side effect (the run db aliased the log store's file). A lock surfacing LATER may
    // have already run side effects, so retrying it could DUPLICATE them — propagate instead.
    if (isBioStoreLocked(e) && isRunDbOpenError(e)) { close(); return await run(undefined); }
    throw e;
  } finally {
    close();
  }
}

// open → use → close the ONE store for a memory operation (the store is the source of truth; a re-write here
// supersedes, a delete tombstones, reads are as-of). Failures propagate (unlike the run-log, memory IS the point).
async function withStore<T>(open: OpenStore, cwd: string, fn: (conn: SqlConn) => Promise<T>): Promise<T> {
  const store = await open(cwd);
  try {
    return await fn(store.conn);
  } finally {
    store.close();
  }
}

// Best-effort open that DOES NOT throw on the expected contention: another process holding the file store's write
// lock returns undefined (the caller degrades). A REAL error (corruption/permissions) still throws — not hidden.
// A server-backed injected store never hits the lock path. This is the explicit non-throwing variant.
async function tryOpen(open: OpenStore, cwd: string): Promise<BioStore | undefined> {
  try {
    return await open(cwd);
  } catch (e) {
    if (isBioStoreLocked(e)) return undefined;
    throw e;
  }
}

type OpenStore = (cwd: string) => Promise<BioStore>;

export interface BioExtensionOptions {
  network?: { fetch: FetchLike };
  /** Out-of-process COMPUTE grant: the host injects a ProcessRunner so a manifest's `process.compute` resources can
   *  spawn (R/Python/shell) — same explicit, composed-in grant model as `network`. Absent => process.compute fails
   *  closed (unbound). The prompt/tools advertise this capability; without this it could never actually be granted. */
  process?: { runner: ProcessRunner };
  /** CAS grant: a content-addressed store so `process.compute` can capture declared FILE outputs by digest, and
   *  runs can serialize result/receipts/replay bytes outside the DB. Absent => file outputs fail closed. */
  cas?: CasStore;
  /** Host-owned DuckDB session variables, bound after ordinary agent `bindings`, digested but not serialized in
   *  replay.json, and blocked from ad-hoc `bio_query` reads by name. This is a host composition hook, never a tool
   *  parameter; declared operations may intentionally consume these values. */
  protectedSessionBindings?: Record<string, unknown>;
  /** Additional protected session variable names, for values established by host init/profile code outside this
   *  extension. This only declares the ad-hoc query guard surface; it does not bind values by itself. */
  protectedSessionVariables?: string[];
  /** The authoring agent id stamped on runs/memory this instance records (shared-store attribution). */
  author?: string;
  /** How to open the ONE store. Default: the project-local file (`openBioStore(cwd)`), a process-exclusive writer
   *  — fine for a single project run serially, but it LOCKS out concurrent openers. For inter-project /
   *  inter-agent / inter-process / inter-machine memory, the host injects a SERVER-backed store here — a
   *  connection to a ducknng `run_rpc` or a duckdb quack server — so many agents share one live store without
   *  lock contention. This is the provider-agnostic seam: the library records; the host decides where memory lives. */
  openStore?: OpenStore;
}

export function createBioExtension(options: BioExtensionOptions = {}): (pi: ExtensionAPI) => void {
  const network = options.network;
  const processGrant = options.process; // the out-of-process compute grant (threaded into runs so process.compute can bind)
  const cas = options.cas; // the CAS grant (file outputs + byte serialization); absent => file outputs fail closed
  const protectedSessionBindings = options.protectedSessionBindings;
  const protectedSessionVariables = options.protectedSessionVariables;
  const author = options.author ?? "agent:local";
  const openStore: OpenStore = options.openStore ?? ((cwd) => openBioStore(cwd));
  return function piBioAgentExtension(pi: ExtensionAPI): void {
  pi.on("resources_discover", (event) => ({
    skillPaths: [runtimeSkillRoot(event.cwd)],
  }));

  // Give the agent a persistent, drift-resistant orientation to pi-bio-agent on every turn (the pi-coding-agent
  // way: append to the chained system prompt in before_agent_start). It points at DISCOVERY tools + the examples
  // dir rather than enumerating volatile specifics, so it can never lie as the corpus changes.
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${BIO_ORIENTATION}${await memoryIndexBlock(openStore, event.systemPromptOptions?.cwd ?? process.cwd())}`,
  }));

  pi.registerTool({
    name: "bio_describe_model",
    label: "Describe Pi Bio model",
    description: "Describe the pi-bio-agent model. With no argument: the global domain model (SQL-first bio primitives, ontology/KG modeling, provenance, DuckDB extension substrate, context contract). With a manifestPath: THAT manifest's resources, operations (including the runnable operation ids bio_run_operation accepts), resolvers, and term sets — the discovery path, so you never parse raw manifest JSON by hand. The manifestPath may be a local path OR an http(s) URL (a remote manifest registry); a URL uses the host-granted network and fails closed when none is injected.",
    parameters: Type.Object({
      manifestPath: Type.Optional(Type.String({ description: "Optional path to a manifest JSON — a local path (relative to cwd or absolute) OR an http(s) URL. When set, describe that specific manifest instead of the global domain model." })),
    }),
    async execute(_id, params: { manifestPath?: string }, _signal, _onUpdate, ctx) {
      if (params.manifestPath) {
        // describe THIS program: resources/operations/resolvers/termSets. Local path or (host-granted) URL.
        return text(await describeBioManifestFromPath({ cwd: ctx.cwd, manifestPath: params.manifestPath, network }));
      }
      const bioCtx: BioContext = {
        sources: [],
        duckdbExtensions: defaultDuckDbExtensionCatalog,
      };
      return text({
        summary: summarizeBioContext(bioCtx),
        principles: [
          "Do not encode every question as a bespoke skill; expose primitives the agent can compose.",
          "Ontologies are SQL graph tables: terms, edges, synonyms, xrefs, term sets, and mappings to local concepts.",
          "Knowledge graphs are typed nodes and edges with trust/provenance blocks; summaries are expansion handles, not facts.",
          "Use scoped graph-as-SQL for counts, joins, trends, and provenance instead of serializing neighborhoods into prompt context.",
          "A manifest is the program: declare resources/operations/termSets as data; the agent writes read-only SQL over them.",
          "The agent may author project-local skills when a repeated workflow emerges; run /reload to expose them.",
          "To learn a specific manifest, call bio_describe_model with its manifestPath rather than reading the JSON.",
        ],
      });
    },
  });

  pi.registerTool({
    name: "bio_run_operation",
    label: "Run a bio operation",
    description: "Run a declared duckdb.sql operation from a manifest JSON against an explicit DuckDB database, persisting run/result/receipts under .pi/bio-agent/runs/<runId>. Built-in resolvers always bound: duckdb.file_scan, duckdb.sql_materialize, duckhts.read_bcf. Host-GRANTED (fail closed unless the operator injected them): http.get (network) and process.compute (out-of-process). `ncurl_table` is not a resolver — it is SQL used inside a duckdb.sql_materialize query. Any other resolver id fails closed. The manifest must pass registry validation and the operation must be duckdb.sql.",
    parameters: Type.Object({
      dbPath: Type.String({ description: "Explicit DuckDB database path, or ':memory:'." }),
      manifestPath: Type.String({ description: "Path to a manifest JSON file (relative to cwd or absolute)." }),
      operationId: Type.String({ description: "Operation id declared in the manifest." }),
      runId: Type.Optional(Type.String({ description: "Stable run id; generated when omitted." })),
    }),
    async execute(_id, params: { dbPath: string; manifestPath: string; operationId: string; runId?: string }, signal, _onUpdate, ctx) {
      // Pass ONLY schema-approved fields — never spread untrusted params. Spreading would let an agent smuggle
      // host-only capabilities the tool schema omits (duckdbInitSql / now / cwd) if the schema validator does
      // not strip unknown keys. network/signal are host-composed, never agent-supplied.
      const { dbPath, manifestPath, operationId, runId } = params;
      return text(await withRunLog(openStore, ctx.cwd, dbPath, (storeConn) =>
        runBioOperationFromManifest({ cwd: ctx.cwd, dbPath, manifestPath, operationId, runId, network, process: processGrant, cas, protectedSessionBindings, protectedSessionVariables, signal, store: storeConn, author })));
    },
  });

  pi.registerTool({
    name: "bio_query",
    label: "Run an ad-hoc bio query",
    description: "Resolve a manifest's declared resources into DuckDB tables and run YOUR read-only SQL over them, persisting run/result/receipts under .pi/bio-agent/runs/<runId>. This is the general path: the manifest declares only resources; you do schema discovery (e.g. SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '<resource table>', or SELECT * FROM <table> LIMIT 5) and write the SQL that answers the actual question. No need for a declared operation per question. SQL must be a single read-only SELECT/WITH. result.json holds the rows.",
    parameters: Type.Object({
      dbPath: Type.String({ description: "Explicit DuckDB database path, or ':memory:'." }),
      manifestPath: Type.String({ description: "Path to a manifest JSON file (relative to cwd or absolute)." }),
      sql: Type.String({ description: "A single read-only SELECT/WITH over the manifest's resolved resource tables." }),
      resources: Type.Optional(Type.Array(Type.String(), { description: "Which declared resource ids to resolve first. Defaults to ALL declared; pass the subset your SQL uses to avoid resolving unrelated resources (e.g. a remote one you don't need)." })),
      bindings: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Non-secret agent params as DuckDB session variables: each becomes `SET VARIABLE name = value`, so a resource's url (a SQL expression) composes it via getvariable('name') — e.g. {\"query\":\"asthma\"} for a url like `'...?q=' || getvariable('query')`. Do not put API tokens here; host-owned auth belongs in injected fetch policy, protected host bindings, or declared operations." })),
      runId: Type.Optional(Type.String({ description: "Stable run id; generated when omitted." })),
    }),
    async execute(_id, params: { dbPath: string; manifestPath: string; sql: string; resources?: string[]; bindings?: Record<string, unknown>; runId?: string }, signal, _onUpdate, ctx) {
      // Only schema-approved fields (see bio_run_operation): never spread untrusted params into the host runner.
      const { dbPath, manifestPath, sql, resources, bindings, runId } = params;
      return text(await withRunLog(openStore, ctx.cwd, dbPath, (storeConn) =>
        runBioQueryFromManifest({ cwd: ctx.cwd, dbPath, manifestPath, sql, resources, bindings, runId, network, process: processGrant, cas, protectedSessionBindings, protectedSessionVariables, signal, store: storeConn, author })));
    },
  });

  pi.registerTool({
    name: "bio_list_duckdb_extensions",
    label: "List bio DuckDB extensions",
    description: "List DuckDB extensions useful as bio-data substrates, including HTS, PLINK, AnnData, Zarr, FTS, and remote/object-store access.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Optional text search over name, source, purpose, notes, and examples." })),
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
    name: "bio_validate_graph_projection",
    label: "Validate graph projection",
    description: "Validate a graph projection profile and preview the generated source->bio_edges SQL. This is a dry-run only: it does not execute the projection. Use it when turning a foreign KG table, SemanticSQL edge view, producer output, memory link table, or observation projection into the shared graph shape.",
    parameters: Type.Object({
      profile: Type.Unknown({ description: "A pi-bio.graph_projection_profile.v1 object." }),
    }),
    async execute(_id, params: { profile: unknown }) {
      const profile = params.profile as GraphProjectionProfile;
      const errors = validateGraphProjectionProfile(profile);
      const warnings = errors.length === 0 ? graphProjectionPolicyWarnings(profile) : [];
      return text({ valid: errors.length === 0, errors, warnings, sql: errors.length === 0 ? graphProjectionSql(profile, { allowPolicyFields: true }) : undefined });
    },
  });

  pi.registerTool({
    name: "bio_graph_window",
    label: "Window graph context",
    description: "Return a bounded one-hop window over the compiled project graph, with total/omitted counts and a continuation handle. Defaults to the temporal `bio_edges_as_of` projection from the shared ledger. Use this instead of asking for a full high-degree graph neighborhood.",
    parameters: Type.Object({
      startId: Type.String({ description: "Graph node id, e.g. agent:memory:<slug>, MONDO:..., HP:..., run:<id>." }),
      table: Type.Optional(Type.String({ description: "Graph table to query. Defaults to bio_edges_as_of. Common: bio_edges_as_of, entailed_edge_as_of, bio_edges, entailed_edge." })),
      direction: Type.Optional(Type.Union([Type.Literal("out"), Type.Literal("in"), Type.Literal("both")], { description: "Edge direction relative to startId. Default out." })),
      predicates: Type.Optional(Type.Array(Type.String(), { description: "Optional predicate filter." })),
      transitivePredicates: Type.Optional(Type.Array(Type.String(), { description: "Required when table is entailed_edge_as_of; used to materialize the as-of closure." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000, description: "Max rows to return. Default 100." })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Pagination offset. Default 0." })),
      asOf: Type.Optional(Type.String({ description: "ISO time for temporal graph projections. Default now." })),
    }),
    async execute(_id, params: { startId: string; table?: string; direction?: "out" | "in" | "both"; predicates?: string[]; transitivePredicates?: string[]; limit?: number; offset?: number; asOf?: string }, _signal, _onUpdate, ctx) {
      const table = params.table ?? "bio_edges_as_of";
      return text(await withStore(openStore, ctx.cwd, async (conn) => {
        if (table === "bio_edges_as_of") {
          await materializeBioEdgesAsOf(conn, normalizeAsOf(params.asOf));
        } else if (table === "entailed_edge_as_of") {
          if (!params.transitivePredicates?.length) throw new Error("bio_graph_window: transitivePredicates is required for entailed_edge_as_of");
          await entailedEdgesAsOf(conn, normalizeAsOf(params.asOf), params.transitivePredicates);
        }
        return queryGraphWindow(conn, {
          table,
          startId: params.startId,
          direction: params.direction,
          predicates: params.predicates,
          limit: params.limit,
          offset: params.offset,
        });
      }));
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
      // Temporal + attributed like memory (a re-create supersedes, prior revision kept); the SKILL.md file is the
      // current VIEW pi loads. Order: VALIDATE (pure, no effects) → RECORD to the ledger (source of truth) →
      // MATERIALIZE the file. So invalid input reaches NEITHER; a ledger-write failure leaves NO orphan SKILL.md; and
      // a file-write failure still leaves the ledger correct (the view is re-materializable). Truth before view.
      validateSkillInput(params.name, params.description, params.body);
      await withStore(openStore, ctx.cwd, (conn) => recordSkill(conn, params, systemClock(), author));
      const path = await writeProjectSkill(ctx.cwd, params.name, params.description, params.body);
      return text({ path, stored: skillSubjectId(params.name), author, message: "Skill recorded (temporal, superseded on re-create) + written. Run /reload to load it in this Pi session." });
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
    name: "bio_remember",
    label: "Remember (memory note)",
    description: "Remember a project-local memory note. APPENDS to the temporal ledger (bio_observations, agent:memory:<slug>): a re-write of the same slug SUPERSEDES the current revision while every prior revision is retained (recall as-of an earlier time still sees it); the store is the source of truth. Also materializes a legible .pi/bio-agent/study-notes/<slug>.json file view (upserted in place). Use for corpus maps, cheatsheets, concept maps, probes, and memories too volatile or broad to become skills.",
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
      const note = makeStudyNote(params); // normalize slug + parse [[links]] from the body
      // carry `sources` INTO the temporal store too — else shared/as-of recall loses the citations the file view keeps.
      const mem: MemoryContent = { slug: note.slug, kind: note.kind, title: note.title, hook: note.hook, body: note.body, tags: note.tags ?? [], ...(note.sources && note.sources.length ? { sources: note.sources } : {}) };
      // The ledger is the source of truth (append-only, as-of, attributed); the file is a legible git-diffable view.
      await withStore(openStore, ctx.cwd, (conn) => remember(conn, mem, systemClock(), author));
      const { path } = await writeStudyNote(ctx.cwd, note);
      return text({ stored: memorySubjectId(note.slug), author, materialized: path, note: { slug: note.slug, kind: note.kind, title: note.title, hook: note.hook, tags: note.tags } });
    },
  });

  pi.registerTool({
    name: "bio_list_memory",
    label: "List memory",
    description: "List or search project-local study notes. This is the cheap memory index to scan before reading full notes or creating new skills.",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 0, description: "Max notes to return (non-negative integer)." })),
      asOf: Type.Optional(Type.String({ description: "ISO time — list memory AS OF then (time-travel; default now)." })),
    }),
    async execute(_id, params: { query?: string; limit?: number; asOf?: string }, _signal, _onUpdate, ctx) {
      // defense-in-depth beyond the schema: a negative/fractional limit makes slice() do surprising things
      // (slice(0,-2) drops from the END). Fail closed on an invalid limit rather than return a confusing subset.
      if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 0)) {
        throw new Error(`bio_list_memory: limit must be a non-negative integer (got ${params.limit})`);
      }
      let mems = await withStore(openStore, ctx.cwd, (conn) => listMemory(conn, normalizeAsOf(params.asOf)));
      if (params.query) {
        const q = params.query.toLowerCase();
        mems = mems.filter((m) => `${m.slug} ${m.title} ${m.hook} ${m.body}`.toLowerCase().includes(q));
      }
      if (params.limit !== undefined) mems = mems.slice(0, params.limit);
      return text({ notes: mems.map((m) => ({ slug: m.slug, kind: m.kind, title: m.title, hook: m.hook, tags: m.tags, author: m.author })), root: runtimeStudyRoot(ctx.cwd) });
    },
  });

  pi.registerTool({
    name: "bio_walk_memory",
    label: "Walk bio memory graph",
    description: "Walk the MEMORY GRAPH: each memory note is a node (memory:<slug>); its [[slug]] wikilinks (parsed from the note body) are edges. With no start, returns the whole memory graph (nodes + edges) so you grasp structure at a glance INSTEAD of reading every note (or re-reading the corpus). With a start slug + depth, returns that note's neighborhood (BFS out N hops, links followed both ways). Memory is a graph, not a flat list — studying is only ONE way it gets populated.",
    parameters: Type.Object({
      start: Type.Optional(Type.String({ description: "Start note slug; omit for the whole graph." })),
      depth: Type.Optional(Type.Number({ description: "Hops to walk out from start (default 1)." })),
    }),
    async execute(_id, params: { start?: string; depth?: number }, _signal, _onUpdate, ctx) {
      const root = runtimeStudyRoot(ctx.cwd);
      // walkMemoryGraph reads slug/kind/title/hook/tags + parses [[links]] from body — all carried by MemoryContent.
      // The store OPEN/READ stays OUTSIDE the try so an infra failure (locked/corrupt store) PROPAGATES as a real tool
      // error — consistent with bio_list_memory/bio_recall; only the WALK below turns a bad-input error into data.
      const mems = await withStore(openStore, ctx.cwd, (conn) => listMemory(conn, MEMORY_NOW));
      try {
        const graph = walkMemoryGraph(mems as unknown as StudyNote[], { start: params.start, depth: params.depth });
        return text({ root, start: params.start ?? null, depth: params.start ? params.depth ?? 1 : null, nodeCount: graph.nodes.length, edgeCount: graph.edges.length, graph });
      } catch (e) {
        // Return a WALK error AS DATA so the agent can correct itself (e.g. a malformed/unknown start slug) — but a
        // store failure is NOT caught here (it propagated above), so infra faults don't masquerade as a clean result.
        return text({ root, start: params.start ?? null, error: (e as Error).message });
      }
    },
  });

  pi.registerTool({
    name: "bio_recall",
    label: "Recall memory note",
    description: "Read a memory note's full content by slug from the store, optionally AS OF a past time (time-travel). Find slugs with bio_list_memory / bio_walk_memory.",
    parameters: Type.Object({
      id: Type.String({ description: "Note slug." }),
      asOf: Type.Optional(Type.String({ description: "ISO time — read the revision that was current AS OF then (default now)." })),
    }),
    async execute(_id, params: { id: string; asOf?: string }, _signal, _onUpdate, ctx) {
      const note = await withStore(openStore, ctx.cwd, (conn) => recall(conn, normalizeStudySlug(params.id), normalizeAsOf(params.asOf)));
      if (!note) throw new Error(`no memory found for slug '${params.id}'${params.asOf ? ` as of ${params.asOf}` : ""}`);
      return text(note);
    },
  });

  pi.registerTool({
    name: "bio_forget",
    label: "Forget memory note",
    description: "Forget a memory note by slug — a TEMPORAL RETRACTION, not destruction: recall(now) becomes null and it drops from the current list, but recall AS OF an earlier time still sees it (memory is never erased). Prefer updating by slug via bio_remember; forget only rotten units.",
    parameters: Type.Object({ slug: Type.String({ description: "Slug of the note to forget." }) }),
    async execute(_id, params: { slug: string }, _signal, _onUpdate, ctx) {
      // Normalize ONCE, identically to how bio_remember stores it (makeStudyNote → normalizeStudySlug), so the
      // ledger tombstone and the file deletion hit the SAME key — a raw/cased slug otherwise tombstones a phantom.
      const slug = normalizeStudySlug(params.slug);
      await withStore(openStore, ctx.cwd, (conn) => forget(conn, slug, systemClock(), author));
      // The LEDGER retraction (above) is the truth and has succeeded — `forgotten: true` is honest. Removing the
      // legible file view is best-effort cleanup: a REAL failure (permissions/IO) now THROWS out of deleteStudyNote
      // (ENOENT is a benign no-op), so surface it as data rather than falsely reporting a clean delete of a stale view.
      let fileRemoved = false;
      let fileWarning: string | undefined;
      try {
        fileRemoved = await deleteStudyNote(ctx.cwd, slug);
      } catch (e) {
        fileWarning = `file-view cleanup failed: ${(e as Error).message} — the ledger retraction succeeded, but the .json/INDEX view is stale`;
      }
      return text({ forgotten: true, slug, fileRemoved, ...(fileWarning ? { warning: fileWarning } : {}), note: "temporal retraction — recall as-of an earlier time still sees it" });
    },
  });
  };
}

// Default entrypoint: NO fetch injected — the http.get resolver stays unbound, so every http.get manifest fails
// closed. Grant network by loading the explicit networked entrypoint: `pi -e extensions/pi-coding-agent/index-networked.ts`.
// CAVEAT (not a fetch gate): DuckDB-level remote reads — httpfs (`read_csv_auto('https://…')`, a remote file_scan
// `path`) or a host-installed network extension — can still egress via SQL without an injected fetch. That is the
// host's sandbox residue, NOT something the library gates (a denylist can't be complete); a strict-no-egress host
// must not provision network extensions/httpfs into a shared DuckDB home. See examples/connectors/README.md + sql-guard.ts.
export default createBioExtension();
