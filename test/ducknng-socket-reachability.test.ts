import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";

// The committed artifact behind "every NNG protocol is reachable" (docs/closes-over.md): a real round-trip over a
// BUS socket via ducknng's SQL socket layer (open_socket → listen/dial → send/recv_aio → aio_collect), the exact
// convention the topology demos and ducknng's own conformance test use. Gated on ducknng availability like the
// other ducknng examples (INSTALL ducknng FROM community on a matching DuckDB).
const ducknngAvailable = await (async () => {
  try {
    const c = await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect();
    await c.run("INSTALL ducknng FROM community");
    await c.run("LOAD ducknng");
    return true;
  } catch { return false; }
})();

const hex = (s: string): string => Buffer.from(s, "utf8").toString("hex");

describe("ducknng socket reachability: a BUS round-trip (backs 'verified reachable')", { skip: ducknngAvailable ? false : "ducknng unavailable" }, () => {
  test("open_socket('bus') → listen/dial → send → recv_aio → aio_collect returns the frame", async () => {
    const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
    const c = await inst.connect();
    await c.run("LOAD ducknng");
    const one = async (sql: string) => (await c.runAndReadAll(sql)).getRowObjects()[0] as Record<string, unknown>;
    const url = "ipc:///tmp/ducknng_bus_reach_test.ipc";

    const s1 = String((await one("SELECT (ducknng_open_socket('bus')).socket_id AS id")).id);
    const s2 = String((await one("SELECT (ducknng_open_socket('bus')).socket_id AS id")).id);
    assert.equal((await one(`SELECT (ducknng_listen_socket(${s1}, '${url}', 134217728, 0::UBIGINT)).ok AS ok`)).ok, true);
    assert.equal((await one(`SELECT (ducknng_dial_socket(${s2}, '${url}', 1000, 0::UBIGINT)).ok AS ok`)).ok, true);
    await new Promise((r) => setTimeout(r, 150)); // let the mesh connect

    const recvAio = (await one(`SELECT ducknng_recv_socket_raw_aio(${s1}::UBIGINT, 1500) AS a`)).a as bigint;
    const sendAio = (await one(`SELECT ducknng_send_socket_raw_aio(${s2}::UBIGINT, from_hex('${hex("bus-hello")}'), 1000) AS a`)).a as bigint;
    const sc = await one(`SELECT ok FROM ducknng_aio_collect(list_value(${String(sendAio)}::UBIGINT), 1000)`);
    const rc = await one(`SELECT ok, hex(frame) AS f FROM ducknng_aio_collect(list_value(${String(recvAio)}::UBIGINT), 1500)`);
    await c.run(`SELECT ducknng_close_socket(${s1})`);
    await c.run(`SELECT ducknng_close_socket(${s2})`);
    c.closeSync(); inst.closeSync();

    assert.equal(sc.ok, true, "send collected ok");
    assert.equal(rc.ok, true, "recv collected ok");
    assert.equal(String(rc.f).toLowerCase(), hex("bus-hello"), "the bus peer received the exact frame");
  });
});
