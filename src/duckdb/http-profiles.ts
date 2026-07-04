import type { SqlConn } from "../core/ports.js";

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export interface DucknngHttpProfileSpec {
  profileId: string;
  scheme: "http" | "https";
  host: string;
  /** Omit/null to allow the scheme's default port. */
  port?: number | null;
  pathPrefix: string;
  /** Defaults to "*", meaning any method within the other profile scopes. */
  method?: string;
  /** Extra policy: require an HTTPS URL. The host opts in; this helper does not infer deployment policy. */
  tlsRequired?: boolean;
  authHeaderName: string;
  /** Host-owned credential material. It is passed as a bound parameter and is never serialized by this helper. */
  authHeaderValue: string;
  /** Optional wall-clock expiry in milliseconds since epoch, enforced by ducknng at send time. */
  expiresAtMs?: number | null;
}

export interface DucknngHttpProfileInfo {
  profileId: string;
  scheme: string;
  host: string;
  port: number | null;
  hasPort: boolean;
  pathPrefix: string;
  method: string;
  tlsRequired: boolean;
  authHeaderNamesJson: string;
  version: bigint;
  createdMs: bigint;
  updatedMs: bigint;
  expiresAtMs: bigint;
}

function cleanString(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must be a non-empty string without control characters`);
  }
  return value;
}

function validPort(port: number | null | undefined): number | null {
  if (port == null) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("ducknng HTTP profile port must be an integer between 1 and 65535");
  return port;
}

function validExpiry(expiresAtMs: number | null | undefined): number | null {
  if (expiresAtMs == null) return null;
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 1) throw new Error("ducknng HTTP profile expiresAtMs must be a positive safe integer");
  return expiresAtMs;
}

function validatedProfile(spec: DucknngHttpProfileSpec): Required<Omit<DucknngHttpProfileSpec, "port" | "expiresAtMs">> & { port: number | null; expiresAtMs: number | null } {
  const scheme = spec.scheme;
  if (scheme !== "http" && scheme !== "https") throw new Error("ducknng HTTP profile scheme must be http or https");
  const pathPrefix = cleanString(spec.pathPrefix, "ducknng HTTP profile pathPrefix");
  if (!pathPrefix.startsWith("/")) throw new Error("ducknng HTTP profile pathPrefix must start with '/'");
  const method = spec.method ?? "*";
  if (!HTTP_TOKEN.test(method)) throw new Error("ducknng HTTP profile method must be an HTTP token or '*'");
  const authHeaderName = cleanString(spec.authHeaderName, "ducknng HTTP profile authHeaderName");
  if (!HTTP_TOKEN.test(authHeaderName)) throw new Error("ducknng HTTP profile authHeaderName must be an HTTP token");
  return {
    profileId: cleanString(spec.profileId, "ducknng HTTP profile profileId"),
    scheme,
    host: cleanString(spec.host, "ducknng HTTP profile host"),
    port: validPort(spec.port),
    pathPrefix,
    method,
    tlsRequired: spec.tlsRequired ?? false,
    authHeaderName,
    authHeaderValue: cleanString(spec.authHeaderValue, "ducknng HTTP profile authHeaderValue"),
    expiresAtMs: validExpiry(spec.expiresAtMs),
  };
}

export async function ducknngHttpProfilesAvailable(conn: SqlConn): Promise<boolean> {
  const rows = await conn.all<{ n: bigint }>(
    "SELECT count(*) n FROM duckdb_functions() WHERE function_name = 'ducknng_register_http_profile'",
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function registerDucknngHttpProfile(conn: SqlConn, spec: DucknngHttpProfileSpec): Promise<void> {
  const p = validatedProfile(spec);
  const params: unknown[] = [
    p.profileId,
    p.scheme,
    p.host,
    p.port,
    p.pathPrefix,
    p.method,
    p.tlsRequired,
    p.authHeaderName,
    p.authHeaderValue,
  ];
  const rows = await conn.all<{ ok: boolean }>(
    p.expiresAtMs == null
      ? `SELECT ducknng_register_http_profile(?, ?, ?, ?::INTEGER, ?, ?, ?, ?, ?) AS ok`
      : `SELECT ducknng_register_http_profile(?, ?, ?, ?::INTEGER, ?, ?, ?, ?, ?, ?::UBIGINT) AS ok`,
    p.expiresAtMs == null ? params : [...params, p.expiresAtMs],
  );
  if (rows[0]?.ok !== true) throw new Error(`ducknng HTTP profile '${p.profileId}' was not registered`);
}

export async function dropDucknngHttpProfile(conn: SqlConn, profileId: string): Promise<boolean> {
  const rows = await conn.all<{ dropped: boolean }>(
    "SELECT ducknng_drop_http_profile(?) AS dropped",
    [cleanString(profileId, "ducknng HTTP profile profileId")],
  );
  return rows[0]?.dropped === true;
}

export async function listDucknngHttpProfiles(conn: SqlConn): Promise<DucknngHttpProfileInfo[]> {
  const rows = await conn.all<{
    profile_id: string;
    scheme: string;
    host: string;
    port: number | null;
    has_port: boolean;
    path_prefix: string;
    method: string;
    tls_required: boolean;
    auth_header_names_json: string;
    version: bigint;
    created_ms: bigint;
    updated_ms: bigint;
    expires_at_ms: bigint;
  }>("SELECT * FROM ducknng_list_http_profiles()");
  return rows.map((r) => ({
    profileId: r.profile_id,
    scheme: r.scheme,
    host: r.host,
    port: r.port,
    hasPort: r.has_port,
    pathPrefix: r.path_prefix,
    method: r.method,
    tlsRequired: r.tls_required,
    authHeaderNamesJson: r.auth_header_names_json,
    version: r.version,
    createdMs: r.created_ms,
    updatedMs: r.updated_ms,
    expiresAtMs: r.expires_at_ms,
  }));
}
