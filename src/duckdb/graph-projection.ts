import type { GraphProjectionProfile } from "../core/graph-projection.js";
import { graphProjectionSql, validateGraphProjectionProfile } from "../core/graph-projection.js";
import type { SqlConn } from "../core/ports.js";
import { materializeEntailedEdges } from "./graph-closure.js";

export interface MaterializedGraphProjection {
  edgesTable: string;
  edgeCount: number;
  closureTable?: string;
  closureCount?: number;
}

function targetEdgesTable(profile: GraphProjectionProfile): string {
  return profile.target?.edgesTable ?? (profile.target?.temporal?.kind === "as_of" ? "bio_edges_as_of" : "bio_edges");
}

function targetClosureTable(profile: GraphProjectionProfile): string {
  return profile.target?.closureTable ?? (profile.target?.temporal?.kind === "as_of" ? "entailed_edge_as_of" : "entailed_edge");
}

function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, "\"\"")}"`;
}

/** Execute a graph projection profile over already-materialized DuckDB relations.
 *
 * Core owns the profile contract and emits the projection SQL; this DuckDB helper executes that SQL and, for local
 * closure policies, materializes the matching `entailed_edge` table. Non-local closure policies remain explicit
 * host/resolver work and fail closed here.
 */
export async function materializeGraphProjectionProfile(conn: SqlConn, profile: GraphProjectionProfile): Promise<MaterializedGraphProjection> {
  const errors = validateGraphProjectionProfile(profile);
  if (errors.length) throw new Error(`invalid graph projection profile: ${errors.join("; ")}`);

  const edgesTable = targetEdgesTable(profile);
  await conn.run(graphProjectionSql(profile, { allowPolicyFields: true }));
  const [edgeRow] = await conn.all<{ n: bigint }>(`SELECT count(*) AS n FROM ${quoteIdent(edgesTable)}`);
  const out: MaterializedGraphProjection = { edgesTable, edgeCount: Number(edgeRow?.n ?? 0) };

  if (!profile.closure) return out;
  if (profile.closure.source !== "local_cte") {
    throw new Error(`materializeGraphProjectionProfile: closure source '${profile.closure.source}' is not locally materializable`);
  }
  const closureTable = targetClosureTable(profile);
  const closureCount = await materializeEntailedEdges(conn, profile.closure.transitivePredicates ?? [], {
    sourceTable: edgesTable,
    targetTable: closureTable,
  });
  return { ...out, closureTable, closureCount };
}
