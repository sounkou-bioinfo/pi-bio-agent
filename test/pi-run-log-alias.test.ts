import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createBioExtension } from "../extensions/pi-coding-agent/index.js";
import { openBioStore } from "../src/hosts/bio-store.js";

interface RegisteredTool {
  name: string;
  execute: (...args: any[]) => Promise<any>;
}

function loadTools(extension: ReturnType<typeof createBioExtension>): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  extension({
    on() {
      // This regression exercises only the bio_query tool.
    },
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
  } as any);
  return tools;
}

describe("Pi run-log ownership fallback", () => {
  test("a custom file store aliasing the scientific db is closed and retried unlogged before execution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-run-log-alias-"));
    const dbPath = join(cwd, "scientific-and-ledger.duckdb");
    const manifestPath = join(cwd, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({
      schema: "pi-bio.manifest.v1",
      id: "run-log-alias",
      version: "0.1.0",
      title: "Run-log alias",
      description: "Resource-free fixture for the custom-store alias fallback.",
      provides: {},
    }), "utf8");

    const tools = loadTools(createBioExtension({
      openStore: (invocationCwd) => openBioStore(invocationCwd, { path: dbPath }),
    }));
    const query = tools.find((tool) => tool.name === "bio_query");
    assert.ok(query, "bio_query tool registered");

    const result = await query.execute("tool-call", {
      dbPath,
      manifestPath,
      sql: "SELECT 1 AS answer",
      runId: "custom-store-alias-run",
    }, undefined, undefined, { cwd });

    assert.equal(result.details.ok, true, result.details.ok ? "" : result.details.error);
    assert.deepEqual(result.details.result.rows, [{ answer: 1 }]);

    const store = await openBioStore(cwd, { path: dbPath });
    try {
      const rows = await store.conn.all<{ n: bigint }>(
        "SELECT count(*) AS n FROM bio_observations WHERE subject_id = 'run:custom-store-alias-run'",
      );
      assert.equal(Number(rows[0]?.n ?? 0), 0, "the retry succeeds without writing evidence into the scientific catalog");
    } finally {
      store.close();
    }
  });
});
