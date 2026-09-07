import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type {
  AgentHarness,
  AgentHarnessTool,
  AgentLane,
  LaneSnapshot,
} from "@earendil-works/pi-agent-core";
import type { ScienceToolRuntime } from "./science/client.js";

export interface AppToolContext {
  science: ScienceToolRuntime;
  rScope: string;
  harness?: AgentHarness<AppToolContext>;
}

const SqlParameters = Type.Object(
  {
    sql: Type.String({ minLength: 1, maxLength: 200_000 }),
    maxRows: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
  },
  { additionalProperties: false },
);

const RParameters = Type.Object(
  {
    code: Type.String({ minLength: 1, maxLength: 200_000 }),
    maxRows: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
  },
  { additionalProperties: false },
);

const DelegateParameters = Type.Object(
  {
    task: Type.String({ minLength: 1, maxLength: 100_000 }),
  },
  { additionalProperties: false },
);

const EmptyParameters = Type.Object({}, { additionalProperties: false });

export function createHarnessTools(): AgentHarnessTool<AppToolContext>[] {
  const duckdbSql: AgentHarnessTool<AppToolContext, typeof SqlParameters> = {
    name: "duckdb_sql",
    label: "DuckDB SQL",
    description:
      "Execute SQL in the persistent scientific workspace. Durable tables survive restarts; temporary relations do not.",
    parameters: SqlParameters,
    execute: async (_toolCallId, params, _onUpdate, toolContext, _invocation, context) => {
      const value = await toolContext.science.sql(
        params.sql,
        params.maxRows,
        context.abortSignal,
      );
      return toolResult(value);
    },
  };

  const rEval: AgentHarnessTool<AppToolContext, typeof RParameters> = {
    name: "r_eval",
    label: "R",
    description:
      "Evaluate R code in a persistent nanonext/NNG worker. Treat the R heap as scratch and materialize durable results into DuckDB or files.",
    parameters: RParameters,
    execute: async (_toolCallId, params, _onUpdate, toolContext, _invocation, context) => {
      const value = await toolContext.science.evalR(
        toolContext.rScope,
        params.code,
        params.maxRows,
        context.abortSignal,
      );
      return toolResult(value);
    },
  };

  const rReset: AgentHarnessTool<AppToolContext, typeof EmptyParameters> = {
    name: "r_reset",
    label: "Reset R",
    description: "Discard this analysis session's ephemeral R environment and start it clean.",
    parameters: EmptyParameters,
    execute: async (_toolCallId, _params, _onUpdate, toolContext, _invocation, context) =>
      toolResult(await toolContext.science.resetR(toolContext.rScope, context.abortSignal)),
  };

  const delegate: AgentHarnessTool<AppToolContext, typeof DelegateParameters> = {
    name: "delegate",
    label: "Delegate",
    description:
      "Run one isolated child Harness lane for bounded analysis. The child can use DuckDB and R but cannot recursively delegate.",
    parameters: DelegateParameters,
    execute: async (_toolCallId, params, onUpdate, toolContext, invocation, context) => {
      const harness = toolContext.harness;
      if (harness === undefined) throw new Error("Harness context is not attached");
      const memo = await resolveChildMemo(invocation, params.task);
      const lane = await harness.lane(memo.lane, { createAt: null }, context);
      await lane.setActiveTools(["duckdb_sql", "r_eval", "r_reset"], context);
      onUpdate(toolResult({ lane: memo.lane, operationId: memo.operationId, status: "running" }));

      const existing = await lane.getResult(memo.operationId, context);
      if (existing === undefined) {
        const execution = await lane.inspectExecution(context);
        if (execution.current === null) {
          const admission = await lane.accept(
            { kind: "prompt", operationId: memo.operationId, prompt: params.task },
            context,
          );
          if (!admission.ok) throw admission.error;
        } else if (execution.current.id !== memo.operationId) {
          throw new Error(`Child lane ${memo.lane} is occupied by ${execution.current.id}`);
        }
        await driveToSettlement(lane, memo.operationId, context);
      }

      const result = await lane.getResult(memo.operationId, context);
      if (result === undefined) throw new Error("Child Harness operation ended without a result");
      if (result.status !== "completed") {
        throw new Error(result.error?.message ?? `Child Harness operation ${result.status}`);
      }
      const watch = await lane.watch(context);
      const answer = lastAssistantText(watch.snapshot);
      watch.unsubscribe();
      return toolResult({
        lane: memo.lane,
        operationId: memo.operationId,
        status: result.status,
        answer,
      });
    },
  };

  return [duckdbSql, rEval, rReset, delegate];
}

async function resolveChildMemo(
  invocation: {
    invocationId: string;
    getMemo(name: string): Promise<unknown>;
    setMemo(name: string, value: { lane: string; operationId: string }): Promise<void>;
  },
  task: string,
): Promise<{ lane: string; operationId: string }> {
  const existing = await invocation.getMemo("child");
  if (isChildMemo(existing)) return existing;
  const digest = createHash("sha256")
    .update(invocation.invocationId)
    .update("\0")
    .update(task)
    .digest("hex");
  const memo = { lane: `rlm-${digest.slice(0, 16)}`, operationId: `rlm-${digest}` };
  await invocation.setMemo("child", memo);
  return memo;
}

async function driveToSettlement(
  lane: AgentLane,
  operationId: string,
  context: Parameters<AgentLane["drive"]>[1],
): Promise<void> {
  for (;;) {
    const driven = await lane.drive(
      { operationId, waitForRetry: true, pollDeferred: true },
      context,
    );
    if (!driven.ok) throw driven.error;
    if (driven.value.kind === "settled") return;
  }
}

function toolResult(value: unknown): {
  content: [{ type: "text"; text: string }];
  details: unknown;
} {
  return {
    content: [{ type: "text", text: boundedJson(value) }],
    details: jsonSafe(value),
  };
}

function lastAssistantText(snapshot: LaneSnapshot): string {
  for (let index = snapshot.transcript.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.transcript[index];
    if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
    const text = entry.message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (text.length > 0) return text;
  }
  return "";
}

function boundedJson(value: unknown): string {
  const text = JSON.stringify(jsonSafe(value), null, 2) ?? "null";
  return text.length <= 20_000 ? text : `${text.slice(0, 20_000)}\n… truncated`;
}

function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  ) as unknown;
}

function isChildMemo(value: unknown): value is { lane: string; operationId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { lane?: unknown }).lane === "string" &&
    typeof (value as { operationId?: unknown }).operationId === "string"
  );
}
