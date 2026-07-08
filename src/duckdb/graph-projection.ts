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

function quoteQualifiedIdent(id: string): string {
  return id.split(".").map(quoteIdent).join(".");
}

async function materializeClosureArtifact(conn: SqlConn, profile: GraphProjectionProfile, targetTable: string): Promise<number> {
  const artifactTable = profile.closure?.artifactTable;
  if (!artifactTable) throw new Error("materializeGraphProjectionProfile: closure artifactTable is required");
  const predicates = profile.closure?.transitivePredicates ?? [];
  const predicateFilter = predicates.length > 0 ? ` WHERE ${quoteIdent(profile.columns.predicate)} IN (${predicates.map(() => "?").join(", ")})` : "";
  await conn.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(targetTable)} AS
     SELECT ${quoteIdent(profile.columns.from)} AS from_id,
            ${quoteIdent(profile.columns.predicate)} AS predicate,
            ${quoteIdent(profile.columns.to)} AS to_id
     FROM ${quoteQualifiedIdent(artifactTable)}${predicateFilter}`,
    predicates,
  );
  await conn.run(`CREATE INDEX IF NOT EXISTS ${quoteIdent(`${targetTable}_obj`)} ON ${quoteIdent(targetTable)} (to_id, predicate)`);
  await conn.run(`CREATE INDEX IF NOT EXISTS ${quoteIdent(`${targetTable}_subj`)} ON ${quoteIdent(targetTable)} (from_id, predicate)`);
  const [row] = await conn.all<{ n: bigint }>(`SELECT count(*) AS n FROM ${quoteIdent(targetTable)}`);
  return Number(row?.n ?? 0);
}

/** Execute a graph projection profile over already-materialized DuckDB relations.
 *
 * Core owns the profile contract and emits the projection SQL; this DuckDB helper executes that SQL and, for local
 * closure policies, materializes the matching `entailed_edge` table. Declared upstream closure artifacts are copied
 * into the same target shape; the host/resolver remains responsible for staging and receipting the artifact.
 */
export async function materializeGraphProjectionProfile(conn: SqlConn, profile: GraphProjectionProfile): Promise<MaterializedGraphProjection> {
  const errors = validateGraphProjectionProfile(profile);
  if (errors.length) throw new Error(`invalid graph projection profile: ${errors.join("; ")}`);

  const edgesTable = targetEdgesTable(profile);
  await conn.run(graphProjectionSql(profile, { allowPolicyFields: true }));
  const [edgeRow] = await conn.all<{ n: bigint }>(`SELECT count(*) AS n FROM ${quoteIdent(edgesTable)}`);
  const out: MaterializedGraphProjection = { edgesTable, edgeCount: Number(edgeRow?.n ?? 0) };

  if (!profile.closure) return out;
  const closureTable = targetClosureTable(profile);
  if (profile.closure.source !== "local_cte") {
    const closureCount = await materializeClosureArtifact(conn, profile, closureTable);
    return { ...out, closureTable, closureCount };
  }
  const closureCount = await materializeEntailedEdges(conn, profile.closure.transitivePredicates ?? [], {
    sourceTable: edgesTable,
    targetTable: closureTable,
  });
  return { ...out, closureTable, closureCount };
}
