import type { RuntimeStatus, SessionSummary } from "@pi-bio/protocol";
import type { LaneSnapshot, TranscriptEntry } from "./api.js";

export function renderSessions(
  root: HTMLElement,
  sessions: SessionSummary[],
  selectedId: string | undefined,
  select: (id: string) => void,
): void {
  root.replaceChildren(
    ...sessions.map((session) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `session-item${session.id === selectedId ? " selected" : ""}`;
      button.addEventListener("click", () => select(session.id));
      const title = document.createElement("strong");
      title.textContent = session.name;
      const time = document.createElement("small");
      time.textContent = new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(session.modifiedAt);
      button.append(title, time);
      return button;
    }),
  );
}

export function renderTranscript(root: HTMLElement, snapshot: LaneSnapshot | undefined): void {
  const entries = snapshot?.transcript.filter(
    (entry): entry is TranscriptEntry & { message: NonNullable<TranscriptEntry["message"]> } =>
      entry.type === "message" && entry.message !== undefined,
  );
  if (entries === undefined || entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const glyph = document.createElement("span");
    glyph.className = "empty-glyph";
    glyph.textContent = "π";
    const heading = document.createElement("h2");
    heading.textContent = "Work with data, not prompt-sized copies.";
    const text = document.createElement("p");
    text.textContent = "Use persistent DuckDB, R over NNG, and bounded Harness delegation.";
    empty.append(glyph, heading, text);
    root.replaceChildren(empty);
    return;
  }

  root.replaceChildren(
    ...entries.map((entry) => {
      const article = document.createElement("article");
      article.className = `message ${entry.message.role}`;
      const label = document.createElement("header");
      label.textContent = roleLabel(entry.message.role);
      const body = document.createElement("div");
      body.className = "message-body";
      const text = messageText(entry.message.content);
      if (text.length > 0) {
        const paragraph = document.createElement("p");
        paragraph.textContent = text;
        body.append(paragraph);
      }
      for (const tool of toolCalls(entry.message.content)) {
        const card = document.createElement("div");
        card.className = "tool-card";
        const name = document.createElement("strong");
        name.textContent = tool.name;
        const detail = document.createElement("code");
        detail.textContent = compactJson(tool.arguments);
        card.append(name, detail);
        body.append(card);
      }
      article.append(label, body);
      return article;
    }),
  );
  root.scrollTop = root.scrollHeight;
}

export function renderRuntime(root: HTMLElement, runtime: RuntimeStatus): void {
  const rows: Array<[string, string, string]> = [
    ["Harness", runtime.harness, "ready"],
    ["Worker", runtime.scienceWorker, runtime.scienceWorker],
    ["DuckDB", runtime.duckdb, runtime.duckdb],
    ["R / NNG", runtime.r, runtime.r],
  ];
  root.replaceChildren(
    ...rows.map(([name, value, status]) => {
      const row = document.createElement("div");
      row.className = "runtime-row";
      const label = document.createElement("span");
      label.textContent = name;
      const badge = document.createElement("span");
      badge.className = `badge ${status}`;
      badge.textContent = value;
      row.append(label, badge);
      return row;
    }),
  );
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function toolCalls(content: unknown): Array<{ name: string; arguments: unknown }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (
      typeof part !== "object" ||
      part === null ||
      (part as { type?: unknown }).type !== "toolCall" ||
      typeof (part as { name?: unknown }).name !== "string"
    ) {
      return [];
    }
    return [
      {
        name: (part as { name: string }).name,
        arguments: (part as { arguments?: unknown }).arguments,
      },
    ];
  });
}

function compactJson(value: unknown): string {
  const text = JSON.stringify(value) ?? "";
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

function roleLabel(role: string): string {
  if (role === "user") return "You";
  if (role === "assistant") return "Pi Bio";
  if (role === "toolResult") return "Evidence";
  return role;
}
