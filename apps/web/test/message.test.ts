import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import Message from "../src/Message.svelte";
import Markdown from "../src/Markdown.svelte";

afterEach(cleanup);

describe("chat rendering", () => {
  it("shows model-provided thinking during streaming and preserves it as a disclosure", () => {
    const message = fauxAssistantMessage([{ type: "thinking", thinking: "Check the column types first." }, { type: "text", text: "**Result:** 42" }]);
    const view = render(Message, { message, streaming: true });
    expect(view.container.querySelector("details.thinking")?.hasAttribute("open")).toBe(true);
    expect(view.container.textContent).toContain("Check the column types first.");
    expect(view.container.querySelector("strong")?.textContent).toBe("Result:");
    expect(view.container.textContent).not.toContain("Harness");
  });

  it("renders highlighted code, lists, and tables and copies exact code", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const view = render(Markdown, { text: "- A result\n\n```sql\nSELECT 42 AS answer;\n```\n\n| x | y |\n|---|---|\n| 1 | 2 |" });
    expect(view.container.querySelector("li")?.textContent).toBe("A result");
    expect(view.container.querySelector(".hljs-keyword")?.textContent).toBe("SELECT");
    expect(view.container.querySelector("table")).not.toBeNull();
    await fireEvent.click(view.getByRole("button", { name: "Copy code" }));
    expect(writeText).toHaveBeenCalledWith("SELECT 42 AS answer;\n");
  });

  it("never executes HTML or javascript links from model output", () => {
    const view = render(Markdown, { text: '<img src=x onerror="alert(1)">\n\n[bad](javascript:alert(1))\n\n```<img\n<script>alert(1)</script>\n```' });
    expect(view.container.querySelector("img, script")).toBeNull();
    expect(view.container.querySelector('[href^="javascript:"]')).toBeNull();
    expect(view.container.textContent).toContain("<script>alert(1)</script>");
  });

  it("keeps reasoning and text in the provider's original order and highlights patches", () => {
    const view = render(Message, { message: fauxAssistantMessage([
      { type: "text", text: "First response" },
      { type: "thinking", thinking: "Then inspect the patch" },
      { type: "text", text: "```diff\n-old\n+new\n```" },
    ]) });
    const content = view.container.textContent ?? "";
    expect(content.indexOf("First response")).toBeLessThan(content.indexOf("Then inspect the patch"));
    expect(view.container.querySelector(".hljs-deletion")?.textContent).toBe("-old");
    expect(view.container.querySelector(".hljs-addition")?.textContent).toBe("+new");
  });

  it("shows failures and omits empty assistant bubbles", () => {
    const view = render(Message, { message: fauxAssistantMessage([], { stopReason: "error" }) });
    expect(view.container.textContent).toContain("This reply failed.");
    cleanup();
    const empty = render(Message, { message: fauxAssistantMessage([]) });
    expect(empty.container.querySelector("article")).toBeNull();
  });
});
