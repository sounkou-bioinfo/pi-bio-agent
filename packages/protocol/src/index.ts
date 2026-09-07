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

export const PromptAcceptedSchema = Type.Object(
  {
    operationId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

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
export type RuntimeStatus = Static<typeof RuntimeStatusSchema>;
export type AgentEvent = Static<typeof AgentEventSchema>;

export function assertSchema<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) {
    const first = Value.Errors(schema, value).First();
    throw new Error(first?.message ?? "Request does not match the API schema");
  }
  return value as Static<T>;
}
