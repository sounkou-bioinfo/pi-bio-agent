import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { deriveStudyScaffold, scaffoldExecutionOrder, stepNoteLinks, validateStudyScaffold, type StudyCorpus, type StudyScaffold } from "../src/core/study.js";

// Fugu piece 2 (scaffold-as-data) over the study-notes system: a study plan is a DAG of steps, each producing a
// note of a kind and declaring an ACCESS LIST (which upstream notes + sources feed its context). Execution is
// topological; a step reads only its access list (isolation) and writes its note (shared memory). The access
// list IS the produced note's depends_on edges — one dependency model (Fugu piece 2 meets our note graph).

const corpus: StudyCorpus = {
  id: "duckhts-corpus",
  label: "duckhts",
  roots: [
    { kind: "artifact", role: "input", path: "src/duckhts" } as StudyCorpus["roots"][number],
    { kind: "artifact", role: "input", path: "docs/duckhts.md" } as StudyCorpus["roots"][number],
  ],
};

describe("study scaffold: machine studying as a DAG with access lists", () => {
  test("deriveStudyScaffold produces a valid DAG; access lists only reference earlier steps", () => {
    const scaffold = deriveStudyScaffold(corpus, "operate duckhts");
    assert.deepEqual(validateStudyScaffold(scaffold), []);
    assert.equal(scaffold.steps.length, 5);
    assert.equal(scaffold.corpusId, "duckhts-corpus");
    // corpus sources flow into the first steps' access lists
    assert.deepEqual(scaffold.steps[0]!.accessList.sources, [{ path: "src/duckhts" }, { path: "docs/duckhts.md" }]);
  });

  test("execution order is topological — map first, synthesis last, every dep precedes its dependent", () => {
    const scaffold = deriveStudyScaffold(corpus);
    const order = scaffoldExecutionOrder(scaffold);
    assert.equal(order[0], "corpus-map");
    assert.equal(order[order.length - 1], "study-index");
    const pos = new Map(order.map((id, i) => [id, i]));
    for (const step of scaffold.steps) {
      for (const dep of step.accessList.notes ?? []) {
        assert.ok(pos.get(dep)! < pos.get(step.id)!, `${dep} must precede ${step.id}`);
      }
    }
  });

  test("a step's access list IS its produced note's depends_on links (one dependency model)", () => {
    const scaffold = deriveStudyScaffold(corpus);
    const probes = scaffold.steps.find((s) => s.id === "probes")!;
    assert.deepEqual(stepNoteLinks(probes), [
      { to: "contracts", predicate: "depends_on" },
      { to: "concept-map", predicate: "depends_on" },
    ]);
  });

  test("validation fails closed: forward reference, unknown kind, duplicate id", () => {
    const forwardRef: StudyScaffold = {
      schema: "pi-bio.study_scaffold.v1", corpusId: "c", objective: "o",
      steps: [{ id: "a", subtask: "x", produces: "corpus_map", accessList: { notes: ["b"] } }, { id: "b", subtask: "y", produces: "index", accessList: {} }],
    };
    assert.ok(validateStudyScaffold(forwardRef).some((e) => /not an earlier step/.test(e)), "a forward reference (cycle risk) must fail");

    const badKind = { schema: "pi-bio.study_scaffold.v1", corpusId: "c", objective: "o", steps: [{ id: "a", subtask: "x", produces: "not_a_kind", accessList: {} }] };
    assert.ok(validateStudyScaffold(badKind).some((e) => /not a valid note kind/.test(e)));

    const dup: StudyScaffold = {
      schema: "pi-bio.study_scaffold.v1", corpusId: "c", objective: "o",
      steps: [{ id: "a", subtask: "x", produces: "corpus_map", accessList: {} }, { id: "a", subtask: "y", produces: "index", accessList: {} }],
    };
    assert.ok(validateStudyScaffold(dup).some((e) => /duplicated/.test(e)));
  });
});
