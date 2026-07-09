import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { cappedFetchLike, DEFAULT_MAX_RESPONSE_BYTES } from "../hosts/network.js";
import { describeBioManifestFromPath } from "../hosts/run-store.js";
import type { HostCapabilityStatus } from "../hosts/manifest-capabilities.js";
import { nodeComputeRunner } from "../process/node-compute-runner.js";
import { parseFlags } from "./run.js";

export interface DescribeCliDeps {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
  signal?: AbortSignal;
}

const USAGE = [
  "usage: pi-bio-agent describe <manifest.json|url> [--network fetch] [--max-response-bytes <n>]",
  "       [--compute local] [--capabilities-file <json>]",
  "Validates declarations and reports this CLI host's ready/blocked/unknown admission without executing resources.",
].join("\n");

async function readCapabilities(cwd: string, path: string | undefined): Promise<Record<string, HostCapabilityStatus> | undefined> {
  if (!path) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(resolve(cwd, path), "utf8")) as unknown;
  } catch (error) {
    throw new Error(`--capabilities-file is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("--capabilities-file must be a JSON object");
  for (const [id, status] of Object.entries(parsed as Record<string, unknown>)) {
    if (!id || !["available", "unavailable", "unknown"].includes(String(status))) {
      throw new Error(`--capabilities-file entry '${id}' must be available, unavailable, or unknown`);
    }
  }
  return parsed as Record<string, HostCapabilityStatus>;
}

export async function mainDescribe(argv: string[], deps: DescribeCliDeps): Promise<number> {
  const [manifestPath, ...rest] = argv;
  if (manifestPath === "--help" || manifestPath === "-h") {
    deps.out(USAGE);
    return 0;
  }
  if (!manifestPath || manifestPath.startsWith("--")) {
    deps.err(USAGE);
    return 2;
  }

  let flags: Record<string, string>;
  try {
    flags = parseFlags(rest);
    const known = new Set(["network", "max-response-bytes", "compute", "capabilities-file"]);
    const unknown = Object.keys(flags).filter((key) => !known.has(key));
    if (unknown.length > 0) throw new Error(`unknown describe flag(s): ${unknown.map((key) => `--${key}`).join(", ")}`);
    const empty = Object.entries(flags).filter(([, value]) => value.length === 0).map(([key]) => key);
    if (empty.length > 0) throw new Error(`flag(s) with an empty value: ${empty.map((key) => `--${key}`).join(", ")}`);
    if (flags.network && flags.network !== "fetch") throw new Error("--network currently accepts only 'fetch'");
    if (flags.compute && flags.compute !== "local") throw new Error("--compute currently accepts only 'local'");
    if (flags["max-response-bytes"] && flags.network !== "fetch") throw new Error("--max-response-bytes requires --network fetch");
    if (flags["max-response-bytes"] && (!Number.isSafeInteger(Number(flags["max-response-bytes"])) || Number(flags["max-response-bytes"]) < 1)) throw new Error("--max-response-bytes must be a positive safe integer");
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error));
    deps.err(USAGE);
    return 2;
  }

  try {
    const capabilities = await readCapabilities(deps.cwd, flags["capabilities-file"]);
    const result = await describeBioManifestFromPath({
      cwd: deps.cwd,
      manifestPath,
      signal: deps.signal,
      ...(flags.network === "fetch" ? { network: { fetch: cappedFetchLike(globalThis.fetch, Number(flags["max-response-bytes"] ?? DEFAULT_MAX_RESPONSE_BYTES)) } } : {}),
      ...(flags.compute === "local" ? { compute: { runner: nodeComputeRunner() } } : {}),
      capabilities,
    });
    deps.out(JSON.stringify(result, null, 2));
    return result.valid ? 0 : 1;
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
