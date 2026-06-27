import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { defineBioOperationSpec, operationSpecIndex, registryFromOperations, validateBioOperationSpec, type BioOperationSpec } from "../src/core/operation-spec.js";
import { contentAddressUri, isContentAddressUri, validateResourceResolverSpec, type ResourceResolverSpec } from "../src/core/resources.js";
import { appendRunEvent, defineBioRunSpec, newRunRecord, validateBioRunSpec, type BioRunSpec } from "../src/core/run-spec.js";
import { bioProjectLayout, casPathForAddress, validateContentAddress } from "../src/core/storage.js";
import { defineBioToolSpec, validateBioToolSpec, type BioToolSpec } from "../src/core/tool-spec.js";
import { makeConceptNode, validateReadOnlySelect } from "../src/core/knowledge-graph.js";
import { deriveStudyPlan, memoryNodeId, parseStudyNoteLinks, studyNoteIndex, studyNoteLinkEdges, validateStudyNote, STUDY_DEFAULT_LINK_PREDICATE, type StudyNote } from "../src/core/study.js";

const validTool: BioToolSpec = {
  schema: "pi-bio.tool_spec.v1",
  name: "test.echo",
  version: "0.1.0",
  title: "Echo",
  description: "Echo a value for tests.",
  domains: ["testing"],
  determinism: "deterministic",
  inputs: [{ name: "input", kind: "question", required: true }],
  outputs: [{ name: "output", kind: "fact_bundle" }],
  surfaces: [{ substrate: "pi", constraints: { readOnly: true } }],
  effects: ["read"],
};

const validResolver: ResourceResolverSpec = {
  schema: "pi-bio.resource_resolver.v1",
  name: "test.resolver",
  version: "0.1.0",
  description: "Resolve test resources.",
  modes: ["virtual"],
  request: { method: "GET", urlTemplate: "https://example.org/{id}", networkPolicy: "explicit-consent" },
};

const validOperation: BioOperationSpec = {
  schema: "pi-bio.operation_spec.v1",
  id: "opentargets.search",
  version: "0.1.0",
  title: "OpenTargets search",
  description: "Search public OpenTargets entities.",
  domains: ["open-targets", "evidence"],
  transport: "graphql",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  identifiers: [{ name: "query", namespace: "free_text", required: true }],
  graphql: {
    endpoint: "https://api.platform.opentargets.org/api/v4/graphql",
    query: "query Search($q: String!) { search(queryString: $q) { hits { id name entity } } }",
    networkPolicy: "explicit-consent",
  },
  cache: { mode: "metadata", ttlSeconds: 3600, keyFields: ["query"] },
  provenance: { includeRequest: true, includeResponseDigest: true },
};

const validRun: BioRunSpec = {
  schema: "pi-bio.run_spec.v1",
  id: "study:opentargets:001",
  title: "Study OpenTargets",
  description: "Build an operation-pack study note.",
  tool: { name: "bio_study_plan" },
  mode: "background",
  inputs: [{ name: "objective", value: "map public evidence operations" }],
  expectedOutputs: [{ name: "study-note", kind: "study_note", required: true }],
  budget: { maxWallClockSeconds: 300, maxToolCalls: 20 },
  checkpointPolicy: { intervalSeconds: 60, resumable: true },
};

describe("BioToolSpec validation", () => {
  test("accepts a valid spec and returns the same object from defineBioToolSpec", () => {
    assert.deepEqual(validateBioToolSpec(validTool), []);
    assert.equal(defineBioToolSpec(validTool), validTool);
  });

  test("reports malformed specs without throwing", () => {
    const errors = validateBioToolSpec({ schema: "nope", name: "Bad Name" } as unknown as BioToolSpec);
    assert.ok(errors.includes("schema must be pi-bio.tool_spec.v1"));
    assert.ok(errors.some((e) => e.includes("name must be lowercase")));
    assert.ok(errors.includes("at least one execution surface is required"));
    assert.ok(errors.includes("at least one effect is required"));
  });

  test("rejects write effects on read-only surfaces", () => {
    const errors = validateBioToolSpec({ ...validTool, effects: ["read", "write"] });
    assert.ok(errors.includes("read-only surfaces cannot declare write effects"));
  });
});

describe("BioOperationSpec validation", () => {
  test("accepts operation specs and builds registries", () => {
    assert.deepEqual(validateBioOperationSpec(validOperation), []);
    assert.equal(defineBioOperationSpec(validOperation), validOperation);
    const registry = registryFromOperations([validOperation]);
    assert.deepEqual(operationSpecIndex(registry), [{
      id: validOperation.id,
      version: validOperation.version,
      title: validOperation.title,
      description: validOperation.description,
      domains: validOperation.domains,
      transport: validOperation.transport,
    }]);
  });

  test("reports malformed operation specs without throwing", () => {
    const errors = validateBioOperationSpec({ schema: "x", id: "Bad Operation", transport: "graphql" } as unknown as BioOperationSpec);
    assert.ok(errors.includes("schema must be pi-bio.operation_spec.v1"));
    assert.ok(errors.some((e) => e.includes("id must be lowercase")));
    assert.ok(errors.includes("inputSchema is required"));
    assert.ok(errors.includes("graphql transport requires graphql request details"));
  });

  test("enforces transport-specific policy", () => {
    const httpErrors = validateBioOperationSpec({
      ...validOperation,
      transport: "http",
      graphql: undefined,
      http: { method: "GET", urlTemplate: "https://example.org/{id}", networkPolicy: "forbidden" },
    });
    assert.ok(httpErrors.includes("http operations cannot declare forbidden network policy"));
    const sqlErrors = validateBioOperationSpec({
      ...validOperation,
      transport: "duckdb.sql",
      graphql: undefined,
      sql: { sqlTemplate: "SELECT * FROM bio_nodes", readOnly: false as true },
    });
    assert.ok(sqlErrors.includes("sql.readOnly must be true"));
  });

  test("requires OpenAPI details and validates network-policy consistency", () => {
    const missingOpenapi = validateBioOperationSpec({ ...validOperation, transport: "openapi", graphql: undefined });
    assert.ok(missingOpenapi.includes("openapi transport requires openapi request details"));
    const validOpenapi = validateBioOperationSpec({
      ...validOperation,
      transport: "openapi",
      graphql: undefined,
      openapi: { specUrl: "https://example.org/openapi.json", operationId: "searchTargets", networkPolicy: "explicit-consent" },
      safety: { networkPolicy: "explicit-consent" },
    });
    assert.deepEqual(validOpenapi, []);
    const mismatch = validateBioOperationSpec({
      ...validOperation,
      safety: { networkPolicy: "allowed" },
      graphql: { ...validOperation.graphql!, networkPolicy: "explicit-consent" },
    });
    assert.ok(mismatch.includes("safety.networkPolicy must match graphql.networkPolicy when both are set"));
  });
});

describe("BioRunSpec and storage helpers", () => {
  test("validates run specs and tracks run events immutably", () => {
    assert.deepEqual(validateBioRunSpec(validRun), []);
    assert.equal(defineBioRunSpec(validRun), validRun);
    const record = newRunRecord(validRun, "2026-06-27T00:00:00Z");
    assert.equal(record.status, "queued");
    const running = appendRunEvent(record, { type: "started", message: "go", at: "2026-06-27T00:00:01Z" });
    assert.equal(running.status, "running");
    assert.equal(record.status, "queued", "appendRunEvent must not mutate the original record");
    const done = appendRunEvent(running, { type: "completed", data: { ok: true }, at: "2026-06-27T00:00:02Z" });
    assert.equal(done.status, "succeeded");
    assert.equal(done.events.length, 3);
  });

  test("reports malformed run specs without throwing", () => {
    const errors = validateBioRunSpec({ schema: "x", id: "bad id with spaces", mode: "nope" } as unknown as BioRunSpec);
    assert.ok(errors.includes("schema must be pi-bio.run_spec.v1"));
    assert.ok(errors.some((e) => e.includes("id is required")));
    assert.ok(errors.includes("tool.name is required"));
    assert.ok(errors.includes("mode is invalid"));
    assert.ok(errors.includes("inputs array is required"));
  });

  test("computes project storage layout and CAS paths", () => {
    const layout = bioProjectLayout("/work/project");
    assert.equal(layout.root, "/work/project/.pi/bio-agent");
    assert.equal(layout.duckdbPath, "/work/project/.pi/bio-agent/bio.duckdb");
    const address = { algorithm: "sha256" as const, digest: "a".repeat(64), sizeBytes: 1 };
    assert.deepEqual(validateContentAddress(address), []);
    assert.equal(casPathForAddress(layout, address), `/work/project/.pi/bio-agent/cas/sha256/${"a".repeat(64)}`);
    assert.ok(validateContentAddress({ algorithm: "sha256", digest: "abc" }).includes("sha256 digest must be 64 hex chars"));
  });
});

describe("Resource resolver validation", () => {
  test("accepts valid resolver specs", () => {
    assert.deepEqual(validateResourceResolverSpec(validResolver), []);
  });

  test("reports malformed resolver specs without throwing", () => {
    const errors = validateResourceResolverSpec({ schema: "x", name: "Bad Resolver" } as unknown as ResourceResolverSpec);
    assert.ok(errors.includes("schema must be pi-bio.resource_resolver.v1"));
    assert.ok(errors.includes("invalid resolver name"));
    assert.ok(errors.includes("at least one mode is required"));
  });

  test("forbids impossible request network policy", () => {
    const errors = validateResourceResolverSpec({ ...validResolver, request: { ...validResolver.request!, networkPolicy: "forbidden" } });
    assert.ok(errors.includes("request templates cannot declare forbidden network policy"));
  });

  test("formats and detects content-address URIs", () => {
    const uri = contentAddressUri({ algorithm: "sha256", digest: "a".repeat(64), sizeBytes: 7 });
    assert.equal(uri, `cas:sha256:${"a".repeat(64)}`);
    assert.equal(isContentAddressUri(uri), true);
    assert.equal(isContentAddressUri("cas:md5:bad"), false);
  });
});

describe("SQL and graph helpers", () => {
  test("validates a single read-only SELECT/WITH", () => {
    assert.equal(validateReadOnlySelect(" select * from bio_nodes; \n"), "select * from bio_nodes");
    assert.equal(validateReadOnlySelect("WITH x AS (SELECT 1) SELECT * FROM x"), "WITH x AS (SELECT 1) SELECT * FROM x");
  });

  test("rejects multi-statement and write/DDL SQL", () => {
    assert.throws(() => validateReadOnlySelect("SELECT 1; SELECT 2"), /one statement only/);
    assert.throws(() => validateReadOnlySelect("DELETE FROM bio_nodes"), /SELECT/);
    assert.throws(() => validateReadOnlySelect("SELECT * FROM x; DROP TABLE x"), /one statement only/);
    assert.throws(() => validateReadOnlySelect("WITH x AS (DELETE FROM y RETURNING *) SELECT * FROM x"), /forbidden/);
  });

  test("creates stable concept nodes", () => {
    const node = makeConceptNode("Glycemic Trajectory", 2);
    assert.equal(node.id, "concept:glycemic-trajectory");
    assert.equal(node.attrs?.slug, "glycemic-trajectory");
    assert.throws(() => makeConceptNode("!!!"), /concept label cannot be empty/);
  });
});

describe("Study helpers", () => {
  test("builds compact indexes and study plans", () => {
    const note: StudyNote = {
      schema: "pi-bio.study_note.v1",
      slug: "opentargets-identifiers",
      id: "n1",
      kind: "cheatsheet",
      title: "OpenTargets identifiers",
      hook: "Use before querying OpenTargets.",
      body: "Genes need target IDs.",
      tags: ["opentargets"],
      sources: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };
    assert.deepEqual(studyNoteIndex([note]), [{ slug: "opentargets-identifiers", id: "n1", kind: "cheatsheet", title: note.title, hook: note.hook, tags: ["opentargets"], updatedAt: note.updatedAt }]);
    assert.deepEqual(validateStudyNote(note), []);
    const plan = deriveStudyPlan({ id: "api", label: "API", roots: [] }, "learn operation specs");
    assert.ok(plan.some((step) => step.includes("Objective: learn operation specs")));
  });

  test("validateStudyNote is fail-closed and checks slug, kind, and the hook", () => {
    assert.deepEqual(validateStudyNote(null), ["study note must be an object"]);
    const errors = validateStudyNote({ schema: "pi-bio.study_note.v1", slug: "Bad Slug", kind: "not_a_kind", title: "T", hook: "T", body: "" } as unknown as StudyNote);
    assert.ok(errors.some((e) => e.includes("slug must be lowercase")));
    assert.ok(errors.includes("kind is invalid"));
    assert.ok(errors.some((e) => e.includes("hook must say when to read")));
    assert.ok(errors.includes("body is required"));
    assert.ok(errors.includes("createdAt is required"));
    // The admission gate must also catch fields readers later dereference (id/tags/sources).
    assert.ok(errors.includes("id is required"));
    assert.ok(errors.includes("tags must be an array"));
    assert.ok(errors.includes("sources must be an array"));
    assert.ok(validateStudyNote({ schema: "pi-bio.study_note.v1", slug: "ok", id: "i", kind: "cheatsheet", title: "T", hook: "Read it later.", body: "b", tags: [], sources: [], createdAt: "t", updatedAt: "t", links: [{ to: "Bad Slug" }] } as unknown as StudyNote).includes("each link.to must be a slug"));
  });

  test("parses and projects note links: dedup, dangling-tolerant, body + explicit field", () => {
    const note = {
      slug: "acmg-pm2",
      body: "See [[gnomad-frequencies]] and again [[gnomad-frequencies]]; also [[Not A Slug]] is ignored.",
      links: [{ to: "acmg-pvs1", predicate: "supersedes" as const }, { to: "gnomad-frequencies" }],
    };
    const links = parseStudyNoteLinks(note);
    // explicit (acmg-pvs1/supersedes), explicit (gnomad-frequencies/references), body (gnomad-frequencies/references dedup) -> 2 unique
    assert.equal(links.length, 2);
    assert.ok(links.some((l) => l.to === "acmg-pvs1" && l.predicate === "supersedes"));
    assert.ok(links.some((l) => l.to === "gnomad-frequencies" && l.predicate === STUDY_DEFAULT_LINK_PREDICATE));

    const edges = studyNoteLinkEdges(note);
    assert.equal(edges.length, 2);
    // Dangling is fine: gnomad-frequencies need not exist as a note for the edge to project.
    assert.ok(edges.some((e) => e.from === memoryNodeId("acmg-pm2") && e.to === memoryNodeId("gnomad-frequencies") && e.predicate === "references"));
  });
});
