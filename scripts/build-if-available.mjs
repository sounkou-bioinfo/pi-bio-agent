import { chmodSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const tsc = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
if (!existsSync(tsc)) {
  console.log("pi-bio-agent: skipping build; TypeScript is not installed yet");
  process.exit(0);
}

rmSync(join(process.cwd(), "dist"), { recursive: true, force: true });
const build = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
  stdio: "inherit",
});
if ((build.status ?? 1) === 0) chmodSync(join(process.cwd(), "dist", "cli", "bin.js"), 0o755);
process.exit(build.status ?? 1);
