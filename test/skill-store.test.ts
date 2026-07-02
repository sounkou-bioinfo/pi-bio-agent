import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import type { SqlConn } from "../src/core/ports.js";
import { createBioObservationSchema } from "../src/duckdb/observations.js";
import { recallSkill, recordSkill, skillHistory } from "../src/hosts/skill-store.js";

const conn = async (): Promise<SqlConn> => {
  const c = duckdbNodeConn(await (await DuckDBInstance.create(":memory:")).connect());
  await createBioObservationSchema(c);
  return c;
};
const T1 = "2026-01-01T00:00:01Z";
const T2 = "2026-01-01T00:00:02Z";

describe("skill-store: skills are temporal + attributed + superseded (like memory)", () => {
  test("re-creating a skill supersedes now but keeps the prior revision as-of, attributed", async () => {
    const c = await conn();
    await recordSkill(c, { name: "hpo-grounding", description: "v1", body: "step one" }, T1, "agent:A");
    await recordSkill(c, { name: "hpo-grounding", description: "v2", body: "step one and two" }, T2, "agent:B");

    const now = await recallSkill(c, "hpo-grounding");
    assert.equal(now?.body, "step one and two");
    assert.equal(now?.author, "agent:B");
    assert.equal((await recallSkill(c, "hpo-grounding", T1))?.body, "step one"); // as-of the first revision

    assert.deepEqual((await skillHistory(c, "hpo-grounding")).map((h) => h.author), ["agent:A", "agent:B"]);
  });

  test("a re-create at the SAME millisecond still deterministically supersedes (monotonic recordedAt)", async () => {
    const c = await conn();
    const SAME = "2026-01-01T00:00:05Z";
    await recordSkill(c, { name: "s", description: "d", body: "old" }, SAME, "agent:A");
    await recordSkill(c, { name: "s", description: "d", body: "new" }, SAME, "agent:B"); // same ms -> must still win
    assert.equal((await recallSkill(c, "s"))?.body, "new", "the re-create supersedes even at an identical wall-clock time");
    assert.equal((await skillHistory(c, "s")).length, 2, "both revisions retained (append-only)");
  });
});
