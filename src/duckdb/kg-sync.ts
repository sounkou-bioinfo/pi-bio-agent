import type { BioGraphEdge, BioGraphNode, BioGraphSnapshot } from "../core/knowledge-graph.js";

/**
 * Minimal SQL port the KG-sync adapter writes through, implemented by a concrete DuckDB connection
 * exposing the `bio_nodes`/`bio_edges` contract. The sync logic writes through this port so it stays
 * testable (fake port) and injectable (a host can pass its own connection); the concrete
 * `@duckdb/node-api` binding (`duckdbNodeConn`) is separate. The adapter emits DuckDB-dialect SQL
 * (e.g. `?::JSON` casts), so the port is not dialect-neutral.
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
// Memory-origin edges whose target node does not exist: the persisted dangling links.
const DANGLING_MEMORY_EDGES = "bio_edges e WHERE e.from_id LIKE 'memory:%' AND NOT EXISTS (SELECT 1 FROM bio_nodes n WHERE n.node_id = e.to_id)";
const MEMORY_NODE_ID_RE = /^memory:[a-z0-9]+(?:-[a-z0-9]+)*$/;

function jsonParam(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

/**
 * Fail closed: the adapter only owns the memory subgraph, so it refuses to write a snapshot that
 * carries anything else, or one that is internally inconsistent. Every node must be `family: "memory"`
 * with a well-formed `memory:<slug>` id and a unique id; every edge must originate at a memory node
 * (targets may be anything — dangling links are allowed) and be unique by `(from, to, predicate)`.
 * A normal file-backed note set does not produce duplicates, so a duplicate reaching the adapter is a
 * caller/input bug surfaced here rather than silently deduped (which would skew the reported insert
 * counts) or left to a constraint rollback.
 */
function assertMemorySubgraph(snapshot: BioGraphSnapshot): void {
  const seenNodes = new Set<string>();
  for (const node of snapshot.nodes) {
    if (node.family !== "memory" || !MEMORY_NODE_ID_RE.test(node.id)) {
      throw new Error(`syncStudyNoteGraph: refusing non-memory node ${node.id} (family=${node.family})`);
    }
    if (seenNodes.has(node.id)) throw new Error(`syncStudyNoteGraph: duplicate node id ${node.id}`);
    seenNodes.add(node.id);
  }
  const seenEdges = new Set<string>();
  for (const edge of snapshot.edges) {
    if (!MEMORY_NODE_ID_RE.test(edge.from)) throw new Error(`syncStudyNoteGraph: refusing edge from non-memory node ${edge.from}`);
    const key = JSON.stringify([edge.from, edge.to, edge.predicate]);
    if (seenEdges.has(key)) throw new Error(`syncStudyNoteGraph: duplicate edge ${edge.from} -> ${edge.to} (${edge.predicate})`);
    seenEdges.add(key);
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

export interface CreateBioGraphSchemaOptions {
  /** Emit `CREATE TABLE IF NOT EXISTS`, so the call is idempotent against an existing store. */
  ifNotExists?: boolean;
}

/**
 * Create the `bio_nodes`/`bio_edges` tables this adapter writes into, plus indexes for the scans and
 * join the sync runs (`family`, `from_id`, `to_id`). DuckDB-dialect DDL.
 *
 * These are the *global* KG tables, not memory-only, so their constraints encode KG-wide policy:
 * - `node_id PRIMARY KEY`;
 * - `UNIQUE (from_id, to_id, predicate)` — **one edge per (from, to, predicate)**. Multiple evidences
 *   for the same relationship aggregate in the edge's `trust` block (`TrustBlock.evidence[]`), not as
 *   parallel rows. If parallel evidence edges with the same triple are ever required, this constraint
 *   must be revisited.
 * - No foreign keys — dangling link targets are allowed by design, so an edge may reference a node id
 *   that does not exist.
 */
export async function createBioGraphSchema(conn: KgSqlConn, options: CreateBioGraphSchemaOptions = {}): Promise<void> {
  const ifNotExists = options.ifNotExists ? "IF NOT EXISTS " : "";
  await conn.run(
    `CREATE TABLE ${ifNotExists}bio_nodes (` +
      "node_id TEXT PRIMARY KEY, family TEXT NOT NULL, type TEXT NOT NULL, label TEXT NOT NULL, " +
      "description TEXT, attrs JSON, trust JSON)",
  );
  await conn.run(
    `CREATE TABLE ${ifNotExists}bio_edges (` +
      "from_id TEXT NOT NULL, to_id TEXT NOT NULL, predicate TEXT NOT NULL, attrs JSON, trust JSON, " +
      "UNIQUE (from_id, to_id, predicate))",
  );
  await conn.run(`CREATE INDEX ${ifNotExists}bio_nodes_family ON bio_nodes (family)`);
  await conn.run(`CREATE INDEX ${ifNotExists}bio_edges_from_id ON bio_edges (from_id)`);
  await conn.run(`CREATE INDEX ${ifNotExists}bio_edges_to_id ON bio_edges (to_id)`);
}

export interface BioGraphEdgeRow {
  from: string;
  to: string;
  predicate: string;
}

export interface ReportStudyNoteGraphOptions {
  /** Cap how many dangling / external-inbound rows are returned. The *counts* stay exact. Default: no cap. */
  limit?: number;
}

export interface StudyNoteGraphReport {
  memoryNodes: number;
  memoryEdges: number;
  /** Exact count of memory-origin edges whose target node does not exist. */
  danglingEdgeCount: number;
  /** Persisted dangling links to fix or fill (capped at `limit`; may be fewer than `danglingEdgeCount`). */
  danglingEdges: BioGraphEdgeRow[];
  /** Exact count of non-owned edges pointing into memory nodes (these block a write). */
  externalInboundEdgeCount: number;
  /** Non-owned inbound edges to remove/re-home (capped at `limit`; may be fewer than `externalInboundEdgeCount`). */
  externalInboundEdges: BioGraphEdgeRow[];
}

function toEdgeRows(rows: Array<{ from_id: string; to_id: string; predicate: string }>): BioGraphEdgeRow[] {
  return rows.map((row) => ({ from: row.from_id, to: row.to_id, predicate: row.predicate }));
}

function limitClause(limit?: number): string {
  if (limit === undefined) return "";
  if (!Number.isInteger(limit) || limit < 0) throw new Error(`reportStudyNoteGraph: limit must be a non-negative integer, got ${limit}`);
  return ` LIMIT ${limit}`;
}

/**
 * Read-only report over the memory subgraph: exact counts for the (potentially large) totals and the two
 * problem sets, plus the actual problem rows capped at `limit` (progressive disclosure — summarize totals,
 * sample the fixable rows). No writes, no transaction; safe to run any time.
 */
export async function reportStudyNoteGraph(conn: KgSqlConn, options: ReportStudyNoteGraphOptions = {}): Promise<StudyNoteGraphReport> {
  const lim = limitClause(options.limit);
  const [nodeRow] = await conn.all<{ n: number }>(`SELECT count(*) AS n FROM ${OWNED_NODES}`);
  const [edgeRow] = await conn.all<{ n: number }>(`SELECT count(*) AS n FROM ${OWNED_EDGES}`);
  const [danglingCountRow] = await conn.all<{ n: number }>(`SELECT count(*) AS n FROM ${DANGLING_MEMORY_EDGES}`);
  const [externalCountRow] = await conn.all<{ n: number }>(`SELECT count(*) AS n FROM ${EXTERNAL_INBOUND_EDGES}`);
  // Deterministic order so a capped sample is stable across runs.
  const order = " ORDER BY e.from_id, e.to_id, e.predicate";
  const dangling = await conn.all<{ from_id: string; to_id: string; predicate: string }>(`SELECT e.from_id, e.to_id, e.predicate FROM ${DANGLING_MEMORY_EDGES}${order}${lim}`);
  const externalInbound = await conn.all<{ from_id: string; to_id: string; predicate: string }>(`SELECT e.from_id, e.to_id, e.predicate FROM ${EXTERNAL_INBOUND_EDGES}${order}${lim}`);
  return {
    memoryNodes: Number(nodeRow?.n ?? 0),
    memoryEdges: Number(edgeRow?.n ?? 0),
    danglingEdgeCount: Number(danglingCountRow?.n ?? 0),
    danglingEdges: toEdgeRows(dangling),
    externalInboundEdgeCount: Number(externalCountRow?.n ?? 0),
    externalInboundEdges: toEdgeRows(externalInbound),
  };
}
