import { describe, expect, it } from "vitest";
import {
  LoginRequestSchema,
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

  it("uses Pi's auth types instead of provider-specific login methods", () => {
    expect(assertSchema(LoginRequestSchema, { type: "oauth" })).toEqual({ type: "oauth" });
    expect(() => assertSchema(LoginRequestSchema, { method: "browser" })).toThrow();
  });

  it("keeps runtime status explicit", () => {
    expect(
      assertSchema(RuntimeStatusSchema, {
        model: "openai-codex/gpt-5.6-sol",
        harness: "v2",
        scienceWorker: "ready",
        duckdb: "ready",
        r: "idle",
      }),
    ).toBeTruthy();
  });
});
