import { scaffoldExecutionOrder, stepNoteLinks, validateStudyScaffold, type StudyNote, type StudyScaffold, type StudyStep } from "./study.js";

// The scaffold EXECUTOR — what turns the StudyScaffold data structure (Fugu piece 2) into an actual run. It
// executes steps in topological order; for each step it gives the worker ONLY that step's access list (upstream
// notes + sources) — the isolation boundary that stops one worker railroading the rest (Fugu's anti-
// orchestration-collapse) — and records the produced note into shared memory visible to downstream steps. The
// `worker` is an injected port: a deterministic mock in tests, a real Pi sub-agent (a separate process) in a
// live run, or a recursive `bio_query` sub-call for the RLM-shaped case. The executor itself is pure orchestration.

/** The context a worker is given for one step: only what its access list names. */
export interface StudyStepContext {
  step: StudyStep;
  /** The produced notes of the upstream steps this step's access list references (slug + body). */
  notes: Array<{ slug: string; body: string }>;
  /** External sources the access list names. */
  sources: NonNullable<StudyStep["accessList"]["sources"]>;
}

/** A worker produces a note body + retrieval hook from a step and its access-list context. Injected: mock /
 *  Pi sub-agent process / recursive sub-query. This is the only place real model/agent work happens. */
export type StudyWorker = (ctx: StudyStepContext) => Promise<{ body: string; hook: string }>;

export interface ScaffoldRunResult {
  /** Produced notes, in execution order. */
  notes: StudyNote[];
  /** The topological execution order (step ids). */
  order: string[];
}

/** Run a scaffold to completion: topological order, per-step access-list isolation, downstream shared memory.
 *  Fails closed on an invalid scaffold. `now` is injected for deterministic note timestamps. */
export async function runStudyScaffold(scaffold: StudyScaffold, worker: StudyWorker, opts: { now: string }): Promise<ScaffoldRunResult> {
  const errors = validateStudyScaffold(scaffold);
  if (errors.length) throw new Error(`invalid study scaffold: ${errors.join("; ")}`);
  const order = scaffoldExecutionOrder(scaffold);
  const byId = new Map(scaffold.steps.map((s) => [s.id, s]));
  const produced = new Map<string, StudyNote>();

  for (const id of order) {
    const step = byId.get(id)!;
    // ISOLATION: the worker sees ONLY this step's access-list upstream notes — never the whole transcript.
    const notes = (step.accessList.notes ?? []).map((ref) => {
      const n = produced.get(ref);
      if (!n) throw new Error(`step '${id}' access-list references '${ref}' which has not been produced`); // unreachable for a valid scaffold
      return { slug: n.slug, body: n.body };
    });
    const { body, hook } = await worker({ step, notes, sources: step.accessList.sources ?? [] });
    const note: StudyNote = {
      schema: "pi-bio.study_note.v1",
      slug: step.id,
      id: `${step.id}@${opts.now}`,
      kind: step.produces,
      title: step.id,
      hook,
      body,
      tags: [],
      links: stepNoteLinks(step), // the access list IS the note's depends_on edges
      sources: step.accessList.sources ?? [],
      createdAt: opts.now,
      updatedAt: opts.now,
    };
    // SHARED MEMORY: the produced note becomes visible to downstream steps' access lists.
    produced.set(id, note);
  }
  return { notes: order.map((id) => produced.get(id)!), order };
}
