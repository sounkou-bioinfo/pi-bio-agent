import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { mainSession } from "../src/cli/session.js";
import { openBioStore } from "../src/hosts/bio-store.js";
import { fsCasStore } from "../src/hosts/fs-cas.js";
import { sessionTimeline } from "../src/hosts/session-ingest.js";

const sink = () => {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
};

describe("session import CLI", () => {
  test("auto-detects a Codex rollout and persists it in the requested store and CAS", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-cli-session-"));
    const sessionPath = join(cwd, "rollout.jsonl");
    const dbPath = join(cwd, "ledger.duckdb");
    const casRoot = join(cwd, "objects");
    await fs.writeFile(sessionPath, `${[
      { timestamp: "2026-07-05T10:00:00.000Z", type: "session_meta", payload: { id: "cli-codex", session_id: "cli-codex", timestamp: "2026-07-05T10:00:00.000Z", cwd, model_provider: "openai" } },
      { timestamp: "2026-07-05T10:00:01.000Z", type: "turn_context", payload: { turn_id: "turn-1", model: "gpt-test" } },
      { timestamp: "2026-07-05T10:00:02.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }], internal_chat_message_metadata_passthrough: { turn_id: "turn-1" } } },
    ].map((line) => JSON.stringify(line)).join("\n")}\n`);

    const out = sink();
    const err = sink();
    const code = await mainSession([
      "import", sessionPath,
      "--db", dbPath,
      "--cas-root", casRoot,
    ], { cwd, out: out.write, err: err.write });
    assert.equal(code, 0, err.lines.join("\n"));
    const result = JSON.parse(out.lines[0]!) as { sessionId: string; format: string; dbPath: string; casRoot: string; rawDigest: string };
    assert.equal(result.sessionId, "cli-codex");
    assert.equal(result.format, "codex");
    assert.equal(result.dbPath, dbPath);
    assert.equal(result.casRoot, casRoot);
    assert.equal(await fsCasStore(casRoot).has({ algorithm: "sha256", digest: result.rawDigest.slice("sha256:".length) }), true);

    const store = await openBioStore(cwd, { path: dbPath });
    try {
      const timeline = await sessionTimeline(store.conn, "cli-codex");
      assert.deepEqual(timeline.map((row) => row.role), ["user"]);
    } finally {
      store.close();
    }
  });

  test("rejects an unknown format before creating the store", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-cli-session-usage-"));
    const err = sink();
    const code = await mainSession(["import", "session.jsonl", "--format", "other"], { cwd, out: sink().write, err: err.write });
    assert.equal(code, 2);
    await assert.rejects(() => fs.stat(join(cwd, ".pi", "bio-agent", "store.duckdb")));
  });

  test("reports a missing source without creating the default store", async () => {
    const cwd = await fs.mkdtemp(join(tmpdir(), "pi-bio-cli-session-missing-"));
    const err = sink();
    const code = await mainSession(["import", "missing.jsonl"], { cwd, out: sink().write, err: err.write });
    assert.equal(code, 1);
    assert.match(err.lines.join("\n"), /source is not readable/);
    await assert.rejects(() => fs.stat(join(cwd, ".pi", "bio-agent", "store.duckdb")));
  });
});
