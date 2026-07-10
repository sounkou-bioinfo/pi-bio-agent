import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import type { CasStore } from "../src/core/cas.js";
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
      { type: "session", id: "s-head", timestamp: "2026-07-05T10:00:00.000Z", cwd: dir, parentSession: join(dir, "2026-07-05T09-00-00-000Z_parent-session.jsonl") },
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

    const out = await ingestSessionJsonl({ conn: c, cas, casMetadata: { conn: c, nowMs: 1_783_249_200_000 }, sessionPath: sessionFile, sessionId: "s1", parentSessionId: "parent-session", now: "2026-07-05T10:00:00.000Z", source: "test" });
    assert.equal(out.entries, 4);
    assert.equal(out.messages, 3);
    assert.equal(out.turns, 1);
    assert.equal(out.toolCalls, 1);
    assert.equal(out.artifacts, 1);
    assert.equal(await cas.has({ algorithm: "sha256", digest: out.rawDigest.slice("sha256:".length) }), true, "raw JSONL is in CAS");
    const rawRefs = await c.all<{ digest: string }>(
      "SELECT digest FROM cas_ref WHERE ref_id = 'session:s1' AND ref_type = 'session_raw'",
    );
    assert.deepEqual(rawRefs.map((row) => row.digest), [out.rawDigest.slice("sha256:".length)], "the successful session roots its raw bytes in shared-CAS metadata");

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
    assert.ok(edges.some((e) => e.from_id === "session:s1" && e.predicate === "parent_session" && e.to_id === "session:parent-session"));
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

  test("does not root an empty raw snapshot when the fallback clock is invalid", async () => {
    const dir = await tmp("pi-bio-session-bad-fallback-");
    const sessionFile = join(dir, "empty.jsonl");
    await fs.writeFile(sessionFile, "");
    const c = await conn();
    const cas = fsCasStore(join(dir, "cas"));
    await assert.rejects(
      () => ingestSessionJsonl({ conn: c, cas, casMetadata: { conn: c, nowMs: 1 }, sessionPath: sessionFile, now: "not-a-time" }),
      /non-DuckDB-castable TIMESTAMPTZ/,
    );
    const metadataTables = await c.all<{ n: bigint }>(
      "SELECT count(*) AS n FROM information_schema.tables WHERE table_name IN ('cas_object', 'cas_ref')",
    );
    assert.equal(Number(metadataTables[0]!.n), 0);
    assert.equal(Number((await c.all<{ n: bigint }>("SELECT count(*) AS n FROM bio_observations WHERE predicate = 'session'"))[0]!.n), 0);
  });

  test("normalizes the immutable CAS snapshot when a live source is appended after capture", async () => {
    const dir = await tmp("pi-bio-session-live-snapshot-");
    const sessionFile = join(dir, "live.jsonl");
    const original = `${JSON.stringify({ type: "session", id: "live", timestamp: "2026-07-05T10:00:00.000Z" })}\n`;
    await fs.writeFile(sessionFile, original);
    const inner = fsCasStore(join(dir, "cas"));
    const cas: CasStore = {
      ...inner,
      async putFile(path) {
        const stored = await inner.putFile(path);
        await fs.appendFile(path, `${JSON.stringify({ type: "message", id: "late", timestamp: "2026-07-05T10:00:01.000Z", message: { role: "user", content: "arrived later" } })}\n`);
        return stored;
      },
    };
    const c = await conn();
    const out = await ingestSessionJsonl({ conn: c, cas, casMetadata: { conn: c, nowMs: 1_783_249_200_000 }, sessionPath: sessionFile, source: "test" });
    assert.equal(out.entries, 1);
    assert.equal(out.messages, 0);
    assert.equal(out.rawDigest, `sha256:${createHash("sha256").update(original).digest("hex")}`);
    assert.deepEqual(await sessionTimeline(c, "live"), []);
    const second = await ingestSessionJsonl({ conn: c, cas, casMetadata: { conn: c, nowMs: 1_783_249_201_000 }, sessionPath: sessionFile, source: "test" });
    const refs = await c.all<{ digest: string }>("SELECT digest FROM cas_ref WHERE ref_id = 'session:live' AND ref_type = 'session_raw'");
    assert.deepEqual(refs.map((row) => row.digest), [second.rawDigest.slice("sha256:".length)], "a live re-sync replaces the prior raw-snapshot root");
  });

  test("uses the terminal session fact as a completion marker and resumes idempotently after a malformed later line", async () => {
    const dir = await tmp("pi-bio-session-rollback-");
    const sessionFile = join(dir, "partial.jsonl");
    const validLines = [
      JSON.stringify({ type: "session", id: "partial", timestamp: "2026-07-05T10:00:00.000Z" }),
      ...Array.from({ length: 300 }, (_, i) => JSON.stringify({
        type: "message",
        id: `u${i}`,
        timestamp: `2026-07-05T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
        message: { role: "user", content: `message ${i}` },
      })),
    ];
    await fs.writeFile(sessionFile, [
      ...validLines,
      "{malformed",
      "",
    ].join("\n"));
    const c = await conn();
    const cas = fsCasStore(join(dir, "cas"));
    await assert.rejects(
      () => ingestSessionJsonl({ conn: c, cas, casMetadata: { conn: c, nowMs: 1_783_249_200_000 }, sessionPath: sessionFile, source: "test" }),
      /invalid JSON at line 302/,
    );
    const partial = await c.all<{ predicate: string; n: bigint }>(
      "SELECT predicate, count(*) AS n FROM bio_observations GROUP BY predicate ORDER BY predicate",
    );
    assert.ok(partial.reduce((n, row) => n + Number(row.n), 0) > 0, "completed batches remain as durable checkpoints");
    assert.equal(partial.find((row) => row.predicate === "session"), undefined, "no terminal completion marker was written");
    const metadataTables = await c.all<{ n: bigint }>(
      "SELECT count(*) AS n FROM information_schema.tables WHERE table_name IN ('cas_object', 'cas_ref')",
    );
    assert.equal(Number(metadataTables[0]!.n), 0, "a failed import does not root the private raw transcript");

    await fs.writeFile(sessionFile, `${validLines.join("\n")}\n`);
    const out = await ingestSessionJsonl({ conn: c, cas, casMetadata: { conn: c, nowMs: 1_783_249_201_000 }, sessionPath: sessionFile, source: "test" });
    assert.equal(out.entries, validLines.length);
    const completed = await c.all<{ predicate: string; n: bigint }>(
      `SELECT predicate, count(*) AS n FROM bio_observations
       WHERE predicate IN ('session', 'session_entry') GROUP BY predicate ORDER BY predicate`,
    );
    assert.deepEqual(completed.map((row) => [row.predicate, Number(row.n)]), [["session", 1], ["session_entry", validLines.length]]);
    const rawRefs = await c.all<{ digest: string }>("SELECT digest FROM cas_ref WHERE ref_id = 'session:partial' AND ref_type = 'session_raw'");
    assert.deepEqual(rawRefs.map((row) => row.digest), [out.rawDigest.slice("sha256:".length)]);
  });

  test("imports Codex rollout JSONL through the same message, turn, tool, compaction, graph, and CAS contract", async () => {
    const dir = await tmp("pi-bio-codex-session-");
    const sessionFile = join(dir, "rollout.jsonl");
    const cas = fsCasStore(join(dir, "cas"));
    const c = await conn();
    const sessionId = "codex-session-1";
    const turnId = "codex-turn-1";
    const lines = [
      { timestamp: "2026-07-05T10:00:00.000Z", type: "session_meta", payload: { id: sessionId, session_id: sessionId, timestamp: "2026-07-05T10:00:00.000Z", cwd: dir, model_provider: "openai", parent_thread_id: "codex-parent" } },
      { timestamp: "2026-07-05T10:00:01.000Z", type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      { timestamp: "2026-07-05T10:00:02.000Z", type: "turn_context", payload: { turn_id: turnId, model: "gpt-test", effort: "high", cwd: dir } },
      { timestamp: "2026-07-05T10:00:03.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the ledger" }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
      { timestamp: "2026-07-05T10:00:04.000Z", type: "response_item", payload: { type: "message", id: "assistant-comment", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "I am checking it." }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
      { timestamp: "2026-07-05T10:00:05.000Z", type: "response_item", payload: { type: "function_call", id: "fc-1", call_id: "call-1", name: "exec_command", arguments: JSON.stringify({ cmd: "duckdb store.duckdb '.tables'" }), internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
      { timestamp: "2026-07-05T10:00:06.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "call-1", output: "bio_observations" } },
      { timestamp: "2026-07-05T10:00:06.100Z", type: "response_item", payload: { type: "web_search_call", id: "web-1", call_id: "web-1", status: "completed", action: { type: "search", query: "DuckDB JSON" } } },
      { timestamp: "2026-07-05T10:00:06.200Z", type: "response_item", payload: { type: "web_search_output", id: "web-1", call_id: "web-1", output: { results: 2 } } },
      { timestamp: "2026-07-05T10:00:07.000Z", type: "compacted", payload: { message: "Retain the ledger result", replacement_history: [{ type: "message", role: "user" }], window_number: 2, first_window_id: "window-1", previous_window_id: "window-1", window_id: "window-2" } },
      { timestamp: "2026-07-05T10:00:08.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: "I found the table." } },
    ];
    const raw = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
    await fs.writeFile(sessionFile, raw);

    await assert.rejects(
      () => ingestSessionJsonl({ conn: c, cas, sessionPath: sessionFile, format: "pi", source: "test" }),
      /format pi does not match.*detected codex/,
    );
    const out = await ingestSessionJsonl({ conn: c, cas, sessionPath: sessionFile, source: "test" });
    assert.equal(out.format, "codex");
    assert.equal(out.sessionId, sessionId);
    assert.equal(out.entries, lines.length);
    assert.equal(out.messages, 6);
    assert.equal(out.turns, 3, "each assistant response item is a normalized turn; host turn id remains metadata");
    assert.equal(out.toolCalls, 2);
    assert.equal(out.rawDigest, `sha256:${createHash("sha256").update(raw).digest("hex")}`);
    assert.equal(await cas.has({ algorithm: "sha256", digest: out.rawDigest.slice("sha256:".length) }), true);

    const timeline = await sessionTimeline(c, sessionId);
    assert.deepEqual(timeline.map((row) => row.role), ["user", "assistant", "assistant", "toolResult", "assistant", "toolResult"]);
    assert.equal(timeline[1]!.provider, "openai");
    assert.equal(timeline[1]!.model, "gpt-test");

    const tools = await sessionToolTrajectory(c, sessionId);
    assert.equal(tools.length, 2);
    const execTool = tools.find((tool) => tool.toolCallId === `toolcall:${sessionId}:call-1`)!;
    assert.equal(execTool.name, "exec_command");
    assert.match(execTool.argsDigest ?? "", /^sha256:/);
    assert.match(execTool.resultDigest ?? "", /^sha256:/);
    const webTool = tools.find((tool) => tool.toolCallId === `toolcall:${sessionId}:web-1`)!;
    assert.equal(webTool.name, "web_search_call");
    assert.match(webTool.argsDigest ?? "", /^sha256:/);
    assert.match(webTool.resultDigest ?? "", /^sha256:/);

    const facts = await c.all<{ predicate: string; value_json: string | null }>(
      `SELECT predicate, value_json FROM bio_observations
       WHERE (subject_id = ? AND predicate IN ('raw_jsonl', 'session'))
          OR (subject_id LIKE ? AND predicate IN ('compaction', 'custom_entry'))
       ORDER BY predicate`,
      [`session:${sessionId}`, `entry:${sessionId}:%`],
    );
    const rawFact = facts.find((row) => row.predicate === "raw_jsonl");
    assert.equal(JSON.parse(rawFact!.value_json!).format, "codex-rollout-jsonl");
    assert.ok(facts.some((row) => row.predicate === "compaction"));
    assert.ok(facts.some((row) => row.predicate === "custom_entry"));

    await materializeBioEdgesAsOf(c, "2026-07-05T10:00:09.000Z");
    const edges = await c.all<{ from_id: string; predicate: string; to_id: string }>(
      `SELECT from_id, predicate, to_id FROM bio_edges_as_of
       WHERE from_id IN (?, ?) ORDER BY from_id, predicate, to_id`,
      [`session:${sessionId}`, `turn:${sessionId}:codex-call-1-call`],
    );
    assert.ok(edges.some((edge) => edge.from_id === `session:${sessionId}` && edge.predicate === "parent_session" && edge.to_id === "session:codex-parent"));
    assert.ok(edges.some((edge) => edge.from_id === `session:${sessionId}` && edge.predicate === "has_turn" && edge.to_id === `turn:${sessionId}:codex-call-1-call`));
    assert.ok(edges.some((edge) => edge.from_id === `turn:${sessionId}:codex-call-1-call` && edge.predicate === "calls" && edge.to_id === `toolcall:${sessionId}:call-1`));
    const rawAttrs = await c.all<{ attrs: string | null }>(
      "SELECT attrs FROM bio_observations WHERE subject_id = ? AND predicate = 'raw_jsonl'",
      [`session:${sessionId}`],
    );
    assert.deepEqual(JSON.parse(rawAttrs[0]!.attrs!), { session_id: sessionId }, "shared ledger attrs do not leak the host-local source path");
  });

  test("finds Codex session identity and parentage when session_meta follows an initial Codex record", async () => {
    const dir = await tmp("pi-bio-codex-late-meta-");
    const sessionFile = join(dir, "rollout.jsonl");
    const cas = fsCasStore(join(dir, "cas"));
    const c = await conn();
    await fs.writeFile(sessionFile, `${[
      { timestamp: "2026-07-05T10:00:00.000Z", type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-test" } },
      { timestamp: "2026-07-05T10:00:01.000Z", type: "session_meta", payload: { id: "late-meta", parent_thread_id: "parent-late", model_provider: "openai" } },
      { timestamp: "2026-07-05T10:00:02.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
    ].map((line) => JSON.stringify(line)).join("\n")}\n`);
    const out = await ingestSessionJsonl({ conn: c, cas, sessionPath: sessionFile, source: "test" });
    assert.equal(out.sessionId, "late-meta");
    await materializeBioEdgesAsOf(c, "2026-07-05T10:00:03.000Z");
    const parent = await c.all<{ to_id: string }>(
      "SELECT to_id FROM bio_edges_as_of WHERE from_id = 'session:late-meta' AND predicate = 'parent_session'",
    );
    assert.deepEqual(parent.map((row) => row.to_id), ["session:parent-late"]);
  });

  test("session snapshot facts are idempotent across host clocks when JSONL content is unchanged", async () => {
    const dir = await tmp("pi-bio-session-idem-");
    const sessionFile = join(dir, "session.jsonl");
    const cas = fsCasStore(join(dir, "cas"));
    const c = await conn();
    await fs.writeFile(sessionFile, `${JSON.stringify({ type: "session", id: "idem", timestamp: "2026-07-05T10:00:00.000Z", cwd: dir })}\n${JSON.stringify({
      type: "message", id: "u1", timestamp: "2026-07-05T10:00:01.000Z",
      message: { role: "user", content: "same bytes" },
    })}\n`);

    await ingestSessionJsonl({ conn: c, cas, sessionPath: sessionFile, sessionId: "idem", now: "2026-07-05T11:00:00.000Z", source: "test" });
    await ingestSessionJsonl({ conn: c, cas, sessionPath: sessionFile, sessionId: "idem", now: "2026-07-05T12:00:00.000Z", source: "test" });

    const rows = await c.all<{ predicate: string; n: bigint }>(
      `SELECT predicate, count(*) AS n FROM bio_observations
       WHERE subject_id = 'session:idem' AND predicate IN ('raw_jsonl', 'session')
       GROUP BY predicate ORDER BY predicate`,
    );
    assert.deepEqual(rows.map((r) => [r.predicate, Number(r.n)]), [["raw_jsonl", 1], ["session", 1]]);
  });

  test("does not infer run links by scanning arbitrary tool text", async () => {
    const dir = await tmp("pi-bio-session-no-run-scan-");
    const sessionFile = join(dir, "session.jsonl");
    const cas = fsCasStore(join(dir, "cas"));
    const c = await conn();
    await fs.writeFile(sessionFile, `${[
      { type: "session", id: "no-scan", timestamp: "2026-07-05T10:00:00.000Z", cwd: dir },
      { type: "message", id: "a1", timestamp: "2026-07-05T10:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "tc", name: "read", arguments: { path: "fixture.json" } }] } },
      { type: "message", id: "r1", timestamp: "2026-07-05T10:00:02.000Z", message: { role: "toolResult", toolCallId: "tc", toolName: "read", isError: false, content: "{\"run_id\":\"phantom\"}" } },
    ].map((line) => JSON.stringify(line)).join("\n")}\n`);

    await ingestSessionJsonl({ conn: c, cas, sessionPath: sessionFile, now: "2026-07-05T10:00:00.000Z", source: "test" });

    const rows = await c.all<{ n: bigint }>(
      "SELECT count(*) AS n FROM bio_observations WHERE object_id = 'run:phantom' OR subject_id = 'run:phantom'",
    );
    assert.equal(Number(rows[0]!.n), 0);
  });

  test("projects compaction and Pi custom session entries as graph observations", async () => {
    const dir = await tmp("pi-bio-session-control-");
    const sessionFile = join(dir, "session.jsonl");
    const cas = fsCasStore(join(dir, "cas"));
    const c = await conn();
    await fs.writeFile(sessionFile, `${[
      { type: "session", id: "control", timestamp: "2026-07-05T10:00:00.000Z", cwd: dir },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-07-05T10:00:01.000Z", message: { role: "user", content: "start" } },
      { type: "custom_message", id: "cm1", parentId: "u1", timestamp: "2026-07-05T10:00:02.000Z", customType: "other-extension.steer-note", content: "steer accepted", display: true, details: { delivery: "steer" } },
      { type: "custom", id: "c1", parentId: "cm1", timestamp: "2026-07-05T10:00:03.000Z", customType: "other-extension.audit", data: { event: "transformed-input" } },
      { type: "model_change", id: "m1", parentId: "c1", timestamp: "2026-07-05T10:00:04.000Z", provider: "openai", modelId: "gpt-test" },
      { type: "thinking_level_change", id: "th1", parentId: "m1", timestamp: "2026-07-05T10:00:05.000Z", thinkingLevel: "high" },
      { type: "label", id: "l1", parentId: "th1", timestamp: "2026-07-05T10:00:06.000Z", targetId: "u1", label: "important" },
      { type: "session_info", id: "si1", parentId: "l1", timestamp: "2026-07-05T10:00:07.000Z", name: "Control session" },
      { type: "compaction", id: "k1", parentId: "si1", timestamp: "2026-07-05T10:00:08.000Z", summary: "Kept start", firstKeptEntryId: "u1", tokensBefore: 1234, fromHook: false, details: { reason: "manual" } },
      { type: "branch_summary", id: "b1", parentId: "k1", timestamp: "2026-07-05T10:00:09.000Z", fromId: "u1", summary: "Branch summary", fromHook: true, details: { target: "u1" } },
    ].map((line) => JSON.stringify(line)).join("\n")}\n`);

    const out = await ingestSessionJsonl({ conn: c, cas, sessionPath: sessionFile, sessionId: "control", now: "2026-07-05T10:00:00.000Z", source: "test" });
    assert.equal(out.entries, 10);
    assert.equal(out.messages, 2);

    const timeline = await sessionTimeline(c, "control");
    assert.deepEqual(timeline.map((row) => row.role), ["user", "custom"]);

    const facts = await c.all<{ predicate: string; subject_id: string; value_json: string | null }>(
      `SELECT predicate, subject_id, value_json FROM bio_observations
       WHERE subject_id LIKE 'entry:control:%'
         AND predicate IN ('compaction', 'branch_summary', 'custom_entry', 'model_change', 'thinking_level_change', 'label', 'session_info')
       ORDER BY predicate`,
    );
    assert.deepEqual(facts.map((row) => row.predicate).sort(), [
      "branch_summary",
      "compaction",
      "custom_entry",
      "label",
      "model_change",
      "session_info",
      "thinking_level_change",
    ]);
    const compaction = facts.find((row) => row.predicate === "compaction");
    assert.equal(JSON.parse(compaction!.value_json!).first_kept_entry, "entry:control:u1");

    await materializeBioEdgesAsOf(c, "2026-07-05T10:00:10.000Z");
    const edges = await c.all<{ from_id: string; predicate: string; to_id: string }>(
      `SELECT from_id, predicate, to_id FROM bio_edges_as_of
       WHERE from_id = 'session:control' OR from_id IN ('entry:control:k1', 'entry:control:b1', 'entry:control:l1')
       ORDER BY from_id, predicate, to_id`,
    );
    assert.ok(edges.some((e) => e.from_id === "session:control" && e.predicate === "has_custom_message" && e.to_id === "msg:control:cm1"));
    assert.ok(edges.some((e) => e.from_id === "session:control" && e.predicate === "has_custom_entry" && e.to_id === "entry:control:c1"));
    assert.ok(edges.some((e) => e.from_id === "session:control" && e.predicate === "has_compaction" && e.to_id === "entry:control:k1"));
    assert.ok(edges.some((e) => e.from_id === "entry:control:k1" && e.predicate === "first_kept_entry" && e.to_id === "entry:control:u1"));
    assert.ok(edges.some((e) => e.from_id === "entry:control:b1" && e.predicate === "summarizes_from" && e.to_id === "entry:control:u1"));
    assert.ok(edges.some((e) => e.from_id === "entry:control:l1" && e.predicate === "labels" && e.to_id === "entry:control:u1"));
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
