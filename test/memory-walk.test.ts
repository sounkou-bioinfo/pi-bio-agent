import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { walkMemoryGraph } from "../src/core/study.js";
import { makeStudyNote } from "../src/hosts/pi-project.js";

// a note whose body [[slug]] links become memory-graph edges
const note = (slug: string, links: string[] = []) =>
  makeStudyNote({ kind: "memory_note", title: slug, hook: `hook ${slug}`, body: links.map((l) => `[[${l}]]`).join(" "), slug });

describe("walkMemoryGraph: study-note memory is a walkable graph", () => {
  const notes = [note("a", ["b"]), note("b", ["c"]), note("c"), note("island")];

  test("no start -> whole graph: one node per note, one edge per link", () => {
    const g = walkMemoryGraph(notes);
    assert.equal(g.nodes.length, 4);
    assert.equal(g.edges.length, 2); // a->b, b->c
  });

  test("start + depth 1 -> immediate neighborhood only", () => {
    const g = walkMemoryGraph(notes, { start: "a", depth: 1 });
    assert.deepEqual(g.nodes.map((n) => n.id).sort(), ["memory:a", "memory:b"]);
  });

  test("start + depth 2 -> two hops (a-b-c)", () => {
    const g = walkMemoryGraph(notes, { start: "a", depth: 2 });
    assert.deepEqual(g.nodes.map((n) => n.id).sort(), ["memory:a", "memory:b", "memory:c"]);
  });

  test("an isolated node walks to just itself", () => {
    const g = walkMemoryGraph(notes, { start: "island", depth: 3 });
    assert.deepEqual(g.nodes.map((n) => n.id), ["memory:island"]);
  });
});
