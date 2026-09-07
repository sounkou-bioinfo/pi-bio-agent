import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dist = join(root, "dist");
const require = createRequire(import.meta.url);
const piDucknngRoot = dirname(require.resolve("pi-ducknng/package.json"));

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "vendor/pi-ducknng/extensions/pi-ducknng"), {
  recursive: true,
});

await buildSources();

await build({
  entryPoints: [join(piDucknngRoot, "extensions/pi-ducknng/index.ts")],
  outfile: join(dist, "vendor/pi-ducknng/extensions/pi-ducknng/index.js"),
  platform: "node",
  format: "esm",
  target: "node24",
  bundle: true,
  sourcemap: true,
  external: ["@duckdb/node-api", "@sinclair/typebox"],
});

await mkdir(join(dist, "vendor/pi-ducknng/tools"), { recursive: true });
await cp(
  join(piDucknngRoot, "tools/pi-r-endpoint.R"),
  join(dist, "vendor/pi-ducknng/tools/pi-r-endpoint.R"),
);
await cp(
  join(piDucknngRoot, "Makefile"),
  join(dist, "vendor/pi-ducknng/Makefile"),
);
await cp(
  join(piDucknngRoot, "vendor"),
  join(dist, "vendor/pi-ducknng/vendor"),
  { recursive: true },
);

export async function buildSources() {
  const protocol = join(root, "../../packages/protocol");
  const common = { platform: "node", format: "esm", target: "node24", bundle: false, sourcemap: true };
  await Promise.all([
    build({ ...common, entryPoints: await sourceFiles(join(root, "src")), outbase: join(root, "src"), outdir: dist }),
    build({ ...common, entryPoints: [join(protocol, "src/index.ts")], outfile: join(protocol, "dist/index.js") }),
  ]);
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : [path];
    }),
  );
  return files.flat().filter((path) => path.endsWith(".ts"));
}
