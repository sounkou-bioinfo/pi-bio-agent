# Dependency-driven blackboard


Every step starts concurrently. A step waits only for the note ids in
its access list, then publishes its own note. No scheduler computes a
topological order; the order emerges from the declared data
dependencies.

``` ts
import assert from "node:assert/strict";
import { memoryBlackboard, runScaffoldOnBlackboard } from "../../dist/core/blackboard.js";

const scaffold = {
  schema: "pi-bio.study_scaffold.v1",
  corpusId: "variant-board",
  objective: "classify variants on a blackboard",
  steps: [
    { id: "extract", subtask: "extract variant rows", produces: "corpus_map", accessList: {} },
    { id: "annotate", subtask: "annotate consequence", produces: "cheatsheet", accessList: { notes: ["extract"] } },
    { id: "qc", subtask: "check frequency", produces: "concept_map", accessList: { notes: ["extract"] } },
    { id: "classify", subtask: "combine annotation and QC", produces: "index", accessList: { notes: ["annotate", "qc"] } },
  ],
};

const delays = { extract: 20, annotate: 40, qc: 25, classify: 10 };
const published = [];
const worker = async ({ step, notes }) => {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, delays[step.id]));
  published.push({ id: step.id, after: notes.map((note) => note.slug) });
  return { body: `${step.id}(${notes.map((note) => note.slug).join("+") || "root"})`, hook: step.subtask };
};

const notes = await runScaffoldOnBlackboard(scaffold, worker, memoryBlackboard(), { now: "T1" });
const order = published.map((entry) => entry.id);
assert.ok(order.indexOf("extract") < order.indexOf("annotate"));
assert.ok(order.indexOf("extract") < order.indexOf("qc"));
assert.equal(order.at(-1), "classify");

piBio.json({
  pattern: "blackboard",
  topology: "extract -> {annotate, qc} -> classify",
  publicationOrder: published,
  notes: notes.map((note) => ({ slug: note.slug, body: note.body })),
  invariant: "extract precedes both branches; classify is last",
});
```

<details class="pi-bio-output">

<summary>

Output: cell-1
</summary>

``` json
{
  "pattern": "blackboard",
  "topology": "extract -> {annotate, qc} -> classify",
  "publicationOrder": [
    {
      "id": "extract",
      "after": []
    },
    {
      "id": "qc",
      "after": [
        "extract"
      ]
    },
    {
      "id": "annotate",
      "after": [
        "extract"
      ]
    },
    {
      "id": "classify",
      "after": [
        "annotate",
        "qc"
      ]
    }
  ],
  "notes": [
    {
      "slug": "extract",
      "body": "extract(root)"
    },
    {
      "slug": "annotate",
      "body": "annotate(extract)"
    },
    {
      "slug": "qc",
      "body": "qc(extract)"
    },
    {
      "slug": "classify",
      "body": "classify(annotate+qc)"
    }
  ],
  "invariant": "extract precedes both branches; classify is last"
}
```

</details>

This proves deterministic access-list coordination in one process. The
shared SQL variant exercises the same publish/await contract across
processes; it does not turn this pattern into Fugu’s learned
orchestrator.
