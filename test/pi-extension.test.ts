import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import piBioAgentExtension, { createBioExtension } from "../extensions/pi-coding-agent/index.js";
import { openBioStore } from "../src/hosts/bio-store.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";
import { sessionArtifacts, sessionTimeline, sessionToolTrajectory } from "../src/hosts/session-ingest.js";
import { recallSkill } from "../src/hosts/skill-store.js";

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

function loadExtension(extension = piBioAgentExtension) {
  const handlers = new Map<string, Function[]>();
  const tools: RegisteredTool[] = [];
  const pi = {
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  };
  extension(pi as any);
  return { handlers, tools };
}

describe("Pi coding-agent extension", () => {
  test("registers resource discovery and the expected safe tools", () => {
    const { handlers, tools } = loadExtension();
    const discover = handlers.get("resources_discover")?.[0];
    assert.ok(discover, "resources_discover handler registered");
    assert.deepEqual(discover!({ cwd: "/work", reason: "startup" }), { skillPaths: ["/work/.pi/bio-agent/skills"] });

    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "bio_create_skill",
      "bio_describe_model",
      "bio_forget",
      "bio_graph_window",
      "bio_list_duckdb_extensions",
      "bio_list_memory",
      "bio_query",
      "bio_recall",
      "bio_remember",
      "bio_run_operation",
      "bio_study_plan",
      "bio_validate_graph_projection",
      "bio_validate_select",
      "bio_walk_memory",
    ]);
  });

  test("Pi session hooks sync the active session JSONL into the project ledger and CAS", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-bio-ext-session-"));
    const sessionFile = join(cwd, "pi-session.jsonl");
    const imageBytes = Buffer.from("fake image bytes");
    const lines = [
      { type: "session", version: 3, id: "pi-dogfood", timestamp: "2026-07-05T11:00:00.000Z", cwd },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-07-05T11:00:01.000Z", message: { role: "user", content: "make a plot" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-05T11:00:02.000Z", message: { role: "assistant", provider: "openai", model: "codex", content: [{ type: "text", text: "Plotting." }, { type: "toolCall", id: "tc1", name: "plot", arguments: { chart: "bar" } }] } },
      { type: "message", id: "t1", parentId: "a1", timestamp: "2026-07-05T11:00:03.000Z", message: { role: "toolResult", toolCallId: "tc1", toolName: "plot", isError: false, content: [{ type: "image", mimeType: "image/png", data: imageBytes.toString("base64") }] } },
    ];
    await writeFile(sessionFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

    const { handlers } = loadExtension(createBioExtension({ author: "agent:test" }));
    const sessionManager = {
      getSessionFile: () => sessionFile,
      getSessionId: () => "pi-dogfood",
    };
    const ctx = { cwd, sessionManager };

    const start = handlers.get("session_start")?.[0];
    assert.ok(start, "session_start handler registered");
    await start!({ type: "session_start", reason: "startup" }, ctx);
    const compact = handlers.get("session_compact")?.[0];
    assert.ok(compact, "session_compact handler registered");
    await compact!({ type: "session_compact", reason: "manual" }, ctx);
    const shutdown = handlers.get("session_shutdown")?.[0];
    assert.ok(shutdown, "session_shutdown handler registered");
    await shutdown!({ type: "session_shutdown", reason: "quit" }, ctx);

    const store = await openBioStore(cwd);
    let rawDigest = "";
    try {
      assert.deepEqual((await sessionTimeline(store.conn, "pi-dogfood")).map((row) => row.role), ["user", "assistant", "toolResult"]);
      const trajectory = await sessionToolTrajectory(store.conn, "pi-dogfood");
      assert.equal(trajectory[0]!.name, "plot");
      assert.equal(trajectory[0]!.isError, false);
      const artifacts = await sessionArtifacts(store.conn, "pi-dogfood");
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0]!.mediaType, "image/png");
      const sessionRows = await store.conn.all<{ value_json: string }>("SELECT value_json FROM bio_observations WHERE subject_id = 'session:pi-dogfood' AND predicate = 'session'");
      assert.equal(sessionRows.length, 1);
      rawDigest = (JSON.parse(sessionRows[0]!.value_json) as { raw_digest: string }).raw_digest;
    } finally {
      store.close();
    }

    const cas = fsCasStore(join(cwd, ".pi", "bio-agent", "cas"));
    assert.equal(await cas.has({ algorithm: "sha256", digest: rawDigest.slice("sha256:".length) }), true);
  });

  test("Pi session hooks merge distributed resume through an injected shared store and CAS", async () => {
    const shared = await mkdtemp(join(tmpdir(), "pi-bio-ext-shared-"));
    const machineA = await mkdtemp(join(tmpdir(), "pi-bio-ext-machine-a-"));
    const machineB = await mkdtemp(join(tmpdir(), "pi-bio-ext-machine-b-"));
    const sessionId = "dist-session";
    const sessionA = join(machineA, "session.jsonl");
    const sessionB = join(machineB, "session.jsonl");
    const user = { type: "message", id: "u1", parentId: null, timestamp: "2026-07-05T12:00:01.000Z", message: { role: "user", content: "continue elsewhere" } };
    const assistant = { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-05T12:00:02.000Z", message: { role: "assistant", provider: "openai", model: "codex", content: [{ type: "text", text: "continued" }, { type: "toolCall", id: "tc1", name: "bio_query", arguments: { sql: "SELECT 1" } }] } };
    const tool = { type: "message", id: "t1", parentId: "a1", timestamp: "2026-07-05T12:00:03.000Z", message: { role: "toolResult", toolCallId: "tc1", toolName: "bio_query", isError: false, content: "ok" } };
    await writeFile(sessionA, `${[
      { type: "session", version: 3, id: sessionId, timestamp: "2026-07-05T12:00:00.000Z", cwd: machineA },
      user,
    ].map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
    await writeFile(sessionB, `${[
      { type: "session", version: 3, id: sessionId, timestamp: "2026-07-05T12:00:00.000Z", cwd: machineB },
      user,
      assistant,
      tool,
    ].map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

    const cas = fsCasStore(join(shared, "cas"));
    const openSharedStore = () => openBioStore(shared);
    const extension = createBioExtension({ author: "agent:distributed", openStore: openSharedStore, cas });
    const runShutdown = async (cwd: string, sessionFile: string) => {
      const { handlers } = loadExtension(extension);
      const shutdown = handlers.get("session_shutdown")?.[0];
      assert.ok(shutdown, "session_shutdown handler registered");
      await shutdown!({ type: "session_shutdown", reason: "quit" }, {
        cwd,
        sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => sessionId },
      });
    };

    await runShutdown(machineA, sessionA);
    await runShutdown(machineB, sessionB);

    const store = await openBioStore(shared);
    let rawDigest = "";
    try {
      assert.deepEqual((await sessionTimeline(store.conn, sessionId)).map((row) => row.role), ["user", "assistant", "toolResult"]);
      assert.equal((await sessionToolTrajectory(store.conn, sessionId))[0]!.name, "bio_query");
      const latestSession = await store.conn.all<{ value_json: string }>(
        `SELECT value_json FROM bio_observations
         WHERE subject_id = 'session:dist-session' AND predicate = 'session'
         ORDER BY recorded_at::TIMESTAMPTZ DESC, observation_id DESC LIMIT 1`,
      );
      const latestValue = JSON.parse(latestSession[0]!.value_json) as { entries: number; raw_digest: string };
      assert.equal(latestValue.entries, 4);
      rawDigest = latestValue.raw_digest;
    } finally {
      store.close();
    }
    assert.equal(await cas.has({ algorithm: "sha256", digest: rawDigest.slice("sha256:".length) }), true);
  });

  test("bio tools link their session tool call to the scientific run ledger", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-bio-ext-tool-run-"));
    const sessionFile = join(cwd, "session.jsonl");
    const manifestPath = join(cwd, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      schema: "pi-bio.manifest.v1",
      id: "tool-run-link",
      version: "0.1.0",
      title: "Tool/run link",
      description: "Resource-free manifest for trace-link testing.",
      provides: {},
    }), "utf8");
    const sessionManager = {
      getSessionFile: () => sessionFile,
      getSessionId: () => "trace-session",
    };
    const ctx = { cwd, sessionManager };
    const toolCallId = "call_trace_session|fc_bio_query_01";
    const { handlers, tools } = loadExtension(createBioExtension({ author: "agent:test" }));
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const result = await byName.get("bio_query")!.execute(toolCallId, {
      dbPath: ":memory:",
      manifestPath,
      sql: "SELECT 1 AS answer",
      runId: "trace-run",
    }, undefined, undefined, ctx);
    assert.equal(result.details.ok, true, result.details.ok ? "" : result.details.error);

    await writeFile(sessionFile, `${[
      { type: "session", version: 3, id: "trace-session", timestamp: "2026-07-05T14:00:00.000Z", cwd },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-07-05T14:00:01.000Z", message: { role: "user", content: "run the query" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-05T14:00:02.000Z", message: { role: "assistant", provider: "openai", model: "codex", content: [{ type: "toolCall", id: toolCallId, name: "bio_query", arguments: { dbPath: ":memory:", manifestPath, sql: "SELECT 1 AS answer", runId: "trace-run" } }] } },
      { type: "message", id: "tr1", parentId: "a1", timestamp: "2026-07-05T14:00:03.000Z", message: { role: "toolResult", toolCallId, toolName: "bio_query", isError: false, content: result.content } },
    ].map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
    const shutdown = handlers.get("session_shutdown")?.[0];
    assert.ok(shutdown, "session_shutdown handler registered");
    await shutdown!({ type: "session_shutdown", reason: "quit" }, ctx);

    const store = await openBioStore(cwd);
    try {
      const edges = await store.conn.all<{ subject_id: string; predicate: string; object_id: string | null }>(
        `SELECT subject_id, predicate, object_id FROM bio_observations
         WHERE object_id = 'run:trace-run' OR subject_id = 'run:trace-run'
         ORDER BY subject_id, predicate`,
      );
      assert.ok(edges.some((edge) => edge.subject_id === `toolcall:trace-session:${toolCallId}` && edge.predicate === "executes"));
      assert.ok(edges.some((edge) => edge.subject_id === "run:trace-run" && edge.predicate === "invoked_by" && edge.object_id === `toolcall:trace-session:${toolCallId}`));
      const runRows = await store.conn.all<{ value_json: string | null }>(
        "SELECT value_json FROM bio_observations WHERE subject_id = 'run:trace-run' AND predicate = 'run'",
      );
      assert.equal(runRows.length, 1, "the linked target is the real run ledger fact");
    } finally {
      store.close();
    }
  });

  test("Pi session start records fork parentage from lifecycle metadata when the header lacks it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-bio-ext-fork-parent-"));
    const sessionFile = join(cwd, "child.jsonl");
    const parentFile = join(cwd, "parent.jsonl");
    await writeFile(parentFile, `${JSON.stringify({ type: "session", version: 3, id: "parent-session", timestamp: "2026-07-05T12:00:00.000Z", cwd })}\n`, "utf8");
    await writeFile(sessionFile, `${[
      { type: "session", version: 3, id: "child-session", timestamp: "2026-07-05T12:30:00.000Z", cwd },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-07-05T12:30:01.000Z", message: { role: "user", content: "forked" } },
    ].map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
    const { handlers } = loadExtension(createBioExtension({ author: "agent:test" }));
    const ctx = {
      cwd,
      sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "child-session" },
    };
    const start = handlers.get("session_start")?.[0];
    assert.ok(start, "session_start handler registered");
    await start!({
      type: "session_start",
      reason: "fork",
      previousSessionFile: parentFile,
    }, ctx);
    const shutdown = handlers.get("session_shutdown")?.[0];
    assert.ok(shutdown, "session_shutdown handler registered");
    await shutdown!({ type: "session_shutdown", reason: "quit" }, ctx);

    const store = await openBioStore(cwd);
    try {
      const edges = await store.conn.all<{ object_id: string | null }>(
        "SELECT object_id FROM bio_observations WHERE subject_id = 'session:child-session' AND predicate = 'parent_session'",
      );
      assert.ok(edges.some((edge) => edge.object_id === "session:parent-session"));
    } finally {
      store.close();
    }
  });

  test("Pi session hooks reject injected stores without an injected CAS", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-bio-ext-no-cas-"));
    const sessionFile = join(cwd, "session.jsonl");
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "no-cas", timestamp: "2026-07-05T13:00:00.000Z", cwd })}\n`, "utf8");
    let openCalled = false;
    const { handlers } = loadExtension(createBioExtension({
      openStore: async () => {
        openCalled = true;
        return openBioStore(cwd);
      },
    }));
    const shutdown = handlers.get("session_shutdown")?.[0];
    assert.ok(shutdown, "session_shutdown handler registered");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      await shutdown!({ type: "session_shutdown", reason: "quit" }, {
        cwd,
        sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "no-cas" },
      });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(openCalled, false);
    assert.match(warnings.join("\n"), /explicit CAS/);
  });

  test("safe registry and SQL tools execute through shared core logic", async () => {
    const { tools } = loadExtension();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const extensions = await byName.get("bio_list_duckdb_extensions")!.execute("id", { query: "duckhts" });
    assert.ok(extensions.details.extensions.length > 0);
    const valid = await byName.get("bio_validate_select")!.execute("id", { sql: "SELECT * FROM bio_nodes;" });
    assert.deepEqual(valid.details, { ok: true, sql: "SELECT * FROM bio_nodes" });
    await assert.rejects(() => byName.get("bio_validate_select")!.execute("id", { sql: "DROP TABLE bio_nodes" }), /SELECT/);
    const projection = await byName.get("bio_validate_graph_projection")!.execute("id", { profile: {
      schema: "pi-bio.graph_projection_profile.v1",
      id: "edge-raw",
      title: "Edge raw projection",
      source: { kind: "semantic_sql", table: "edge_raw" },
      columns: { from: "subject", predicate: "predicate", to: "object" },
    } });
    assert.equal(projection.details.valid, true);
    assert.match(projection.details.sql, /CREATE OR REPLACE TABLE "bio_edges"/);
  });

  test("host-protected session bindings are not tool params: bio_query cannot read them, declared operations can", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-bio-ext-protected-"));
    const manifestPath = join(cwd, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      schema: "pi-bio.manifest.v1",
      id: "pi-protected-session",
      version: "0.1.0",
      title: "Pi protected session",
      description: "Host-owned protected session binding regression.",
      provides: {
        operations: [{
          id: "host_auth.read",
          version: "0.1.0",
          title: "Host auth read",
          description: "Declared operation intentionally consumes host protected state.",
          transport: "duckdb.sql",
          inputSchema: { type: "object" },
          sql: { sqlTemplate: "SELECT getvariable('api_token') AS token", readOnly: true },
        }],
      },
    }), "utf8");

    const { tools } = loadExtension(createBioExtension({
      protectedSessionBindings: { api_token: "Bearer pi-token" },
    }));
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const ctx = { cwd };

    await assert.rejects(
      () => byName.get("bio_query")!.execute("id", {
        dbPath: ":memory:",
        manifestPath,
        sql: "SELECT getvariable('api_token') AS token",
        runId: "pi-protected-query",
      }, undefined, undefined, ctx),
      /protected session variables.*getvariable\('api_token'\)/,
    );

    const op = await byName.get("bio_run_operation")!.execute("id", {
      dbPath: ":memory:",
      manifestPath,
      operationId: "host_auth.read",
      runId: "pi-protected-operation",
    }, undefined, undefined, ctx);
    assert.equal(op.details.ok, true, op.details.ok ? "" : op.details.error);
    const result = JSON.parse(await readFile(join(op.details.runDir, "result.json"), "utf8")) as { rows: Array<{ token: string }> };
    assert.equal(result.rows[0]!.token, "Bearer pi-token");
    const replayText = await readFile(join(op.details.runDir, "replay.json"), "utf8");
    assert.doesNotMatch(replayText, /pi-token/, "protected binding value must not leak into replay.json through Pi");
  });

  test("memory and skill tools persist to the store + a legible file view", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-bio-ext-"));
    const { tools } = loadExtension();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const ctx = { cwd };

    const skill = await byName.get("bio_create_skill")!.execute("id", {
      name: "hpo-grounding",
      description: "Ground phenotypes to HPO terms.",
      body: "# HPO grounding\n\nNormalize terms before evidence collection.",
    }, undefined, undefined, ctx);
    assert.match(await readFile(skill.details.path, "utf8"), /name: hpo-grounding/);

    // #4 ORDER: validate → record → materialize. Invalid input must reach NEITHER the ledger nor a SKILL.md, so a
    // ledger-write failure can never leave an orphan behavior-changing file (and a bad input never pollutes the ledger).
    await assert.rejects(() => byName.get("bio_create_skill")!.execute("id", { name: "NOT-kebab", description: "d", body: "b" }, undefined, undefined, ctx), /kebab/);
    const badStore = await openBioStore(cwd);
    try {
      assert.equal(await recallSkill(badStore.conn, "NOT-kebab"), null, "invalid skill never reached the append-only ledger (validated before recordSkill)");
    } finally { badStore.close(); }

    // #4: bio_list_memory rejects an invalid limit (negative/fractional) rather than doing a surprising slice()
    await assert.rejects(() => byName.get("bio_list_memory")!.execute("id", { limit: -1 }, undefined, undefined, ctx), /non-negative integer/);
    await assert.rejects(() => byName.get("bio_list_memory")!.execute("id", { limit: 1.5 }, undefined, undefined, ctx), /non-negative integer/);
    await assert.rejects(() => byName.get("bio_graph_window")!.execute("id", {
      table: "entailed_edge_as_of",
      startId: "agent:memory:opentargets-identifiers",
    }, undefined, undefined, ctx), /transitivePredicates is required/);

    const wrote = await byName.get("bio_remember")!.execute("id", {
      kind: "cheatsheet",
      title: "OpenTargets identifiers",
      hook: "Use before GraphQL evidence queries.",
      body: "Resolve target and disease IDs first. See [[opentargets-target-node]].",
      tags: ["opentargets"],
    }, undefined, undefined, ctx);
    await byName.get("bio_remember")!.execute("id", {
      kind: "concept_map",
      title: "OpenTargets target node",
      hook: "Use when traversing OpenTargets target concept links.",
      body: "Target concept node.",
      tags: ["opentargets"],
    }, undefined, undefined, ctx);
    assert.equal(wrote.details.note.slug, "opentargets-identifiers");
    // written to the ONE store (attributed) AND materialized as a legible file view
    assert.equal(wrote.details.stored, "agent:memory:opentargets-identifiers");
    assert.match(await readFile(wrote.details.materialized, "utf8"), /opentargets-identifiers/);
    const listed = await byName.get("bio_list_memory")!.execute("id", { query: "graphql" }, undefined, undefined, ctx);
    assert.equal(listed.details.notes[0].slug, wrote.details.note.slug);
    const read = await byName.get("bio_recall")!.execute("id", { id: "opentargets-identifiers" }, undefined, undefined, ctx);
    assert.equal(read.details.title, "OpenTargets identifiers");
    const graphWindow = await byName.get("bio_graph_window")!.execute("id", {
      startId: "agent:memory:opentargets-identifiers",
      direction: "out",
      predicates: ["references"],
      limit: 10,
    }, undefined, undefined, ctx);
    assert.equal(graphWindow.details.rows.length, 1);
    assert.equal(graphWindow.details.rows[0].to_id, "agent:memory:opentargets-target-node");

    // forget = temporal retraction: gone from recall(now), but the store keeps the history
    const forgotten = await byName.get("bio_forget")!.execute("id", { slug: "opentargets-identifiers" }, undefined, undefined, ctx);
    assert.equal(forgotten.details.forgotten, true);
    await assert.rejects(() => byName.get("bio_recall")!.execute("id", { id: "opentargets-identifiers" }, undefined, undefined, ctx), /no memory/);
  });
});
