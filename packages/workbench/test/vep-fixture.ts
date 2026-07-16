import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import type { VepAnnotationRuntime } from "../src/clinical-genomics.js";

export type VepFixture = {
  runtime: VepAnnotationRuntime;
  requests: () => number;
  close: () => Promise<void>;
};

const annotations: Record<string, { geneId: string; gene: string; transcriptId: string; consequence: string; impact: string; af: number; significance: string }> = {
  "17-43093464-A-T": { geneId: "HGNC:GENEB", gene: "GENEB", transcriptId: "ENST_FIXTURE_GENEB", consequence: "stop_gained", impact: "HIGH", af: 0.0002, significance: "pathogenic" },
  "17-43093470-C-G": { geneId: "HGNC:GENEB", gene: "GENEB", transcriptId: "ENST_FIXTURE_GENEB", consequence: "missense_variant", impact: "MODERATE", af: 0.0003, significance: "uncertain_significance" },
  "17-43093470-C-T": { geneId: "HGNC:GENEB", gene: "GENEB", transcriptId: "ENST_FIXTURE_GENEB", consequence: "stop_gained", impact: "HIGH", af: 0.02, significance: "benign" },
};

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

export async function startVepFixture(failuresBeforeSuccess = 2, port = 0): Promise<VepFixture> {
  let requests = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      reply(response, 200, { ok: true });
      return;
    }
    if (request.method !== "POST" || request.url !== "/vep") {
      reply(response, 404, { error: "not_found" });
      return;
    }
    requests += 1;
    let value: unknown;
    try { value = JSON.parse(await bodyOf(request)); } catch {
      reply(response, 400, { error: "invalid_json" });
      return;
    }
    const variants = value && typeof value === "object" && !Array.isArray(value)
      ? (value as { variants?: unknown }).variants
      : undefined;
    if (!Array.isArray(variants) || variants.length === 0 || variants.some((item) => typeof item !== "string")) {
      reply(response, 400, { error: "variants_required" });
      return;
    }
    if (requests <= failuresBeforeSuccess) {
      reply(response, 503, { error: "transient_fixture_failure" });
      return;
    }
    reply(response, 200, variants.map((item) => {
      const input = item as string;
      const [chrom, pos, _dot, ref, alt] = input.split(" ");
      const key = `${chrom}-${pos}-${ref}-${alt}`;
      const annotation = annotations[key] ?? { geneId: "HGNC:UNKNOWN", gene: "UNKNOWN", transcriptId: "ENST_FIXTURE_UNKNOWN", consequence: "missense_variant", impact: "MODERATE", af: 0.2, significance: "uncertain_significance" };
      return {
        input,
        most_severe_consequence: annotation.consequence,
        transcript_consequences: [{
          gene_id: annotation.geneId,
          gene_symbol: annotation.gene,
          transcript_id: annotation.transcriptId,
          biotype: "protein_coding",
          canonical: 1,
          impact: annotation.impact,
          consequence_terms: [annotation.consequence],
        }],
        colocated_variants: [{ id: key, clin_sig: [annotation.significance], frequencies: { [alt]: { gnomadg: annotation.af } } }],
      };
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("VEP fixture did not bind a TCP port");
  return {
    runtime: {
      url: `http://127.0.0.1:${address.port}/vep`,
      headersJson: '[{"name":"Content-Type","value":"application/json"},{"name":"Accept","value":"application/json"}]',
      sourceId: "fixture:vep",
      sourceVersion: "fixture-1",
      duckdbInitSql: ["LOAD ducknng"],
    },
    requests: () => requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? "8792");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("fixture port must be an integer from 1 to 65535");
  const fixture = await startVepFixture(2, port);
  console.log(`VEP fixture listening on http://127.0.0.1:${port}`);
  const close = async () => { await fixture.close(); process.exit(0); };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
}
