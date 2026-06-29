import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deriveStudyScaffold, type StudyCorpus } from "../src/core/study.js";
import { runStudyScaffold, type StudyWorker } from "../src/core/study-exec.js";

// The scaffold EXECUTOR run with a deterministic mock worker — this proves the orchestration MECHANICS (Fugu
// piece 2+3) without any LLM: topological order, per-step access-list ISOLATION (a worker sees only what its
// access list names), and downstream SHARED MEMORY (a later step sees earlier steps' produced notes). A live
// run swaps the mock worker for a real Pi sub-agent process; the orchestration is identical.

const corpus: StudyCorpus = {
  id: "duckhts-corpus",
  label: "duckhts",
  roots: [{ kind: "artifact", role: "input", path: "src/duckhts" } as StudyCorpus["roots"][number]],
};

describe("study scaffold executor: orchestration over workers", () => {
  test("runs steps in topo order; each worker sees ONLY its access-list upstream notes; downstream sees upstream output", async () => {
    const scaffold = deriveStudyScaffold(corpus, "operate duckhts");
    // the worker records exactly which upstream note slugs it was given — the isolation boundary, observable
    const seenByStep: Record<string, string[]> = {};
    const worker: StudyWorker = async ({ step, notes }) => {
      seenByStep[step.id] = notes.map((n) => n.slug);
      return { body: `produced ${step.produces} from [${notes.map((n) => n.slug).join(",")}]`, hook: `read for ${step.produces}` };
    };

    const result = await runStudyScaffold(scaffold, worker, { now: "T1" });

    // topological order: map first, synthesis last
    assert.equal(result.order[0], "corpus-map");
    assert.equal(result.order[result.order.length - 1], "study-index");
    assert.equal(result.notes.length, 5);

    // ISOLATION: each worker saw exactly its access list's upstream steps — no more, no less
    assert.deepEqual(seenByStep["corpus-map"], []); // root step: no upstream
    assert.deepEqual(seenByStep["contracts"], ["corpus-map"]);
    assert.deepEqual(seenByStep["concept-map"], ["corpus-map"]);
    assert.deepEqual(seenByStep["probes"], ["contracts", "concept-map"]);
    assert.deepEqual(seenByStep["study-index"], ["corpus-map", "contracts", "concept-map", "probes"]);

    // SHARED MEMORY: the synthesis note's body was built from the upstream notes it was given
    const index = result.notes.find((n) => n.slug === "study-index")!;
    assert.match(index.body, /from \[corpus-map,contracts,concept-map,probes\]/);
    // the produced note's depends_on links mirror the access list (one dependency model)
    assert.deepEqual(index.links?.map((l) => l.to), ["corpus-map", "contracts", "concept-map", "probes"]);
  });

  test("fails closed on an invalid scaffold (does not execute any worker)", async () => {
    let called = false;
    const worker: StudyWorker = async () => { called = true; return { body: "x", hook: "y" }; };
    const bad = { schema: "pi-bio.study_scaffold.v1", corpusId: "c", objective: "o", steps: [] } as Parameters<typeof runStudyScaffold>[0];
    await assert.rejects(() => runStudyScaffold(bad, worker, { now: "T1" }), /invalid study scaffold/);
    assert.equal(called, false, "no worker runs when the scaffold is invalid");
  });
});
