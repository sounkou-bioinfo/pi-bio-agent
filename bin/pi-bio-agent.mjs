#!/usr/bin/env node
import { chmodSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];

if (command === "install-skill") {
  process.argv.splice(2, 1);
  await import("../scripts/install-skill.mjs");
} else if (command === "install-codex-skill") {
  process.argv.splice(2, 1);
  await import("../scripts/install-codex-skill.mjs");
} else {
  const entry = join(packageRoot, "dist", "cli", "bin.js");
  if (!existsSync(entry)) {
    const tsc = join(packageRoot, "node_modules", "typescript", "bin", "tsc");
    if (!existsSync(tsc)) {
      console.error("pi-bio-agent: dist is missing and TypeScript is unavailable; reinstall the package or run `npm install`.");
      process.exit(1);
    }
    rmSync(join(packageRoot, "dist"), { recursive: true, force: true });
    const build = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
      cwd: packageRoot,
      stdio: "inherit",
    });
    if ((build.status ?? 1) !== 0) process.exit(build.status ?? 1);
    chmodSync(entry, 0o755);
  }
  await import("../dist/cli/bin.js");
}
