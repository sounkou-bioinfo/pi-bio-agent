import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { walkMemoryGraph } from "../src/core/study.js";
import { makeStudyNote } from "../src/hosts/pi-project.js";

// a note whose body [[slug]] links become memory-graph edges
const note = (slug: string, links: string[] = []) =>
  makeStudyNote({ kind: "memory_note", title: slug, hook: `hook ${slug}`, body: `note ${slug} ${links.map((l) => `[[${l}]]`).join(" ")}`.trim(), slug });

describe("walkMemoryGraph: study-note memory is a walkable graph", () => {
  const notes = [note("a", ["b"]), note("b", ["c"]), note("c"), note("island")];

  test("no start -> whole graph: one node per note, one edge per link", () => {
    const g = walkMemoryGraph(notes);
    assert.equal(g.nodes.length, 4);
    assert.equal(g.edges.length, 2); // a->b, b->c
  });

  test("start + depth 1 -> immediate neighborhood only", () => {
    const g = walkMemoryGraph(notes, { start: "a", depth: 1 });
    assert.deepEqual(g.nodes.map((n) => n.id).sort(), ["agent:memory:a", "agent:memory:b"]);
  });

  test("start + depth 2 -> two hops (a-b-c)", () => {
    const g = walkMemoryGraph(notes, { start: "a", depth: 2 });
    assert.deepEqual(g.nodes.map((n) => n.id).sort(), ["agent:memory:a", "agent:memory:b", "agent:memory:c"]);
  });

  test("an isolated node walks to just itself", () => {
    const g = walkMemoryGraph(notes, { start: "island", depth: 3 });
    assert.deepEqual(g.nodes.map((n) => n.id), ["agent:memory:island"]);
  });

  test("a NON-EXISTENT start yields an empty snapshot — even when a live note links to that dangling slug (no phantom edge)", () => {
    // 'a' links to 'ghost', but there is no note 'ghost'. Walking from 'ghost' must be empty (documented), NOT pull
    // in 'a' via reverse traversal and emit an edge to a node absent from `nodes`.
    const withDangling = [note("a", ["ghost"]), note("b")];
    const g = walkMemoryGraph(withDangling, { start: "ghost", depth: 2 });
    assert.deepEqual(g.nodes, [], "no such start node -> empty snapshot");
    assert.deepEqual(g.edges, [], "no phantom edge to the dangling start");
  });
});
