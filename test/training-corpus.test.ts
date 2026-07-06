import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { createBioObservationSchema, recordObservationLink } from "../src/duckdb/observations.js";
import type { SqlConn } from "../src/core/ports.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";
import { recordArtifactReference } from "../src/hosts/artifacts.js";
import { decideCandidateApproval, submitCandidateForApproval, type OperationCandidate } from "../src/hosts/harness-adaptation.js";
import { recordHostEvent } from "../src/hosts/host-events.js";
import { recordRunObservation } from "../src/hosts/run-observations.js";
import { ingestSessionJsonl } from "../src/hosts/session-ingest.js";
import { exportTrainingCorpusParquet, materializeTrainingCorpus, TRAINING_CORPUS_TABLES } from "../src/hosts/training-corpus.js";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const T0 = "2026-07-06T10:00:00.000Z";
const T1 = "2026-07-06T10:00:01.000Z";
const T2 = "2026-07-06T10:00:02.000Z";
const T3 = "2026-07-06T10:00:03.000Z";
const T4 = "2026-07-06T10:00:04.000Z";
const T5 = "2026-07-06T10:00:05.000Z";

async function tmp(prefix: string): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), prefix));
}

async function conn(): Promise<SqlConn> {
  return duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sha256(bytes: Buffer | string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function seedCorpusLedger(c: SqlConn, root: string): Promise<{ sessionId: string; runId: string }> {
  await createBioObservationSchema(c);
  const cas = fsCasStore(join(root, "cas"));
  const sessionPath = join(root, "session.jsonl");
  const sessionId = "corpus";
  const toolCallId = "call_trace|fc_bio_query";
  const runId = "query-corpus-1";
  await fs.writeFile(sessionPath, `${[
    { type: "session", id: sessionId, timestamp: T0, cwd: root },
    { type: "message", id: "u1", timestamp: T1, message: { role: "user", content: "How many rare high-impact variants?" } },
    {
      type: "message", id: "a1", parentId: "u1", timestamp: T2,
      message: {
        role: "assistant", provider: "openai", model: "gpt-test", content: [
          { type: "text", text: "I will query the manifest." },
          { type: "toolCall", id: toolCallId, name: "bio_query", arguments: { sql: "SELECT count(*) FROM variants" } },
        ],
      },
    },
    {
      type: "message", id: "tr1", parentId: "a1", timestamp: T3,
      message: { role: "toolResult", toolCallId, toolName: "bio_query", isError: false, content: [{ type: "image", mimeType: "image/png", data: PNG_1X1 }] },
    },
  ].map((line) => JSON.stringify(line)).join("\n")}\n`);
  await ingestSessionJsonl({ conn: c, cas, sessionPath, sessionId, source: "test", now: T0 });

  const toolNode = `toolcall:${sessionId}:${toolCallId}`;
  const runNode = `run:${runId}`;
  await recordRunObservation(c, {
    runId,
    kind: "query",
    identity: "ad-hoc.query",
    status: "succeeded",
    sql: "SELECT count(*) AS n FROM variants",
    manifestDigest: `sha256:${"1".repeat(64)}`,
    resultDigest: `sha256:${"2".repeat(64)}`,
    receiptsDigest: `sha256:${"3".repeat(64)}`,
    replayDigest: `sha256:${"4".repeat(64)}`,
  }, T4, "test-runner");
  await recordObservationLink(c, { subjectId: toolNode, predicate: "executes", objectId: runNode, recordedAt: T4, source: "test-runner" });
  await recordObservationLink(c, { subjectId: runNode, predicate: "invoked_by", objectId: toolNode, recordedAt: T4, source: "test-runner" });
  const figureBytes = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><text>rare variants</text></svg>");
  const figureDigest = sha256(figureBytes);
  await cas.put({ algorithm: "sha256", digest: figureDigest.slice("sha256:".length) }, figureBytes);
  await recordArtifactReference(c, {
    artifact: { digest: figureDigest, mediaType: "image/svg+xml", semanticRole: "figure", sizeBytes: figureBytes.length },
    subjectId: runNode,
    predicate: "produces",
    recordedAt: T4,
    source: "test-runner",
    attrs: {
      producer_run: runNode,
      source_digest: `sha256:${"6".repeat(64)}`,
      spec_digest: `sha256:${"7".repeat(64)}`,
      plotting_system: "R/ggplot2",
    },
  });
  await recordHostEvent(c, {
    subjectId: `session:${sessionId}`,
    kind: "workbench.input.steer",
    recordedAt: T4,
    source: "test-host",
    value: { payload_digest: `sha256:${"5".repeat(64)}`, delivery: "mid_turn", private_note: "secret host text" },
    attrs: { channel: "private-ui" },
    links: [{ predicate: "affects", objectId: `turn:${sessionId}:a1` }],
  });

  const candidate: OperationCandidate = {
    id: "double.report",
    version: "1.0.0",
    fixtureSql: "CREATE TABLE nums AS SELECT * FROM (VALUES (1),(2)) AS v(x)",
    sql: "SELECT x, x*2 AS y FROM nums ORDER BY x",
    expected: [{ x: 1, y: 2 }, { x: 2, y: 4 }],
  };
  const sandbox = await conn();
  const sub = await submitCandidateForApproval(c, candidate, { sandbox, recordedAt: T4, source: "ci" });
  await decideCandidateApproval(c, { id: candidate.id, version: candidate.version, specDigest: sub.specDigest, approved: true, decidedAt: T5, source: "approver:alice", approvedBy: "alice" });
  return { sessionId, runId };
}

describe("training corpus export", () => {
  test("materializes a digest-first corpus over sessions, tools, runs, artifacts, events, and judgments", async () => {
    const c = await conn();
    const root = await tmp("pi-bio-corpus-");
    const { sessionId, runId } = await seedCorpusLedger(c, root);
    await c.run(`CREATE TABLE ${TRAINING_CORPUS_TABLES.messages} AS SELECT 'persistent-main-table' AS marker`);

    const receipt = await materializeTrainingCorpus(c, { asOf: "2026-07-06T10:00:06.000Z" });
    assert.equal(receipt.schema, "pi-bio.training_corpus.v1");
    assert.equal(receipt.redaction, "digest_only");
    assert.match(receipt.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(receipt.tables.sessions.rows, 1);
    assert.equal(receipt.tables.messages.rows, 3);
    assert.equal(receipt.tables.turns.rows, 1);
    assert.equal(receipt.tables.toolCalls.rows, 1);
    assert.equal(receipt.tables.runs.rows, 1);
    assert.equal(receipt.tables.artifacts.rows, 3, "the corpus preserves session image refs plus a run-produced artifact");
    assert.ok(receipt.tables.judgments.rows >= 4);
    assert.equal(receipt.tables.hostEvents.rows, 1);
    assert.equal(receipt.tables.units.rows, 1);

    const unit = (await c.all<{ session_node: string; tool_calls: number; linked_runs: number; artifacts: number }>(
      `SELECT session_node, tool_calls, linked_runs, artifacts FROM ${TRAINING_CORPUS_TABLES.units}`,
    ))[0]!;
    assert.equal(unit.session_node, `session:${sessionId}`);
    assert.deepEqual({ toolCalls: unit.tool_calls, linkedRuns: unit.linked_runs, artifacts: unit.artifacts }, { toolCalls: 1, linkedRuns: 1, artifacts: 2 });

    const tool = (await c.all<{ toolcall_node: string; run_node: string; is_error: boolean }>(
      `SELECT toolcall_node, run_node, is_error FROM ${TRAINING_CORPUS_TABLES.toolCalls}`,
    ))[0]!;
    assert.equal(tool.toolcall_node, `toolcall:${sessionId}:call_trace|fc_bio_query`);
    assert.equal(tool.run_node, `run:${runId}`);
    assert.equal(tool.is_error, false);

    const run = (await c.all<{ result_digest: string; receipts_digest: string; invoking_toolcall_node: string }>(
      `SELECT result_digest, receipts_digest, invoking_toolcall_node FROM ${TRAINING_CORPUS_TABLES.runs}`,
    ))[0]!;
    assert.equal(run.result_digest, `sha256:${"2".repeat(64)}`);
    assert.equal(run.receipts_digest, `sha256:${"3".repeat(64)}`);
    assert.equal(run.invoking_toolcall_node, tool.toolcall_node);

    const artifactRelations = await c.all<{ relation: string; n: bigint }>(
      `SELECT relation, count(*) AS n FROM ${TRAINING_CORPUS_TABLES.artifacts} GROUP BY relation ORDER BY relation`,
    );
    assert.deepEqual(artifactRelations.map((r) => [r.relation, Number(r.n)]), [["displays", 1], ["produces", 2]]);
    const figure = (await c.all<{ source_node: string; media_type: string; semantic_role: string; source_digest: string; spec_digest: string; plotting_system: string }>(
      `SELECT source_node, media_type, semantic_role, source_digest, spec_digest, plotting_system
       FROM ${TRAINING_CORPUS_TABLES.artifacts}
       WHERE source_node = ?`,
      [`run:${runId}`],
    ))[0]!;
    assert.deepEqual(figure, {
      source_node: `run:${runId}`,
      media_type: "image/svg+xml",
      semantic_role: "figure",
      source_digest: `sha256:${"6".repeat(64)}`,
      spec_digest: `sha256:${"7".repeat(64)}`,
      plotting_system: "R/ggplot2",
    });

    const messageColumns = await c.all<{ column_name: string }>(`DESCRIBE ${TRAINING_CORPUS_TABLES.messages}`);
    assert.ok(messageColumns.some((c) => c.column_name === "content_digest"));
    assert.equal(messageColumns.some((c) => c.column_name === "content"), false, "corpus table does not inline message text");
    const tableFlags = await c.all<{ temporary: boolean; column_count: bigint }>(
      `SELECT temporary, column_count FROM duckdb_tables() WHERE table_name = ? ORDER BY temporary`,
      [TRAINING_CORPUS_TABLES.messages],
    );
    assert.deepEqual(tableFlags.map((r) => [r.temporary, Number(r.column_count)]), [
      [false, 1],
      [true, messageColumns.length],
    ], "materialization uses temp tables and does not clobber caller tables");

    const hostEventColumns = await c.all<{ column_name: string }>(`DESCRIBE ${TRAINING_CORPUS_TABLES.hostEvents}`);
    assert.equal(hostEventColumns.some((c) => c.column_name === "value_json"), false, "host-event payloads are not exported raw");
    assert.equal(hostEventColumns.some((c) => c.column_name === "attrs"), false, "host-event attrs are not exported raw");
    const hostEventRows = await c.all<Record<string, unknown>>(`SELECT * FROM ${TRAINING_CORPUS_TABLES.hostEvents}`);
    assert.doesNotMatch(JSON.stringify(hostEventRows), /secret host text|private-ui/);
    assert.equal(hostEventRows[0]!.payload_digest, `sha256:${"5".repeat(64)}`);
  });

  test("exports the derived corpus tables as readable Parquet files", async () => {
    const c = await conn();
    const root = await tmp("pi-bio-corpus-parquet-");
    await seedCorpusLedger(c, root);
    const outDir = join(root, "export");

    const receipt = await exportTrainingCorpusParquet(c, outDir, { asOf: "2026-07-06T10:00:06.000Z" });
    for (const table of Object.values(receipt.tables)) {
      assert.ok(table.parquetPath);
      assert.match(table.parquetDigest ?? "", /^sha256:[0-9a-f]{64}$/);
      const rows = await c.all<{ n: bigint }>(`SELECT count(*) AS n FROM read_parquet(${sqlString(table.parquetPath!)})`);
      assert.equal(Number(rows[0]!.n), table.rows);
    }
  });
});
