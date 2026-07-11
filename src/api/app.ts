import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { ZodType } from "zod";
import {
  getClinicalAnalysis,
  runClinicalGenomicsWorkbench,
} from "../clinical-genomics.js";
import type { GroundingRuntime } from "../phenotype-grounding.js";
import type { PhenotypeHypothesisRuntime } from "../monarch-host.js";
import {
  AnalysisPathSchema,
  ClinicalAnalysisResponseSchema,
  CreateClinicalAnalysisSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  RunClinicalAnalysisResponseSchema,
} from "./schemas.js";

export interface WorkbenchApiOptions {
  clinicalWorkspace: string;
  grounding: GroundingRuntime;
  hypotheses: PhenotypeHypothesisRuntime;
  clock?: () => string;
}

const json = <T extends ZodType>(schema: T) => ({
  content: { "application/json": { schema } },
});

const healthRoute = createRoute({
  method: "get",
  path: "/healthz",
  tags: ["service"],
  responses: {
    200: { ...json(HealthResponseSchema), description: "Service is ready." },
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

export function createWorkbenchApi(options: WorkbenchApiOptions): OpenAPIHono {
  const app = new OpenAPIHono({
    defaultHook: (result, context) => {
      if (result.success) return;
      return context.json({ error: { code: "invalid_request", message: result.error.message } }, 400);
    },
  });

  app.openapi(healthRoute, (context) => context.json({ ok: true, service: "pi-bio-workbench" }, 200));

  app.openapi(createAnalysisRoute, async (context) => {
    const request = context.req.valid("json");
    try {
      const result = await runClinicalGenomicsWorkbench({
        exampleDir: options.clinicalWorkspace,
        caseId: request.caseId,
        grounding: options.grounding,
        hypotheses: options.hypotheses,
        now: options.clock?.(),
      });
      const { storePath: _storePath, analysisDbPath: _analysisDbPath, ...publicResult } = result;
      return context.json(RunClinicalAnalysisResponseSchema.parse(publicResult), 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return context.json({ error: { code: "analysis_failed", message } }, 500);
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
