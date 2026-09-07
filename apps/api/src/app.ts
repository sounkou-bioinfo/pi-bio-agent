import { existsSync } from "node:fs";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  LoginRequestSchema,
  AuthReplySchema,
  ModelSelectionSchema,
  ThinkingRequestSchema,
  RenameSessionSchema,
  ForkRequestSchema,
  CreateSessionRequestSchema,
  DraftRequestSchema,
  PromptRequestSchema,
  assertSchema,
} from "@pi-bio/protocol";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentService } from "./agent-service.js";
import type { ScienceRuntime } from "./science/client.js";

type AgentApi = Pick<
  AgentService,
  | "modelIdentity"
  | "selectModel"
  | "selectThinking"
  | "renameSession"
  | "archiveSession"
  | "restoreSession"
  | "forkSession"
  | "sessionTree"
  | "listSessions"
  | "createSession"
  | "snapshot"
  | "saveDraft"
  | "startPrompt"
  | "abort"
  | "subscribe"
> & { credentials: Pick<AgentService["credentials"], "catalog" | "status" | "login" | "answer" | "cancel" | "logout"> };

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
    context.header(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
    );
  });

  app.get("/health", (context) => context.json({ ok: true }));

  app.use("/api/*", async (context, next) => {
    const origin = context.req.header("origin");
    if (options.apiToken === undefined && origin !== undefined && origin !== new URL(context.req.url).origin) {
      return context.json({ error: "Cross-origin API request denied" }, 403);
    }
    if (options.apiToken === undefined || options.apiToken.length === 0) return next();
    if (context.req.header("authorization") !== `Bearer ${options.apiToken}`) {
      return context.json({ error: "Unauthorized" }, 401);
    }
    return next();
  });

  app.get("/api/providers", (context) => context.json(options.agents.credentials.catalog()));
  app.get("/api/providers/:provider/auth", async (context) =>
    context.json(await options.agents.credentials.status(context.req.param("provider"))));
  app.post("/api/providers/:provider/auth/login", async (context) => {
    const request = assertSchema(LoginRequestSchema, await context.req.json());
    return context.json(await options.agents.credentials.login(context.req.param("provider"), request), 202);
  });
  app.post("/api/providers/:provider/auth/reply", async (context) => {
    const request = assertSchema(AuthReplySchema, await context.req.json());
    return context.json(await options.agents.credentials.answer(context.req.param("provider"), request));
  });
  app.delete("/api/providers/:provider/auth/login", async (context) =>
    context.json(await options.agents.credentials.cancel(context.req.param("provider"))));
  app.delete("/api/providers/:provider/auth", async (context) =>
    context.json(await options.agents.credentials.logout(context.req.param("provider"))));

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
    context.json({ sessions: await options.agents.listSessions(context.req.query("archived") === "true") }),
  );

  app.post("/api/sessions", async (context) => {
    const request = assertSchema(CreateSessionRequestSchema, await optionalJson(context.req.raw));
    return context.json(await options.agents.createSession(request.name), 201);
  });

  app.get("/api/sessions/:id", async (context) =>
    context.json(await options.agents.snapshot(context.req.param("id"))),
  );

  app.delete("/api/sessions/:id", async (context) => {
    await options.agents.archiveSession(context.req.param("id"));
    return context.json({ archived: true });
  });
  app.post("/api/sessions/:id/restore", async (context) => {
    await options.agents.restoreSession(context.req.param("id"));
    return context.json({ restored: true });
  });

  app.patch("/api/sessions/:id", async (context) => {
    const request = assertSchema(RenameSessionSchema, await context.req.json());
    await options.agents.renameSession(context.req.param("id"), request.name);
    return context.json({ saved: true });
  });
  app.post("/api/sessions/:id/fork", async (context) => {
    const request = assertSchema(ForkRequestSchema, await optionalJson(context.req.raw));
    return context.json(await options.agents.forkSession(context.req.param("id"), request.entryId), 201);
  });
  app.get("/api/sessions/:id/tree", async (context) => {
    const rawCursor = context.req.query("cursor");
    const cursor = rawCursor === undefined ? undefined : Number(rawCursor);
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new Error("Invalid tree cursor");
    return context.json(await options.agents.sessionTree(context.req.param("id"), cursor));
  });

  app.put("/api/sessions/:id/thinking", async (context) => {
    const request = assertSchema(ThinkingRequestSchema, await context.req.json());
    await options.agents.selectThinking(context.req.param("id"), request.level);
    return context.json({ saved: true });
  });

  app.put("/api/sessions/:id/model", async (context) => {
    const request = assertSchema(ModelSelectionSchema, await context.req.json());
    await options.agents.selectModel(context.req.param("id"), request);
    return context.json({ saved: true });
  });

  app.put("/api/sessions/:id/draft", async (context) => {
    const request = assertSchema(DraftRequestSchema, await context.req.json());
    await options.agents.saveDraft(context.req.param("id"), request.text);
    return context.json({ saved: true });
  });

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
      let writes = Promise.resolve();
      let finish: (() => void) | undefined;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      stream.onAbort(() => finish?.());
      let pending = 0;
      const enqueue = (frame: Parameters<typeof stream.writeSSE>[0]): void => {
        if (stream.aborted) return;
        // Disconnect lagging clients so they can reconnect from a fresh snapshot.
        if (++pending > 128) { stream.abort(); return; }
        writes = writes.then(async () => {
          try { if (!stream.aborted) await stream.writeSSE(frame); }
          finally { pending--; }
        }).catch(() => stream.abort());
      };
      const unsubscribe = await options.agents.subscribe(
        context.req.param("id"),
        (record) => enqueue({ id: String(record.sequence), event: "harness", data: JSON.stringify(record) }),
      );
      const heartbeat = setInterval(() => enqueue({ event: "heartbeat", data: "{}" }), 15_000);
      await done;
      clearInterval(heartbeat);
      unsubscribe();
      await writes.catch(() => undefined);
    }),
  );

  app.all("/api/*", (context) => context.json({ error: "Unknown API route. Check that the frontend and API are running the same build." }, 404));

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
