import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { defineBioOperationSpec, operationSpecIndex, registryFromOperations, validateBioOperationSpec, type BioOperationSpec } from "../src/core/operation-spec.js";
import { contentAddressUri, isContentAddressUri } from "../src/core/resources.js";
import { appendRunEvent, defineBioRunSpec, newRunRecord, validateBioRunSpec, type BioRunSpec } from "../src/core/run-spec.js";
import { bioProjectLayout, casPathForAddress, validateContentAddress } from "../src/core/storage.js";
import { makeConceptNode, validateReadOnlySelect } from "../src/core/knowledge-graph.js";
import { deriveStudyPlan, memoryNodeId, parseStudyNoteLinks, studyNoteGraph, studyNoteIndex, studyNoteLinkEdges, studyNoteNode, validateStudyNote, STUDY_DEFAULT_LINK_PREDICATE, type StudyNote } from "../src/core/study.js";

const validOperation: BioOperationSpec = {
  id: "variants.classify",
  version: "0.1.0",
  title: "Classify variants",
  description: "Classify resolved variants over DuckDB.",
  transport: "duckdb.sql",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  identifiers: [{ name: "query", namespace: "free_text", required: true }],
  sql: { sqlTemplate: "SELECT variant_key FROM annotated_variants", readOnly: true, requiredResources: ["annotated_variants"] },
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
      transport: validOperation.transport,
    }]);
  });

  test("reports malformed operation specs without throwing", () => {
    const errors = validateBioOperationSpec({ id: "Bad Operation", transport: "graphql" } as unknown as BioOperationSpec);
    assert.ok(errors.some((e) => e.includes("id must be lowercase")));
    assert.ok(errors.includes("inputSchema is required"));
    assert.ok(errors.includes("transport must be duckdb.sql"));
  });

  test("requires sql details and enforces read-only", () => {
    const missingSql = validateBioOperationSpec({ ...validOperation, sql: undefined });
    assert.ok(missingSql.includes("a duckdb.sql operation requires sql request details"));
    const notReadOnly = validateBioOperationSpec({ ...validOperation, sql: { sqlTemplate: "SELECT 1", readOnly: false as true } });
    assert.ok(notReadOnly.includes("sql.readOnly must be true"));
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
    const errors = validateBioRunSpec({ schema: "x", id: "bad id with spaces", mode: "" } as unknown as BioRunSpec);
    assert.ok(errors.includes("schema must be pi-bio.run_spec.v1"));
    assert.ok(errors.some((e) => e.includes("id is required")));
    assert.ok(errors.includes("tool.name is required"));
    assert.ok(errors.includes("mode is invalid"));
    assert.ok(errors.includes("inputs array is required"));
  });

  test("fail closed: a non-string sql.sqlTemplate is a validation error, not a TypeError on .trim()", () => {
    const errs = validateBioOperationSpec({ ...validOperation, sql: { sqlTemplate: 1 as unknown as string, readOnly: true, requiredResources: [] } });
    assert.ok(errs.includes("sql.sqlTemplate is required"), "a non-string template fails closed cleanly");
  });

  test("open type labels: BioRunMode accepts any host/backend vocabulary; the run STATUS stays a closed machine", () => {
    // mode is an OPEN host label — a public user's backend vocabulary must validate, not be gatekept to 5 words
    for (const mode of ["slurm", "k8s", "aws-batch", "modal", "nng-worker", "local-daemon"]) {
      assert.deepEqual(validateBioRunSpec({ ...validRun, mode }), [], `mode '${mode}' must validate`);
    }
    assert.ok(validateBioRunSpec({ ...validRun, mode: "" } as unknown as BioRunSpec).includes("mode is invalid"), "empty mode still fails closed");
    // BioRunStatus stays CLOSED (the state machine branches on it): appendRunEvent drives status transitions
    const rec = newRunRecord(validRun, "2026-07-01T00:00:00Z");
    const started = appendRunEvent(rec, { type: "started", at: "2026-07-01T00:00:01Z" });
    assert.equal(started.status, "running", "started -> running is the closed lifecycle, not an open label");
  });

  test("open descriptive labels: BioArtifact.role accepts real-world roles (nothing branches on it)", () => {
    for (const role of ["index", "sidecar", "qc_plot", "checkpoint", "coverage_track", "html_report"]) {
      const artifact = { kind: "artifact" as const, role, path: `out/${role}` };
      assert.equal(artifact.role, role); // constructs + type-checks with an arbitrary role
    }
  });

  test("CAS is sha256-only at the type AND uri level", () => {
    assert.equal(isContentAddressUri(`cas:sha256:${"a".repeat(64)}`), true);
    assert.equal(isContentAddressUri("cas:sha256:abc"), false, "a short/malformed digest is rejected — parity with validateContentAddress (64 hex)");
    assert.equal(isContentAddressUri(`cas:sha512:${"a".repeat(128)}`), false, "sha512 uri rejected — the store backs only sha256");
    assert.equal(isContentAddressUri(`cas:blake3:${"a".repeat(64)}`), false);
    assert.ok(validateContentAddress({ algorithm: "sha512", digest: "0".repeat(128) } as unknown as import("../src/core/resources.js").ContentAddress).includes("algorithm must be sha256"));
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

describe("Content-address URIs", () => {
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
    const base = { schema: "pi-bio.study_note.v1", slug: "ok", id: "i", kind: "cheatsheet", title: "T", hook: "Read it later.", body: "b", tags: [], sources: [], createdAt: "t", updatedAt: "t" };
    assert.ok(validateStudyNote({ ...base, links: [{ to: "Bad Slug" }] } as unknown as StudyNote).some((e) => e.includes("each link")));
    // A KG-evidence predicate like `supersedes` is not a note-navigation predicate and must be rejected.
    assert.ok(validateStudyNote({ ...base, links: [{ to: "other-note", predicate: "supersedes" }] } as unknown as StudyNote).some((e) => e.includes("each link")));
    assert.deepEqual(validateStudyNote({ ...base, links: [{ to: "other-note", predicate: "depends_on" }] } as unknown as StudyNote), []);
  });

  test("parses and projects note links: dedup, dangling-tolerant, body + explicit field", () => {
    const note = {
      slug: "acmg-pm2",
      body: "See [[gnomad-frequencies]] and again [[gnomad-frequencies]]; also [[Not A Slug]] is ignored.",
      links: [{ to: "acmg-pvs1", predicate: "depends_on" as const }, { to: "gnomad-frequencies" }],
    };
    const links = parseStudyNoteLinks(note);
    // explicit (acmg-pvs1/depends_on), explicit (gnomad-frequencies/references), body (gnomad-frequencies/references dedup) -> 2 unique
    assert.equal(links.length, 2);
    assert.ok(links.some((l) => l.to === "acmg-pvs1" && l.predicate === "depends_on"));
    assert.ok(links.some((l) => l.to === "gnomad-frequencies" && l.predicate === STUDY_DEFAULT_LINK_PREDICATE));

    const edges = studyNoteLinkEdges(note);
    assert.equal(edges.length, 2);
    // Dangling is fine: gnomad-frequencies need not exist as a note for the edge to project.
    assert.ok(edges.some((e) => e.from === memoryNodeId("acmg-pm2") && e.to === memoryNodeId("gnomad-frequencies") && e.predicate === "references"));

    // Defensive: a bogus predicate from unvalidated input falls back to the default, not a junk edge.
    const coerced = parseStudyNoteLinks({ body: "", links: [{ to: "x", predicate: "supersedes" as unknown as undefined }] });
    assert.deepEqual(coerced, [{ to: "x", predicate: "references" }]);

    // memoryNodeId rejects non-slug input rather than minting memory:<garbage>.
    assert.throws(() => memoryNodeId("Bad Slug"), /invalid memory slug/);
  });

  test("parseStudyNoteLinks tolerates malformed input and agrees with the validator", () => {
    assert.deepEqual(parseStudyNoteLinks(null), []);
    assert.deepEqual(parseStudyNoteLinks("not an object"), []);
    // "Bad Slug" is a string but not a slug: the parser skips it rather than rewriting to "bad-slug",
    // so it agrees with validateStudyNote (which rejects the same link).
    const messy = { body: 42, links: [null, "nope", { to: 7 }, { to: "Bad Slug" }, { to: "good-note" }] };
    assert.deepEqual(parseStudyNoteLinks(messy), [{ to: "good-note", predicate: STUDY_DEFAULT_LINK_PREDICATE }]);
  });

  test("projects notes into a memory-family graph snapshot", () => {
    const notes = [
      { schema: "pi-bio.study_note.v1", slug: "acmg-pm2", id: "a", kind: "cheatsheet", title: "ACMG PM2", hook: "Read on rare-variant calls.", body: "See [[gnomad-frequencies]].", tags: ["acmg"], sources: [], createdAt: "t", updatedAt: "t" },
      { schema: "pi-bio.study_note.v1", slug: "gnomad-frequencies", id: "b", kind: "cheatsheet", title: "gnomAD freqs", hook: "Read before AF filters.", body: "x", tags: [], sources: [], createdAt: "t", updatedAt: "t" },
    ] as StudyNote[];

    const node = studyNoteNode(notes[0]);
    assert.equal(node.id, memoryNodeId("acmg-pm2"));
    assert.equal(node.family, "memory");
    assert.equal(node.description, "Read on rare-variant calls.");

    const graph = studyNoteGraph(notes);
    assert.equal(graph.schema, "pi-bio.graph_snapshot.v1");
    assert.deepEqual(graph.nodes.map((n) => n.id), [memoryNodeId("acmg-pm2"), memoryNodeId("gnomad-frequencies")]);
    assert.equal(graph.edges.length, 1);
    assert.deepEqual(graph.edges[0], { from: memoryNodeId("acmg-pm2"), to: memoryNodeId("gnomad-frequencies"), predicate: "references" });
  });
});
