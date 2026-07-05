import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { basename } from "node:path";
import readline from "node:readline";
import type { CasStore } from "../core/cas.js";
import type { SqlConn } from "../core/ports.js";
import { canonicalDigest } from "../core/reproducibility.js";
import { createBioObservationSchema, recordObservation, recordObservationLink } from "../duckdb/observations.js";

type JsonObject = Record<string, unknown>;

const FUTURE = "9999-12-31T23:59:59.999Z";

export interface IngestSessionJsonlRequest {
  conn: SqlConn;
  cas: CasStore;
  sessionPath: string;
  /** Stable public id for the imported session. Defaults to the JSONL basename without `.jsonl`. */
  sessionId?: string;
  /** Optional stable parent session id. When omitted, Pi's header `parentSession` path is used only as metadata. */
  parentSessionId?: string;
  /** Observation source/author. Defaults to `session-ingest`. */
  source?: string;
  /** Used only when a JSONL entry has no timestamp. A present but invalid timestamp fails closed. */
  now?: string;
}

export interface IngestSessionJsonlResult {
  sessionId: string;
  rawDigest: `sha256:${string}`;
  rawCasUri: `cas:sha256:${string}`;
  entries: number;
  messages: number;
  turns: number;
  toolCalls: number;
  artifacts: number;
  observations: number;
}

export interface SessionTimelineRow {
  messageId: string;
  role: string;
  recordedAt: string;
  lineNumber: number | null;
  contentDigest: string | null;
  parentMessageId: string | null;
  provider: string | null;
  model: string | null;
}

export interface SessionToolCallRow {
  toolCallId: string;
  name: string | null;
  recordedAt: string;
  lineNumber: number | null;
  argsDigest: string | null;
  resultDigest: string | null;
  isError: boolean | null;
}

export interface SessionArtifactRow {
  casUri: `cas:sha256:${string}`;
  digest: `sha256:${string}`;
  mediaType: string;
  semanticRole: string;
  sizeBytes: number;
  sourceNode: string | null;
  producerRun: string | null;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function stripJsonl(name: string): string {
  return name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : name;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringProp(obj: JsonObject, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function node(kind: "session" | "entry" | "msg" | "turn" | "toolcall", sessionId: string, local?: string | number): string {
  return local === undefined ? `${kind}:${sessionId}` : `${kind}:${sessionId}:${String(local)}`;
}

function casNode(digest: `sha256:${string}`): `cas:sha256:${string}` {
  return `cas:${digest}` as `cas:sha256:${string}`;
}

function localEntryId(entry: JsonObject, lineNumber: number): string {
  return stringProp(entry, "id") ?? `line-${lineNumber}`;
}

function messageId(entry: JsonObject, lineNumber: number): string {
  return stringProp(entry, "id") ?? `line-${lineNumber}`;
}

function topMessage(entry: JsonObject): JsonObject | undefined {
  return isObject(entry.message) ? entry.message : undefined;
}

function entryTime(entry: JsonObject, fallback: string): string {
  const msg = topMessage(entry);
  return stringProp(entry, "timestamp") ?? (msg ? stringProp(msg, "timestamp") : undefined) ?? fallback;
}

function childBlocks(message: JsonObject): unknown[] {
  return Array.isArray(message.content) ? message.content : [];
}

function digestJson(value: unknown): `sha256:${string}` {
  return canonicalDigest(value);
}

function firstSessionHeader(bytes: Buffer): JsonObject | undefined {
  const firstLine = bytes.toString("utf8").split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!firstLine) return undefined;
  try {
    const parsed = JSON.parse(firstLine) as unknown;
    return isObject(parsed) && parsed.type === "session" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function putCas(cas: CasStore, bytes: Buffer | string): Promise<`sha256:${string}`> {
  const digest = sha256(bytes);
  await cas.put({ algorithm: "sha256", digest }, bytes);
  return `sha256:${digest}`;
}

async function record(
  conn: SqlConn,
  obs: Parameters<typeof recordObservation>[1],
  counts: { observations: number },
): Promise<void> {
  await recordObservation(conn, obs);
  counts.observations++;
}

async function recordEdge(
  conn: SqlConn,
  counts: { observations: number },
  subjectId: string,
  predicate: string,
  objectId: string,
  recordedAt: string,
  source: string,
  attrs?: Record<string, unknown>,
): Promise<void> {
  await recordObservationLink(conn, { subjectId, predicate, objectId, recordedAt, source, attrs });
  counts.observations++;
}

function* walkImages(value: unknown): Generator<{ data: string; mimeType: string; indexPath: string }> {
  function* walk(v: unknown, path: string): Generator<{ data: string; mimeType: string; indexPath: string }> {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) yield* walk(v[i], `${path}[${i}]`);
      return;
    }
    if (!isObject(v)) return;
    if (v.type === "image" && typeof v.data === "string" && typeof v.mimeType === "string" && v.data.length > 0) {
      yield { data: v.data, mimeType: v.mimeType, indexPath: path };
    }
    for (const [k, child] of Object.entries(v)) yield* walk(child, `${path}.${k}`);
  }
  yield* walk(value, "$");
}

async function recordImageArtifacts(args: {
  conn: SqlConn;
  cas: CasStore;
  counts: { observations: number; artifacts: number };
  seenArtifacts: Set<string>;
  sessionId: string;
  source: string;
  recordedAt: string;
  ownerNode: string;
  ownerPredicate?: "displays" | "produces";
  value: unknown;
  lineNumber: number;
  producerRun?: string | null;
}): Promise<void> {
  let imageIndex = 0;
  for (const img of walkImages(args.value)) {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(img.data, "base64");
    } catch {
      throw new Error(`ingestSessionJsonl: invalid base64 image at line ${args.lineNumber} (${img.indexPath})`);
    }
    if (bytes.length === 0) throw new Error(`ingestSessionJsonl: empty image at line ${args.lineNumber} (${img.indexPath})`);
    const digest = await putCas(args.cas, bytes);
    const uri = casNode(digest);
    const firstSeen = !args.seenArtifacts.has(digest);
    args.seenArtifacts.add(digest);
    const artifactValue = {
      digest,
      uri,
      media_type: img.mimeType,
      semantic_role: "session_image",
      size_bytes: bytes.length,
    };
    await record(args.conn, {
      statementKey: `${uri}:artifact`,
      subjectId: uri,
      predicate: "artifact",
      value: artifactValue,
      recordedAt: args.recordedAt,
      source: args.source,
      digest,
      attrs: {
        media_type: img.mimeType,
        semantic_role: "session_image",
      },
    }, args.counts);
    await recordEdge(args.conn, args.counts, args.ownerNode, args.ownerPredicate ?? "displays", uri, args.recordedAt, args.source, {
      media_type: img.mimeType,
      semantic_role: "session_image",
      source_session: args.sessionId,
      source_node: args.ownerNode,
      producer_run: args.producerRun ?? null,
      line_number: args.lineNumber,
      image_index: imageIndex,
      json_path: img.indexPath,
    });
    if (firstSeen) args.counts.artifacts++;
    imageIndex++;
  }
}

async function recordControlEntry(args: {
  conn: SqlConn;
  counts: { observations: number };
  sessionId: string;
  sessionNode: string;
  entryNode: string;
  entry: JsonObject;
  entryType: string;
  entryDigest: `sha256:${string}`;
  recordedAt: string;
  source: string;
  lineNumber: number;
}): Promise<void> {
  const commonAttrs = { session_id: args.sessionId, line_number: args.lineNumber, entry_type: args.entryType };
  if (args.entryType === "compaction") {
    const firstKeptEntryId = stringProp(args.entry, "firstKeptEntryId");
    const value = {
      summary_digest: digestJson(args.entry.summary ?? null),
      first_kept_entry: firstKeptEntryId ? node("entry", args.sessionId, firstKeptEntryId) : null,
      tokens_before: typeof args.entry.tokensBefore === "number" ? args.entry.tokensBefore : null,
      from_hook: typeof args.entry.fromHook === "boolean" ? args.entry.fromHook : false,
      details_digest: args.entry.details === undefined ? null : digestJson(args.entry.details),
    };
    await record(args.conn, {
      statementKey: `${args.entryNode}:compaction`,
      subjectId: args.entryNode,
      predicate: "compaction",
      value,
      recordedAt: args.recordedAt,
      source: args.source,
      digest: args.entryDigest,
      attrs: commonAttrs,
    }, args.counts);
    await recordEdge(args.conn, args.counts, args.sessionNode, "has_compaction", args.entryNode, args.recordedAt, args.source, commonAttrs);
    if (firstKeptEntryId) {
      await recordEdge(args.conn, args.counts, args.entryNode, "first_kept_entry", node("entry", args.sessionId, firstKeptEntryId), args.recordedAt, args.source);
    }
    return;
  }

  if (args.entryType === "branch_summary") {
    const fromId = stringProp(args.entry, "fromId");
    const value = {
      summary_digest: digestJson(args.entry.summary ?? null),
      from_entry: fromId ? node("entry", args.sessionId, fromId) : null,
      from_hook: typeof args.entry.fromHook === "boolean" ? args.entry.fromHook : false,
      details_digest: args.entry.details === undefined ? null : digestJson(args.entry.details),
    };
    await record(args.conn, {
      statementKey: `${args.entryNode}:branch_summary`,
      subjectId: args.entryNode,
      predicate: "branch_summary",
      value,
      recordedAt: args.recordedAt,
      source: args.source,
      digest: args.entryDigest,
      attrs: commonAttrs,
    }, args.counts);
    await recordEdge(args.conn, args.counts, args.sessionNode, "has_branch_summary", args.entryNode, args.recordedAt, args.source, commonAttrs);
    if (fromId) await recordEdge(args.conn, args.counts, args.entryNode, "summarizes_from", node("entry", args.sessionId, fromId), args.recordedAt, args.source);
    return;
  }

  if (args.entryType === "custom") {
    const customType = stringProp(args.entry, "customType") ?? "unknown";
    await record(args.conn, {
      statementKey: `${args.entryNode}:extension_event`,
      subjectId: args.entryNode,
      predicate: "extension_event",
      value: {
        custom_type: customType,
        data_digest: args.entry.data === undefined ? null : digestJson(args.entry.data),
        line_number: args.lineNumber,
      },
      recordedAt: args.recordedAt,
      source: args.source,
      digest: args.entryDigest,
      attrs: { ...commonAttrs, custom_type: customType },
    }, args.counts);
    await recordEdge(args.conn, args.counts, args.sessionNode, "has_extension_event", args.entryNode, args.recordedAt, args.source, { ...commonAttrs, custom_type: customType });
    return;
  }

  if (args.entryType === "model_change") {
    await record(args.conn, {
      statementKey: `${args.entryNode}:model_change`,
      subjectId: args.entryNode,
      predicate: "model_change",
      value: {
        provider: stringProp(args.entry, "provider") ?? null,
        model_id: stringProp(args.entry, "modelId") ?? null,
      },
      recordedAt: args.recordedAt,
      source: args.source,
      digest: args.entryDigest,
      attrs: commonAttrs,
    }, args.counts);
    await recordEdge(args.conn, args.counts, args.sessionNode, "has_model_change", args.entryNode, args.recordedAt, args.source, commonAttrs);
    return;
  }

  if (args.entryType === "thinking_level_change") {
    await record(args.conn, {
      statementKey: `${args.entryNode}:thinking_level_change`,
      subjectId: args.entryNode,
      predicate: "thinking_level_change",
      value: { thinking_level: stringProp(args.entry, "thinkingLevel") ?? null },
      recordedAt: args.recordedAt,
      source: args.source,
      digest: args.entryDigest,
      attrs: commonAttrs,
    }, args.counts);
    await recordEdge(args.conn, args.counts, args.sessionNode, "has_thinking_level_change", args.entryNode, args.recordedAt, args.source, commonAttrs);
    return;
  }

  if (args.entryType === "label") {
    const targetId = stringProp(args.entry, "targetId");
    await record(args.conn, {
      statementKey: `${args.entryNode}:label`,
      subjectId: args.entryNode,
      predicate: "label",
      value: {
        target_entry: targetId ? node("entry", args.sessionId, targetId) : null,
        label: typeof args.entry.label === "string" ? args.entry.label : null,
      },
      recordedAt: args.recordedAt,
      source: args.source,
      digest: args.entryDigest,
      attrs: commonAttrs,
    }, args.counts);
    await recordEdge(args.conn, args.counts, args.sessionNode, "has_label", args.entryNode, args.recordedAt, args.source, commonAttrs);
    if (targetId) await recordEdge(args.conn, args.counts, args.entryNode, "labels", node("entry", args.sessionId, targetId), args.recordedAt, args.source);
    return;
  }

  if (args.entryType === "session_info") {
    await record(args.conn, {
      statementKey: `${args.entryNode}:session_info`,
      subjectId: args.entryNode,
      predicate: "session_info",
      value: { name: stringProp(args.entry, "name") ?? null },
      recordedAt: args.recordedAt,
      source: args.source,
      digest: args.entryDigest,
      attrs: commonAttrs,
    }, args.counts);
    await recordEdge(args.conn, args.counts, args.sessionNode, "has_session_info", args.entryNode, args.recordedAt, args.source, commonAttrs);
  }
}

function parseJsonLine(line: string, lineNumber: number): JsonObject {
  const parsed = JSON.parse(line) as unknown;
  if (!isObject(parsed)) throw new Error(`ingestSessionJsonl: line ${lineNumber} is not a JSON object`);
  return parsed;
}

/**
 * Import a Pi-style JSONL session into the one observation ledger. This deliberately uses Pi session JSONL as the
 * concrete host format today; public/redacted exports such as pi-share-hf are derived JSONL views that can be fed
 * through the same function when a host chooses them.
 */
export async function ingestSessionJsonl(req: IngestSessionJsonlRequest): Promise<IngestSessionJsonlResult> {
  await createBioObservationSchema(req.conn, { ifNotExists: true });
  const source = req.source ?? "session-ingest";
  const fallbackNow = req.now ?? new Date().toISOString();
  const raw = await fs.readFile(req.sessionPath);
  const header = firstSessionHeader(raw);
  const sessionId = req.sessionId ?? (header ? stringProp(header, "id") : undefined) ?? stripJsonl(basename(req.sessionPath));
  const parentSessionId = req.parentSessionId?.trim();
  if (req.parentSessionId !== undefined && !parentSessionId) throw new Error("ingestSessionJsonl: parentSessionId must be non-empty when provided");
  const sessionNode = node("session", sessionId);
  const headerParentSession = header ? stringProp(header, "parentSession") : undefined;
  const inferredParentSessionId = parentSessionId;
  const rawDigest = await putCas(req.cas, raw);
  const rawCasUri = casNode(rawDigest);
  const counts = { observations: 0, artifacts: 0 };
  const seenArtifacts = new Set<string>();
  let entries = 0, messages = 0, turns = 0, toolCalls = 0;
  let previousUserMessageNode: string | undefined;
  let snapshotRecordedAt = fallbackNow;

  const input = createReadStream(req.sessionPath, { encoding: "utf8" });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const rawLine of reader) {
    lineNumber++;
    const line = rawLine.trim();
    if (!line) continue;
    const entry = parseJsonLine(line, lineNumber);
    entries++;
    const recordedAt = entryTime(entry, fallbackNow);
    snapshotRecordedAt = recordedAt;
    const entryDigest = digestJson(entry);
    const entryId = localEntryId(entry, lineNumber);
    const entryNode = node("entry", sessionId, entryId);
    const entryType = stringProp(entry, "type") ?? "unknown";

    await record(req.conn, {
      statementKey: entryNode,
      subjectId: entryNode,
      predicate: "session_entry",
      value: { type: entryType, line_number: lineNumber, digest: entryDigest },
      recordedAt,
      source,
      digest: entryDigest,
      attrs: { session_id: sessionId, line_number: lineNumber },
    }, counts);
    await recordEdge(req.conn, counts, sessionNode, "has_entry", entryNode, recordedAt, source, { line_number: lineNumber, type: entryType });

    await recordControlEntry({
      conn: req.conn, counts, sessionId, sessionNode, entryNode, entry, entryType, entryDigest, recordedAt, source, lineNumber,
    });

    if (entryType === "custom_message") {
      const customType = stringProp(entry, "customType") ?? "unknown";
      const mid = messageId(entry, lineNumber);
      const msgNode = node("msg", sessionId, mid);
      const parentId = stringProp(entry, "parentId");
      const parentNode = parentId ? node("msg", sessionId, parentId) : undefined;
      const contentDigest = digestJson(entry.content ?? null);
      const detailsDigest = entry.details === undefined ? null : digestJson(entry.details);
      messages++;
      await record(req.conn, {
        statementKey: msgNode,
        subjectId: msgNode,
        predicate: "message",
        value: {
          role: "custom",
          custom_type: customType,
          content_digest: contentDigest,
          details_digest: detailsDigest,
          parent_message: parentNode ?? null,
          provider: null,
          model: null,
          api: null,
          display: typeof entry.display === "boolean" ? entry.display : null,
          line_number: lineNumber,
        },
        recordedAt,
        source,
        digest: contentDigest,
        attrs: { session_id: sessionId, role: "custom", custom_type: customType, line_number: lineNumber, local_id: mid },
      }, counts);
      await recordEdge(req.conn, counts, sessionNode, "has_message", msgNode, recordedAt, source, { role: "custom", custom_type: customType, line_number: lineNumber });
      await recordEdge(req.conn, counts, sessionNode, "has_extension_message", msgNode, recordedAt, source, { custom_type: customType, line_number: lineNumber });
      await recordEdge(req.conn, counts, entryNode, "materializes_message", msgNode, recordedAt, source, { custom_type: customType });
      if (parentNode) await recordEdge(req.conn, counts, msgNode, "parent", parentNode, recordedAt, source);
      await recordImageArtifacts({
        conn: req.conn, cas: req.cas, counts, sessionId, source, recordedAt,
        seenArtifacts,
        ownerNode: msgNode, ownerPredicate: "displays", value: entry.content, lineNumber,
      });
      continue;
    }

    const msg = topMessage(entry);
    if (entryType !== "message" || !msg) continue;
    const role = stringProp(msg, "role");
    if (!role) continue;
    messages++;

    const mid = messageId(entry, lineNumber);
    const msgNode = node("msg", sessionId, mid);
    const parentId = stringProp(entry, "parentId");
    const parentNode = parentId ? node("msg", sessionId, parentId) : undefined;
    const contentDigest = digestJson(msg.content ?? null);
    const provider = stringProp(msg, "provider");
    const model = stringProp(msg, "model");
    const api = stringProp(msg, "api");
    const messageValue = {
      role,
      content_digest: contentDigest,
      parent_message: parentNode ?? null,
      provider: provider ?? null,
      model: model ?? null,
      api: api ?? null,
      stop_reason: stringProp(msg, "stopReason") ?? null,
      usage_digest: msg.usage === undefined ? null : digestJson(msg.usage),
      line_number: lineNumber,
    };

    await record(req.conn, {
      statementKey: msgNode,
      subjectId: msgNode,
      predicate: "message",
      value: messageValue,
      recordedAt,
      source,
      digest: contentDigest,
      attrs: { session_id: sessionId, role, line_number: lineNumber, local_id: mid },
    }, counts);
    await recordEdge(req.conn, counts, sessionNode, "has_message", msgNode, recordedAt, source, { role, line_number: lineNumber });
    if (parentNode) await recordEdge(req.conn, counts, msgNode, "parent", parentNode, recordedAt, source);

    let turnNode: string | undefined;
    if (role === "assistant") {
      turnNode = node("turn", sessionId, mid);
      turns++;
      await record(req.conn, {
        statementKey: turnNode,
        subjectId: turnNode,
        predicate: "turn",
        value: {
          kind: "agent_turn",
          output_message: msgNode,
          input_message: parentNode ?? previousUserMessageNode ?? null,
          provider: provider ?? null,
          model: model ?? null,
          api: api ?? null,
          context_digest: digestJson({ parent: parentNode ?? previousUserMessageNode ?? null }),
          output_digest: contentDigest,
          reproducibility: {
            verdict: "audit_replayable_not_content_reproducible",
            reason: "provider/model call is a live host effect; context can be reconstructed but text is not content-guaranteed",
          },
        },
        recordedAt,
        source,
        digest: contentDigest,
        attrs: { session_id: sessionId, kind: "agent_turn", provider: provider ?? null, model: model ?? null },
      }, counts);
      await recordEdge(req.conn, counts, sessionNode, "has_turn", turnNode, recordedAt, source);
      await recordEdge(req.conn, counts, turnNode, "output", msgNode, recordedAt, source);
      const inputNode = parentNode ?? previousUserMessageNode;
      if (inputNode) await recordEdge(req.conn, counts, turnNode, "input", inputNode, recordedAt, source);
    }

    if (role === "user") previousUserMessageNode = msgNode;

    await recordImageArtifacts({
      conn: req.conn, cas: req.cas, counts, sessionId, source, recordedAt,
      seenArtifacts,
      ownerNode: msgNode, ownerPredicate: "displays", value: msg.content, lineNumber,
    });
    if (turnNode) await recordImageArtifacts({
      conn: req.conn, cas: req.cas, counts, sessionId, source, recordedAt,
      seenArtifacts,
      ownerNode: turnNode, ownerPredicate: "displays", value: msg.content, lineNumber,
    });

    if (role === "assistant") {
      let idx = 0;
      for (const block of childBlocks(msg)) {
        if (!isObject(block) || block.type !== "toolCall") { idx++; continue; }
        const toolId = stringProp(block, "id") ?? `${mid}:tool-${idx}`;
        const toolNode = node("toolcall", sessionId, toolId);
        const name = stringProp(block, "name");
        const argsDigest = digestJson(block.arguments ?? block.partialJson ?? null);
        toolCalls++;
        await record(req.conn, {
          statementKey: toolNode,
          subjectId: toolNode,
          predicate: "tool_call",
          value: { name: name ?? null, args_digest: argsDigest, line_number: lineNumber, index: idx },
          recordedAt,
          source,
          digest: argsDigest,
          attrs: { session_id: sessionId, name: name ?? null, line_number: lineNumber, index: idx },
        }, counts);
        await recordEdge(req.conn, counts, turnNode ?? msgNode, "calls", toolNode, recordedAt, source, { name: name ?? null, index: idx });
        idx++;
      }
    } else if (role === "toolResult") {
      const toolId = stringProp(msg, "toolCallId") ?? `${mid}:result`;
      const toolNode = node("toolcall", sessionId, toolId);
      const toolName = stringProp(msg, "toolName");
      const resultDigest = digestJson(msg.content ?? null);
      const isError = typeof msg.isError === "boolean" ? msg.isError : null;
      await record(req.conn, {
        statementKey: `${toolNode}:result`,
        subjectId: toolNode,
        predicate: "tool_result",
        value: { name: toolName ?? null, result_digest: resultDigest, is_error: isError, line_number: lineNumber },
        recordedAt,
        source,
        digest: resultDigest,
        attrs: { session_id: sessionId, name: toolName ?? null, line_number: lineNumber, is_error: isError },
      }, counts);
      await recordEdge(req.conn, counts, toolNode, "output", msgNode, recordedAt, source, { name: toolName ?? null, is_error: isError });
      await recordImageArtifacts({
        conn: req.conn, cas: req.cas, counts, sessionId, source, recordedAt,
        seenArtifacts,
        ownerNode: toolNode, ownerPredicate: "produces", value: msg.content, lineNumber,
      });
    }
  }

  await record(req.conn, {
    statementKey: `${sessionNode}:raw_jsonl`,
    subjectId: sessionNode,
    predicate: "raw_jsonl",
    value: { digest: rawDigest, uri: rawCasUri, size_bytes: raw.length, format: "pi-session-jsonl", file: basename(req.sessionPath) },
    recordedAt: snapshotRecordedAt,
    source,
    digest: rawDigest,
    attrs: { session_id: sessionId, source_path: req.sessionPath },
  }, counts);

  if (inferredParentSessionId) {
    await recordEdge(req.conn, counts, sessionNode, "parent_session", node("session", inferredParentSessionId), snapshotRecordedAt, source, {
      parent_session_id: inferredParentSessionId,
      parent_session_ref: headerParentSession ?? null,
      parent_session_ref_kind: "explicit_id",
    });
  }

  await record(req.conn, {
    statementKey: sessionNode,
    subjectId: sessionNode,
    predicate: "session",
    value: {
      session_id: sessionId,
      raw_digest: rawDigest,
      raw_uri: rawCasUri,
      entries,
      messages,
      turns,
      tool_calls: toolCalls,
      artifacts: counts.artifacts,
      parent_session_id: inferredParentSessionId ?? null,
      parent_session_ref: headerParentSession ?? null,
    },
    recordedAt: snapshotRecordedAt,
    source,
    digest: rawDigest,
    attrs: { session_id: sessionId, format: "pi-session-jsonl" },
  }, counts);

  return { sessionId, rawDigest, rawCasUri, entries, messages, turns, toolCalls, artifacts: counts.artifacts, observations: counts.observations };
}

const latestAsOf = (predicate: string, subjectPrefix: string): string =>
  `SELECT * FROM (
     SELECT *, row_number() OVER (PARTITION BY statement_key ORDER BY recorded_at::TIMESTAMPTZ DESC, observation_id DESC) AS rn
     FROM bio_observations
     WHERE predicate = ? AND starts_with(subject_id, ?) AND recorded_at::TIMESTAMPTZ <= ?::TIMESTAMPTZ
       AND (valid_from IS NULL OR valid_from::TIMESTAMPTZ <= ?::TIMESTAMPTZ)
       AND (valid_to IS NULL OR valid_to::TIMESTAMPTZ > ?::TIMESTAMPTZ)
   ) WHERE rn = 1 ORDER BY recorded_at::TIMESTAMPTZ ASC, subject_id ASC`;

export async function sessionTimeline(conn: SqlConn, sessionId: string, asOf = FUTURE): Promise<SessionTimelineRow[]> {
  const rows = await conn.all<{ subject_id: string; value_json: string | null; recorded_at: string; attrs: string | null }>(
    latestAsOf("message", `msg:${sessionId}:`),
    ["message", `msg:${sessionId}:`, asOf, asOf, asOf],
  );
  return rows.map((r) => {
    const v = r.value_json ? JSON.parse(r.value_json) as JsonObject : {};
    return {
      messageId: r.subject_id,
      role: typeof v.role === "string" ? v.role : "",
      recordedAt: r.recorded_at,
      lineNumber: typeof v.line_number === "number" ? v.line_number : null,
      contentDigest: typeof v.content_digest === "string" ? v.content_digest : null,
      parentMessageId: typeof v.parent_message === "string" ? v.parent_message : null,
      provider: typeof v.provider === "string" ? v.provider : null,
      model: typeof v.model === "string" ? v.model : null,
    };
  });
}

export async function sessionToolTrajectory(conn: SqlConn, sessionId: string, asOf = FUTURE): Promise<SessionToolCallRow[]> {
  const rows = await conn.all<{ subject_id: string; value_json: string | null; recorded_at: string }>(
    latestAsOf("tool_call", `toolcall:${sessionId}:`),
    ["tool_call", `toolcall:${sessionId}:`, asOf, asOf, asOf],
  );
  const resultRows = await conn.all<{ subject_id: string; value_json: string | null }>(
    latestAsOf("tool_result", `toolcall:${sessionId}:`),
    ["tool_result", `toolcall:${sessionId}:`, asOf, asOf, asOf],
  );
  const results = new Map(resultRows.map((r) => [r.subject_id, r.value_json ? JSON.parse(r.value_json) as JsonObject : {}]));
  return rows.map((r) => {
    const v = r.value_json ? JSON.parse(r.value_json) as JsonObject : {};
    const res = results.get(r.subject_id);
    return {
      toolCallId: r.subject_id,
      name: typeof v.name === "string" ? v.name : null,
      recordedAt: r.recorded_at,
      lineNumber: typeof v.line_number === "number" ? v.line_number : null,
      argsDigest: typeof v.args_digest === "string" ? v.args_digest : null,
      resultDigest: res && typeof res.result_digest === "string" ? res.result_digest : null,
      isError: res && typeof res.is_error === "boolean" ? res.is_error : null,
    };
  });
}

export async function sessionArtifacts(conn: SqlConn, sessionId: string, asOf = FUTURE): Promise<SessionArtifactRow[]> {
  const artifactRows = await conn.all<{ subject_id: string; value_json: string | null }>(
    latestAsOf("artifact", "cas:"),
    ["artifact", "cas:", asOf, asOf, asOf],
  );
  const artifacts = new Map<string, JsonObject>();
  for (const r of artifactRows) {
    const v = r.value_json ? JSON.parse(r.value_json) as JsonObject : {};
    if (r.subject_id.startsWith("cas:sha256:")) artifacts.set(r.subject_id, v);
  }

  const edgeRows = await conn.all<{ subject_id: string; predicate: string; object_id: string | null; attrs: string | null }>(
    `SELECT subject_id, predicate, object_id, attrs FROM (
       SELECT *, row_number() OVER (PARTITION BY statement_key ORDER BY recorded_at::TIMESTAMPTZ DESC, observation_id DESC) AS rn
       FROM bio_observations
       WHERE object_id IS NOT NULL AND starts_with(object_id, 'cas:sha256:')
         AND predicate IN ('displays', 'produces') AND recorded_at::TIMESTAMPTZ <= ?::TIMESTAMPTZ
         AND (valid_from IS NULL OR valid_from::TIMESTAMPTZ <= ?::TIMESTAMPTZ)
         AND (valid_to IS NULL OR valid_to::TIMESTAMPTZ > ?::TIMESTAMPTZ)
     ) WHERE rn = 1 ORDER BY subject_id ASC, predicate ASC, object_id ASC`,
    [asOf, asOf, asOf],
  );
  const sessionPrefixes = [`msg:${sessionId}:`, `turn:${sessionId}:`, `toolcall:${sessionId}:`];
  const selected = new Map<string, { sourceNode: string; producerRun: string | null; attrs: JsonObject; relation: string }>();
  for (const edge of edgeRows) {
    if (!edge.object_id) continue;
    const attrs = edge.attrs ? JSON.parse(edge.attrs) as JsonObject : {};
    const belongsToSession =
      attrs.source_session === sessionId ||
      sessionPrefixes.some((prefix) => edge.subject_id.startsWith(prefix));
    if (!belongsToSession) continue;
    const producerRun = typeof attrs.producer_run === "string" ? attrs.producer_run : null;
    const current = selected.get(edge.object_id);
    // For a graphic both displayed by a tool-result message and produced by the tool call, prefer the producer edge.
    if (!current || (current.relation !== "produces" && edge.predicate === "produces")) {
      selected.set(edge.object_id, { sourceNode: edge.subject_id, producerRun, attrs, relation: edge.predicate });
    }
  }

  return Array.from(selected.entries()).flatMap(([uri, edge]) => {
    const v = artifacts.get(uri) ?? {};
    const digest = typeof v.digest === "string" ? v.digest : uri.slice("cas:".length);
    if (!digest.startsWith("sha256:") || !uri.startsWith("cas:sha256:")) return [];
    return [{
      casUri: uri as `cas:sha256:${string}`,
      digest: digest as `sha256:${string}`,
      mediaType: typeof v.media_type === "string" ? v.media_type : typeof edge.attrs.media_type === "string" ? edge.attrs.media_type : "application/octet-stream",
      semanticRole: typeof v.semantic_role === "string" ? v.semantic_role : typeof edge.attrs.semantic_role === "string" ? edge.attrs.semantic_role : "artifact",
      sizeBytes: typeof v.size_bytes === "number" ? v.size_bytes : 0,
      sourceNode: edge.sourceNode,
      producerRun: edge.producerRun,
    }];
  });
}
