import { spawn } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSources } from "./build.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let child;
let closing = false;
let timer;
let rebuild = Promise.resolve();

async function stopChild() {
  const running = child;
  child = undefined;
  if (!running || running.exitCode !== null) return;
  const exited = once(running, "exit");
  running.kill("SIGTERM");
  const deadline = setTimeout(() => running.kill("SIGKILL"), 10_000);
  try { await exited; } finally { clearTimeout(deadline); }
}

function startChild() {
  if (closing) return;
  child = spawn(process.execPath, ["--enable-source-maps", join(root, "dist/server.js")], { cwd: root, stdio: "inherit" });
  child.on("error", (error) => console.error(error));
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    rebuild = rebuild.then(async () => {
      await stopChild();
      if (closing) return;
      // Restart only after both protocol and API compilation succeed.
      await buildSources();
      startChild();
    }).catch((error) => console.error("API build failed; waiting for source changes.", error));
  }, 150);
}

const watchers = [join(root, "src"), join(root, "../../packages/protocol/src")].map((path) => {
  const watcher = watch(path, { recursive: true }, schedule);
  watcher.on("error", (error) => { console.error(error); process.exitCode = 1; void close(); });
  return watcher;
});
startChild();

async function close() {
  closing = true;
  clearTimeout(timer);
  for (const watcher of watchers) watcher.close();
  await rebuild;
  await stopChild();
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
