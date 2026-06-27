import type { BioGraphEdge, BioGraphNode, BioGraphSnapshot } from "../core/knowledge-graph.js";

/**
 * Minimal SQL port the KG-sync adapter writes through, implemented by a concrete DuckDB connection
 * exposing the `bio_nodes`/`bio_edges` contract. Keeping the adapter behind this port means the
 * package needs no native database-driver dependency; the host wires a real connection. The adapter
 * emits DuckDB-dialect SQL (e.g. `?::JSON` casts), so the port is not dialect-neutral.
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
  /** Non-owned edges pointing into memory nodes. Reported in dry-runs; writes refuse while any exist. */
  externalInboundEdges: number;
}

// Ownership scope: the adapter owns exactly the memory-origin subgraph and nothing else.
// External edges that point INTO memory nodes (non-owned origin) are not owned.
const OWNED_NODES = "bio_nodes WHERE family = 'memory'";
const OWNED_EDGES = "bio_edges WHERE from_id LIKE 'memory:%'";
// The guard must protect exactly the delete set (the family='memory' nodes), so it joins inbound edges
// to those rows rather than matching a to_id prefix — otherwise it over-blocks edges to missing memory:*
// targets and under-protects family='memory' nodes whose id is not a well-formed memory: id.
const EXTERNAL_INBOUND_EDGES = "bio_edges e JOIN bio_nodes n ON e.to_id = n.node_id WHERE n.family = 'memory' AND e.from_id NOT LIKE 'memory:%'";
const MEMORY_NODE_ID_RE = /^memory:[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
    if (node.family !== "memory" || !MEMORY_NODE_ID_RE.test(node.id)) {
      throw new Error(`syncStudyNoteGraph: refusing non-memory node ${node.id} (family=${node.family})`);
    }
  }
  for (const edge of snapshot.edges) {
    if (!MEMORY_NODE_ID_RE.test(edge.from)) throw new Error(`syncStudyNoteGraph: refusing edge from non-memory node ${edge.from}`);
  }
}

/** Private helper: read the owned-subgraph delete counts plus the non-owned external-inbound count. */
async function countOwned(conn: KgSqlConn): Promise<Pick<SyncStudyNoteGraphResult, "nodesToDelete" | "edgesToDelete" | "externalInboundEdges">> {
  const [nodeRow] = await conn.all<{ n: number }>(`SELECT count(*) AS n FROM ${OWNED_NODES}`);
  const [edgeRow] = await conn.all<{ n: number }>(`SELECT count(*) AS n FROM ${OWNED_EDGES}`);
  const [externalInboundRow] = await conn.all<{ n: number }>(`SELECT count(*) AS n FROM ${EXTERNAL_INBOUND_EDGES}`);
  return {
    nodesToDelete: Number(nodeRow?.n ?? 0),
    edgesToDelete: Number(edgeRow?.n ?? 0),
    externalInboundEdges: Number(externalInboundRow?.n ?? 0),
  };
}

/**
 * Full re-sync of the `memory` subgraph from a pure snapshot. Effect contract:
 * - writes ONLY `bio_nodes(family='memory')` and `bio_edges(from_id LIKE 'memory:%')`; external edges
 *   pointing into memory nodes are not owned, and writes fail closed while any exist;
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

  const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
  const projection = {
    nodesToInsert: snapshot.nodes.length,
    edgesToInsert: snapshot.edges.length,
    danglingEdges: snapshot.edges.filter((edge) => !nodeIds.has(edge.to)).length,
  };

  if (dryRun) return { dryRun: true, ...(await countOwned(conn)), ...projection };

  // Write mode: count and run the fail-closed external-inbound check INSIDE the transaction, so the
  // guarantee can't drift between the check and the delete (TOCTOU under a concurrent connection).
  await conn.run("BEGIN");
  try {
    const counts = await countOwned(conn);
    if (counts.externalInboundEdges > 0) {
      throw new Error(`syncStudyNoteGraph: refusing to delete memory nodes while ${counts.externalInboundEdges} non-owned edges point into them`);
    }
    // Edges before nodes on delete, nodes before edges on insert: safe even if FK constraints are added later.
    await conn.run(`DELETE FROM ${OWNED_EDGES}`);
    await conn.run(`DELETE FROM ${OWNED_NODES}`);
    for (const node of snapshot.nodes) await insertNode(conn, node);
    for (const edge of snapshot.edges) await insertEdge(conn, edge);
    await conn.run("COMMIT");
    return { dryRun: false, ...counts, ...projection };
  } catch (error) {
    await conn.run("ROLLBACK");
    throw error;
  }
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
