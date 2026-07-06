import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DuckDBInstance } from "@duckdb/node-api";
import { duckdbNodeConn } from "../src/duckdb/node-api.js";
import { DUCKNNG_HTTP_PROFILE_RECEIPT_SCHEMA, ducknngHttpProfileSubjectsAvailable, ducknngHttpProfilesAvailable, registerDucknngHttpProfile } from "../src/duckdb/http-profiles.js";

const ducknngExtensionPath = process.env.DUCKNNG_EXTENSION_PATH;
const ducknngLoadSql = ducknngExtensionPath ? `LOAD '${ducknngExtensionPath.replace(/'/g, "''")}'` : "LOAD ducknng";

// The SQL-native HTTP path uses a local ducknng HTTP server as the fixture, so these tests exercise the same
// SQL table functions without external network or injected fetch.
const ducknngAvailable = await (async () => {
  try {
    const c = await (await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" })).connect();
    if (!ducknngExtensionPath) await c.run("INSTALL ducknng FROM community");
    await c.run(ducknngLoadSql);
    return true;
  } catch { return false; }
})();

describe("SQL-native HTTP grounding via ducknng (a local ducknng server is the deterministic fixture)", { skip: ducknngAvailable ? false : "ducknng unavailable (provision: INSTALL ducknng FROM community on a matching DuckDB)" }, () => {
  test("server serves JSON -> ncurl_table fetches+parses -> agent grounds, all SQL, no external network", async () => {
    const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
    const conn = duckdbNodeConn(await inst.connect());
    await conn.run(ducknngLoadSql);

    // FIXTURE: a ducknng HTTP server serving a canned OLS4-shaped search response from a SQL route handler.
    // Bind port 0 (OS-assigned) and DISCOVER the real port via ducknng_list_servers — a fixed port races under
    // parallel test runs / TIME_WAIT.
    await conn.run(`SELECT ducknng_start_server('ols_fixture', 'http://127.0.0.1:0/_ducknng', 1, 134217728, 300000, 0::UBIGINT)`);
    const BASE = (await conn.all<{ listen: string }>("SELECT listen FROM ducknng_list_servers() WHERE name='ols_fixture'"))[0]!.listen.replace(/\/_ducknng.*$/, "");
    await conn.run(`SELECT ducknng_register_http_route('ols_fixture', 'GET', '/search', 'SELECT * FROM ducknng_http_json(200, ''[{"obo_id":"MONDO:0004979","label":"asthma"},{"obo_id":"MONDO:0004784","label":"allergic asthma"}]'')')`);

    // the AGENT supplies the query as a session variable; the url composes it in SQL (getvariable + url_encode);
    // ncurl_table fetches the LOCAL server and parses the JSON to a table; the grounding is one SQL line.
    await conn.run("SET VARIABLE query = 'asthma'");
    const rows = await conn.all<{ obo_id: string; label: string }>(
      `SELECT obo_id, label FROM ducknng_ncurl_table('${BASE}/search?q=' || url_encode(getvariable('query')), 'GET', NULL, NULL, 5000, 0::UBIGINT) WHERE lower(label) = getvariable('query')`,
    );
    assert.deepEqual(rows, [{ obo_id: "MONDO:0004979", label: "asthma" }]); // exact-match grounding over the fetched table

    // a DIFFERENT query composes a different URL from the SAME route — it's SQL, not a hardcoded term
    await conn.run("SET VARIABLE query = 'allergic asthma'");
    const url2 = await conn.all<{ u: string }>(`SELECT '${BASE}/search?q=' || url_encode(getvariable('query')) AS u`);
    assert.match(url2[0]!.u, /q=allergic%20asthma$/, "url_encode composed the new query in SQL");

    inst.closeSync(); // tears down the server
  });

  test("host-commissioned HTTP profile injects auth without exposing the token to SQL", async (t) => {
    const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
    const conn = duckdbNodeConn(await inst.connect());
    await conn.run(ducknngLoadSql);
    if (!(await ducknngHttpProfilesAvailable(conn))) {
      inst.closeSync();
      t.skip("ducknng HTTP profiles unavailable in this build");
      return;
    }

    await conn.run(`SELECT ducknng_start_server('auth_fixture', 'http://127.0.0.1:0/_ducknng', 1, 134217728, 300000, 0::UBIGINT)`);
    const BASE = (await conn.all<{ listen: string }>("SELECT listen FROM ducknng_list_servers() WHERE name='auth_fixture'"))[0]!.listen.replace(/\/_ducknng.*$/, "");
    const baseUrl = new URL(BASE);
    await conn.run(`SELECT ducknng_register_http_route('auth_fixture', 'GET', '/secure',
      'SELECT * FROM ducknng_http_json(
        CASE WHEN ducknng_http_header(''authorization'') = ''Bearer host-token'' THEN 200 ELSE 401 END,
        json_array(json_object(''ok'', ducknng_http_header(''authorization'') = ''Bearer host-token''))::VARCHAR
      )')`);

    // The host commissions the profile on this connection. The agent-visible SQL below receives only the
    // non-secret profile id; ducknng resolves the secret after URL/method scope checks and before send.
    const profileReceipt = await registerDucknngHttpProfile(conn, {
      profileId: "auth-fixture-profile",
      scheme: "http",
      host: "127.0.0.1",
      port: Number(baseUrl.port),
      pathPrefix: "/secure",
      method: "GET",
      authHeaderName: "Authorization",
      authHeaderValue: "Bearer host-token",
    });
    assert.equal(profileReceipt.schema, DUCKNNG_HTTP_PROFILE_RECEIPT_SCHEMA);
    assert.equal(profileReceipt.profileId, "auth-fixture-profile");
    assert.deepEqual(profileReceipt.authHeaderNames, ["Authorization"]);
    assert.deepEqual(profileReceipt.scope, {
      scheme: "http",
      host: "127.0.0.1",
      port: Number(baseUrl.port),
      pathPrefix: "/secure",
      method: "GET",
      tlsRequired: false,
    });
    assert.match(profileReceipt.policyDigest, /^sha256:[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(profileReceipt), /host-token|Bearer/i, "profile receipt never exposes the token value");

    const rows = await conn.all<{ ok: boolean }>(
      `SELECT ok FROM ducknng_ncurl_table(
        '${BASE}/secure',
        'GET',
        NULL,
        NULL,
        5000,
        0::UBIGINT,
        'auth-fixture-profile'
      )`,
    );
    assert.deepEqual(rows, [{ ok: true }]);
    const listed = await conn.all<{ auth_header_names_json: string; token_absent: boolean }>(
      `SELECT auth_header_names_json,
              position('host-token' IN profile_id || scheme || host || path_prefix || method || auth_header_names_json) = 0 AS token_absent
       FROM ducknng_list_http_profiles()
       WHERE profile_id = 'auth-fixture-profile'`,
    );
    assert.deepEqual(listed, [{ auth_header_names_json: "[\"Authorization\"]", token_absent: true }]);
    await assert.rejects(() => conn.all(
      `SELECT * FROM ducknng_ncurl_table('${BASE}/secure', 'GET', NULL, NULL, 5000, 0::UBIGINT)`,
    ), /HTTP status 401/);
    await assert.rejects(() => conn.all(
      `SELECT * FROM ducknng_ncurl_table('${BASE}/securez', 'GET', NULL, NULL, 5000, 0::UBIGINT, 'auth-fixture-profile')`,
    ), /HTTP profile scope rejected URL path/);

    inst.closeSync();
  });

  test("subject-restricted HTTP profiles fail closed outside a ducknng execution subject", async (t) => {
    const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
    const conn = duckdbNodeConn(await inst.connect());
    await conn.run(ducknngLoadSql);
    if (!(await ducknngHttpProfileSubjectsAvailable(conn))) {
      inst.closeSync();
      t.skip("ducknng subject-restricted HTTP profiles unavailable in this build");
      return;
    }

    await conn.run(`SELECT ducknng_start_server('subject_auth_fixture', 'http://127.0.0.1:0/_ducknng', 1, 134217728, 300000, 0::UBIGINT)`);
    const BASE = (await conn.all<{ listen: string }>("SELECT listen FROM ducknng_list_servers() WHERE name='subject_auth_fixture'"))[0]!.listen.replace(/\/_ducknng.*$/, "");
    const baseUrl = new URL(BASE);
    await conn.run(`SELECT ducknng_register_http_route('subject_auth_fixture', 'GET', '/secure',
      'SELECT * FROM ducknng_http_json(200, ''[{"sent":true}]'')'
    )`);

    const restrictedReceipt = await registerDucknngHttpProfile(conn, {
      profileId: "subject-auth-fixture-profile",
      scheme: "http",
      host: "127.0.0.1",
      port: Number(baseUrl.port),
      pathPrefix: "/secure",
      method: "GET",
      authHeaderName: "Authorization",
      authHeaderValue: "Bearer host-token",
      allowSubjects: ["alice"],
    });
    assert.equal(restrictedReceipt.subjectRestriction.restricted, true);
    assert.equal(restrictedReceipt.subjectRestriction.count, 1);
    assert.match(restrictedReceipt.subjectRestriction.digest ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(restrictedReceipt), /alice|host-token|Bearer/i, "receipt records only a subject-list digest and never token values");

    const listed = await conn.all<{ allow_subjects_json: string | null }>(
      `SELECT allow_subjects_json FROM ducknng_list_http_profiles()
       WHERE profile_id = 'subject-auth-fixture-profile'`,
    );
    assert.deepEqual(listed, [{ allow_subjects_json: "[\"alice\"]" }]);
    await assert.rejects(() => conn.all(
      `SELECT * FROM ducknng_ncurl_table('${BASE}/secure', 'GET', NULL, NULL, 5000, 0::UBIGINT, 'subject-auth-fixture-profile')`,
    ), /admission rejected/);

    inst.closeSync();
  });

  test("MCP-style initialize captures a session header and tools/list threads it through ncurl", async () => {
    const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
    const conn = duckdbNodeConn(await inst.connect());
    await conn.run(ducknngLoadSql);

    await conn.run(`SELECT ducknng_start_server('mcp_fixture', 'http://127.0.0.1:0/_ducknng', 1, 134217728, 300000, 0::UBIGINT)`);
    const BASE = (await conn.all<{ listen: string }>("SELECT listen FROM ducknng_list_servers() WHERE name='mcp_fixture'"))[0]!.listen.replace(/\/_ducknng.*$/, "");
    await conn.run(`SELECT ducknng_register_http_route('mcp_fixture', 'POST', '/mcp',
      'SELECT * FROM ducknng_http_response(
         CASE
           WHEN json_extract_string((SELECT body_text FROM ducknng_http_request_body()), ''$.method'') = ''initialize'' THEN 200
           WHEN json_extract_string((SELECT body_text FROM ducknng_http_request_body()), ''$.method'') = ''tools/list'' AND ducknng_http_header(''mcp-session-id'') = ''session-1'' THEN 200
           ELSE 401
         END,
         ducknng_http_headers_build([''Mcp-Session-Id''], [''session-1'']),
         ''application/json'',
         NULL::BLOB,
         CASE
           WHEN json_extract_string((SELECT body_text FROM ducknng_http_request_body()), ''$.method'') = ''initialize'' THEN json_object(''jsonrpc'', ''2.0'', ''id'', 1, ''result'', json_object(''protocolVersion'', ''2025-06-18''))::VARCHAR
           WHEN json_extract_string((SELECT body_text FROM ducknng_http_request_body()), ''$.method'') = ''tools/list'' AND ducknng_http_header(''mcp-session-id'') = ''session-1'' THEN json_object(''jsonrpc'', ''2.0'', ''id'', 2, ''result'', json_object(''tools'', json_array(json_object(''name'', ''echo''))))::VARCHAR
           ELSE json_object(''jsonrpc'', ''2.0'', ''id'', 2, ''error'', json_object(''code'', -32001, ''message'', ''missing session''))::VARCHAR
         END
       )')`);

    await conn.run(`SET VARIABLE mcp_url = '${BASE}/mcp'`);
    await conn.run(`CREATE TEMP TABLE mcp_initialize AS
      SELECT * FROM ducknng_ncurl(
        getvariable('mcp_url')::VARCHAR,
        'POST',
        ducknng_http_headers_build(['Content-Type','Accept'], ['application/json','application/json']),
        json_object('jsonrpc','2.0','id',1,'method','initialize')::VARCHAR::BLOB,
        5000,
        0::UBIGINT
      )`);
    await conn.run(`SET VARIABLE mcp_session_id = (
      SELECT ducknng_http_headers_get(headers_json, 'Mcp-Session-Id') FROM mcp_initialize WHERE status = 200
    )`);
    const session = await conn.all<{ sid: string }>("SELECT getvariable('mcp_session_id')::VARCHAR AS sid");
    assert.equal(session[0]!.sid, "session-1");

    const tools = await conn.all<{ name: string }>(`SELECT unnest(result.tools).name AS name
      FROM ducknng_ncurl_table(
        getvariable('mcp_url')::VARCHAR,
        'POST',
        ducknng_http_headers_build(
          ['Content-Type','Accept','Mcp-Session-Id'],
          ['application/json','application/json', getvariable('mcp_session_id')::VARCHAR]
        ),
        json_object('jsonrpc','2.0','id',2,'method','tools/list')::VARCHAR::BLOB,
        5000,
        0::UBIGINT
      )`);
    assert.deepEqual(tools, [{ name: "echo" }]);
    await assert.rejects(() => conn.all(`SELECT * FROM ducknng_ncurl_table(
      getvariable('mcp_url')::VARCHAR,
      'POST',
      ducknng_http_headers_build(['Content-Type','Accept'], ['application/json','application/json']),
      json_object('jsonrpc','2.0','id',2,'method','tools/list')::VARCHAR::BLOB,
      5000,
      0::UBIGINT
    )`), /HTTP status 401/);

    inst.closeSync();
  });

  test("SSE-style streaming route is served by ducknng and consumed with ncurl", async () => {
    const inst = await DuckDBInstance.create(":memory:", { allow_unsigned_extensions: "true" });
    const conn = duckdbNodeConn(await inst.connect());
    await conn.run(ducknngLoadSql);

    await conn.run(`SELECT ducknng_start_server('sse_fixture', 'http://127.0.0.1:0/_ducknng', 1, 134217728, 300000, 0::UBIGINT)`);
    const BASE = (await conn.all<{ listen: string }>("SELECT listen FROM ducknng_list_servers() WHERE name='sse_fixture'"))[0]!.listen.replace(/\/_ducknng.*$/, "");
    await conn.run(`SELECT ducknng_add_stream_route(
      'sse_fixture',
      'GET',
      '/events',
      'SELECT ducknng_format_sse(''row '' || i::VARCHAR) AS chunk FROM generate_series(1,3) t(i)'
    )`);
    const route = await conn.all<{ is_stream: boolean; stream_content_type: string }>(
      "SELECT is_stream, stream_content_type FROM ducknng_list_http_routes() WHERE service_name = 'sse_fixture' AND path = '/events'",
    );
    assert.deepEqual(route, [{ is_stream: true, stream_content_type: "text/event-stream; charset=utf-8" }]);

    const rows = await conn.all<{ status: number; body_text: string }>(
      `SELECT status, body_text FROM ducknng_ncurl('${BASE}/events', 'GET', ducknng_http_headers_build(['Accept'], ['text/event-stream']), NULL, 5000, 0::UBIGINT)`,
    );
    assert.equal(rows[0]!.status, 200);
    assert.equal(rows[0]!.body_text, "data: row 1\n\ndata: row 2\n\ndata: row 3\n\n");

    inst.closeSync();
  });
});
