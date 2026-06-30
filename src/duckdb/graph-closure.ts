import type { SqlConn } from "../core/ports.js";

// SemanticSQL's shape, applied to OUR OWN graph (not just imported ontologies). `bio_edges(from_id,
// predicate, to_id)` is the statement/edge base — subject=from_id, predicate, object=to_id, exactly like a
// SemanticSQL `statements`/`edge` table. The one piece that makes it powerful is `entailed_edge`: the
// precomputed transitive closure over the TRANSITIVE predicates (e.g. rdfs:subClassOf, BFO:0000050 part_of).
// With it, descendants / ancestors / subsumption / graph-walk are a single indexed JOIN — no bespoke
// traversal code, no graph runtime — and the SAME SQL grounds a term in an imported ontology and walks our
// own committed graph. Which predicates are transitive is DATA (the caller declares them); the only TS is
// this generic projection. This is the bet at the graph layer: graph-as-SQL, closure-as-data.

export const ENTAILED_EDGE_TABLE = "entailed_edge";
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Closure source/target tables. Defaults = the compiled graph (`bio_edges` → `entailed_edge`). Phase 4's as-of
 *  layer passes `bio_edges_as_of` → `entailed_edge_as_of` so the SAME algorithm closes a point-in-time projection. */
export interface ClosureTables { sourceTable?: string; targetTable?: string; }

/**
 * Materialize `entailed_edge(from_id, predicate, to_id)` as the transitive closure of `bio_edges` over the
 * given transitive predicates (each predicate closed independently). Returns the row count. A recursive CTE
 * with UNION (not UNION ALL) so cycles terminate. Idempotent (CREATE OR REPLACE). The closure is the direct
 * edges plus all transitively-reachable pairs; a reflexive X→X appears only when X lies on a cycle (then X is
 * genuinely reachable from itself) — we do not blanket-add X→X for every node.
 *
 * Descendants of X (is-a):  SELECT from_id FROM entailed_edge WHERE to_id = ? AND predicate = 'rdfs:subClassOf'
 * Ancestors  of X (is-a):  SELECT to_id   FROM entailed_edge WHERE from_id = ? AND predicate = 'rdfs:subClassOf'
 */
export async function materializeEntailedEdges(conn: SqlConn, transitivePredicates: readonly string[], tables: ClosureTables = {}): Promise<number> {
  const source = tables.sourceTable ?? "bio_edges";
  const target = tables.targetTable ?? ENTAILED_EDGE_TABLE;
  for (const [label, id] of [["sourceTable", source], ["targetTable", target]] as const) {
    if (!IDENT.test(id)) throw new Error(`materializeEntailedEdges: ${label} '${id}' must be a SQL identifier`);
  }
  if (transitivePredicates.length === 0) {
    await conn.run(`CREATE OR REPLACE TABLE ${target} (from_id TEXT, predicate TEXT, to_id TEXT)`);
    return 0;
  }
  const placeholders = transitivePredicates.map(() => "?").join(", ");
  await conn.run(
    `CREATE OR REPLACE TABLE ${target} AS
     WITH RECURSIVE closure(from_id, predicate, to_id) AS (
       SELECT from_id, predicate, to_id FROM ${source} WHERE predicate IN (${placeholders})
       UNION
       SELECT c.from_id, c.predicate, e.to_id
       FROM closure c JOIN ${source} e ON e.from_id = c.to_id AND e.predicate = c.predicate
     )
     SELECT DISTINCT from_id, predicate, to_id FROM closure`,
    [...transitivePredicates],
  );
  // Index the two lookup directions: descendants by (to_id, predicate), ancestors by (from_id, predicate).
  await conn.run(`CREATE INDEX IF NOT EXISTS ${target}_obj ON ${target} (to_id, predicate)`);
  await conn.run(`CREATE INDEX IF NOT EXISTS ${target}_subj ON ${target} (from_id, predicate)`);
  const [row] = await conn.all<{ n: number }>(`SELECT count(*) AS n FROM ${target}`);
  return Number(row?.n ?? 0);
}
