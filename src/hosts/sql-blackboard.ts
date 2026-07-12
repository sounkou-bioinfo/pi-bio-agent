import type { Blackboard } from "../core/blackboard.js";
import type { SqlConn } from "../core/ports.js";
import type { StudyNote } from "../core/study.js";

// A Blackboard ([[networked-agents-stigmergic-cas]]) backed by a SQL table over an injected SqlConn: publish =
// INSERT, awaitNote = poll SELECT until the row appears. This is the SINGLE-DB transport (the deterministic unit
// test). The CROSS-PROCESS decentralized blackboard runs over ducknng RPC instead (publish = ducknng_run_rpc
// INSERT, await = poll ducknng_query_rpc SELECT against a server that owns the table) — see
// examples/patterns/blackboard-shared.qmd; that path is RPC, not a local SqlConn, so it lives in the pattern, not here.
// Publish is idempotent (a slug's note is content-stable), so re-publish is a no-op — safe under retries.
//
// Publish is a CHECK-THEN-PLAIN-INSERT, not `INSERT ... ON CONFLICT` — portable across remote-SQL backends that
// don't implement ON CONFLICT (it was also what made the now-dropped quack path work). Each slug has a SINGLE
// owner (the publishing step's id), so first-writer-wins holds without an atomic upsert; the PRIMARY KEY is the
// backstop against an accidental same-slug double-publish (a constraint error, not silent duplication).

export interface SqlBlackboardOpts {
  table?: string;
  pollMs?: number;
  timeoutMs?: number;
  /** Injectable clock for deterministic timeout tests. */
  nowMs?: () => number;
}

export async function sqlBlackboard(conn: SqlConn, opts: SqlBlackboardOpts = {}): Promise<Blackboard> {
  const table = opts.table ?? "_pi_bio_blackboard";
  const pollMs = opts.pollMs ?? 50;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const nowMs = opts.nowMs ?? (() => Date.now());
  await conn.run(`CREATE TABLE IF NOT EXISTS ${table} (slug TEXT PRIMARY KEY, note TEXT)`);
  return {
    async publish(slug, note) {
      // check-then-insert (portable; see header): first writer wins, re-publish is a no-op.
      const existing = await conn.all<{ one: number }>(`SELECT 1 AS one FROM ${table} WHERE slug = ? LIMIT 1`, [slug]);
      if (existing.length) return;
      await conn.run(`INSERT INTO ${table} (slug, note) VALUES (?, ?)`, [slug, JSON.stringify(note)]);
    },
    async awaitNote(slug) {
      const deadline = nowMs() + timeoutMs;
      for (;;) {
        const rows = await conn.all<{ note: string }>(`SELECT note FROM ${table} WHERE slug = ?`, [slug]);
        if (rows.length) return JSON.parse(rows[0]!.note) as StudyNote;
        if (nowMs() >= deadline) throw new Error(`blackboard awaitNote('${slug}') timed out after ${timeoutMs}ms`);
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },
  };
}
