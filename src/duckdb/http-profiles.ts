import type { SqlConn } from "../core/ports.js";
import { canonicalDigest } from "../core/reproducibility.js";

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export const DUCKNNG_HTTP_PROFILE_RECEIPT_SCHEMA = "pi-bio.ducknng_http_profile_receipt.v1" as const;

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
  /** Optional execution subjects admitted by ducknng. Non-empty means ad-hoc SQL without a subject fails closed. */
  allowSubjects?: readonly string[] | null;
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
  allowSubjectsJson: string | null;
}

export interface DucknngHttpProfileReceipt {
  schema: typeof DUCKNNG_HTTP_PROFILE_RECEIPT_SCHEMA;
  profileId: string;
  scope: {
    scheme: string;
    host: string;
    port: number | null;
    pathPrefix: string;
    method: string;
    tlsRequired: boolean;
  };
  authHeaderNames: string[];
  version: string;
  createdMs: string;
  updatedMs: string;
  expiresAtMs: string | null;
  subjectRestriction: {
    restricted: boolean;
    count: number;
    digest?: `sha256:${string}`;
  };
  /** Digest of this secret-free profile policy receipt. Token/header values are intentionally not representable. */
  policyDigest: `sha256:${string}`;
}

export interface DucknngHttpProfileRefreshResult {
  profileId: string;
  current: DucknngHttpProfileReceipt;
  previous?: DucknngHttpProfileReceipt;
  created: boolean;
  /** True when the redacted receipt digest changed; upsert version/timestamp movement intentionally counts. */
  receiptChanged: boolean;
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

function validAllowSubjects(subjects: readonly string[] | null | undefined): string | null {
  if (subjects == null) return null;
  if (!Array.isArray(subjects) || subjects.length === 0) throw new Error("ducknng HTTP profile allowSubjects must be a non-empty array when supplied");
  const normalized = [...new Set(subjects.map((s) => cleanString(s, "ducknng HTTP profile allowSubject")))].sort();
  return JSON.stringify(normalized);
}

function parseStringArray(json: string | null, label: string): string[] {
  if (json == null) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch {
    throw new Error(`${label} must be JSON array text`);
  }
  if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) {
    throw new Error(`${label} must be a JSON array of strings`);
  }
  return parsed;
}

function bigintText(value: bigint): string {
  return value.toString();
}

function expiryText(value: bigint): string | null {
  return value > 0n ? value.toString() : null;
}

export function ducknngHttpProfileReceiptFromInfo(info: DucknngHttpProfileInfo): DucknngHttpProfileReceipt {
  const authHeaderNames = parseStringArray(info.authHeaderNamesJson, "ducknng HTTP profile auth_header_names_json");
  const allowSubjects = [...new Set(parseStringArray(info.allowSubjectsJson, "ducknng HTTP profile allow_subjects_json"))].sort();
  const subjectRestriction = allowSubjects.length === 0
    ? { restricted: false, count: 0 }
    : { restricted: true, count: allowSubjects.length, digest: canonicalDigest([...allowSubjects].sort()) };
  const body = {
    schema: DUCKNNG_HTTP_PROFILE_RECEIPT_SCHEMA,
    profileId: info.profileId,
    scope: {
      scheme: info.scheme,
      host: info.host,
      port: info.hasPort ? info.port : null,
      pathPrefix: info.pathPrefix,
      method: info.method,
      tlsRequired: info.tlsRequired,
    },
    authHeaderNames,
    version: bigintText(info.version),
    createdMs: bigintText(info.createdMs),
    updatedMs: bigintText(info.updatedMs),
    expiresAtMs: expiryText(info.expiresAtMs),
    subjectRestriction,
  };
  return { ...body, policyDigest: canonicalDigest(body) };
}

function validatedProfile(spec: DucknngHttpProfileSpec): Required<Omit<DucknngHttpProfileSpec, "port" | "expiresAtMs" | "allowSubjects">> & { port: number | null; expiresAtMs: number | null; allowSubjectsJson: string | null } {
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
    allowSubjectsJson: validAllowSubjects(spec.allowSubjects),
  };
}

export async function ducknngHttpProfilesAvailable(conn: SqlConn): Promise<boolean> {
  const rows = await conn.all<{ n: bigint }>(
    "SELECT count(*) n FROM duckdb_functions() WHERE function_name = 'ducknng_register_http_profile'",
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function ducknngHttpProfileSubjectsAvailable(conn: SqlConn): Promise<boolean> {
  const rows = await conn.all<{ n: bigint }>(
    "SELECT count(*) n FROM duckdb_functions() WHERE function_name = 'ducknng_register_http_profile' AND array_length(parameter_types) = 11",
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

export async function registerDucknngHttpProfile(conn: SqlConn, spec: DucknngHttpProfileSpec): Promise<DucknngHttpProfileReceipt> {
  const p = validatedProfile(spec);
  if (p.allowSubjectsJson != null && !(await ducknngHttpProfileSubjectsAvailable(conn))) {
    throw new Error("ducknng HTTP profile allowSubjects requires ducknng_register_http_profile(..., allow_subjects_json)");
  }
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
    p.allowSubjectsJson != null
      ? `SELECT ducknng_register_http_profile(?, ?, ?, ?::INTEGER, ?, ?, ?, ?, ?, ?::UBIGINT, ?) AS ok`
      : p.expiresAtMs == null
      ? `SELECT ducknng_register_http_profile(?, ?, ?, ?::INTEGER, ?, ?, ?, ?, ?) AS ok`
      : `SELECT ducknng_register_http_profile(?, ?, ?, ?::INTEGER, ?, ?, ?, ?, ?, ?::UBIGINT) AS ok`,
    p.allowSubjectsJson != null ? [...params, p.expiresAtMs ?? 0, p.allowSubjectsJson] : p.expiresAtMs == null ? params : [...params, p.expiresAtMs],
  );
  if (rows[0]?.ok !== true) throw new Error(`ducknng HTTP profile '${p.profileId}' was not registered`);
  const receipt = await getDucknngHttpProfileReceipt(conn, p.profileId);
  if (!receipt) throw new Error(`ducknng HTTP profile '${p.profileId}' was registered but could not be listed for a receipt`);
  return receipt;
}

/** Commission or rotate a ducknng HTTP profile through ducknng's upsert path.
 *
 * The host remains responsible for fetching or refreshing credential material. This helper only installs the
 * current secret into ducknng using bound parameters, then returns the before/after redacted policy receipts that
 * runs can pin as host capability receipts. Re-registering the same profile id is intentionally not drop/register:
 * ducknng replaces the profile atomically in its runtime and advances the redacted profile version/timestamps.
 */
export async function refreshDucknngHttpProfile(conn: SqlConn, spec: DucknngHttpProfileSpec): Promise<DucknngHttpProfileRefreshResult> {
  const profileId = cleanString(spec.profileId, "ducknng HTTP profile profileId");
  const previous = await getDucknngHttpProfileReceipt(conn, profileId);
  const current = await registerDucknngHttpProfile(conn, spec);
  if (current.profileId !== profileId) {
    throw new Error(`ducknng HTTP profile refresh returned receipt for '${current.profileId}', expected '${profileId}'`);
  }
  return {
    profileId,
    current,
    ...(previous ? { previous } : {}),
    created: previous === undefined,
    receiptChanged: previous?.policyDigest !== current.policyDigest,
  };
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
    allow_subjects_json?: string | null;
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
    allowSubjectsJson: r.allow_subjects_json ?? null,
  }));
}

export async function listDucknngHttpProfileReceipts(conn: SqlConn): Promise<DucknngHttpProfileReceipt[]> {
  return (await listDucknngHttpProfiles(conn)).map(ducknngHttpProfileReceiptFromInfo);
}

export async function getDucknngHttpProfileReceipt(conn: SqlConn, profileId: string): Promise<DucknngHttpProfileReceipt | undefined> {
  const clean = cleanString(profileId, "ducknng HTTP profile profileId");
  return (await listDucknngHttpProfileReceipts(conn)).find((p) => p.profileId === clean);
}
