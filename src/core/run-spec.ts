import type { ResourceHandle } from "./resources.js";
import { systemClock } from "./clock.js";
import type { JsonValue } from "./json.js";
import type { BioArtifact, Provenance } from "./types.js";

// OPEN host/backend execution label — inline/background/subagent/service/batch, or slurm/k8s/aws-batch/modal/
// nng-worker/local-daemon/… No core logic branches on the mode; a host chooses its own vocabulary. (Contrast
// BioRunStatus/BioRunEventType, which stay closed because the run state machine branches on them.)
export type BioRunMode = string;
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

// Nested inside BioRunRecord (run.json) — the record's schema governs the whole file; an event never travels
// standalone, so it carries no envelope tag of its own.
export interface BioRunEvent {
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
const EVENT_TYPES: BioRunEventType[] = ["created", "started", "progress", "checkpoint", "artifact", "message", "completed", "failed", "cancelled"];

export function validateBioRunSpec(spec: BioRunSpec): string[] {
  const errors: string[] = [];
  const inputs = Array.isArray(spec.inputs) ? spec.inputs : undefined;
  if (spec.schema !== "pi-bio.run_spec.v1") errors.push("schema must be pi-bio.run_spec.v1");
  if (typeof spec.id !== "string" || !RUN_ID_RE.test(spec.id)) errors.push("id is required and may contain letters, numbers, '.', '_', ':', '-' (max 128 chars)");
  if (typeof spec.title !== "string" || !spec.title.trim()) errors.push("title is required");
  if (typeof spec.description !== "string" || !spec.description.trim()) errors.push("description is required");
  if (!spec.tool || typeof spec.tool.name !== "string" || !spec.tool.name.trim()) errors.push("tool.name is required");
  if (typeof spec.mode !== "string" || !spec.mode.trim()) errors.push("mode is invalid"); // open label: require a non-empty string, not membership
  if (!inputs) errors.push("inputs array is required");
  if (spec.budget?.maxWallClockSeconds !== undefined && (typeof spec.budget.maxWallClockSeconds !== "number" || !(spec.budget.maxWallClockSeconds > 0))) errors.push("budget.maxWallClockSeconds must be a positive number");
  if (spec.budget?.maxToolCalls !== undefined && (typeof spec.budget.maxToolCalls !== "number" || !(spec.budget.maxToolCalls > 0))) errors.push("budget.maxToolCalls must be a positive number");
  if (spec.budget?.maxTokens !== undefined && (typeof spec.budget.maxTokens !== "number" || !(spec.budget.maxTokens > 0))) errors.push("budget.maxTokens must be a positive number");
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
  if (typeof event.runId !== "string" || !event.runId.trim()) errors.push("runId is required");
  if (typeof event.at !== "string" || !event.at.trim()) errors.push("at is required");
  if (!EVENT_TYPES.includes(event.type)) errors.push("type is invalid");
  if (event.progress?.current !== undefined && (typeof event.progress.current !== "number" || event.progress.current < 0)) errors.push("progress.current must be a non-negative number");
  if (event.progress?.total !== undefined && (typeof event.progress.total !== "number" || event.progress.total < 0)) errors.push("progress.total must be a non-negative number");
  return errors;
}

export function newRunRecord(spec: BioRunSpec, now = systemClock()): BioRunRecord {
  const errors = validateBioRunSpec(spec);
  if (errors.length) throw new Error(`invalid BioRunSpec ${spec.id || "<unnamed>"}: ${errors.join("; ")}`);
  return {
    schema: "pi-bio.run_record.v1",
    spec,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    events: [{ runId: spec.id, at: now, type: "created", message: spec.title }],
  };
}

export function appendRunEvent(record: BioRunRecord, event: Omit<BioRunEvent, "runId" | "at"> & { at?: string }): BioRunRecord {
  const at = event.at ?? systemClock();
  const fullEvent: BioRunEvent = { runId: record.spec.id, at, ...event };
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
