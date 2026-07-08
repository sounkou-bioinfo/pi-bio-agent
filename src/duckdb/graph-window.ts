import type { ResourceHandle } from "../core/resources.js";
import type { SqlConn } from "../core/ports.js";

const IDENT_PART_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface GraphWindowEdge {
  from_id: string;
  predicate: string;
  to_id: string;
}

export interface GraphQueryWindowOptions {
  table?: string;
  startId: string;
  direction?: "out" | "in" | "both";
  predicates?: readonly string[];
  limit?: number;
  offset?: number;
}

export interface GraphQueryWindow {
  schema: "pi-bio.graph_query_window.v1";
  table: string;
  startId: string;
  direction: "out" | "in" | "both";
  predicates: string[];
  limit: number;
  offset: number;
  rows: GraphWindowEdge[];
  totalCount: number;
  omittedCount: number;
  continuation?: ResourceHandle;
}

function renderTableRef(table: string): string {
  const parts = table.split(".");
  if (parts.length === 0 || parts.length > 3 || parts.some((part) => !IDENT_PART_RE.test(part))) {
    throw new Error(`graph window: table '${table}' must be a SQL identifier`);
  }
  return parts.map((part) => `"${part.replace(/"/g, '""')}"`).join(".");
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 10_000) throw new Error("graph window: limit must be an integer between 1 and 10000");
  return limit;
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isInteger(offset) || offset < 0) throw new Error("graph window: offset must be a non-negative integer");
  return offset;
}

function continuationHandle(opts: Required<Pick<GraphQueryWindowOptions, "startId" | "direction">> & { table: string; predicates: string[]; limit: number; offset: number }): ResourceHandle {
  const params = new URLSearchParams();
  params.set("table", opts.table);
  params.set("startId", opts.startId);
  params.set("direction", opts.direction);
  params.set("limit", String(opts.limit));
  params.set("offset", String(opts.offset));
  for (const p of opts.predicates) params.append("predicate", p);
  return { mode: "virtual", name: "graph_query_window", pointer: { uri: `graph-window:${params.toString()}`, format: "graph-window" } };
}

/**
 * A bounded one-hop window over a compiled graph table (`bio_edges`, `bio_edges_as_of`, `entailed_edge`, ...).
 * This is the context-control shape for high-degree nodes: return a page plus omitted counts and a continuation
 * handle, without introducing a graph runtime or loading a whole neighborhood into the prompt.
 */
export async function queryGraphWindow(conn: SqlConn, options: GraphQueryWindowOptions): Promise<GraphQueryWindow> {
  const table = options.table ?? "bio_edges";
  const tableSql = renderTableRef(table);
  if (typeof options.startId !== "string" || !options.startId.trim()) throw new Error("graph window: startId is required");
  const direction = options.direction ?? "out";
  if (!["out", "in", "both"].includes(direction)) throw new Error("graph window: direction must be out, in, or both");
  const predicates = [...(options.predicates ?? [])];
  if (predicates.some((p) => typeof p !== "string" || !p.trim())) throw new Error("graph window: predicates must be non-empty strings");
  const limit = normalizeLimit(options.limit);
  const offset = normalizeOffset(options.offset);

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (direction === "out" || direction === "both") {
    clauses.push("(from_id = ?)");
    params.push(options.startId);
  }
  if (direction === "in" || direction === "both") {
    clauses.push("(to_id = ?)");
    params.push(options.startId);
  }
  let where = `(${clauses.join(" OR ")})`;
  if (predicates.length > 0) {
    where += ` AND predicate IN (${predicates.map(() => "?").join(", ")})`;
    params.push(...predicates);
  }

  const [{ n }] = await conn.all<{ n: number }>(`SELECT count(*) AS n FROM ${tableSql} WHERE ${where}`, params);
  const totalCount = Number(n ?? 0);
  const rows = await conn.all<GraphWindowEdge>(
    `SELECT from_id, predicate, to_id FROM ${tableSql} WHERE ${where} ORDER BY predicate, from_id, to_id LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const omittedCount = Math.max(0, totalCount - offset - rows.length);
  return {
    schema: "pi-bio.graph_query_window.v1",
    table,
    startId: options.startId,
    direction,
    predicates,
    limit,
    offset,
    rows,
    totalCount,
    omittedCount,
    ...(omittedCount > 0 ? { continuation: continuationHandle({ table, startId: options.startId, direction, predicates, limit, offset: offset + rows.length }) } : {}),
  };
}
