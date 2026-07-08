import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { join } from "node:path";
import type { SqlConn } from "../core/ports.js";
import { canonicalDigest } from "../core/reproducibility.js";

const FAR_FUTURE = "9999-12-31T23:59:59.999Z";

export const TRAINING_CORPUS_TABLES = {
  sessions: "training_corpus_sessions",
  messages: "training_corpus_messages",
  turns: "training_corpus_turns",
  toolCalls: "training_corpus_tool_calls",
  runs: "training_corpus_runs",
  artifacts: "training_corpus_artifacts",
  judgments: "training_corpus_judgments",
  hostEvents: "training_corpus_host_events",
  hostEventLinks: "training_corpus_host_event_links",
  units: "training_corpus_units",
} as const;

export type TrainingCorpusTableName = keyof typeof TRAINING_CORPUS_TABLES;

export interface TrainingCorpusOptions {
  /** As-of timestamp for the derived projection. Defaults to the latest known state. */
  asOf?: string;
}

export interface TrainingCorpusTableReceipt {
  table: string;
  rows: number;
  parquetPath?: string;
  parquetDigest?: `sha256:${string}`;
}

export interface TrainingCorpusReceipt {
  schema: "pi-bio.training_corpus.v2";
  asOf: string;
  redaction: "digest_only";
  tables: Record<TrainingCorpusTableName, TrainingCorpusTableReceipt>;
  digest: `sha256:${string}`;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function sha256File(path: string): Promise<`sha256:${string}`> {
  const h = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on("data", (chunk) => h.update(chunk)).on("error", reject).on("end", resolve);
  });
  return `sha256:${h.digest("hex")}`;
}

async function tableCounts(conn: SqlConn, asOf: string, files: Partial<Record<TrainingCorpusTableName, { parquetPath: string; parquetDigest: `sha256:${string}` }>> = {}): Promise<TrainingCorpusReceipt> {
  const tables = {} as Record<TrainingCorpusTableName, TrainingCorpusTableReceipt>;
  for (const [name, table] of Object.entries(TRAINING_CORPUS_TABLES) as Array<[TrainingCorpusTableName, string]>) {
    const rows = await conn.all<{ n: bigint | number }>(`SELECT count(*) AS n FROM ${table}`);
    tables[name] = { table, rows: Number(rows[0]?.n ?? 0), ...files[name] };
  }
  const stable = {
    schema: "pi-bio.training_corpus.v2",
    asOf,
    redaction: "digest_only",
    tables: Object.fromEntries(Object.entries(tables).map(([name, t]) => [name, { table: t.table, rows: t.rows, parquetDigest: t.parquetDigest }])),
  };
  return { ...stable, tables, digest: canonicalDigest(stable) } as TrainingCorpusReceipt;
}

/** Materialize a digest-first corpus projection from the existing observation ledger.
 *
 * The projection deliberately keeps payloads out of the corpus tables: messages carry content digests, tools carry
 * args/result digests, runs carry CAS/replay/receipt digests, and artifacts carry CAS URIs. Raw session JSONL and
 * result bytes remain in CAS or the run ledger. Applications that need private text can join back to their own
 * authorized source of truth; the core export is the redacted training/publication skeleton.
 */
export async function materializeTrainingCorpus(conn: SqlConn, opts: TrainingCorpusOptions = {}): Promise<TrainingCorpusReceipt> {
  const asOf = opts.asOf ?? FAR_FUTURE;
  await conn.all(`SELECT ?::TIMESTAMPTZ`, [asOf]);
  const t = sqlString(asOf);

  await conn.run(
    `CREATE OR REPLACE TEMP VIEW training_corpus_latest_observations AS
     SELECT * EXCLUDE (rn) FROM (
       SELECT *,
              row_number() OVER (PARTITION BY statement_key ORDER BY recorded_at::TIMESTAMPTZ DESC, observation_id DESC) AS rn
       FROM bio_observations
       WHERE recorded_at::TIMESTAMPTZ <= ${t}::TIMESTAMPTZ
         AND (valid_from IS NULL OR valid_from::TIMESTAMPTZ <= ${t}::TIMESTAMPTZ)
         AND (valid_to IS NULL OR valid_to::TIMESTAMPTZ > ${t}::TIMESTAMPTZ)
     ) WHERE rn = 1`,
  );

  await conn.run(
    `CREATE OR REPLACE TEMP TABLE ${TRAINING_CORPUS_TABLES.sessions} AS
     SELECT
       s.subject_id AS session_node,
       json_extract_string(s.value_json, '$.session_id') AS session_id,
       json_extract_string(s.value_json, '$.raw_digest') AS raw_digest,
       json_extract_string(s.value_json, '$.raw_uri') AS raw_cas_uri,
       try_cast(json_extract_string(s.value_json, '$.entries') AS INTEGER) AS entries,
       try_cast(json_extract_string(s.value_json, '$.messages') AS INTEGER) AS messages,
       try_cast(json_extract_string(s.value_json, '$.turns') AS INTEGER) AS turns,
       try_cast(json_extract_string(s.value_json, '$.tool_calls') AS INTEGER) AS tool_calls,
       try_cast(json_extract_string(s.value_json, '$.artifacts') AS INTEGER) AS artifacts,
       coalesce(
         json_extract_string(s.value_json, '$.parent_session_id'),
         CASE WHEN starts_with(parent.object_id, 'session:') THEN substr(parent.object_id, length('session:') + 1) ELSE parent.object_id END
       ) AS parent_session_id,
       s.recorded_at,
       s.source,
       s.digest
     FROM training_corpus_latest_observations s
     LEFT JOIN training_corpus_latest_observations parent
       ON parent.subject_id = s.subject_id AND parent.predicate = 'parent_session' AND parent.object_id IS NOT NULL
     WHERE s.predicate = 'session' AND starts_with(s.subject_id, 'session:')
     ORDER BY s.recorded_at::TIMESTAMPTZ, s.subject_id`,
  );

  await conn.run(
    `CREATE OR REPLACE TEMP TABLE ${TRAINING_CORPUS_TABLES.messages} AS
     SELECT
       se.subject_id AS session_node,
       m.subject_id AS message_node,
       json_extract_string(m.value_json, '$.role') AS role,
       json_extract_string(m.value_json, '$.content_digest') AS content_digest,
       json_extract_string(m.value_json, '$.parent_message') AS parent_message_node,
       json_extract_string(m.value_json, '$.provider') AS provider,
       json_extract_string(m.value_json, '$.model') AS model,
       json_extract_string(m.value_json, '$.api') AS api,
       json_extract_string(m.value_json, '$.stop_reason') AS stop_reason,
       json_extract_string(m.value_json, '$.usage_digest') AS usage_digest,
       try_cast(json_extract_string(m.value_json, '$.line_number') AS INTEGER) AS line_number,
       m.recorded_at,
       m.source,
       m.digest
     FROM training_corpus_latest_observations m
     LEFT JOIN training_corpus_latest_observations se
       ON se.predicate = 'has_message' AND se.object_id = m.subject_id
     WHERE m.predicate = 'message' AND starts_with(m.subject_id, 'msg:')
     ORDER BY m.recorded_at::TIMESTAMPTZ, m.subject_id`,
  );

  await conn.run(
    `CREATE OR REPLACE TEMP TABLE ${TRAINING_CORPUS_TABLES.turns} AS
     SELECT
       se.subject_id AS session_node,
       tr.subject_id AS turn_node,
       json_extract_string(tr.value_json, '$.kind') AS kind,
       coalesce(input_edge.object_id, json_extract_string(tr.value_json, '$.input_message')) AS input_message_node,
       coalesce(output_edge.object_id, json_extract_string(tr.value_json, '$.output_message')) AS output_message_node,
       json_extract_string(tr.value_json, '$.provider') AS provider,
       json_extract_string(tr.value_json, '$.model') AS model,
       json_extract_string(tr.value_json, '$.api') AS api,
       json_extract_string(tr.value_json, '$.context_digest') AS context_digest,
       json_extract_string(tr.value_json, '$.output_digest') AS output_digest,
       json_extract_string(tr.value_json, '$.reproducibility.verdict') AS reproducibility_verdict,
       json_extract_string(tr.value_json, '$.reproducibility.reason') AS reproducibility_reason,
       tr.recorded_at,
       tr.source,
       tr.digest
     FROM training_corpus_latest_observations tr
     LEFT JOIN training_corpus_latest_observations se
       ON se.predicate = 'has_turn' AND se.object_id = tr.subject_id
     LEFT JOIN training_corpus_latest_observations input_edge
       ON input_edge.subject_id = tr.subject_id AND input_edge.predicate = 'input' AND input_edge.object_id IS NOT NULL
     LEFT JOIN training_corpus_latest_observations output_edge
       ON output_edge.subject_id = tr.subject_id AND output_edge.predicate = 'output' AND output_edge.object_id IS NOT NULL
     WHERE tr.predicate = 'turn' AND starts_with(tr.subject_id, 'turn:')
     ORDER BY tr.recorded_at::TIMESTAMPTZ, tr.subject_id`,
  );

  await conn.run(
    `CREATE OR REPLACE TEMP TABLE ${TRAINING_CORPUS_TABLES.toolCalls} AS
     SELECT
       calls.subject_id AS turn_node,
       tc.subject_id AS toolcall_node,
       coalesce(json_extract_string(tc.value_json, '$.name'), json_extract_string(res.value_json, '$.name')) AS name,
       json_extract_string(tc.value_json, '$.args_digest') AS args_digest,
       json_extract_string(res.value_json, '$.result_digest') AS result_digest,
       try_cast(json_extract_string(res.value_json, '$.is_error') AS BOOLEAN) AS is_error,
       executes.object_id AS run_node,
       tc.recorded_at,
       tc.source,
       tc.digest
     FROM training_corpus_latest_observations tc
     LEFT JOIN training_corpus_latest_observations calls
       ON calls.predicate = 'calls' AND calls.object_id = tc.subject_id
     LEFT JOIN training_corpus_latest_observations res
       ON res.statement_key = tc.subject_id || ':result' AND res.predicate = 'tool_result'
     LEFT JOIN training_corpus_latest_observations executes
       ON executes.subject_id = tc.subject_id AND executes.predicate = 'executes' AND starts_with(executes.object_id, 'run:')
     WHERE tc.predicate = 'tool_call' AND starts_with(tc.subject_id, 'toolcall:')
     ORDER BY tc.recorded_at::TIMESTAMPTZ, tc.subject_id`,
  );

  await conn.run(
    `CREATE OR REPLACE TEMP TABLE ${TRAINING_CORPUS_TABLES.runs} AS
     SELECT
       r.subject_id AS run_node,
       json_extract_string(r.value_json, '$.kind') AS kind,
       json_extract_string(r.value_json, '$.identity') AS identity,
       json_extract_string(r.value_json, '$.status') AS status,
       json_extract_string(r.value_json, '$.manifestDigest') AS manifest_digest,
       json_extract_string(r.value_json, '$.resultDigest') AS result_digest,
       json_extract_string(r.value_json, '$.receiptsDigest') AS receipts_digest,
       json_extract_string(r.value_json, '$.replayDigest') AS replay_digest,
       json_extract_string(r.value_json, '$.runObjectDigest') AS run_object_digest,
       json_extract_string(r.value_json, '$.error') AS error,
       invoked.subject_id AS invoking_toolcall_node,
       r.recorded_at,
       r.source,
       r.digest
     FROM training_corpus_latest_observations r
     LEFT JOIN training_corpus_latest_observations invoked
       ON invoked.predicate = 'executes' AND invoked.object_id = r.subject_id
     WHERE r.predicate = 'run' AND starts_with(r.subject_id, 'run:')
     ORDER BY r.recorded_at::TIMESTAMPTZ, r.subject_id`,
  );

  await conn.run(
    `CREATE OR REPLACE TEMP TABLE ${TRAINING_CORPUS_TABLES.artifacts} AS
     SELECT
       a.subject_id AS cas_uri,
       json_extract_string(a.value_json, '$.digest') AS digest,
       json_extract_string(a.value_json, '$.media_type') AS media_type,
       json_extract_string(a.value_json, '$.semantic_role') AS semantic_role,
       try_cast(json_extract_string(a.value_json, '$.size_bytes') AS BIGINT) AS size_bytes,
       edge.subject_id AS source_node,
       edge.predicate AS relation,
       json_extract_string(edge.attrs, '$.producer_run') AS producer_run,
       json_extract_string(edge.attrs, '$.source_session') AS source_session,
       json_extract_string(edge.attrs, '$.source_digest') AS source_digest,
       json_extract_string(edge.attrs, '$.spec_digest') AS spec_digest,
       json_extract_string(edge.attrs, '$.plotting_system') AS plotting_system,
       a.recorded_at,
       a.source
     FROM training_corpus_latest_observations a
     LEFT JOIN training_corpus_latest_observations edge
       ON edge.object_id = a.subject_id AND edge.predicate IN ('displays', 'produces')
     WHERE a.predicate = 'artifact' AND starts_with(a.subject_id, 'cas:sha256:')
     ORDER BY a.subject_id, edge.predicate, edge.subject_id`,
  );

  await conn.run(
    `CREATE OR REPLACE TEMP TABLE ${TRAINING_CORPUS_TABLES.judgments} AS
     SELECT
       j.subject_id,
       j.statement_key,
       j.predicate,
       j.object_id,
       j.value_json,
       j.recorded_at,
       j.source,
       j.digest,
       j.attrs,
       j.trust
     FROM training_corpus_latest_observations j
     WHERE starts_with(j.predicate, 'harness:')
     ORDER BY j.recorded_at::TIMESTAMPTZ, j.subject_id, j.predicate`,
  );

  await conn.run(
    `CREATE OR REPLACE TEMP TABLE ${TRAINING_CORPUS_TABLES.hostEvents} AS
     SELECT
       e.subject_id,
       e.statement_key,
       json_extract_string(e.value_json, '$.kind') AS kind,
       json_extract_string(e.value_json, '$.value.event_type') AS event_type,
       json_extract_string(e.value_json, '$.value.reason') AS reason,
       json_extract_string(e.value_json, '$.value.parent_session_id') AS parent_session_id,
       json_extract_string(e.value_json, '$.value.payload_digest') AS payload_digest,
       e.observation_id AS event_digest,
       e.recorded_at,
       e.source,
       e.digest
     FROM training_corpus_latest_observations e
     WHERE e.predicate = 'host_event'
     ORDER BY e.recorded_at::TIMESTAMPTZ, e.subject_id`,
  );

  await conn.run(
    // Exact event-link export requires the link attrs stamped by recordHostEvent. Older links that only carried
    // host_event_kind remain ordinary graph edges; guessing their event row would create ambiguous joins.
    `CREATE OR REPLACE TEMP TABLE ${TRAINING_CORPUS_TABLES.hostEventLinks} AS
     SELECT
       json_extract_string(l.attrs, '$.host_event_statement_key') AS host_event_statement_key,
       json_extract_string(l.attrs, '$.host_event_observation_id') AS host_event_digest,
       json_extract_string(l.attrs, '$.host_event_kind') AS kind,
       l.subject_id,
       l.predicate,
       l.object_id,
       l.observation_id AS link_digest,
       l.recorded_at,
       l.source,
       l.digest
     FROM training_corpus_latest_observations l
     WHERE l.predicate != 'host_event'
       AND json_extract_string(l.attrs, '$.host_event_statement_key') IS NOT NULL
     ORDER BY l.recorded_at::TIMESTAMPTZ, l.subject_id, l.predicate, l.object_id`,
  );

  await conn.run(
    `CREATE OR REPLACE TEMP TABLE ${TRAINING_CORPUS_TABLES.units} AS
     SELECT
       tr.turn_node AS unit_id,
       tr.session_node,
       tr.input_message_node,
       tr.output_message_node,
       tr.provider,
       tr.model,
       tr.context_digest,
       tr.output_digest,
       tr.reproducibility_verdict,
       count(DISTINCT tc.toolcall_node)::INTEGER AS tool_calls,
       count(DISTINCT tc.run_node) FILTER (WHERE tc.run_node IS NOT NULL)::INTEGER AS linked_runs,
       count(DISTINCT art.cas_uri) FILTER (WHERE art.cas_uri IS NOT NULL)::INTEGER AS artifacts,
       min(tr.recorded_at) AS recorded_at
     FROM ${TRAINING_CORPUS_TABLES.turns} tr
     LEFT JOIN ${TRAINING_CORPUS_TABLES.toolCalls} tc ON tc.turn_node = tr.turn_node
     LEFT JOIN ${TRAINING_CORPUS_TABLES.artifacts} art
       ON art.source_node IN (tr.turn_node, tr.output_message_node) OR art.source_node IN (tc.toolcall_node, tc.run_node)
     GROUP BY tr.turn_node, tr.session_node, tr.input_message_node, tr.output_message_node, tr.provider, tr.model,
              tr.context_digest, tr.output_digest, tr.reproducibility_verdict
     ORDER BY min(tr.recorded_at)::TIMESTAMPTZ, tr.turn_node`,
  );

  return tableCounts(conn, asOf);
}

/** Materialize the corpus tables and write each one as Parquet for external engines. */
export async function exportTrainingCorpusParquet(conn: SqlConn, outputDir: string, opts: TrainingCorpusOptions = {}): Promise<TrainingCorpusReceipt> {
  const materialized = await materializeTrainingCorpus(conn, opts);
  await fs.mkdir(outputDir, { recursive: true });
  const files: Partial<Record<TrainingCorpusTableName, { parquetPath: string; parquetDigest: `sha256:${string}` }>> = {};
  for (const [name, table] of Object.entries(TRAINING_CORPUS_TABLES) as Array<[TrainingCorpusTableName, string]>) {
    const path = join(outputDir, `${table}.parquet`);
    await conn.run(`COPY (SELECT * FROM ${table}) TO ${sqlString(path)} (FORMAT parquet)`);
    files[name] = { parquetPath: path, parquetDigest: await sha256File(path) };
  }
  return tableCounts(conn, materialized.asOf, files);
}
