import type { HarnessEvent, LaneSnapshot } from "@earendil-works/pi-agent-core";
import type { AuthEvent, AuthPrompt, AuthType, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const ApiErrorSchema = Type.Object(
  {
    error: Type.String(),
  },
  { additionalProperties: false },
);

export const SessionSummarySchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    createdAt: Type.Number(),
    modifiedAt: Type.Number(),
    parentSessionId: Type.Optional(Type.String()),
    archivedAt: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

export const CreateSessionRequestSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  },
  { additionalProperties: false },
);

export const PromptRequestSchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 200_000 }),
  },
  { additionalProperties: false },
);

export const ForkRequestSchema = Type.Object(
  { entryId: Type.Optional(Type.String({ minLength: 1 })) },
  { additionalProperties: false },
);

export const RenameSessionSchema = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 160 }) },
  { additionalProperties: false },
);

export interface SessionTree {
  entries: Array<{ id: string; parentId: string | null; seq: number; label: string }>;
  lanes: Array<{ name: string; tipId: string | null }>;
  nextCursor?: number;
}

export const DraftRequestSchema = Type.Object(
  { text: Type.String({ maxLength: 100_000 }) },
  { additionalProperties: false },
);

export const PromptAcceptedSchema = Type.Object(
  {
    operationId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const LoginRequestSchema = Type.Object(
  { type: Type.Union([Type.Literal("oauth"), Type.Literal("api_key")]) },
  { additionalProperties: false },
);

export const AuthReplySchema = Type.Object(
  { promptId: Type.String({ minLength: 1 }), value: Type.String({ maxLength: 100_000 }) },
  { additionalProperties: false },
);

export const ThinkingRequestSchema = Type.Object(
  { level: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const ModelSelectionSchema = Type.Object(
  {
    provider: Type.String({ minLength: 1 }),
    modelId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

type WithoutSignal<T> = T extends unknown ? Omit<T, "signal"> : never;
export interface AuthStatus {
  providerId: string;
  status: "connected" | "disconnected" | "connecting" | "error";
  authType?: AuthType;
  message?: string;
  event?: AuthEvent;
  prompt?: WithoutSignal<AuthPrompt> & { id: string };
}
export interface ProviderSummary {
  id: string;
  name: string;
  methods: Array<{ type: AuthType; name: string }>;
  models: Array<{ id: string; name: string; thinkingLevels: ModelThinkingLevel[] }>;
}

export const RuntimeStatusSchema = Type.Object(
  {
    model: Type.String(),
    harness: Type.Literal("v2"),
    scienceWorker: Type.Union([
      Type.Literal("stopped"),
      Type.Literal("starting"),
      Type.Literal("ready"),
      Type.Literal("failed"),
    ]),
    duckdb: Type.Union([Type.Literal("idle"), Type.Literal("ready")]),
    r: Type.Union([
      Type.Literal("idle"),
      Type.Literal("ready"),
      Type.Literal("unavailable"),
    ]),
  },
  { additionalProperties: false },
);

export const AgentEventSchema = Type.Object(
  {
    sequence: Type.Integer({ minimum: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    event: Type.Unknown(),
  },
  { additionalProperties: false },
);

export type ApiError = Static<typeof ApiErrorSchema>;
export type SessionSummary = Static<typeof SessionSummarySchema>;
export type CreateSessionRequest = Static<typeof CreateSessionRequestSchema>;
export type PromptRequest = Static<typeof PromptRequestSchema>;
export type PromptAccepted = Static<typeof PromptAcceptedSchema>;
export type LoginRequest = Static<typeof LoginRequestSchema>;
export type AuthReply = Static<typeof AuthReplySchema>;
export type ModelSelection = Static<typeof ModelSelectionSchema>;
export type RuntimeStatus = Static<typeof RuntimeStatusSchema>;
export type WorkspaceSnapshot = LaneSnapshot & { draft: string; eventCursor: number };
export type AgentEvent = Omit<Static<typeof AgentEventSchema>, "event"> & {
  event: HarnessEvent | { type: "snapshot"; snapshot: WorkspaceSnapshot } | { type: "application_error"; operationId: string; message: string };
};

export function assertSchema<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) {
    const first = Value.Errors(schema, value).First();
    throw new Error(first?.message ?? "Request does not match the API schema");
  }
  return value as Static<T>;
}
