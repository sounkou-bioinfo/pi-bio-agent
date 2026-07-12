import type { JsonValue } from "pi-bio-agent";

export type AgentDelivery = "prompt" | "steer" | "follow_up";
export type AgentSessionState = "available" | "idle" | "running";

export interface AgentModelSummary {
  provider: string;
  id: string;
}

export interface AgentSessionSummary {
  sessionId: string;
  host: string;
  state: AgentSessionState;
  name?: string;
  model?: AgentModelSummary;
  thinkingLevel?: string;
  messageCount: number;
  pendingMessageCount: number;
  resumable: boolean;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface AgentActivityEvent {
  cursor: number;
  at: string;
  kind: string;
  payload: JsonValue;
}

export interface AgentActivityPage {
  sessionId: string;
  events: AgentActivityEvent[];
  nextCursor: number;
  truncated: boolean;
}

export interface AgentTranscriptPage {
  sessionId: string;
  messages: JsonValue[];
  omittedCount: number;
}

export interface OpenAgentSessionRequest {
  name?: string;
  resumeSessionId?: string;
}

export interface SendAgentMessageRequest {
  delivery: AgentDelivery;
  text: string;
}

/** Browser-facing control plane for an interactive agent host.
 *
 * This port is intentionally not a scientific run, compute runner, memory store, or event ledger. Its activity
 * stream is ephemeral UI transport. Durable scientific state continues to flow through pi-bio-agent runs, CAS,
 * observations, jobs, and imported host sessions.
 */
export interface AgentHostPort {
  readonly kind: string;
  list(): Promise<AgentSessionSummary[]>;
  open(request?: OpenAgentSessionRequest): Promise<AgentSessionSummary>;
  get(sessionId: string): Promise<AgentSessionSummary | undefined>;
  send(sessionId: string, request: SendAgentMessageRequest): Promise<AgentSessionSummary>;
  abort(sessionId: string): Promise<AgentSessionSummary>;
  transcript(sessionId: string, limit?: number): Promise<AgentTranscriptPage>;
  events(sessionId: string, after?: number, limit?: number): Promise<AgentActivityPage>;
  subscribe(sessionId: string, listener: (event: AgentActivityEvent) => void): () => void;
  close(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

export class AgentSessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`agent session '${sessionId}' is not active`);
    this.name = "AgentSessionNotFoundError";
  }
}

export class AgentSessionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSessionConflictError";
  }
}
