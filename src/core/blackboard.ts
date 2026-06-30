import { stepNoteLinks, validateStudyScaffold, type StudyNote, type StudyScaffold, type StudyStep } from "./study.js";
import type { StudyWorker } from "./study-exec.js";

// Decentralized pub/sub execution — the nng PUB/SUB blackboard pattern. Unlike runStudyScaffold (a CENTRAL
// coordinator that threads artifacts in topological order), here every step is an autonomous agent launched
// CONCURRENTLY; each AWAITS its access-list deps from a shared BLACKBOARD, runs its worker, and PUBLISHES its
// note back. Topological order EMERGES from the data dependencies — there is NO coordinator. That is stigmergy:
// agents coordinate only through traces left in a shared environment ([[networked-agents-stigmergic-cas]]).
//
// The Blackboard is an injected port. SHIPPED backends: in-memory (tests / single process) and a SQL table over
// an injected SqlConn (src/hosts/sql-blackboard.ts, single-db). DESIGNED-but-not-yet-shipped backends (do not
// reach for these as if they exist — they are the cross-process roadmap, not an API): a ducknng-served shared
// table (publish = ducknng_run_rpc INSERT, await = poll ducknng_query_rpc SELECT — prototyped only in
// scripts/blackboard-shared.mjs), or a ducknng pub/sub socket (publish = pub send, await = sub recv by prefix).
// A CAS-backed blackboard (publish = put at the slug's address, await = poll has) is INTENTIONALLY NOT provided:
// CAS entries are not GC roots, so blackboard notes living in CAS would be swept by collectGarbage — exactly the
// shared-CAS hazard collectGarbage now fails closed on. A shared blackboard belongs on the ducknng-RPC table (a
// live mutable store), not on the immutable-CAS-of-bytes ([[duckdb-process-boundary-locking]]).

export interface Blackboard {
  publish(slug: string, note: StudyNote): Promise<void>;
  /** Resolves when the note for `slug` has been published (subscribe / await). */
  awaitNote(slug: string): Promise<StudyNote>;
}

function noteFor(step: StudyStep, body: string, hook: string, now: string): StudyNote {
  return {
    schema: "pi-bio.study_note.v1", slug: step.id, id: `${step.id}@${now}`, kind: step.produces,
    title: step.id, hook, body, tags: [], links: stepNoteLinks(step), sources: step.accessList.sources ?? [],
    createdAt: now, updatedAt: now,
  };
}

/** Run ONE step as an autonomous agent: await its deps from the blackboard, run the worker, publish the result.
 *  This is the unit that runs per-process / per-machine in a real decentralized deployment. */
export async function runStepOnBlackboard(step: StudyStep, worker: StudyWorker, bb: Blackboard, now: string): Promise<void> {
  const deps = await Promise.all((step.accessList.notes ?? []).map((slug) => bb.awaitNote(slug)));
  const { body, hook } = await worker({ step, notes: deps.map((n) => ({ slug: n.slug, body: n.body })), sources: step.accessList.sources ?? [] });
  await bb.publish(step.id, noteFor(step, body, hook, now));
}

/** Decentralized run: launch EVERY step concurrently; each blocks on its deps via the blackboard. No coordinator
 *  imposes order — it emerges from the access-list data dependencies (acyclic, so no deadlock). */
export async function runScaffoldOnBlackboard(scaffold: StudyScaffold, worker: StudyWorker, bb: Blackboard, opts: { now: string }): Promise<StudyNote[]> {
  const errors = validateStudyScaffold(scaffold);
  if (errors.length) throw new Error(`invalid study scaffold: ${errors.join("; ")}`);
  await Promise.all(scaffold.steps.map((step) => runStepOnBlackboard(step, worker, bb, opts.now)));
  return Promise.all(scaffold.steps.map((s) => bb.awaitNote(s.id)));
}

/** In-memory blackboard for tests / single-process runs. Cross-process: a ducknng-served table, CAS, or ducknng pub/sub. */
export function memoryBlackboard(): Blackboard {
  const notes = new Map<string, StudyNote>();
  const waiters = new Map<string, Array<(n: StudyNote) => void>>();
  return {
    async publish(slug, note) {
      notes.set(slug, note);
      for (const w of waiters.get(slug) ?? []) w(note);
      waiters.delete(slug);
    },
    awaitNote(slug) {
      const existing = notes.get(slug);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const arr = waiters.get(slug) ?? [];
        arr.push(resolve);
        waiters.set(slug, arr);
      });
    },
  };
}
