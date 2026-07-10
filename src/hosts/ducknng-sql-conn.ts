import type { SqlConn, SqlRow } from "../core/ports.js";

export interface DucknngSqlConnOptions {
  /** A throwaway DuckDB connection with the owned ducknng extension loaded. */
  client: SqlConn;
  /** The ducknng service URL, for example tls+tcp://127.0.0.1:9000. */
  url: string;
  /** A client-side ducknng TLS configuration handle. Zero selects plaintext. */
  tlsConfigId?: bigint;
}

interface DucknngExecResult {
  ok: boolean;
  error: string | null;
}

interface DucknngParameterExpression {
  type: string;
  sql: string;
  bindings: unknown[];
}

interface DucknngParameterBudget {
  nodes: number;
}

function duckdbParameterExpression(
  value: unknown,
  seen: Set<object>,
  budget: DucknngParameterBudget,
  depth = 0,
): DucknngParameterExpression {
  budget.nodes += 1;
  if (budget.nodes > 65_535) {
    throw new Error("ducknng SqlConn parameters may contain at most 65,535 value nodes");
  }
  if (depth > 16) throw new Error("ducknng SqlConn parameter nesting exceeds 16 levels");
  if (value === null) return { type: "VARCHAR", sql: "NULL", bindings: [] };
  if (typeof value === "boolean") return { type: "BOOLEAN", sql: "CAST(? AS BOOLEAN)", bindings: [value] };
  if (typeof value === "number") return { type: "DOUBLE", sql: "CAST(? AS DOUBLE)", bindings: [value] };
  if (typeof value === "string") return { type: "VARCHAR", sql: "CAST(? AS VARCHAR)", bindings: [value] };
  if (typeof value === "bigint") {
    const type = value >= -9223372036854775808n && value <= 9223372036854775807n ? "BIGINT" : "HUGEINT";
    return { type, sql: "CAST(? AS " + type + ")", bindings: [value] };
  }
  if (value instanceof Uint8Array) return { type: "BLOB", sql: "CAST(? AS BLOB)", bindings: [value] };
  if (typeof value !== "object") {
    throw new Error("ducknng SqlConn parameters must be portable SQL values");
  }
  if (seen.has(value)) throw new Error("ducknng SqlConn parameters cannot be cyclic");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => duckdbParameterExpression(item, seen, budget, depth + 1));
      const elementTypes = [...new Set(items.filter((_item, index) => value[index] !== null).map((item) => item.type))];
      if (elementTypes.length > 1) {
        throw new Error("ducknng SqlConn list parameters must have one concrete element type");
      }
      const elementType = elementTypes[0] ?? "VARCHAR";
      const type = elementType + "[]";
      if (items.length === 0) return { type, sql: "[]::" + type, bindings: [] };
      const itemSql = items.map((item, index) => value[index] === null ? "NULL::" + elementType : item.sql);
      return {
        type,
        sql: "CAST(list_value(" + itemSql.join(", ") + ") AS " + type + ")",
        bindings: items.flatMap((item) => item.bindings),
      };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("ducknng SqlConn object parameters must be plain records");
    }
    const entries = Object.entries(value);
    if (entries.length === 0) {
      throw new Error("ducknng SqlConn struct parameters cannot be empty because they have no inferable field types");
    }
    const fields = entries.map(([key, item]) => {
      const quoted = '"' + key.replace(/"/g, '""') + '"';
      return { quoted, value: duckdbParameterExpression(item, seen, budget, depth + 1) };
    });
    const type = "STRUCT(" + fields.map((field) => field.quoted + " " + field.value.type).join(", ") + ")";
    return {
      type,
      sql: "CAST(struct_pack(" + fields.map((field) => field.quoted + " := " + field.value.sql).join(", ") +
        ") AS " + type + ")",
      bindings: fields.flatMap((field) => field.value.bindings),
    };
  } finally {
    seen.delete(value);
  }
}

function rpcCall(functionName: string, params: readonly unknown[]): { sql: string; bindings: unknown[] } {
  if (params.length > 65_535) throw new Error("ducknng SqlConn supports at most 65,535 parameters");
  const budget = { nodes: 0 };
  const expressions = params.map((value) => duckdbParameterExpression(value, new Set(), budget));
  if (expressions.length === 0) {
    return {
      sql: "SELECT * FROM " + functionName + "_params(?, ?, NULL::STRUCT(p0 VARCHAR), ?::UBIGINT)",
      bindings: [],
    };
  }
  const fields = expressions.map((expression, index) => "p" + index + " := " + expression.sql).join(", ");
  return {
    sql: "SELECT * FROM " + functionName + "_params(?, ?, struct_pack(" + fields + "), ?::UBIGINT)",
    bindings: expressions.flatMap((expression) => expression.bindings),
  };
}

/**
 * Adapt ducknng's typed RPC helpers to the package's host-neutral SQL port.
 *
 * Parameters travel as an Arrow struct and are bound by the remote DuckDB; they are never substituted into SQL
 * text. The host still owns service admission, SQL authorization, TLS material, and the client connection lifetime.
 */
export function createDucknngSqlConn(options: DucknngSqlConnOptions): SqlConn {
  const url = options.url.trim();
  if (url.length === 0) throw new Error("ducknng SqlConn requires a service URL");
  const tlsConfigId = options.tlsConfigId ?? 0n;
  if (tlsConfigId < 0n) throw new Error("ducknng SqlConn TLS configuration id must be non-negative");

  return {
    async all<T = SqlRow>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      const call = rpcCall("ducknng_query_rpc", params);
      return options.client.all<T>(call.sql, [url, sql, ...call.bindings, tlsConfigId]);
    },

    async run(sql: string, params: readonly unknown[] = []): Promise<void> {
      const call = rpcCall("ducknng_run_rpc", params);
      const [result] = await options.client.all<DucknngExecResult>(
        call.sql,
        [url, sql, ...call.bindings, tlsConfigId],
      );
      if (result?.ok !== true) {
        throw new Error("ducknng SqlConn remote exec failed: " + (result?.error ?? "missing result row"));
      }
    },
  };
}
