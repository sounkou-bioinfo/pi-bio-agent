import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listManifestCatalog } from "../hosts/manifest-catalog.js";
import { parseFlags } from "./run.js";

export interface CatalogCliDeps {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultRoot = join(packageRoot, "examples");

const USAGE = [
  "usage: pi-bio-agent catalog [--root <dir>] [--query <text>] [--include-invalid true]",
  "  Lists validated manifest-backed sources/templates. Entries are manifest programs a caller can describe and run.",
].join("\n");

export async function mainCatalog(argv: string[], deps: CatalogCliDeps): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    deps.err(USAGE);
    return 0;
  }
  let flags: Record<string, string>;
  try {
    flags = parseFlags(argv);
    const known = new Set(["root", "query", "include-invalid"]);
    const unknown = Object.keys(flags).filter((k) => !known.has(k));
    if (unknown.length) throw new Error(`unknown flag(s) for 'catalog': ${unknown.map((k) => `--${k}`).join(", ")}`);
    const empty = Object.entries(flags).filter(([, v]) => v === "").map(([k]) => k);
    if (empty.length) throw new Error(`flag(s) with an empty value: ${empty.map((k) => `--${k}`).join(", ")}`);
    if (flags["include-invalid"] !== undefined && !["true", "false"].includes(flags["include-invalid"])) {
      throw new Error("--include-invalid must be true or false");
    }
  } catch (e) {
    deps.err(e instanceof Error ? e.message : String(e));
    deps.err(USAGE);
    return 2;
  }
  try {
    const catalog = await listManifestCatalog({
      cwd: deps.cwd,
      root: flags.root ?? defaultRoot,
      query: flags.query,
      includeInvalid: flags["include-invalid"] === "true",
    });
    deps.out(JSON.stringify(catalog, null, 2));
    return 0;
  } catch (e) {
    deps.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}
