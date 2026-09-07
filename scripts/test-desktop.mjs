import childProcess from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.versions.electron) {
  const directory = await mkdtemp(join(tmpdir(), "pi-bio-desktop-test-"));
  try {
    const { default: electron } = await import("electron");
    const env = { ...process.env, PI_CODING_AGENT_DIR: join(directory, "credentials") };
    delete env.ELECTRON_RUN_AS_NODE;
    // This smoke executes trusted local application code on headless CI hosts.
    const child = childProcess.spawn(electron, ["--no-sandbox", fileURLToPath(import.meta.url), `--smoke-data-dir=${directory}`], {
      env, stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
    const [code] = await once(child, "exit");
    if (code !== 0 || !output.includes('"desktopSmoke":"passed"')) throw new Error("Desktop smoke did not complete successfully");
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
} else {
  const { app, clipboard } = await import("electron");
  const directory = process.argv.find((value) => value.startsWith("--smoke-data-dir="))?.slice("--smoke-data-dir=".length);
  if (!directory) throw new Error("Missing smoke data directory");
  app.setPath("userData", directory);
  app.disableHardwareAcceleration();

  let apiProcess;
  const spawn = childProcess.spawn;
  childProcess.spawn = (...args) => {
    const child = spawn(...args);
    if (args[2]?.env?.PI_BIO_API_TOKEN) apiProcess = child;
    return child;
  };
  syncBuiltinESMExports();

  let finishing = false;
  const timeout = setTimeout(() => void finish(new Error("Desktop startup timed out")), 20_000);
  const errors = [];
  app.on("web-contents-created", (_event, contents) => {
    contents.on("preload-error", (_event, _path, error) => errors.push(error.message));
    contents.on("console-message", (details) => { if (details.level === "error") errors.push(details.message); });
    contents.once("did-finish-load", async () => {
      try {
        await contents.executeJavaScript(`new Promise((resolve, reject) => {
          const end = Date.now() + 10000;
          const poll = () => {
            const error = document.querySelector('.app-error')?.textContent;
            if (error) return reject(Error(error));
            if (window.piBio && document.querySelector('textarea')?.readOnly === false) return resolve();
            if (Date.now() > end) return reject(Error('Desktop API connection did not initialize'));
            setTimeout(poll, 25);
          };
          poll();
        })`);
        const isolated = await contents.executeJavaScript("typeof require === 'undefined' && typeof process === 'undefined'");
        if (!isolated) throw new Error("Node globals must not be exposed in the renderer");
        await contents.executeJavaScript("navigator.clipboard.writeText('PI_BIO_COPY_CHECK')", true);
        if (await clipboard.readText() !== "PI_BIO_COPY_CHECK") throw new Error("Copied text did not reach the clipboard");
        const readDenied = await contents.executeJavaScript("navigator.clipboard.readText().then(() => false, () => true)", true);
        if (!readDenied) throw new Error("Renderer clipboard reads must remain denied");
        if (errors.length) throw new Error(errors.join("\n"));
        await finish();
      } catch (error) { await finish(error); }
    });
  });

  async function finish(error) {
    if (finishing) return;
    finishing = true;
    clearTimeout(timeout);
    if (apiProcess && apiProcess.exitCode === null && apiProcess.signalCode === null) {
      const exited = once(apiProcess, "exit");
      apiProcess.kill("SIGTERM");
      const kill = setTimeout(() => apiProcess.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(kill);
    }
    if (error) process.stderr.write(`${error.stack ?? error}\n`);
    else process.stdout.write(`${JSON.stringify({ desktopSmoke: "passed", preload: true, api: true, clipboardWrite: true, clipboardReadDenied: true })}\n`);
    app.exit(error ? 1 : 0);
  }

  await import("../apps/desktop/src/main.mjs");
}
