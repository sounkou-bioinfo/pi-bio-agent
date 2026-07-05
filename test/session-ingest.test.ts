import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { materializeBioEdgesAsOf } from "../src/duckdb/observations.js";
import { collectGarbage } from "../src/hosts/gc.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";
import { ingestSessionJsonl, sessionArtifacts, sessionTimeline, sessionToolTrajectory } from "../src/hosts/session-ingest.js";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

async function tmp(prefix: string): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), prefix));
}

async function conn() {
  return duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
}

describe("session JSONL ingestion into the observation ledger", () => {
  test("imports Pi-shaped session JSONL as observations, graph edges, and CAS graphics", async () => {
    const dir = await tmp("pi-bio-session-");
    const sessionFile = join(dir, "session.jsonl");
    const cas = fsCasStore(join(dir, "cas"));
    const c = await conn();
    const toolCallId = "call_plot";
    const lines = [
      { type: "session", id: "s-head", timestamp: "2026-07-05T10:00:00.000Z", cwd: dir },
      { type: "message", id: "u1", timestamp: "2026-07-05T10:00:01.000Z", message: { role: "user", content: "Plot this table" } },
      {
        type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-05T10:00:02.000Z",
        message: {
          role: "assistant", provider: "openai", model: "gpt-test", content: [
            { type: "text", text: "I will call the plotting tool." },
            { type: "toolCall", id: toolCallId, name: "plot", arguments: { table: "counts" } },
          ],
        },
      },
      {
        type: "message", id: "tr1", parentId: "a1", timestamp: "2026-07-05T10:00:03.000Z",
        message: { role: "toolResult", toolCallId, toolName: "plot", isError: false, content: [{ type: "image", mimeType: "image/png", data: PNG_1X1 }] },
      },
    ];
    await fs.writeFile(sessionFile, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

    const out = await ingestSessionJsonl({ conn: c, cas, sessionPath: sessionFile, sessionId: "s1", now: "2026-07-05T10:00:00.000Z", source: "test" });
    assert.equal(out.entries, 4);
    assert.equal(out.messages, 3);
    assert.equal(out.turns, 1);
    assert.equal(out.toolCalls, 1);
    assert.equal(out.artifacts, 1);
    assert.equal(await cas.has({ algorithm: "sha256", digest: out.rawDigest.slice("sha256:".length) }), true, "raw JSONL is in CAS");

    const timeline = await sessionTimeline(c, "s1");
    assert.deepEqual(timeline.map((r) => r.role), ["user", "assistant", "toolResult"]);
    assert.equal(timeline[1]!.provider, "openai");
    assert.equal(timeline[1]!.model, "gpt-test");
    assert.equal(timeline[1]!.parentMessageId, "msg:s1:u1");

    const tools = await sessionToolTrajectory(c, "s1");
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.toolCallId, `toolcall:s1:${toolCallId}`);
    assert.equal(tools[0]!.name, "plot");
    assert.equal(tools[0]!.isError, false);
    assert.match(tools[0]!.argsDigest ?? "", /^sha256:/);
    assert.match(tools[0]!.resultDigest ?? "", /^sha256:/);

    const artifacts = await sessionArtifacts(c, "s1");
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]!.mediaType, "image/png");
    assert.equal(artifacts[0]!.semanticRole, "session_image");
    assert.equal(artifacts[0]!.sourceNode, `toolcall:s1:${toolCallId}`);
    assert.equal(await cas.has({ algorithm: "sha256", digest: artifacts[0]!.digest.slice("sha256:".length) }), true, "image is in CAS");

    await materializeBioEdgesAsOf(c, "2026-07-05T10:00:04.000Z");
    const edges = await c.all<{ from_id: string; predicate: string; to_id: string }>(
      `SELECT from_id, predicate, to_id FROM bio_edges_as_of ORDER BY from_id, predicate, to_id`,
    );
    assert.ok(edges.some((e) => e.from_id === "session:s1" && e.predicate === "has_message" && e.to_id === "msg:s1:a1"));
    assert.ok(edges.some((e) => e.from_id === "session:s1" && e.predicate === "has_turn" && e.to_id === "turn:s1:a1"));
    assert.ok(edges.some((e) => e.from_id === "turn:s1:a1" && e.predicate === "calls" && e.to_id === `toolcall:s1:${toolCallId}`));
    assert.ok(edges.some((e) => e.from_id === `toolcall:s1:${toolCallId}` && e.predicate === "produces" && e.to_id.startsWith("cas:sha256:")));
  });

  test("fails closed on an invalid explicit timestamp", async () => {
    const dir = await tmp("pi-bio-session-badtime-");
    const sessionFile = join(dir, "bad.jsonl");
    await fs.writeFile(sessionFile, `${JSON.stringify({ type: "message", id: "m", timestamp: "not-a-time", message: { role: "user", content: "x" } })}\n`);
    const c = await conn();
    const cas = fsCasStore(join(dir, "cas"));
    await assert.rejects(
      () => ingestSessionJsonl({ conn: c, cas, sessionPath: sessionFile, now: "2026-07-05T10:00:00.000Z" }),
      /DuckDB-castable TIMESTAMPTZ/,
    );
  });

  test("GC roots live session raw JSONL and graphics through ledger facts", async () => {
    const dir = await tmp("pi-bio-session-gc-");
    const sessionFile = join(dir, "session.jsonl");
    const cas = fsCasStore(join(dir, ".pi", "bio-agent", "cas"));
    const c = await conn();
    await fs.writeFile(sessionFile, `${JSON.stringify({
      type: "message", id: "tr", timestamp: "2026-07-05T10:00:00.000Z",
      message: { role: "toolResult", toolCallId: "plot", toolName: "plot", content: [{ type: "image", mimeType: "image/png", data: PNG_1X1 }] },
    })}\n`);
    const out = await ingestSessionJsonl({ conn: c, cas, sessionPath: sessionFile, sessionId: "gc", now: "2026-07-05T10:00:00.000Z" });
    const artifacts = await sessionArtifacts(c, "gc");
    const strayDigest = createHash("sha256").update("stray").digest("hex");
    await cas.put({ algorithm: "sha256", digest: strayDigest }, "stray");

    const result = await collectGarbage(dir, { casRoot: join(dir, ".pi", "bio-agent", "cas"), store: c, minAgeMs: 0 });
    assert.ok(result.casSwept.includes(`sha256/${strayDigest}`));
    assert.equal(await cas.has({ algorithm: "sha256", digest: out.rawDigest.slice("sha256:".length) }), true, "raw session survives");
    assert.equal(await cas.has({ algorithm: "sha256", digest: artifacts[0]!.digest.slice("sha256:".length) }), true, "graphic survives");
  });
});
