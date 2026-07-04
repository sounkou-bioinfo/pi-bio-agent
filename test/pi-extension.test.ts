import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import piBioAgentExtension from "../extensions/pi-coding-agent/index.js";
import { openBioStore } from "../src/hosts/bio-store.js";
import { recallSkill } from "../src/hosts/skill-store.js";

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

function loadExtension() {
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
  piBioAgentExtension(pi as any);
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
