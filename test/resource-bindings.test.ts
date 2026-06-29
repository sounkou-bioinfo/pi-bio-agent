import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bindResourceParams, fillTemplate } from "../src/hosts/resource-bindings.js";

// Parameterized resources: URL composition over params. The manifest declares a template; the agent fills it.

describe("resource bindings: URL/body composition over agent params", () => {
  test("fillTemplate URL-encodes for a url, raw otherwise; fails closed on a missing binding", () => {
    assert.equal(fillTemplate("?q={query}&o=mondo", { query: "lung cancer" }, true), "?q=lung%20cancer&o=mondo");
    assert.equal(fillTemplate("hello {who}", { who: "world" }, false), "hello world");
    assert.throws(() => fillTemplate("?q={query}", {}, true), /references '\{query\}' but no binding/);
  });

  test("bindResourceParams composes the url and substitutes the body structurally", () => {
    const out = bindResourceParams(
      { url: "https://ex/search?q={query}", table: "t", method: "POST", body: { ids: "{ids}", note: "for {query}" } },
      { query: "asthma", ids: ["rs1", "rs2"] },
    );
    assert.equal(out.url, "https://ex/search?q=asthma");
    assert.deepEqual(out.body, { ids: ["rs1", "rs2"], note: "for asthma" }); // {ids} whole-value -> the array; {query} textual
  });

  test("defaults: {name:default} uses the default unless the agent overrides; required slots still fail closed", () => {
    const url = "?q={query}&ontology={ontology:mondo}&fields={fieldList:obo_id,label}";
    // only query supplied -> ontology + fields fall back to their manifest defaults
    assert.equal(fillTemplate(url, { query: "asthma" }, true), "?q=asthma&ontology=mondo&fields=obo_id%2Clabel");
    // the agent overrides a defaulted param
    assert.equal(fillTemplate(url, { query: "asthma", ontology: "hp" }, true), "?q=asthma&ontology=hp&fields=obo_id%2Clabel");
    // query has no default -> still required
    assert.throws(() => fillTemplate(url, {}, true), /references '\{query\}' but no binding \(and no default\)/);
  });

  test("a resource with no templates is unchanged even with bindings present", () => {
    const params = { url: "https://ex/static", table: "t" };
    assert.deepEqual(bindResourceParams(params, { unused: 1 }), params);
  });
});
