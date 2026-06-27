import type { ResourceHandle } from "./resources.js";
import type { JsonValue } from "./tool-spec.js";
import type { BioArtifact, Provenance } from "./types.js";

export type BioRunMode = "inline" | "background" | "subagent" | "service" | "batch";
export type BioRunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export type BioRunEventType = "created" | "started" | "progress" | "checkpoint" | "artifact" | "message" | "completed" | "failed" | "cancelled";

export interface BioRunInput {
  name: string;
  value: JsonValue | ResourceHandle;
  description?: string;
}

export interface BioRunExpectedOutput {
  name: string;
  kind: string;
  required?: boolean;
  description?: string;
}

export interface BioRunSpec {
  schema: "pi-bio.run_spec.v1";
  id: string;
  title: string;
  description: string;
  tool: {
    name: string;
    version?: string;
  };
  mode: BioRunMode;
  inputs: BioRunInput[];
  expectedOutputs?: BioRunExpectedOutput[];
  budget?: {
    maxWallClockSeconds?: number;
    maxToolCalls?: number;
    maxTokens?: number;
  };
  checkpointPolicy?: {
    intervalSeconds?: number;
    artifactEveryStep?: boolean;
    resumable?: boolean;
  };
  provenance?: Provenance[];
}

export interface BioRunEvent {
  schema: "pi-bio.run_event.v1";
  runId: string;
  at: string;
  type: BioRunEventType;
  message?: string;
  progress?: {
    current?: number;
    total?: number;
    unit?: string;
  };
  data?: JsonValue;
  artifacts?: BioArtifact[];
}

export interface BioRunRecord {
  schema: "pi-bio.run_record.v1";
  spec: BioRunSpec;
  status: BioRunStatus;
  createdAt: string;
  updatedAt: string;
  events: BioRunEvent[];
  artifacts?: BioArtifact[];
  result?: JsonValue;
  error?: string;
}

const RUN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const RUN_MODES: BioRunMode[] = ["inline", "background", "subagent", "service", "batch"];
const EVENT_TYPES: BioRunEventType[] = ["created", "started", "progress", "checkpoint", "artifact", "message", "completed", "failed", "cancelled"];

export function validateBioRunSpec(spec: BioRunSpec): string[] {
  const errors: string[] = [];
  const inputs = Array.isArray(spec.inputs) ? spec.inputs : undefined;
  if (spec.schema !== "pi-bio.run_spec.v1") errors.push("schema must be pi-bio.run_spec.v1");
  if (typeof spec.id !== "string" || !RUN_ID_RE.test(spec.id)) errors.push("id is required and may contain letters, numbers, '.', '_', ':', '-' (max 128 chars)");
  if (typeof spec.title !== "string" || !spec.title.trim()) errors.push("title is required");
  if (typeof spec.description !== "string" || !spec.description.trim()) errors.push("description is required");
  if (!spec.tool || typeof spec.tool.name !== "string" || !spec.tool.name.trim()) errors.push("tool.name is required");
  if (!RUN_MODES.includes(spec.mode)) errors.push("mode is invalid");
  if (!inputs) errors.push("inputs array is required");
  if (spec.budget?.maxWallClockSeconds !== undefined && spec.budget.maxWallClockSeconds <= 0) errors.push("budget.maxWallClockSeconds must be positive");
  if (spec.budget?.maxToolCalls !== undefined && spec.budget.maxToolCalls <= 0) errors.push("budget.maxToolCalls must be positive");
  if (spec.budget?.maxTokens !== undefined && spec.budget.maxTokens <= 0) errors.push("budget.maxTokens must be positive");
  if (spec.checkpointPolicy?.intervalSeconds !== undefined && spec.checkpointPolicy.intervalSeconds <= 0) errors.push("checkpointPolicy.intervalSeconds must be positive");
  return errors;
}

export function defineBioRunSpec(spec: BioRunSpec): BioRunSpec {
  const errors = validateBioRunSpec(spec);
  if (errors.length) throw new Error(`invalid BioRunSpec ${spec.id || "<unnamed>"}: ${errors.join("; ")}`);
  return spec;
}

export function validateBioRunEvent(event: BioRunEvent): string[] {
  const errors: string[] = [];
  if (event.schema !== "pi-bio.run_event.v1") errors.push("schema must be pi-bio.run_event.v1");
  if (typeof event.runId !== "string" || !event.runId.trim()) errors.push("runId is required");
  if (typeof event.at !== "string" || !event.at.trim()) errors.push("at is required");
  if (!EVENT_TYPES.includes(event.type)) errors.push("type is invalid");
  if (event.progress?.current !== undefined && event.progress.current < 0) errors.push("progress.current cannot be negative");
  if (event.progress?.total !== undefined && event.progress.total < 0) errors.push("progress.total cannot be negative");
  return errors;
}

export function newRunRecord(spec: BioRunSpec, now = new Date().toISOString()): BioRunRecord {
  const errors = validateBioRunSpec(spec);
  if (errors.length) throw new Error(`invalid BioRunSpec ${spec.id || "<unnamed>"}: ${errors.join("; ")}`);
  return {
    schema: "pi-bio.run_record.v1",
    spec,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    events: [{ schema: "pi-bio.run_event.v1", runId: spec.id, at: now, type: "created", message: spec.title }],
  };
}

export function appendRunEvent(record: BioRunRecord, event: Omit<BioRunEvent, "schema" | "runId" | "at"> & { at?: string }): BioRunRecord {
  const at = event.at ?? new Date().toISOString();
  const fullEvent: BioRunEvent = { schema: "pi-bio.run_event.v1", runId: record.spec.id, at, ...event };
  const errors = validateBioRunEvent(fullEvent);
  if (errors.length) throw new Error(`invalid BioRunEvent: ${errors.join("; ")}`);
  const next: BioRunRecord = {
    ...record,
    updatedAt: at,
    events: [...record.events, fullEvent],
  };
  if (event.type === "started") next.status = "running";
  if (event.type === "completed") next.status = "succeeded";
  if (event.type === "failed") next.status = "failed";
  if (event.type === "cancelled") next.status = "cancelled";
  if (event.artifacts?.length) next.artifacts = [...(next.artifacts ?? []), ...event.artifacts];
  return next;
}
