import { graphSqlContract } from "../core/knowledge-graph.js";
import { ontologySqlContract } from "../core/ontology.js";

export function bioSqlContract(): string {
  return [
    "# pi-bio SQL contract",
    "",
    "The agent should reason against stable views, not raw ad hoc files. A backend may implement these views using DuckDB tables, community extensions, attached files, or shell-generated staging tables.",
    "",
    graphSqlContract(),
    "",
    ontologySqlContract(),
    "",
    "bio_intervals(node_id, seqid, start, end, coordinate_system, assembly, strand, attrs JSON)",
    "bio_variants(node_id, seqid, pos, ref, alt, id, assembly, attrs JSON)",
    "bio_features(node_id, feature_id, feature_type, seqid, start, end, coordinate_system, assembly, strand, attrs JSON)",
    "bio_matrices(matrix_id, row_id, column_id, value, attrs JSON)",
    "",
    "Rules:",
    "- Always state coordinate system and assembly when using genomic positions.",
    "- Use ontology_terms/edges/mappings to resolve meaning before hard-coding labels.",
    "- Use graph edges for provenance and lineage instead of burying lineage only in JSON.",
    "- Prefer one scoped read-only SELECT for counts/joins/trends over serial context loading.",
  ].join("\n");
}
