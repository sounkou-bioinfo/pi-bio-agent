import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import piBioAgentExtension from "../extensions/pi-coding-agent/index.js";

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
      "bio_delete_study_note",
      "bio_describe_model",
      "bio_list_duckdb_extensions",
      "bio_list_study_notes",
      "bio_list_tool_specs",
      "bio_read_study_note",
      "bio_run_operation",
      "bio_study_plan",
      "bio_validate_select",
      "bio_write_study_note",
    ]);
  });

  test("safe registry and SQL tools execute through shared core logic", async () => {
    const { tools } = loadExtension();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const listed = await byName.get("bio_list_tool_specs")!.execute("id", { query: "duckdb" });
    assert.ok(listed.details.tools.length > 0);
    const valid = await byName.get("bio_validate_select")!.execute("id", { sql: "SELECT * FROM bio_nodes;" });
    assert.deepEqual(valid.details, { ok: true, sql: "SELECT * FROM bio_nodes" });
    await assert.rejects(() => byName.get("bio_validate_select")!.execute("id", { sql: "DROP TABLE bio_nodes" }), /SELECT/);
  });

  test("study-note and skill tools write project-local files", async () => {
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

    const wrote = await byName.get("bio_write_study_note")!.execute("id", {
      kind: "cheatsheet",
      title: "OpenTargets identifiers",
      hook: "Use before GraphQL evidence queries.",
      body: "Resolve target and disease IDs first.",
      tags: ["opentargets"],
    }, undefined, undefined, ctx);
    assert.equal(wrote.details.note.slug, "opentargets-identifiers");
    const listed = await byName.get("bio_list_study_notes")!.execute("id", { query: "graphql" }, undefined, undefined, ctx);
    assert.equal(listed.details.notes[0].slug, wrote.details.note.slug);
    const read = await byName.get("bio_read_study_note")!.execute("id", { id: "opentargets-identifiers" }, undefined, undefined, ctx);
    assert.equal(read.details.title, "OpenTargets identifiers");

    const deleted = await byName.get("bio_delete_study_note")!.execute("id", { slug: "opentargets-identifiers" }, undefined, undefined, ctx);
    assert.equal(deleted.details.deleted, true);
    await assert.rejects(() => byName.get("bio_read_study_note")!.execute("id", { id: "opentargets-identifiers" }, undefined, undefined, ctx), /no study note/);
  });
});
