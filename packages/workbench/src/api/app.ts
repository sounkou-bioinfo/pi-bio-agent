import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ZodType } from "zod";
import { fsCasStore } from "pi-bio-agent";
import {
  AgentSessionConflictError,
  AgentSessionNotFoundError,
  type AgentActivityEvent,
  type AgentHostPort,
} from "../agent-host.js";
import {
  ClinicalReviewInputError,
  getClinicalAnalysis,
  getClinicalReviewQueue,
  listClinicalAnalyses,
  listClinicalReanalysisQueue,
  runClinicalGenomicsWorkbench,
  updateClinicalReviewDisposition,
} from "../clinical-genomics.js";
import type { GroundingRuntime } from "../phenotype-grounding.js";
import type { PhenotypeHypothesisRuntime } from "../monarch-host.js";
import type { CandidateVariantSearchRuntime } from "../candidate-variant-search.js";
import type { VepAnnotationRuntime } from "../clinical-genomics.js";
import {
  ClinicalCaseRegistryInputError,
  getClinicalCaseRevision,
  listClinicalCaseRevisions,
  registerClinicalCaseRevision,
  type RegisterClinicalCaseRevisionRequest,
} from "../clinical-case-registry.js";
import { addonDescriptor, type WorkbenchAddon } from "../workbench-addon.js";
import {
  AnalysisPathSchema,
  AgentActivityPageSchema,
  AgentCommandListSchema,
  AgentEventQuerySchema,
  AgentSessionListSchema,
  AgentSessionPathSchema,
  AgentSessionSchema,
  AgentTranscriptQuerySchema,
  AgentTranscriptSchema,
  ClinicalAnalysisResponseSchema,
  ClinicalAnalysisListQuerySchema,
  ClinicalAnalysisListSchema,
  ClinicalCasePathSchema,
  ClinicalCaseRevisionListQuerySchema,
  ClinicalCaseRevisionListSchema,
  ClinicalCaseRevisionPathSchema,
  ClinicalCaseRevisionSchema,
  ClinicalReanalysisQueueQuerySchema,
  ClinicalReanalysisQueueSchema,
  ClinicalReviewQueueResponseSchema,
  CloseAgentSessionResponseSchema,
  CreateClinicalAnalysisSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  OpenAgentSessionSchema,
  RenameAgentSessionSchema,
  RegisterClinicalCaseRevisionSchema,
  ReviewPathSchema,
  RunClinicalAnalysisResponseSchema,
  SendAgentMessageSchema,
  StageClinicalCaseAssetPathSchema,
  StageClinicalCaseAssetResponseSchema,
  UpdateClinicalReviewSchema,
  WorkbenchInfoSchema,
} from "./schemas.js";

export interface ClinicalWorkbenchAddonOptions {
  clinicalWorkspace: string;
  grounding: GroundingRuntime;
  hypotheses: PhenotypeHypothesisRuntime;
  variantSearch: CandidateVariantSearchRuntime;
  vep: VepAnnotationRuntime;
  clock?: () => string;
}

export interface WorkbenchApiOptions {
  agentHost?: AgentHostPort;
  addons?: WorkbenchAddon[];
}

const json = <T extends ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});

async function stageClinicalAssetBytes(
  workspace: string,
  body: ReadableStream<Uint8Array> | null,
  expectedDigest: string,
): Promise<{ digest: `sha256:${string}`; uri: `cas:sha256:${string}`; sizeBytes: number }> {
  if (!body) throw new ClinicalCaseRegistryInputError("asset request body is required");
  const uploadDir = join(workspace, ".pi", "bio-agent", "uploads");
  await fs.mkdir(uploadDir, { recursive: true });
  const temporaryPath = join(uploadDir, `asset-${randomUUID()}.tmp`);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    const handle = await fs.open(temporaryPath, "wx");
    try {
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const bytes = Buffer.from(value);
          hash.update(bytes);
          sizeBytes += bytes.length;
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, null);
            if (bytesWritten === 0) throw new Error("asset upload made no write progress");
            offset += bytesWritten;
          }
        }
      } finally {
        reader.releaseLock();
      }
    } finally {
      await handle.close();
    }
    if (sizeBytes === 0) throw new ClinicalCaseRegistryInputError("asset request body is empty");
    const actualDigest = hash.digest("hex");
    if (actualDigest !== expectedDigest) {
      throw new ClinicalCaseRegistryInputError(`asset bytes hash to '${actualDigest}', not '${expectedDigest}'`);
    }
    const stored = await fsCasStore(join(workspace, ".pi", "bio-agent", "cas")).putFile(temporaryPath);
    if (stored.address.digest !== expectedDigest || stored.size !== sizeBytes) {
      throw new Error("CAS staging result does not match the verified upload");
    }
    return {
      digest: `sha256:${expectedDigest}`,
      uri: `cas:sha256:${expectedDigest}`,
      sizeBytes,
    };
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

const healthRoute = createRoute({
  method: "get",
  path: "/healthz",
  tags: ["service"],
  responses: {
    200: { ...json(HealthResponseSchema), description: "Service is ready." },
  },
});

const workbenchInfoRoute = createRoute({
  method: "get",
  path: "/v1/workbench",
  tags: ["service"],
  responses: {
    200: { ...json(WorkbenchInfoSchema), description: "Available workbench host capabilities." },
  },
});

const listAgentSessionsRoute = createRoute({
  method: "get",
  path: "/v1/agent-sessions",
  tags: ["agent sessions"],
  summary: "List active and resumable agent sessions",
  responses: {
    200: { ...json(AgentSessionListSchema), description: "Agent sessions visible to this host workspace." },
    503: { ...json(ErrorResponseSchema), description: "No interactive agent host is configured." },
    500: { ...json(ErrorResponseSchema), description: "The agent host could not list sessions." },
  },
});

const openAgentSessionRoute = createRoute({
  method: "post",
  path: "/v1/agent-sessions",
  tags: ["agent sessions"],
  summary: "Open or resume an agent session",
  request: {
    body: { required: true, content: { "application/json": { schema: OpenAgentSessionSchema } } },
  },
  responses: {
    201: { ...json(AgentSessionSchema), description: "The active agent session." },
    404: { ...json(ErrorResponseSchema), description: "The requested persisted session was not found." },
    503: { ...json(ErrorResponseSchema), description: "No interactive agent host is configured." },
    500: { ...json(ErrorResponseSchema), description: "The agent host could not open the session." },
  },
});

const getAgentSessionRoute = createRoute({
  method: "get",
  path: "/v1/agent-sessions/{sessionId}",
  tags: ["agent sessions"],
  request: { params: AgentSessionPathSchema },
  responses: {
    200: { ...json(AgentSessionSchema), description: "Current agent session state." },
    404: { ...json(ErrorResponseSchema), description: "The active session was not found." },
    503: { ...json(ErrorResponseSchema), description: "No interactive agent host is configured." },
    500: { ...json(ErrorResponseSchema), description: "The agent host could not read the session." },
  },
});

const renameAgentSessionRoute = createRoute({
  method: "patch",
  path: "/v1/agent-sessions/{sessionId}",
  tags: ["agent sessions"],
  summary: "Rename a persisted agent session",
  request: {
    params: AgentSessionPathSchema,
    body: { required: true, content: { "application/json": { schema: RenameAgentSessionSchema } } },
  },
  responses: {
    200: { ...json(AgentSessionSchema), description: "The renamed active session." },
    404: { ...json(ErrorResponseSchema), description: "The active session was not found." },
    503: { ...json(ErrorResponseSchema), description: "No interactive agent host is configured." },
    500: { ...json(ErrorResponseSchema), description: "The agent host could not rename the session." },
  },
});

const agentCommandsRoute = createRoute({
  method: "get",
  path: "/v1/agent-sessions/{sessionId}/commands",
  tags: ["agent sessions"],
  summary: "List commands invokable in the active agent session",
  request: { params: AgentSessionPathSchema },
  responses: {
    200: { ...json(AgentCommandListSchema), description: "Extension, prompt-template, and skill commands." },
    404: { ...json(ErrorResponseSchema), description: "The active session was not found." },
    503: { ...json(ErrorResponseSchema), description: "No interactive agent host is configured." },
    500: { ...json(ErrorResponseSchema), description: "The agent host could not list commands." },
  },
});

const sendAgentMessageRoute = createRoute({
  method: "post",
  path: "/v1/agent-sessions/{sessionId}/messages",
  tags: ["agent sessions"],
  summary: "Prompt, steer, or follow up with an agent",
  request: {
    params: AgentSessionPathSchema,
    body: { required: true, content: { "application/json": { schema: SendAgentMessageSchema } } },
  },
  responses: {
    202: { ...json(AgentSessionSchema), description: "The input was accepted by the host." },
    404: { ...json(ErrorResponseSchema), description: "The active session was not found." },
    409: { ...json(ErrorResponseSchema), description: "The input was incompatible with current agent state." },
    503: { ...json(ErrorResponseSchema), description: "No interactive agent host is configured." },
    500: { ...json(ErrorResponseSchema), description: "The agent host failed while accepting the input." },
  },
});

const abortAgentSessionRoute = createRoute({
  method: "post",
  path: "/v1/agent-sessions/{sessionId}/abort",
  tags: ["agent sessions"],
  summary: "Abort the active agent operation",
  request: { params: AgentSessionPathSchema },
  responses: {
    200: { ...json(AgentSessionSchema), description: "The agent is idle after abort settlement." },
    404: { ...json(ErrorResponseSchema), description: "The active session was not found." },
    503: { ...json(ErrorResponseSchema), description: "No interactive agent host is configured." },
    500: { ...json(ErrorResponseSchema), description: "The agent host could not abort the session." },
  },
});

const closeAgentSessionRoute = createRoute({
  method: "delete",
  path: "/v1/agent-sessions/{sessionId}",
  tags: ["agent sessions"],
  summary: "Close the active host session while retaining its persisted history",
  request: { params: AgentSessionPathSchema },
  responses: {
    200: { ...json(CloseAgentSessionResponseSchema), description: "The active host resources were released." },
    404: { ...json(ErrorResponseSchema), description: "The active session was not found." },
    503: { ...json(ErrorResponseSchema), description: "No interactive agent host is configured." },
    500: { ...json(ErrorResponseSchema), description: "The agent host could not close the session." },
  },
});

const agentEventsRoute = createRoute({
  method: "get",
  path: "/v1/agent-sessions/{sessionId}/events",
  tags: ["agent sessions"],
  summary: "Read a bounded page of ephemeral agent activity",
  request: { params: AgentSessionPathSchema, query: AgentEventQuerySchema },
  responses: {
    200: { ...json(AgentActivityPageSchema), description: "Agent activity after the requested cursor." },
    404: { ...json(ErrorResponseSchema), description: "The active session was not found." },
    503: { ...json(ErrorResponseSchema), description: "No interactive agent host is configured." },
    500: { ...json(ErrorResponseSchema), description: "The agent host could not read activity." },
  },
});

const agentTranscriptRoute = createRoute({
  method: "get",
  path: "/v1/agent-sessions/{sessionId}/transcript",
  tags: ["agent sessions"],
  summary: "Read a bounded active-session transcript",
  request: { params: AgentSessionPathSchema, query: AgentTranscriptQuerySchema },
  responses: {
    200: { ...json(AgentTranscriptSchema), description: "The tail of the host transcript." },
    404: { ...json(ErrorResponseSchema), description: "The active session was not found." },
    503: { ...json(ErrorResponseSchema), description: "No interactive agent host is configured." },
    500: { ...json(ErrorResponseSchema), description: "The agent host could not read the transcript." },
  },
});

const stageClinicalCaseAssetRoute = createRoute({
  method: "put",
  path: "/v1/clinical-case-assets/{digest}",
  tags: ["clinical cases"],
  summary: "Stream verified bytes into the clinical workspace CAS",
  description: "The path is the caller-computed SHA-256 hex digest and the request body is the raw asset bytes. No host filesystem path crosses the API boundary.",
  request: { params: StageClinicalCaseAssetPathSchema },
  responses: {
    201: { ...json(StageClinicalCaseAssetResponseSchema), description: "The verified immutable CAS reference." },
    400: { ...json(ErrorResponseSchema), description: "The body was empty or did not match the declared digest." },
    500: { ...json(ErrorResponseSchema), description: "The asset could not be staged." },
  },
});

const registerClinicalCaseRevisionRoute = createRoute({
  method: "post",
  path: "/v1/clinical-cases/{caseId}/revisions",
  tags: ["clinical cases"],
  summary: "Register an immutable clinical case revision",
  description: "Binds pseudonymous family structure and staged CAS assets. The ledger stores identifiers and content addresses; raw clinical bytes remain in CAS.",
  request: {
    params: ClinicalCasePathSchema,
    body: { required: true, content: { "application/json": { schema: RegisterClinicalCaseRevisionSchema } } },
  },
  responses: {
    201: { ...json(ClinicalCaseRevisionSchema), description: "The immutable registered revision." },
    400: { ...json(ErrorResponseSchema), description: "The revision or one of its asset/family references is invalid." },
    500: { ...json(ErrorResponseSchema), description: "The revision could not be registered." },
  },
});

const listClinicalCaseRevisionsRoute = createRoute({
  method: "get",
  path: "/v1/clinical-cases/{caseId}/revisions",
  tags: ["clinical cases"],
  summary: "List immutable revisions for one clinical case",
  request: { params: ClinicalCasePathSchema, query: ClinicalCaseRevisionListQuerySchema },
  responses: {
    200: { ...json(ClinicalCaseRevisionListSchema), description: "Revision summaries from the temporal ledger." },
    500: { ...json(ErrorResponseSchema), description: "The case revision history could not be read." },
  },
});

const getClinicalCaseRevisionRoute = createRoute({
  method: "get",
  path: "/v1/clinical-cases/{caseId}/revisions/{revisionId}",
  tags: ["clinical cases"],
  summary: "Read one immutable clinical case revision",
  request: { params: ClinicalCaseRevisionPathSchema },
  responses: {
    200: { ...json(ClinicalCaseRevisionSchema), description: "The verified revision read from CAS." },
    404: { ...json(ErrorResponseSchema), description: "No registered revision has this case/revision identity." },
    500: { ...json(ErrorResponseSchema), description: "The revision could not be read." },
  },
});

const createAnalysisRoute = createRoute({
  method: "post",
  path: "/v1/clinical-analyses",
  tags: ["clinical analyses"],
  summary: "Run a clinical evidence analysis",
  description: "Runs direct and inverted evidence traversal plus reanalysis through recorded pi-bio-agent operations and a resumable packet step.",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateClinicalAnalysisSchema } },
    },
  },
  responses: {
    201: { ...json(RunClinicalAnalysisResponseSchema), description: "The analysis completed and its evidence packet was recorded." },
    400: { ...json(ErrorResponseSchema), description: "The request did not match the declared schema." },
    500: { ...json(ErrorResponseSchema), description: "The analysis failed." },
  },
});

const listAnalysesRoute = createRoute({
  method: "get",
  path: "/v1/clinical-analyses",
  tags: ["clinical analyses"],
  summary: "List recorded clinical analyses",
  description: "Projects completed evidence packets from the temporal ledger. A case filter retains all recorded analysis history for that case.",
  request: { query: ClinicalAnalysisListQuerySchema },
  responses: {
    200: { ...json(ClinicalAnalysisListSchema), description: "Recorded analysis summaries ordered by latest ledger record." },
    500: { ...json(ErrorResponseSchema), description: "The clinical analysis history could not be read." },
  },
});

const getAnalysisRoute = createRoute({
  method: "get",
  path: "/v1/clinical-analyses/{analysisId}",
  tags: ["clinical analyses"],
  summary: "Read a recorded clinical analysis",
  request: { params: AnalysisPathSchema },
  responses: {
    200: { ...json(ClinicalAnalysisResponseSchema), description: "The recorded packet, read back from CAS." },
    404: { ...json(ErrorResponseSchema), description: "No completed analysis has this id." },
    500: { ...json(ErrorResponseSchema), description: "The recorded analysis could not be read." },
  },
});

const getClinicalReviewQueueRoute = createRoute({
  method: "get",
  path: "/v1/clinical-analyses/{analysisId}/reviews",
  tags: ["clinical analyses"],
  summary: "Read the durable review state for a recorded analysis",
  request: { params: AnalysisPathSchema },
  responses: {
    200: { ...json(ClinicalReviewQueueResponseSchema), description: "Review items with their current ledger-backed dispositions." },
    404: { ...json(ErrorResponseSchema), description: "No completed analysis has this id." },
    500: { ...json(ErrorResponseSchema), description: "The clinical review queue could not be read." },
  },
});

const updateClinicalReviewRoute = createRoute({
  method: "put",
  path: "/v1/clinical-analyses/{analysisId}/reviews/{reviewId}",
  tags: ["clinical analyses"],
  summary: "Record a non-diagnostic review disposition",
  description: "This records human workflow state against an evidence packet. It does not change variant classification or produce a clinical conclusion.",
  request: {
    params: ReviewPathSchema,
    body: { required: true, content: { "application/json": { schema: UpdateClinicalReviewSchema } } },
  },
  responses: {
    200: { ...json(ClinicalReviewQueueResponseSchema), description: "The current ledger-backed review queue after the disposition was recorded." },
    400: { ...json(ErrorResponseSchema), description: "The review update did not match the recorded evidence item." },
    404: { ...json(ErrorResponseSchema), description: "No completed analysis has this id." },
    500: { ...json(ErrorResponseSchema), description: "The review disposition could not be recorded." },
  },
});

const clinicalReanalysisQueueRoute = createRoute({
  method: "get",
  path: "/v1/clinical-reanalysis-queue",
  tags: ["clinical reanalysis"],
  summary: "List the latest recorded reanalysis state for each case",
  description: "A transparent queue over recorded current-versus-prior evidence, unresolved evidence, and human review state. It is not a diagnostic ranking or classification endpoint.",
  request: { query: ClinicalReanalysisQueueQuerySchema },
  responses: {
    200: { ...json(ClinicalReanalysisQueueSchema), description: "One latest recorded analysis per case, with explicit queue reasons." },
    500: { ...json(ErrorResponseSchema), description: "The clinical reanalysis queue could not be read." },
  },
});

export function createWorkbenchApi(options: WorkbenchApiOptions): OpenAPIHono {
  const app = new OpenAPIHono({
    defaultHook: (result, context) => {
      if (result.success) return;
      return context.json({ error: { code: "invalid_request", message: result.error.message } }, 400);
    },
  });

  const applicationHeaders = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
    },
    strictTransportSecurity: false,
  });
  app.use("*", async (context, next) => {
    await applicationHeaders(context, next);
    const override = context.res.headers.get("x-pi-bio-csp-override");
    if (override) {
      context.res.headers.set("content-security-policy", override);
      context.res.headers.delete("x-pi-bio-csp-override");
    }
  });

  app.openapi(healthRoute, (context) => context.json({ ok: true, service: "pi-bio-workbench" }, 200));

  app.openapi(workbenchInfoRoute, (context) => context.json({
    service: "pi-bio-workbench",
    agentHost: options.agentHost?.kind ?? null,
    capabilities: {
      agentSessions: Boolean(options.agentHost),
      agentSteering: Boolean(options.agentHost),
      agentCommands: Boolean(options.agentHost),
      eventStream: Boolean(options.agentHost),
    },
    addons: [...(options.addons ?? [])]
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map(addonDescriptor),
  }, 200));

  const unavailable = (context: Context) => context.json({
    error: { code: "agent_host_unavailable", message: "This workbench was started without an interactive agent host." },
  }, 503);

  const internalError = (context: Context, error: unknown, code: string) => context.json({
    error: { code, message: error instanceof Error ? error.message : String(error) },
  }, 500);

  const sessionError = (context: Context, error: unknown, fallbackCode: string) => {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof AgentSessionNotFoundError) {
      return context.json({ error: { code: "agent_session_not_found", message } }, 404);
    }
    return internalError(context, error, fallbackCode);
  };

  const inputError = (context: Context, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof AgentSessionNotFoundError) {
      return context.json({ error: { code: "agent_session_not_found", message } }, 404);
    }
    if (error instanceof AgentSessionConflictError) {
      return context.json({ error: { code: "agent_session_conflict", message } }, 409);
    }
    return internalError(context, error, "agent_input_failed");
  };

  app.openapi(listAgentSessionsRoute, async (context) => {
    if (!options.agentHost) return unavailable(context);
    try {
      return context.json(AgentSessionListSchema.parse({ sessions: await options.agentHost.list() }), 200);
    } catch (error) {
      return internalError(context, error, "agent_session_list_failed");
    }
  });

  app.openapi(openAgentSessionRoute, async (context) => {
    if (!options.agentHost) return unavailable(context);
    try {
      const session = await options.agentHost.open(context.req.valid("json"));
      return context.json(AgentSessionSchema.parse(session), 201);
    } catch (error) {
      return sessionError(context, error, "agent_session_open_failed");
    }
  });

  app.openapi(getAgentSessionRoute, async (context) => {
    if (!options.agentHost) return unavailable(context);
    const { sessionId } = context.req.valid("param");
    try {
      const session = await options.agentHost.get(sessionId);
      if (!session) return context.json({ error: { code: "agent_session_not_found", message: `Agent session '${sessionId}' is not active.` } }, 404);
      return context.json(AgentSessionSchema.parse(session), 200);
    } catch (error) {
      return sessionError(context, error, "agent_session_read_failed");
    }
  });

  app.openapi(renameAgentSessionRoute, async (context) => {
    if (!options.agentHost) return unavailable(context);
    const { sessionId } = context.req.valid("param");
    try {
      return context.json(AgentSessionSchema.parse(await options.agentHost.rename(sessionId, context.req.valid("json").name)), 200);
    } catch (error) {
      return sessionError(context, error, "agent_session_rename_failed");
    }
  });

  app.openapi(agentCommandsRoute, async (context) => {
    if (!options.agentHost) return unavailable(context);
    const { sessionId } = context.req.valid("param");
    try {
      return context.json(AgentCommandListSchema.parse(await options.agentHost.commands(sessionId)), 200);
    } catch (error) {
      return sessionError(context, error, "agent_commands_failed");
    }
  });

  app.openapi(sendAgentMessageRoute, async (context) => {
    if (!options.agentHost) return unavailable(context);
    const { sessionId } = context.req.valid("param");
    try {
      const session = await options.agentHost.send(sessionId, context.req.valid("json"));
      return context.json(AgentSessionSchema.parse(session), 202);
    } catch (error) {
      return inputError(context, error);
    }
  });

  app.openapi(abortAgentSessionRoute, async (context) => {
    if (!options.agentHost) return unavailable(context);
    const { sessionId } = context.req.valid("param");
    try {
      return context.json(AgentSessionSchema.parse(await options.agentHost.abort(sessionId)), 200);
    } catch (error) {
      return sessionError(context, error, "agent_abort_failed");
    }
  });

  app.openapi(closeAgentSessionRoute, async (context) => {
    if (!options.agentHost) return unavailable(context);
    const { sessionId } = context.req.valid("param");
    try {
      await options.agentHost.close(sessionId);
      return context.json(CloseAgentSessionResponseSchema.parse({ closed: true, sessionId }), 200);
    } catch (error) {
      return sessionError(context, error, "agent_session_close_failed");
    }
  });

  app.openapi(agentEventsRoute, async (context) => {
    if (!options.agentHost) return unavailable(context);
    const { sessionId } = context.req.valid("param");
    const query = context.req.valid("query");
    try {
      return context.json(AgentActivityPageSchema.parse(await options.agentHost.events(sessionId, query.after, query.limit)), 200);
    } catch (error) {
      return sessionError(context, error, "agent_events_failed");
    }
  });

  app.openapi(agentTranscriptRoute, async (context) => {
    if (!options.agentHost) return unavailable(context);
    const { sessionId } = context.req.valid("param");
    const { limit } = context.req.valid("query");
    try {
      return context.json(AgentTranscriptSchema.parse(await options.agentHost.transcript(sessionId, limit)), 200);
    } catch (error) {
      return sessionError(context, error, "agent_transcript_failed");
    }
  });

  app.get("/v1/agent-sessions/:sessionId/event-stream", async (context) => {
    if (!options.agentHost) return unavailable(context);
    const sessionId = context.req.param("sessionId");
    const requested = context.req.query("after") ?? context.req.header("last-event-id") ?? "0";
    const after = Number(requested);
    if (!Number.isInteger(after) || after < 0) {
      return context.json({ error: { code: "invalid_event_cursor", message: "after must be a non-negative integer" } }, 400);
    }
    if (!await options.agentHost.get(sessionId)) {
      return context.json({ error: { code: "agent_session_not_found", message: `Agent session '${sessionId}' is not active.` } }, 404);
    }
    return streamSSE(context, async (stream) => {
      let cursor = after;
      let writes = Promise.resolve();
      const write = (event: AgentActivityEvent) => {
        if (event.cursor <= cursor) return;
        cursor = event.cursor;
        writes = writes.then(() => stream.writeSSE({ id: String(event.cursor), event: "activity", data: JSON.stringify(event) }));
      };
      const unsubscribe = options.agentHost!.subscribe(sessionId, write);
      stream.onAbort(unsubscribe);
      try {
        const page = await options.agentHost!.events(sessionId, after, 1_000);
        for (const event of page.events) write(event);
        while (!stream.aborted) {
          await stream.sleep(15_000);
          if (!stream.aborted) writes = writes.then(() => stream.writeSSE({ event: "heartbeat", data: String(cursor) }));
        }
        await writes;
      } finally {
        unsubscribe();
      }
    });
  });

  for (const addon of options.addons ?? []) addon.registerApi(app);

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "pi-bio-workbench API",
      version: "0.1.0",
      description: "API-first scientific workbench over declared resources, DuckDB SQL, recorded runs, CAS artifacts, and ledger observations.",
    },
  });

  return app;
}

export function createClinicalWorkbenchAddon(options: ClinicalWorkbenchAddonOptions): WorkbenchAddon {
  return {
    id: "clinical-evidence",
    label: "Evidence",
    order: 100,
    browserEntry: "/addons/clinical-evidence.js",
    registerApi(app) {
      app.openapi(stageClinicalCaseAssetRoute, async (context) => {
        const { digest } = context.req.valid("param");
        try {
          return context.json(StageClinicalCaseAssetResponseSchema.parse(
            await stageClinicalAssetBytes(options.clinicalWorkspace, context.req.raw.body, digest),
          ), 201);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof ClinicalCaseRegistryInputError) {
            return context.json({ error: { code: "invalid_clinical_asset", message } }, 400);
          }
          return context.json({ error: { code: "clinical_asset_stage_failed", message } }, 500);
        }
      });

      app.openapi(registerClinicalCaseRevisionRoute, async (context) => {
        const { caseId } = context.req.valid("param");
        const request = context.req.valid("json");
        try {
          const revision = await registerClinicalCaseRevision(options.clinicalWorkspace, {
            ...request,
            caseId,
            assets: request.assets.map((asset) => ({
              ...asset,
              digest: asset.digest as `sha256:${string}`,
            })),
            recordedAt: options.clock?.(),
          } satisfies RegisterClinicalCaseRevisionRequest);
          return context.json(ClinicalCaseRevisionSchema.parse(revision), 201);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof ClinicalCaseRegistryInputError) {
            return context.json({ error: { code: "invalid_clinical_case_revision", message } }, 400);
          }
          return context.json({ error: { code: "clinical_case_revision_failed", message } }, 500);
        }
      });

      app.openapi(listClinicalCaseRevisionsRoute, async (context) => {
        const { caseId } = context.req.valid("param");
        const query = context.req.valid("query");
        try {
          return context.json(ClinicalCaseRevisionListSchema.parse({
            revisions: await listClinicalCaseRevisions(options.clinicalWorkspace, {
              caseId,
              limit: query.limit,
              ...(query.asOf ? { asOf: query.asOf } : {}),
            }),
          }), 200);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return context.json({ error: { code: "clinical_case_revision_list_failed", message } }, 500);
        }
      });

      app.openapi(getClinicalCaseRevisionRoute, async (context) => {
        const { caseId, revisionId } = context.req.valid("param");
        try {
          const revision = await getClinicalCaseRevision(options.clinicalWorkspace, caseId, revisionId);
          if (!revision) {
            return context.json({ error: { code: "clinical_case_revision_not_found", message: `No revision '${revisionId}' was found for case '${caseId}'.` } }, 404);
          }
          return context.json(ClinicalCaseRevisionSchema.parse(revision), 200);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return context.json({ error: { code: "clinical_case_revision_read_failed", message } }, 500);
        }
      });

      app.openapi(listAnalysesRoute, async (context) => {
        try {
          return context.json(ClinicalAnalysisListSchema.parse({
            analyses: await listClinicalAnalyses(options.clinicalWorkspace, context.req.valid("query")),
          }), 200);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return context.json({ error: { code: "analysis_list_failed", message } }, 500);
        }
      });

      app.openapi(createAnalysisRoute, async (context) => {
        const request = context.req.valid("json");
        try {
          const result = await runClinicalGenomicsWorkbench({
            exampleDir: options.clinicalWorkspace,
            caseId: request.caseId,
            ...(request.caseRevisionId ? { caseRevisionId: request.caseRevisionId } : {}),
            ...(request.analysisId ? { analysisId: request.analysisId } : {}),
            grounding: options.grounding,
            hypotheses: options.hypotheses,
            variantSearch: options.variantSearch,
            vep: options.vep,
            now: options.clock?.(),
          });
          const { storePath: _storePath, analysisDbPath: _analysisDbPath, ...publicResult } = result;
          return context.json(RunClinicalAnalysisResponseSchema.parse(publicResult), 201);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return context.json({ error: { code: "analysis_failed", message } }, 500);
        }
      });

      app.openapi(getClinicalReviewQueueRoute, async (context) => {
        const { analysisId } = context.req.valid("param");
        try {
          const queue = await getClinicalReviewQueue(options.clinicalWorkspace, analysisId);
          if (!queue.found) {
            return context.json({ error: { code: "analysis_not_found", message: `No completed analysis '${analysisId}' was found.` } }, 404);
          }
          const { found: _found, ...publicQueue } = queue;
          return context.json(ClinicalReviewQueueResponseSchema.parse(publicQueue), 200);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return context.json({ error: { code: "review_queue_read_failed", message } }, 500);
        }
      });

      app.openapi(updateClinicalReviewRoute, async (context) => {
        const { analysisId, reviewId } = context.req.valid("param");
        const request = context.req.valid("json");
        try {
          const queue = await updateClinicalReviewDisposition(options.clinicalWorkspace, analysisId, {
            reviewId,
            status: request.status,
            ...(request.note ? { note: request.note } : {}),
            now: options.clock?.(),
          });
          if (!queue.found) {
            return context.json({ error: { code: "analysis_not_found", message: `No completed analysis '${analysisId}' was found.` } }, 404);
          }
          const { found: _found, ...publicQueue } = queue;
          return context.json(ClinicalReviewQueueResponseSchema.parse(publicQueue), 200);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof ClinicalReviewInputError) {
            return context.json({ error: { code: "invalid_review_item", message } }, 400);
          }
          return context.json({ error: { code: "review_update_failed", message } }, 500);
        }
      });

      app.openapi(getAnalysisRoute, async (context) => {
        const { analysisId } = context.req.valid("param");
        try {
          const status = await getClinicalAnalysis(options.clinicalWorkspace, analysisId);
          if (!status.found) {
            return context.json({ error: { code: "analysis_not_found", message: `No completed analysis '${analysisId}' was found.` } }, 404);
          }
          const { found: _found, ...recorded } = status;
          return context.json(ClinicalAnalysisResponseSchema.parse(recorded), 200);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return context.json({ error: { code: "analysis_read_failed", message } }, 500);
        }
      });
    },
  };
}

export function createClinicalReanalysisWorkbenchAddon(options: ClinicalWorkbenchAddonOptions): WorkbenchAddon {
  return {
    id: "clinical-reanalysis",
    label: "Reanalysis",
    order: 150,
    browserEntry: "/addons/clinical-reanalysis.js",
    registerApi(app) {
      app.openapi(clinicalReanalysisQueueRoute, async (context) => {
        try {
          return context.json(ClinicalReanalysisQueueSchema.parse({
            cases: await listClinicalReanalysisQueue(options.clinicalWorkspace, context.req.valid("query")),
          }), 200);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return context.json({ error: { code: "reanalysis_queue_failed", message } }, 500);
        }
      });
    },
  };
}
