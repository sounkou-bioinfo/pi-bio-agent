import { chmodSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localTsc = join(packageRoot, "node_modules", "typescript", "bin", "tsc");
const tscCommand = existsSync(localTsc) ? process.execPath : "tsc";
const tscPrefix = existsSync(localTsc) ? [localTsc] : [];
const requiredDist = [
  join(packageRoot, "dist", "index.js"),
  join(packageRoot, "dist", "cli", "bin.js"),
];
const tscProbe = spawnSync(tscCommand, [...tscPrefix, "--version"], { cwd: packageRoot, stdio: "ignore" });
if (tscProbe.status !== 0) {
  const missing = requiredDist.filter((path) => !existsSync(path));
  if (missing.length === 0) {
    chmodSync(join(packageRoot, "dist", "cli", "bin.js"), 0o755);
    console.log("pi-bio-agent: TypeScript is not installed; using existing dist artifacts");
    process.exit(0);
  }
  console.error([
    "pi-bio-agent: cannot build because TypeScript is not installed and dist artifacts are missing.",
    "Run `npm install` in this checkout, or install from a package that includes dist/.",
    `Missing: ${missing.map((path) => path.slice(packageRoot.length + 1)).join(", ")}`,
  ].join("\n"));
  process.exit(1);
}

rmSync(join(packageRoot, "dist"), { recursive: true, force: true });
const build = spawnSync(tscCommand, [...tscPrefix, "-p", "tsconfig.build.json"], {
  cwd: packageRoot,
  stdio: "inherit",
});
if ((build.status ?? 1) === 0) chmodSync(join(packageRoot, "dist", "cli", "bin.js"), 0o755);
process.exit(build.status ?? 1);
