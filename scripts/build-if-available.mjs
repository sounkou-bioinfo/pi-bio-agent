import { chmodSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localTsc = join(packageRoot, "node_modules", "typescript", "bin", "tsc");
const localBinTsc = join(packageRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

const isWithin = (root, candidate) => {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

const pathTsc = process.env.PATH?.split(delimiter)
  .map((entry) => join(entry, process.platform === "win32" ? "tsc.cmd" : "tsc"))
  .find((candidate) => existsSync(candidate));
const trustedRoots = [join(packageRoot, "node_modules")];
if (basename(dirname(packageRoot)) === "node_modules") trustedRoots.push(dirname(packageRoot));
const trustedPathTsc = pathTsc && trustedRoots.some((root) => isWithin(root, pathTsc)) ? pathTsc : undefined;
const tscInvocation = existsSync(localTsc)
  ? { command: process.execPath, args: [localTsc] }
  : existsSync(localBinTsc)
    ? { command: localBinTsc, args: [] }
    : trustedPathTsc
      ? { command: trustedPathTsc, args: [] }
      : undefined;
const requiredDist = [
  join(packageRoot, "dist", "index.js"),
  join(packageRoot, "dist", "cli", "bin.js"),
];
const tscProbe = tscInvocation
  ? spawnSync(tscInvocation.command, [...tscInvocation.args, "--version"], { cwd: packageRoot, stdio: "ignore" })
  : { status: 1 };
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
const build = spawnSync(tscInvocation.command, [...tscInvocation.args, "-p", "tsconfig.build.json"], {
  cwd: packageRoot,
  stdio: "inherit",
});
if ((build.status ?? 1) === 0) chmodSync(join(packageRoot, "dist", "cli", "bin.js"), 0o755);
process.exit(build.status ?? 1);
