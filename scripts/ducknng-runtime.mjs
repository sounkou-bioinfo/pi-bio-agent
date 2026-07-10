import { constants, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

export async function resolveDucknngRuntime() {
  const duckdbVersion = createRequire(import.meta.url)("@duckdb/node-api/package.json").version.replace(/-.*/, "");
  const candidates = [
    process.env.DUCKNNG_EXTENSION_PATH
      ? resolve(process.cwd(), process.env.DUCKNNG_EXTENSION_PATH)
      : undefined,
    resolve(repoRoot, ".pi", "ducknng", "duckdb-" + duckdbVersion, "ducknng.duckdb_extension"),
  ];
  for (const path of candidates) {
    if (!path) continue;
    try {
      await fs.access(path, constants.R_OK);
      return {
        extensionPath: path,
        instanceConfig: { allow_unsigned_extensions: "true" },
        loadSql: "LOAD '" + path.replace(/'/g, "''") + "'",
      };
    } catch {
      // Try the next host-provisioned location.
    }
  }
  return {
    extensionPath: null,
    instanceConfig: { allow_unsigned_extensions: "true" },
    loadSql: "LOAD ducknng",
  };
}
