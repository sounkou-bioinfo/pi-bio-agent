import type { SqlConn } from "../core/ports.js";

// SINGLE-ENDPOINT, rate-limited retry over ducknng's HTTP client. Once the OWNED ducknng build (the
// per-DuckDB-version backport) is loaded, `ducknng_ncurl` is backed by a VOLATILE scalar (`ducknng__ncurl_row`),
// so a `WITH RECURSIVE` retry RE-FIRES the call per iteration and the whole retry loop collapses to ONE SQL
// statement — provided the call DEPENDS ON THE RECURSIVE ROW (we put `attempt` in the URL), else DuckDB makes a
// speculative extra call after the stop condition. The default community build lacks that fix, so we feature-probe
// `ducknng__ncurl_row` and fall back to a host loop. (This is the single-endpoint sibling of ncurl-fanout.ts,
// which handles MANY endpoints / chunk fanout; that still needs host code because the dynamic-schema
// `ducknng_ncurl_table` can't be lateral-correlated per chunk.)

const METHOD = /^[A-Z]+$/;

export interface NcurlRetryOptions {
  /** base URL; `attempt` is appended as a query param so the call depends on the recursive row (the KEY RULE) */
  url: string;
  method?: string; // default GET
  /** ducknng header array JSON, e.g. '[{"name":"Accept","value":"application/json"}]'; default none */
  headersJson?: string | null;
  /** request body for POST/PUT (BLOB); default none */
  body?: string | null;
  timeoutMs?: number; // per request; default 30000
  tlsConfigId?: number; // host-owned; default 0 (plain http)
  maxAttempts?: number; // default 5
  /** SQL predicate (over `status`) for "keep retrying"; default transient = null / 429 / 5xx (stops on 2xx and on
   *  permanent 4xx). Used by the recursive-CTE path. */
  retryWhileSql?: string;
  /** JS mirror of retryWhileSql, used by the host-loop fallback; keep the two in agreement. */
  isTransient?: (status: number | null) => boolean;
}

export interface NcurlRetryResult {
  attempts: number;
  status: number | null;
  bodyText: string | null;
  /** which path ran — useful for tests/telemetry */
  via: "recursive-cte" | "host-loop";
}

const DEFAULT_TRANSIENT_SQL = "(status IS NULL OR status = 429 OR status >= 500)";
const defaultTransient = (status: number | null): boolean => status === null || status === 429 || status >= 500;
const esc = (s: string): string => s.replace(/'/g, "''");

/** Does the loaded ducknng have the volatile-scalar `ncurl` fix (the owned/backported build)? */
export async function ncurlRowAvailable(conn: SqlConn): Promise<boolean> {
  const rows = await conn.all<{ stability: string }>(
    "SELECT stability FROM duckdb_functions() WHERE function_name = 'ducknng__ncurl_row' LIMIT 1",
  );
  return rows.length > 0 && rows[0]!.stability === "VOLATILE";
}

function validated(opts: NcurlRetryOptions): {
  url: string; method: string; sep: string; headers: string; body: string; timeout: number; tls: number; maxAttempts: number;
} {
  const method = (opts.method ?? "GET").toUpperCase();
  if (!METHOD.test(method)) throw new Error(`ncurlRetry: invalid method '${method}'`);
  const timeout = Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : 30000;
  const tls = Number.isInteger(opts.tlsConfigId) ? Number(opts.tlsConfigId) : 0;
  const maxAttempts = Number.isInteger(opts.maxAttempts) && (opts.maxAttempts as number) > 0 ? Number(opts.maxAttempts) : 5;
  if (tls < 0 || timeout <= 0) throw new Error("ncurlRetry: timeoutMs must be > 0 and tlsConfigId >= 0");
  return {
    url: opts.url, method, sep: opts.url.includes("?") ? "&" : "?",
    headers: opts.headersJson != null ? `'${esc(opts.headersJson)}'` : "NULL",
    body: opts.body != null ? `'${esc(opts.body)}'::BLOB` : "NULL",
    timeout, tls, maxAttempts,
  };
}

/** The SQL-native retry as ONE recursive-CTE SELECT — valid ONLY when the owned build is loaded (re-fire). */
export function buildNcurlRetrySql(opts: NcurlRetryOptions): string {
  const v = validated(opts);
  const retryWhile = opts.retryWhileSql ?? DEFAULT_TRANSIENT_SQL;
  const call = (attemptSql: string): string =>
    `ducknng_ncurl('${esc(v.url)}${v.sep}attempt=' || ${attemptSql}, '${v.method}', ${v.headers}, ${v.body}, ${v.timeout}, ${v.tls}::UBIGINT)`;
  return `WITH RECURSIVE attempts(attempt, status, body_text) AS (
  SELECT 1, status, body_text FROM ${call("'1'")}
  UNION ALL
  SELECT a.attempt + 1, r.status, r.body_text
  FROM (SELECT * FROM attempts WHERE ${retryWhile} AND attempt < ${v.maxAttempts}) a,
       ${call("(a.attempt + 1)::VARCHAR")} r
)
SELECT attempt, status, body_text FROM attempts ORDER BY attempt`;
}

/**
 * Retry a single HTTP endpoint until it stops being transient (or `maxAttempts`). Uses the SQL-native
 * recursive-CTE path when the owned ducknng build is loaded (`ducknng__ncurl_row` VOLATILE), else a host loop.
 * Returns the LAST attempt's outcome. `conn` must already have ducknng LOADed.
 */
export async function ncurlRetry(conn: SqlConn, opts: NcurlRetryOptions): Promise<NcurlRetryResult> {
  const v = validated(opts);
  if (await ncurlRowAvailable(conn)) {
    const rows = await conn.all<{ attempt: number | bigint; status: number | null; body_text: string | null }>(buildNcurlRetrySql(opts));
    const last = rows[rows.length - 1]!;
    return { attempts: Number(last.attempt), status: last.status, bodyText: last.body_text, via: "recursive-cte" };
  }
  // fallback: the loaded ncurl constant-folds inside a recursive CTE, so loop in host code — each call is its own
  // statement (no fold). The KEY-RULE attempt param is included for parity with the SQL path.
  const isTransient = opts.isTransient ?? defaultTransient;
  let attempt = 0, status: number | null = null, bodyText: string | null = null;
  while (attempt < v.maxAttempts) {
    attempt++;
    const rows = await conn.all<{ status: number | null; body_text: string | null }>(
      "SELECT status, body_text FROM ducknng_ncurl(?, ?, ?, ?::BLOB, ?, ?::UBIGINT)",
      [`${v.url}${v.sep}attempt=${attempt}`, v.method, opts.headersJson ?? null, opts.body ?? null, v.timeout, v.tls],
    );
    status = rows[0]?.status ?? null;
    bodyText = rows[0]?.body_text ?? null;
    if (!isTransient(status)) break;
  }
  return { attempts: attempt, status, bodyText, via: "host-loop" };
}
