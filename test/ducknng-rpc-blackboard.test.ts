import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";

// Locks the cross-process BLACKBOARD over ducknng RPC (scripts/blackboard-shared.mjs): publish = run_rpc INSERT,
// await = poll query_rpc SELECT until a SIBLING catalog's publish lands. This is the stigmergic coordination the
// mutate test doesn't cover (there the same client reads its own writes; here an AWAITER blocks on a PUBLISHER's
// write, across separate catalogs = the cross-process case). Deterministic, self-contained (ducknng's own server).
const ducknngAvailable = await (async () => {
  try {
    const c = await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect();
    await c.run("INSTALL ducknng FROM community");
    await c.run("LOAD ducknng");
    return true;
  } catch (error) {
    if (process.env.DUCKNNG_EXTENSION_PATH) throw error;
    return false;
  }
})();

async function conn(): Promise<Awaited<ReturnType<DuckDBInstance["connect"]>>> {
  const c = await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect();
  await c.run("LOAD ducknng");
  return c;
}

describe("ducknng RPC blackboard: cross-process publish/await (the stigmergic coordination)", { skip: ducknngAvailable ? false : "ducknng unavailable" }, () => {
  test("an awaiter in one catalog blocks until a publisher in another catalog writes the slug", async () => {
    // server owns the board + opts exec in
    const server = await conn();
    await server.run("CREATE TABLE board (slug TEXT PRIMARY KEY, note TEXT)");
    await server.run("SELECT ducknng_start_server('bb', 'tcp://127.0.0.1:0', 2, 134217728, 300000, 0::UBIGINT)");
    await server.run("SELECT ducknng_register_exec_method(false)");
    const url = String((await server.runAndReadAll("SELECT listen FROM ducknng_list_servers() WHERE name = 'bb'")).getRows()[0]![0]);

    const publisher = await conn();
    const awaiter = await conn();
    const present = async (slug: string): Promise<boolean> =>
      (await awaiter.runAndReadAll(`SELECT * FROM ducknng_query_rpc('${url}', ?, 0::UBIGINT)`, [`SELECT 1 FROM board WHERE slug = '${slug}'`])).getRows().length > 0;

    // start awaiting BEFORE the publish exists; record when it resolves
    assert.equal(await present("late"), false, "not on the board yet");
    let publishedAt = 0;
    let publishDone: Promise<unknown> = Promise.resolve();
    const awaited = (async () => { while (!(await present("late"))) await new Promise((r) => setTimeout(r, 20)); return Date.now(); })();
    setTimeout(() => {
      publishedAt = Date.now();
      // the awaiter below still RACES this in-flight publish (the stigmergic point), but we CAPTURE the promise and
      // JOIN it before teardown — otherwise ducknng_stop_server can race an in-flight nng_ctx_send and abort the
      // whole process with an nni_panic (ducknng#4: nng_ctx double-release/UAF on close).
      publishDone = publisher.run(`SELECT * FROM ducknng_run_rpc('${url}', ?, 0::UBIGINT)`, ["INSERT INTO board VALUES ('late', 'hello')"]);
    }, 80);

    const resolvedAt = await awaited;
    assert.ok(resolvedAt >= publishedAt, "the awaiter resolved only AFTER the sibling published (it blocked, not raced)");

    // and the published note is readable cross-catalog
    const note = (await awaiter.runAndReadAll(`SELECT * FROM ducknng_query_rpc('${url}', ?, 0::UBIGINT)`, ["SELECT note FROM board WHERE slug = 'late'"])).getRows()[0]![0];
    assert.equal(note, "hello");
    await publishDone; // join the in-flight send before stopping the server (ducknng#4)
    await server.run("SELECT ducknng_stop_server('bb')");
  });
});
