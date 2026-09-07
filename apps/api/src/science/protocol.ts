export type ScienceOperation = "sql" | "r_eval" | "r_reset" | "status" | "close";

export interface ScienceRequest {
  id: string;
  operation: ScienceOperation;
  sql?: string;
  code?: string;
  scope?: string;
  maxRows?: number;
}

export interface ScienceState {
  duckdb: "idle" | "ready";
  r: "idle" | "ready" | "unavailable";
}

export interface ScienceReady {
  type: "ready";
  state: ScienceState;
}

export interface ScienceResponse {
  type: "response";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
  state: ScienceState;
}

export type ScienceWorkerMessage = ScienceReady | ScienceResponse;
