import { describe, expect, it } from "vitest";
import {
  PromptRequestSchema,
  RuntimeStatusSchema,
  assertSchema,
} from "../src/index.js";

describe("application protocol", () => {
  it("accepts a bounded prompt", () => {
    expect(assertSchema(PromptRequestSchema, { text: "Count variants" })).toEqual({
      text: "Count variants",
    });
  });

  it("rejects undeclared fields", () => {
    expect(() =>
      assertSchema(PromptRequestSchema, { text: "Count variants", shell: true }),
    ).toThrow(/Unexpected property/);
  });

  it("keeps runtime status explicit", () => {
    expect(
      assertSchema(RuntimeStatusSchema, {
        model: "openai/gpt-5.4",
        harness: "v2",
        scienceWorker: "ready",
        duckdb: "ready",
        r: "idle",
      }),
    ).toBeTruthy();
  });
});
