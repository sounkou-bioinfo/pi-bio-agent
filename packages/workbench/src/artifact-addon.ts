import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createRoute } from "@hono/zod-openapi";
import { fsCasStore, openBioStore, validateContentAddress } from "pi-bio-agent";
import type { JsonValue } from "pi-bio-agent";
import {
  ArtifactDigestPathSchema,
  ArtifactListQuerySchema,
  ArtifactReferenceListSchema,
  ErrorResponseSchema,
} from "./api/schemas.js";
import type { WorkbenchAddon } from "./workbench-addon.js";

const AS_OF = "9999-12-31T23:59:59.999Z";

interface ArtifactSqlRow {
  source_node: string;
  relation: string;
  cas_uri: string;
  recorded_at: string;
  reference_attrs: string | null;
  artifact_value: string | null;
  artifact_attrs: string | null;
}

type JsonObject = { [key: string]: JsonValue };

function objectFrom(value: string | null): JsonObject {
  if (!value) return {};
  const parsed = JSON.parse(value) as JsonValue;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
}

function stringField(object: JsonObject, key: string): string | undefined {
  return typeof object[key] === "string" ? object[key] : undefined;
}

function numberField(object: JsonObject, key: string): number | undefined {
  return typeof object[key] === "number" && Number.isFinite(object[key]) ? object[key] : undefined;
}

async function artifactRows(workspace: string, limit: number, digest?: string) {
  const store = await openBioStore(workspace);
  try {
    const rows = await store.conn.all<ArtifactSqlRow>(
      `WITH eligible AS (
         SELECT * FROM bio_observations
         WHERE recorded_at::TIMESTAMPTZ <= ?::TIMESTAMPTZ
           AND (valid_from IS NULL OR valid_from::TIMESTAMPTZ <= ?::TIMESTAMPTZ)
           AND (valid_to IS NULL OR valid_to::TIMESTAMPTZ > ?::TIMESTAMPTZ)
       ), current AS (
         SELECT * EXCLUDE (rn) FROM (
           SELECT *, row_number() OVER (
             PARTITION BY statement_key
             ORDER BY recorded_at::TIMESTAMPTZ DESC, observation_id DESC
           ) AS rn
           FROM eligible
         ) WHERE rn = 1
       ), artifacts AS (
         SELECT subject_id AS cas_uri, value_json, attrs
         FROM current
         WHERE predicate = 'artifact' AND starts_with(subject_id, 'cas:sha256:')
       )
       SELECT
         reference.subject_id AS source_node,
         reference.predicate AS relation,
         reference.object_id AS cas_uri,
         reference.recorded_at,
         reference.attrs AS reference_attrs,
         artifact.value_json AS artifact_value,
         artifact.attrs AS artifact_attrs
       FROM current reference
       JOIN artifacts artifact ON artifact.cas_uri = reference.object_id
       WHERE reference.object_id IS NOT NULL
         AND starts_with(reference.object_id, 'cas:sha256:')
         AND (? IS NULL OR reference.object_id = 'cas:sha256:' || ?)
       ORDER BY reference.recorded_at::TIMESTAMPTZ DESC, reference.subject_id, reference.predicate
       LIMIT ?`,
      [AS_OF, AS_OF, AS_OF, digest ?? null, digest ?? null, limit],
    );
    return rows.map((row) => {
      const value = objectFrom(row.artifact_value);
      const artifactAttrs = objectFrom(row.artifact_attrs);
      const referenceAttrs = objectFrom(row.reference_attrs);
      const digestValue = stringField(value, "digest") ?? row.cas_uri.slice("cas:".length);
      const digestHex = digestValue.startsWith("sha256:") ? digestValue.slice("sha256:".length) : digestValue;
      const mediaType = stringField(value, "media_type") ?? stringField(referenceAttrs, "media_type") ?? "application/octet-stream";
      const semanticRole = stringField(value, "semantic_role") ?? stringField(referenceAttrs, "semantic_role") ?? "artifact";
      return {
        casUri: row.cas_uri,
        digest: `sha256:${digestHex}`,
        mediaType,
        semanticRole,
        sizeBytes: numberField(value, "size_bytes") ?? 0,
        sourceNode: row.source_node,
        relation: row.relation,
        recordedAt: new Date(row.recorded_at).toISOString(),
        producerRun: stringField(referenceAttrs, "producer_run") ?? (row.source_node.startsWith("run:") ? row.source_node : null),
        attrs: { ...artifactAttrs, ...referenceAttrs },
        contentUrl: `/v1/artifacts/${digestHex}/content`,
      };
    });
  } finally {
    store.close();
  }
}

const listRoute = createRoute({
  method: "get",
  path: "/v1/artifacts",
  tags: ["artifacts"],
  summary: "List current CAS-backed artifact references",
  request: { query: ArtifactListQuerySchema },
  responses: {
    200: { description: "Artifact references projected from the temporal ledger.", content: { "application/json": { schema: ArtifactReferenceListSchema } } },
    500: { description: "Artifacts could not be read.", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const contentRoute = createRoute({
  method: "get",
  path: "/v1/artifacts/{digest}/content",
  tags: ["artifacts"],
  summary: "Read verified artifact bytes from the host CAS",
  request: { params: ArtifactDigestPathSchema },
  responses: {
    200: { description: "Artifact bytes. Active content is constrained by a response sandbox policy.", content: { "application/octet-stream": { schema: ArtifactDigestPathSchema.shape.digest } } },
    400: { description: "The digest is not a valid sha256 content address.", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "The artifact reference or bytes were not found.", content: { "application/json": { schema: ErrorResponseSchema } } },
    500: { description: "The artifact could not be read.", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

export function createArtifactWorkbenchAddon(workspace: string): WorkbenchAddon {
  return {
    id: "artifacts",
    label: "Artifacts",
    order: 200,
    browserEntry: "/addons/artifacts.js",
    registerApi(app) {
      app.openapi(listRoute, async (context) => {
        try {
          return context.json(ArtifactReferenceListSchema.parse({
            artifacts: await artifactRows(workspace, context.req.valid("query").limit),
          }), 200);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return context.json({ error: { code: "artifact_list_failed", message } }, 500);
        }
      });

      app.openapi(contentRoute, async (context) => {
        const { digest } = context.req.valid("param");
        const address = { algorithm: "sha256" as const, digest };
        const errors = validateContentAddress(address);
        if (errors.length) return context.json({ error: { code: "invalid_artifact_digest", message: errors.join("; ") } }, 400);
        try {
          const [artifact] = await artifactRows(workspace, 1, digest.toLowerCase());
          if (!artifact) return context.json({ error: { code: "artifact_not_found", message: "No current ledger reference names this artifact." } }, 404);
          const cas = fsCasStore(join(workspace, ".pi", "bio-agent", "cas"));
          if (!await cas.has(address)) return context.json({ error: { code: "artifact_bytes_missing", message: "The ledger reference exists but CAS bytes are unavailable." } }, 404);
          const bytes = await fs.readFile(cas.pathFor(address));
          return context.body(bytes, 200, {
            "cache-control": "public, max-age=31536000, immutable",
            "content-disposition": "inline",
            "content-type": artifact.mediaType,
            etag: `\"sha256-${digest.toLowerCase()}\"`,
            "x-pi-bio-csp-override": "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
            "x-content-type-options": "nosniff",
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return context.json({ error: { code: "artifact_read_failed", message } }, 500);
        }
      });
    },
  };
}
