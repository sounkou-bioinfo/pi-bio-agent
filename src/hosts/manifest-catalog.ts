import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { describeManifest, validateBioManifest, type BioManifest } from "../core/manifest.js";

export interface ManifestCatalogResource {
  id: string;
  title: string;
  resolver: string;
  table?: string;
}

export interface ManifestCatalogOperation {
  id: string;
  title: string;
  transport: string;
  runnable: boolean;
}

export interface ManifestCatalogEntry {
  manifestPath: string;
  id: string;
  title: string;
  description: string;
  version: string;
  resources: ManifestCatalogResource[];
  operations: ManifestCatalogOperation[];
  resolverIds: string[];
  capabilityHints: string[];
}

export interface InvalidManifestCatalogEntry {
  manifestPath: string;
  errors: string[];
}

export interface ManifestCatalog {
  schema: "pi-bio.manifest_catalog.v1";
  root: string;
  query?: string;
  entries: ManifestCatalogEntry[];
  invalid: InvalidManifestCatalogEntry[];
}

export interface ListManifestCatalogRequest {
  cwd: string;
  root: string;
  query?: string;
  includeInvalid?: boolean;
}

function displayPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") && !rel.includes(`..${sep}`) ? rel : path;
}

async function* walkJsonFiles(root: string): AsyncGenerator<string> {
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (e) {
    throw new Error(`manifest catalog root is not readable: ${root} (${e instanceof Error ? e.message : String(e)})`);
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist" || entry.name === "dist-test") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkJsonFiles(path);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      yield path;
    }
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

function resourceTable(params: Record<string, unknown> | undefined): string | undefined {
  return typeof params?.table === "string" && params.table.length > 0 ? params.table : undefined;
}

function mentionsRemoteSource(value: unknown): boolean {
  if (typeof value === "string") return /^https?:\/\//i.test(value) || /https?:\/\//i.test(value);
  if (Array.isArray(value)) return value.some(mentionsRemoteSource);
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some(mentionsRemoteSource);
  return false;
}

function capabilityHints(manifest: BioManifest): string[] {
  const hints = new Set<string>();
  for (const r of manifest.provides.resources ?? []) {
    if (r.resolver === "http.get") hints.add("host.fetch");
    if (r.resolver === "compute.run") hints.add("compute.runner");
    if (r.resolver === "duckhts.read_bcf") hints.add("duckdb.extension.duckhts");
    for (const ext of asStringArray(r.params?.extensions)) hints.add(`duckdb.extension.${ext}`);
    if (mentionsRemoteSource(r.params)) hints.add("network.egress");
  }
  return [...hints].sort();
}

function matchesQuery(entry: ManifestCatalogEntry, query: string | undefined): boolean {
  if (!query?.trim()) return true;
  const q = query.toLowerCase();
  const haystack = [
    entry.manifestPath,
    entry.id,
    entry.title,
    entry.description,
    ...entry.resources.flatMap((r) => [r.id, r.title, r.resolver, r.table ?? ""]),
    ...entry.operations.flatMap((o) => [o.id, o.title, o.transport]),
    ...entry.resolverIds,
    ...entry.capabilityHints,
  ].join("\n").toLowerCase();
  return haystack.includes(q);
}

function catalogEntry(cwd: string, file: string, manifest: BioManifest): ManifestCatalogEntry {
  const described = describeManifest(manifest);
  return {
    manifestPath: displayPath(cwd, file),
    id: described.id,
    title: described.title,
    description: described.description,
    version: described.version,
    resources: (manifest.provides.resources ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      resolver: r.resolver,
      ...(resourceTable(r.params) ? { table: resourceTable(r.params) } : {}),
    })),
    operations: described.operations.map((o) => ({
      id: o.id,
      title: o.title,
      transport: o.transport,
      runnable: o.runnable,
    })),
    resolverIds: described.resolvers.map((r) => r.id).sort(),
    capabilityHints: capabilityHints(manifest),
  };
}

export async function listManifestCatalog(req: ListManifestCatalogRequest): Promise<ManifestCatalog> {
  const cwd = resolve(req.cwd);
  const root = resolve(cwd, req.root);
  const entries: ManifestCatalogEntry[] = [];
  const invalid: InvalidManifestCatalogEntry[] = [];
  for await (const file of walkJsonFiles(root)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (e) {
      if (req.includeInvalid) invalid.push({ manifestPath: displayPath(cwd, file), errors: [`not readable or not valid JSON: ${e instanceof Error ? e.message : String(e)}`] });
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { schema?: unknown }).schema !== "pi-bio.manifest.v1") {
      continue;
    }
    const errors = validateBioManifest(parsed as BioManifest);
    if (errors.length) {
      if (req.includeInvalid) invalid.push({ manifestPath: displayPath(cwd, file), errors });
      continue;
    }
    const entry = catalogEntry(cwd, file, parsed as BioManifest);
    if (matchesQuery(entry, req.query)) entries.push(entry);
  }
  entries.sort((a, b) => a.manifestPath.localeCompare(b.manifestPath));
  invalid.sort((a, b) => a.manifestPath.localeCompare(b.manifestPath));
  return {
    schema: "pi-bio.manifest_catalog.v1",
    root: displayPath(cwd, root) || basename(root),
    ...(req.query?.trim() ? { query: req.query } : {}),
    entries,
    invalid,
  };
}
