import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  CreateSessionRequestSchema,
  PromptRequestSchema,
  assertSchema,
} from "@pi-bio/protocol";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentService } from "./agent-service.js";
import type { ScienceRuntime } from "./science/client.js";

type AgentApi = Pick<
  AgentService,
  "modelIdentity" | "listSessions" | "createSession" | "snapshot" | "startPrompt" | "abort" | "subscribe"
>;

export interface AppOptions {
  agents: AgentApi;
  science: Pick<ScienceRuntime, "status">;
  apiToken?: string;
  webDir?: string;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  app.use("*", async (context, next) => {
    await next();
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Referrer-Policy", "no-referrer");
    context.header("X-Frame-Options", "DENY");
  });

  app.get("/health", (context) => context.json({ ok: true }));

  app.use("/api/*", async (context, next) => {
    if (options.apiToken === undefined || options.apiToken.length === 0) return next();
    if (context.req.header("authorization") !== `Bearer ${options.apiToken}`) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    return next();
  });

  app.get("/api/runtime", (context) => {
    const status = options.science.status();
    return context.json({
      model: options.agents.modelIdentity,
      harness: "v2" as const,
      scienceWorker: status.worker,
      duckdb: status.duckdb,
      r: status.r,
    });
  });

  app.get("/api/sessions", async (context) =>
    context.json({ sessions: await options.agents.listSessions() }),
  );

  app.post("/api/sessions", async (context) => {
    const request = assertSchema(CreateSessionRequestSchema, await optionalJson(context.req.raw));
    return context.json(await options.agents.createSession(request.name), 201);
  });

  app.get("/api/sessions/:id", async (context) =>
    context.json(await options.agents.snapshot(context.req.param("id"))),
  );

  app.post("/api/sessions/:id/prompts", async (context) => {
    const request = assertSchema(PromptRequestSchema, await context.req.json());
    const operationId = await options.agents.startPrompt(context.req.param("id"), request.text);
    return context.json({ operationId }, 202);
  });

  app.post("/api/sessions/:id/abort", async (context) => {
    await options.agents.abort(context.req.param("id"));
    return context.json({ aborted: true });
  });

  app.get("/api/sessions/:id/events", (context) =>
    streamSSE(context, async (stream) => {
      const after = cursor(context.req.header("last-event-id") ?? context.req.query("after"));
      let writes = Promise.resolve();
      let finish: (() => void) | undefined;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const unsubscribe = await options.agents.subscribe(
        context.req.param("id"),
        after,
        (record) => {
          writes = writes.then(() =>
            stream.writeSSE({
              id: String(record.sequence),
              event: "harness",
              data: JSON.stringify(record),
            }),
          );
        },
      );
      const heartbeat = setInterval(() => {
        writes = writes.then(() => stream.writeSSE({ event: "heartbeat", data: "{}" }));
      }, 15_000);
      stream.onAbort(() => finish?.());
      await done;
      clearInterval(heartbeat);
      unsubscribe();
      await writes.catch(() => undefined);
    }),
  );

  if (options.webDir !== undefined && existsSync(join(options.webDir, "index.html"))) {
    app.use("/*", serveStatic({ root: options.webDir }));
    app.get("*", serveStatic({ path: join(options.webDir, "index.html") }));
  }

  app.onError((error, context) => {
    const status = error.message.startsWith("Unknown session:") ? 404 : 400;
    return context.json({ error: error.message }, status);
  });

  return app;
}

async function optionalJson(request: Request): Promise<unknown> {
  const text = await request.text();
  return text.length === 0 ? {} : JSON.parse(text);
}

function cursor(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
