import type { BioGraphEdge, BioGraphNode, BioGraphSnapshot } from "../core/knowledge-graph.js";

/**
 * Minimal SQL port the KG-sync adapter writes through. A concrete DuckDB connection (or any backend
 * exposing the `bio_nodes`/`bio_edges` contract) implements it. Keeping the adapter behind this port
 * means the package needs no native database-driver dependency; the host wires a real connection.
 */
export interface KgSqlConn {
  all<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  run(sql: string, params?: readonly unknown[]): Promise<void>;
}

export interface SyncStudyNoteGraphOptions {
  /** Default true: compute counts only and write nothing. */
  dryRun?: boolean;
  /** Must be explicitly true to write. `dryRun: false` without this throws. */
  allowWrite?: boolean;
}

export interface SyncStudyNoteGraphResult {
  dryRun: boolean;
  nodesToDelete: number;
  edgesToDelete: number;
  nodesToInsert: number;
  edgesToInsert: number;
  /** Edges whose target id is absent from the snapshot's nodes (dangling links). Reported, never materialized as stub nodes. */
  danglingEdges: number;
}

// Ownership scope: the adapter owns exactly the memory-origin subgraph and nothing else.
// External edges that point INTO memory nodes (to_id 'memory:%' but from_id elsewhere) are not owned.
const OWNED_NODES = "bio_nodes WHERE family = 'memory'";
const OWNED_EDGES = "bio_edges WHERE from_id LIKE 'memory:%'";

function jsonParam(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

/**
 * Fail closed: the adapter only owns the memory subgraph, so it refuses to write a snapshot that
 * carries anything else. Every node must be `family: "memory"` with a `memory:` id, and every edge
 * must originate at a memory node (edge targets may be anything — dangling links are allowed).
 */
function assertMemorySubgraph(snapshot: BioGraphSnapshot): void {
  for (const node of snapshot.nodes) {
    if (node.family !== "memory" || !node.id.startsWith("memory:")) {
      throw new Error(`syncStudyNoteGraph: refusing non-memory node ${node.id} (family=${node.family})`);
    }
  }
  for (const edge of snapshot.edges) {
    if (!edge.from.startsWith("memory:")) throw new Error(`syncStudyNoteGraph: refusing edge from non-memory node ${edge.from}`);
  }
}

/**
 * Full re-sync of the `memory` subgraph from a pure snapshot. Effect contract:
 * - writes ONLY `bio_nodes(family='memory')` and `bio_edges(from_id LIKE 'memory:%')`; external edges
 *   pointing into memory nodes are not owned and left untouched;
 * - no network, no arbitrary SQL, all writes in one transaction;
 * - dry-run by default; writing requires `{ dryRun: false, allowWrite: true }`.
 *
 * Files remain the source of truth; this projects them into DuckDB as an index/cache.
 */
export async function syncStudyNoteGraph(
  conn: KgSqlConn,
  snapshot: BioGraphSnapshot,
  options: SyncStudyNoteGraphOptions = {},
): Promise<SyncStudyNoteGraphResult> {
  assertMemorySubgraph(snapshot);
  const dryRun = options.dryRun ?? true;
  if (!dryRun && options.allowWrite !== true) throw new Error("syncStudyNoteGraph: writing requires allowWrite: true");

  const [nodeRow] = await conn.all<{ n: number }>(`SELECT count(*) AS n FROM ${OWNED_NODES}`);
  const [edgeRow] = await conn.all<{ n: number }>(`SELECT count(*) AS n FROM ${OWNED_EDGES}`);
  const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
  const result: SyncStudyNoteGraphResult = {
    dryRun,
    nodesToDelete: Number(nodeRow?.n ?? 0),
    edgesToDelete: Number(edgeRow?.n ?? 0),
    nodesToInsert: snapshot.nodes.length,
    edgesToInsert: snapshot.edges.length,
    danglingEdges: snapshot.edges.filter((edge) => !nodeIds.has(edge.to)).length,
  };
  if (dryRun) return result;

  await conn.run("BEGIN");
  try {
    // Edges before nodes on delete, nodes before edges on insert: safe even if FK constraints are added later.
    await conn.run(`DELETE FROM ${OWNED_EDGES}`);
    await conn.run(`DELETE FROM ${OWNED_NODES}`);
    for (const node of snapshot.nodes) await insertNode(conn, node);
    for (const edge of snapshot.edges) await insertEdge(conn, edge);
    await conn.run("COMMIT");
  } catch (error) {
    await conn.run("ROLLBACK");
    throw error;
  }
  return result;
}

async function insertNode(conn: KgSqlConn, node: BioGraphNode): Promise<void> {
  await conn.run(
    "INSERT INTO bio_nodes (node_id, family, type, label, description, attrs, trust) VALUES (?, ?, ?, ?, ?, ?::JSON, ?::JSON)",
    [node.id, node.family, node.type, node.label, node.description ?? null, jsonParam(node.attrs), jsonParam(node.trust)],
  );
}

async function insertEdge(conn: KgSqlConn, edge: BioGraphEdge): Promise<void> {
  await conn.run(
    "INSERT INTO bio_edges (from_id, to_id, predicate, attrs, trust) VALUES (?, ?, ?, ?::JSON, ?::JSON)",
    [edge.from, edge.to, edge.predicate, jsonParam(edge.attrs), jsonParam(edge.trust)],
  );
}
