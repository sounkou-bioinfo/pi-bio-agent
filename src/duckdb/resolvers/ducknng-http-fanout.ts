import { createHash } from "node:crypto";
import { systemClock } from "../../core/clock.js";
import { quoteSqlIdentifier, validateReadOnlySelect, sqlCallsDynamicSqlAst } from "../../core/sql-guard.js";
import type { BioResolverImpl, ResolverOutput } from "../../core/ports.js";
import { ncurlFanout } from "../ncurl-fanout.js";

type FanoutParams = {
  table?: unknown;
  batchesSql?: unknown;
  declaredSources?: unknown;
  sourceVersion?: unknown;
  extensions?: unknown;
  url?: unknown;
  urlVariable?: unknown;
  headersJson?: unknown;
  headersVariable?: unknown;
  profileId?: unknown;
  profileVariable?: unknown;
  tlsConfigId?: unknown;
  tlsConfigVariable?: unknown;
  timeoutMs?: unknown;
  maxInFlight?: unknown;
  maxRounds?: unknown;
};

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`ducknng.http_fanout: ${label} must be an array of strings`);
  }
  return value;
}

async function sessionValue(conn: Parameters<BioResolverImpl>[1]["conn"], variable: string): Promise<unknown> {
  const rows = await conn.all<{ value: unknown }>("SELECT getvariable(?) AS value", [variable]);
  return rows[0]?.value;
}

async function resolveValue(
  conn: Parameters<BioResolverImpl>[1]["conn"],
  direct: unknown,
  variable: unknown,
  label: string,
): Promise<unknown> {
  if (direct !== undefined && variable !== undefined) throw new Error(`ducknng.http_fanout: ${label} and ${label}Variable are mutually exclusive`);
  if (variable !== undefined) {
    if (typeof variable !== "string" || variable.length === 0 || variable.includes("\u0000")) throw new Error(`ducknng.http_fanout: ${label}Variable must be a non-empty session variable name`);
    return sessionValue(conn, variable);
  }
  return direct;
}

function integerOption(value: unknown, label: string, fallback: number): number {
  if (value === undefined) return fallback;
  const number = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`ducknng.http_fanout: ${label} must be a positive safe integer`);
  return number;
}

export const ducknngHttpFanoutResolver: BioResolverImpl = async (resource, ctx): Promise<ResolverOutput> => {
  const params = resource.params as FanoutParams;
  if (typeof params.table !== "string") throw new Error("ducknng.http_fanout requires params.table");
  quoteSqlIdentifier(params.table, "ducknng.http_fanout params.table");
  if (typeof params.batchesSql !== "string" || !params.batchesSql.trim()) throw new Error("ducknng.http_fanout requires params.batchesSql (a read-only SELECT returning batch_id and body)");
  const batchesSql = validateReadOnlySelect(params.batchesSql);
  if (await sqlCallsDynamicSqlAst(ctx.conn, batchesSql)) throw new Error("ducknng.http_fanout: params.batchesSql uses dynamic SQL (query()/query_table())");
  const declaredSources = stringArray(params.declaredSources, "declaredSources");
  const extensions = stringArray(params.extensions, "extensions");
  for (const extension of extensions) {
    await ctx.conn.run(`LOAD ${quoteSqlIdentifier(extension, "ducknng.http_fanout extension")}`);
  }

  const urlValue = await resolveValue(ctx.conn, params.url, params.urlVariable, "url");
  if (typeof urlValue !== "string") throw new Error("ducknng.http_fanout requires an http(s) URL");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlValue);
  } catch {
    throw new Error("ducknng.http_fanout requires an http(s) URL");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error("ducknng.http_fanout requires an http(s) URL");
  const headersValue = await resolveValue(ctx.conn, params.headersJson, params.headersVariable, "headers");
  if (headersValue !== undefined && headersValue !== null && typeof headersValue !== "string") throw new Error("ducknng.http_fanout headers must be JSON text");
  const profileValue = await resolveValue(ctx.conn, params.profileId, params.profileVariable, "profile");
  if (profileValue !== undefined && profileValue !== null && typeof profileValue !== "string") throw new Error("ducknng.http_fanout profile must be a string");
  const tlsValue = await resolveValue(ctx.conn, params.tlsConfigId, params.tlsConfigVariable, "tlsConfigId");
  const tlsConfigId = tlsValue === undefined || tlsValue === null ? 0 : Number(tlsValue);
  if (!Number.isSafeInteger(tlsConfigId) || tlsConfigId < 0) throw new Error("ducknng.http_fanout tlsConfigId must be a non-negative safe integer");

  const batchesTable = `${params.table}__batches`;
  const batchesTableSql = quoteSqlIdentifier(batchesTable, "ducknng.http_fanout batch table");
  await ctx.conn.run(`CREATE OR REPLACE TABLE ${batchesTableSql} AS SELECT batch_id, body FROM (${batchesSql}) AS declared_batches`);
  const fanout = await ncurlFanout(ctx.conn, {
    batchesTable,
    resultsTable: params.table,
    url: urlValue,
    headersJson: typeof headersValue === "string" ? headersValue : "[]",
    ...(typeof profileValue === "string" && profileValue ? { profileId: profileValue } : {}),
    tlsConfigId,
    timeoutMs: params.timeoutMs === undefined ? undefined : integerOption(params.timeoutMs, "timeoutMs", 1),
    maxInFlight: integerOption(params.maxInFlight, "maxInFlight", 8),
    maxRounds: integerOption(params.maxRounds, "maxRounds", 6),
    signal: ctx.signal,
  });
  if (fanout.failures.length > 0) throw new Error(`ducknng.http_fanout failed for ${fanout.failures.length} batch(es): ${JSON.stringify(fanout.failures)}`);

  const now = ctx.now ?? systemClock();
  const sourceSnapshots = [...new Set([...declaredSources, urlValue])].map((source) => ({
    source,
    ...(source === urlValue && typeof params.sourceVersion === "string" && params.sourceVersion ? { version: params.sourceVersion } : {}),
    retrievedAt: now,
  }));
  const batchesDigest = `sha256:${createHash("sha256").update(batchesSql).digest("hex")}`;
  return {
    result: { mode: "reference", name: params.table, pointer: { uri: `table:${params.table}`, format: "table" } },
    sourceSnapshots,
    provenance: [{
      source: "ducknng.http_fanout",
      retrievedAt: now,
      digest: batchesDigest,
      notes: ["ducknng_ncurl_aio", `waves:${fanout.waves}`, `succeeded:${fanout.succeeded}`, ...extensions.map((extension) => `ext:${extension}`)],
    }],
  };
};
