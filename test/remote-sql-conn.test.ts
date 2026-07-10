import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SqlConn } from "../src/core/ports.js";
import {
  SQL_CONN_HTTP_PATH,
  SQL_CONN_WIRE_SCHEMA,
  createSqlConnHttpClient,
  createSqlConnHttpServer,
  makeSqlConnClient,
} from "../src/hosts/remote-sql-conn.js";
import type { SqlConnWireTransport } from "../src/hosts/remote-sql-conn.js";
import * as hosts from "../src/hosts/index.js";

type SqlCall = { method: "all" | "run"; sql: string; params: readonly unknown[] };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeConn(overrides?: {
  all?: (sql: string, params: readonly unknown[]) => Promise<unknown[]>;
  run?: (sql: string, params: readonly unknown[]) => Promise<void>;
}): { conn: SqlConn; calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  return {
    calls,
    conn: {
      all: async <T>(sql: string, params: readonly unknown[] = []): Promise<T[]> => {
        calls.push({ method: "all", sql, params });
        if (!overrides?.all) return [] as T[];
        return (await overrides.all(sql, params)) as T[];
      },
      run: async (sql, params = []) => {
        calls.push({ method: "run", sql, params });
        if (overrides?.run) await overrides.run(sql, params);
      },
    },
  };
}

describe("remote SQL connection transport", () => {
  const bearerToken = "secret-token";

  test("requires bearer token or policy hook", () => {
    assert.throws(
      () =>
        createSqlConnHttpServer({
          conn: makeConn().conn,
        }),
      /requires bearerToken or authorize callback/i,
    );
  });

  test("preserves SQL, params and exact tuple-encoded object keys", async () => {
    const tricky = Object.create(null) as Record<string, unknown>;
    tricky["__pi_sqlconn_bigint__"] = "marker";
    tricky["__pi_sqlconn_bytes__"] = "marker2";
    Object.defineProperty(tricky, "__proto__", {
      value: "injected",
      enumerable: true,
      configurable: true,
      writable: true,
    });

    const conn = makeConn({
      all: async (sql, params) => [
        {
          ...tricky,
          sql,
          echoed: String(params[0]),
          n: 12345678901234567890n,
          buf: new Uint8Array([1, 2, 3]),
        },
      ],
    });

    const server = await createSqlConnHttpServer({ conn: conn.conn, bearerToken });
    try {
      const client = createSqlConnHttpClient({ endpoint: server.url, bearerToken });
      const value = "x'); DROP TABLE users; --";
      const rows = await client.all<Record<string, unknown>>("SELECT ?", [value]);
      const row = rows[0]!;

      assert.equal(conn.calls.length, 1);
      assert.equal(conn.calls[0]!.sql, "SELECT ?");
      assert.deepEqual(conn.calls[0]!.params, [value]);
      assert.equal(row.echoed, value);
      assert.equal((row as Record<string, unknown>)["__pi_sqlconn_bigint__"], "marker");
      assert.equal((row as Record<string, unknown>)["__pi_sqlconn_bytes__"], "marker2");
      assert.equal((row as Record<string, unknown>).__proto__, "injected");
      assert.equal(row.n, 12_345_678_901_234_567_890n);
      assert.ok(row.buf instanceof Uint8Array && row.buf.length === 3);
    } finally {
      await server.close();
    }
  });

  test("serializes all calls and enforces strict request-id checks", async () => {
    let active = 0;
    let peak = 0;
    const conn = makeConn({
      all: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(40);
        active -= 1;
        return [];
      },
    });

    const server = await createSqlConnHttpServer({ conn: conn.conn, bearerToken });
    try {
      const client = createSqlConnHttpClient({ endpoint: server.url, bearerToken });
      await Promise.all([client.all("SELECT 1"), client.all("SELECT 2"), client.all("SELECT 3")]);
      assert.equal(peak, 1);
      assert.equal(conn.calls.length, 3);

      const mismatch = await fetch(`${server.url}${SQL_CONN_HTTP_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearerToken}`, "content-type": "application/json", "x-request-id": "h1" },
        body: JSON.stringify({ schema: SQL_CONN_WIRE_SCHEMA, requestId: "b1", method: "all", sql: "SELECT 1", params: [] }),
      });
      const mismatchBody = (await mismatch.json()) as { error?: { code: string } };
      assert.equal(mismatch.status, 400);
      assert.equal(mismatchBody.error?.code, "invalid_request");

      const tooLong = await fetch(`${server.url}${SQL_CONN_HTTP_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ schema: SQL_CONN_WIRE_SCHEMA, requestId: "x".repeat(1024), method: "all", sql: "SELECT 1", params: [] }),
      });
      const tooLongBody = (await tooLong.json()) as { error?: { code: string } };
      assert.equal(tooLong.status, 400);
      assert.equal(tooLongBody.error?.code, "invalid_request");
    } finally {
      await server.close();
    }
  });

  test("strict tuple codec rejects malformed tuples", async () => {
    const conn = makeConn();
    const server = await createSqlConnHttpServer({ conn: conn.conn, bearerToken });

    try {
      const badNull = await fetch(`${server.url}${SQL_CONN_HTTP_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ schema: SQL_CONN_WIRE_SCHEMA, requestId: "r1", method: "all", sql: "SELECT 1", params: [["null", 1]] }),
      });
      assert.equal((await badNull.json()).error?.code, "invalid_request");

      const badString = await fetch(`${server.url}${SQL_CONN_HTTP_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ schema: SQL_CONN_WIRE_SCHEMA, requestId: "r2", method: "all", sql: "SELECT 1", params: [["string", "ok", "x"]] }),
      });
      assert.equal((await badString.json()).error?.code, "invalid_request");

      const badPath = await fetch(`${server.url}/bad`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ schema: SQL_CONN_WIRE_SCHEMA, requestId: "r3", method: "all", sql: "SELECT 1", params: [] }),
      });
      assert.equal((await badPath.json()).error?.code, "unknown_path");
    } finally {
      await server.close();
    }
  });

  test("auth, caps, and malformed payload errors are stable", async () => {
    const server = await createSqlConnHttpServer({ conn: makeConn().conn, bearerToken, maxRequestBodyBytes: 64 });

    try {
      const unauthorized = createSqlConnHttpClient({ endpoint: server.url, bearerToken: "wrong" });
      await assert.rejects(() => unauthorized.all("SELECT 1"), /unauthorized/i);

      const tooLarge = createSqlConnHttpClient({ endpoint: server.url, bearerToken, maxRequestBodyBytes: 64 });
      await assert.rejects(() => tooLarge.all("SELECT ?", ["x".repeat(200)]), /payload_too_large|request payload exceeded/);

      const invalidType = await fetch(`${server.url}${SQL_CONN_HTTP_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearerToken}`, "content-type": "text/plain" },
        body: "{}",
      });
      assert.equal(invalidType.status, 415);

      const malformed = await fetch(`${server.url}${SQL_CONN_HTTP_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearerToken}`, "content-type": "application/json" },
        body: "{",
      });
      assert.equal(malformed.status, 400);

      const body = await fetch(`${server.url}${SQL_CONN_HTTP_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ schema: SQL_CONN_WIRE_SCHEMA, requestId: "x", method: "all", sql: "SELECT 1", params: new Array(50).fill("x") }),
      });
      assert.equal(body.status, 413);
      assert.equal((await body.json()).error?.code, "payload_too_large");
    } finally {
      await server.close();
    }
  });

  test("makeSqlConnClient enforces response/request caps and request-id safety", async () => {
    const transport: SqlConnWireTransport = {
      async request() {
        return JSON.stringify({ schema: SQL_CONN_WIRE_SCHEMA, requestId: "ok", method: "all", rows: [["string", "ok"]] });
      },
    };

    const capped = makeSqlConnClient(transport, { maxResponseBodyBytes: 8 });
    await assert.rejects(() => capped.all("SELECT 1"), /response body exceeded 8 bytes/);

    const bad = makeSqlConnClient(transport, { requestId: () => "bad\nid" });
    await assert.rejects(() => bad.run("SELECT 1"), /requestId is not safe/);
  });

  test("hides sql failure by default and exposes mapper output", async () => {
    const secret = "top-secret";
    const conn = makeConn({ all: async () => {
      throw new Error(`execute failed: ${secret}`);
    }});
    const server = await createSqlConnHttpServer({
      conn: conn.conn,
      bearerToken,
      maxResponseBodyBytes: 1024,
    });

    try {
      const client = createSqlConnHttpClient({ endpoint: server.url, bearerToken });
      await assert.rejects(
        () => client.all("SELECT 1"),
        (error) => {
          assert.match(String(error), /sql_error: sql execution failed/i);
          assert.ok(!String(error).includes(secret));
          return true;
        },
      );

      const largeRowsServer = await createSqlConnHttpServer({
        conn: makeConn({
          all: async () => [{ text: "x".repeat(110) }],
        }).conn,
        bearerToken,
      });
      const large = createSqlConnHttpClient({ endpoint: largeRowsServer.url, bearerToken, maxResponseBodyBytes: 80 });
      await assert.rejects(() => large.all("SELECT 1"), /response body exceeded 80 bytes/);
      await largeRowsServer.close();

      const leaking = await createSqlConnHttpServer({
        conn: conn.conn,
        bearerToken,
        mapError: ({ code, cause }) => (code === "sql_error" && cause instanceof Error ? cause.message : undefined),
      });
      await assert.rejects(() => createSqlConnHttpClient({ endpoint: leaking.url, bearerToken }).all("SELECT 1"), (error) =>
        /top-secret/.test(String(error)),
      );
      await leaking.close();
    } finally {
      await server.close();
    }
  });

  test("exports wire-neutral and HTTP API", () => {
    assert.equal(typeof makeSqlConnClient, "function");
    assert.equal(typeof hosts.makeSqlConnClient, "function");
    assert.equal(typeof hosts.createSqlConnHttpClient, "function");
    assert.equal(typeof hosts.createSqlConnHttpServer, "function");
    assert.equal(typeof hosts.SQL_CONN_WIRE_SCHEMA, "string");
    assert.equal(typeof hosts.SQL_CONN_HTTP_PATH, "string");
  });
});
