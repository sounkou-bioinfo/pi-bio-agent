import { chmodSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(packageRoot, "node_modules", "typescript", "bin", "tsc");
if (!existsSync(tsc)) {
  console.log("pi-bio-agent: skipping build; TypeScript is not installed yet");
  process.exit(0);
}

rmSync(join(packageRoot, "dist"), { recursive: true, force: true });
const build = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
  cwd: packageRoot,
  stdio: "inherit",
});
if ((build.status ?? 1) === 0) chmodSync(join(packageRoot, "dist", "cli", "bin.js"), 0o755);
process.exit(build.status ?? 1);
