import type { SqlConn } from "../core/ports.js";

// SINGLE-ENDPOINT, rate-limited retry over ducknng's HTTP client. With the owned ducknng build loaded,
// `ducknng_ncurl` is backed by a VOLATILE scalar (`ducknng__ncurl_row`), so a `WITH RECURSIVE` retry RE-FIRES the
// call per iteration and the whole retry loop is ONE SQL statement. The call must depend on the recursive row; we
// carry that correlation in the timeout argument so the requested URL stays unchanged.

const METHOD = /^[A-Z]+$/;

export interface NcurlRetryOptions {
  /** Base URL. It is passed unchanged; recursive row-correlation rides on timeoutMs. */
  url: string;
  method?: string; // default GET
  /** ducknng header array JSON, e.g. '[{"name":"Accept","value":"application/json"}]'; default none */
  headersJson?: string | null;
  /** ducknng outbound HTTP profile id. Host-commissioned and non-secret; ducknng injects the credential. */
  profileId?: string | null;
  /** request body for POST/PUT (BLOB); default none */
  body?: string | null;
  timeoutMs?: number; // per request; default 30000
  tlsConfigId?: number; // host-owned; default 0 (plain http)
  maxAttempts?: number; // default 5
  /** SQL predicate (over `status`) for "keep retrying"; default transient = null / 429 / 5xx (stops on 2xx and on
   *  permanent 4xx). Used by the recursive-CTE path. */
  retryWhileSql?: string;
}

export interface NcurlRetryResult {
  attempts: number;
  status: number | null;
  bodyText: string | null;
  /** which path ran — useful for tests/telemetry */
  via: "recursive-cte";
}

const DEFAULT_TRANSIENT_SQL = "(status IS NULL OR status = 429 OR status >= 500)";
const esc = (s: string): string => s.replace(/'/g, "''");

/** Does the loaded ducknng have the volatile-scalar `ncurl` fix (the owned/backported build)? */
export async function ncurlRowAvailable(conn: SqlConn): Promise<boolean> {
  const rows = await conn.all<{ stability: string }>(
    "SELECT stability FROM duckdb_functions() WHERE function_name = 'ducknng__ncurl_row' LIMIT 1",
  );
  return rows.length > 0 && rows[0]!.stability === "VOLATILE";
}

function validated(opts: NcurlRetryOptions): {
  url: string; method: string; headers: string; body: string; timeout: number; tls: number; maxAttempts: number; profile: string;
} {
  const method = (opts.method ?? "GET").toUpperCase();
  if (!METHOD.test(method)) throw new Error(`ncurlRetry: invalid method '${method}'`);
  const timeout = Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : 30000;
  const tls = Number.isInteger(opts.tlsConfigId) ? Number(opts.tlsConfigId) : 0;
  const maxAttempts = Number.isInteger(opts.maxAttempts) && (opts.maxAttempts as number) > 0 ? Number(opts.maxAttempts) : 5;
  if (tls < 0 || timeout <= 0) throw new Error("ncurlRetry: timeoutMs must be > 0 and tlsConfigId >= 0");
  return {
    url: opts.url, method,
    headers: opts.headersJson != null ? `'${esc(opts.headersJson)}'` : "NULL",
    body: opts.body != null ? `'${esc(opts.body)}'::BLOB` : "NULL",
    timeout, tls, maxAttempts,
    profile: opts.profileId != null ? `'${esc(opts.profileId)}'` : "NULL",
  };
}

/** The SQL-native retry as ONE recursive-CTE SELECT — valid ONLY when the owned build is loaded (re-fire). */
export function buildNcurlRetrySql(opts: NcurlRetryOptions): string {
  const v = validated(opts);
  const retryWhile = opts.retryWhileSql ?? DEFAULT_TRANSIENT_SQL;
  // The URL is passed UNCHANGED — do NOT append `?attempt=N` (it would break signed/presigned URLs, strict REST
  // endpoints, cache-key-sensitive APIs). The recursive CTE still needs each iteration's ncurl call to be a NEW
  // request, which requires a ROW-CORRELATED argument (referencing the recursive `attempt` column) so DuckDB
  // re-evaluates it per row rather than hoisting it once. Carry that correlation in the TIMEOUT (`timeout + attempt`
  // ms) — a negligible, harmless bump that never touches the URL/method/headers/body the caller requested.
  const call = (attemptSql: string): string =>
    opts.profileId != null
      ? `ducknng_ncurl('${esc(v.url)}', '${v.method}', ${v.headers}, ${v.body}, ${v.timeout} + ${attemptSql}, ${v.tls}::UBIGINT, ${v.profile})`
      : `ducknng_ncurl('${esc(v.url)}', '${v.method}', ${v.headers}, ${v.body}, ${v.timeout} + ${attemptSql}, ${v.tls}::UBIGINT)`;
  return `WITH RECURSIVE attempts(attempt, status, body_text) AS (
  SELECT 1, status, body_text FROM ${call("1")}
  UNION ALL
  SELECT a.attempt + 1, r.status, r.body_text
  FROM (SELECT * FROM attempts WHERE ${retryWhile} AND attempt < ${v.maxAttempts}) a,
       ${call("(a.attempt + 1)")} r
)
SELECT attempt, status, body_text FROM attempts ORDER BY attempt`;
}

/**
 * Retry a single HTTP endpoint until it stops being transient (or `maxAttempts`). This requires a ducknng build
 * that exposes `ducknng__ncurl_row` as VOLATILE; older builds fail clearly instead of changing execution mode.
 * Returns the LAST attempt's outcome. `conn` must already have ducknng LOADed.
 */
export async function ncurlRetry(conn: SqlConn, opts: NcurlRetryOptions): Promise<NcurlRetryResult> {
  if (!(await ncurlRowAvailable(conn))) {
    throw new Error("ncurlRetry requires ducknng__ncurl_row to be registered VOLATILE; load the owned ducknng build");
  }
  const rows = await conn.all<{ attempt: number | bigint; status: number | null; body_text: string | null }>(buildNcurlRetrySql(opts));
  const last = rows[rows.length - 1]!;
  return { attempts: Number(last.attempt), status: last.status, bodyText: last.body_text, via: "recursive-cte" };
}
