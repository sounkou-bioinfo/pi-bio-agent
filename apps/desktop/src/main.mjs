import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, shell } from "electron";

const here = dirname(fileURLToPath(import.meta.url));
const apiEntry = fileURLToPath(import.meta.resolve("@pi-bio/api/server"));
const webDir = dirname(fileURLToPath(import.meta.resolve("@pi-bio/web/index.html")));
const apiToken = randomBytes(32).toString("base64url");
let apiProcess;

void app
  .whenReady()
  .then(start)
  .catch((error) => {
    process.stderr.write(`[desktop] startup failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    app.quit();
  });

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  apiProcess?.kill("SIGTERM");
});

async function start() {
  process.stderr.write("[desktop] starting local API\n");
  const ready = await startApi();
  process.stderr.write(`[desktop] local API ready on 127.0.0.1:${ready.port}\n`);
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#06151e",
    title: "Pi Bio",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: resolve(here, "preload.cjs"),
      additionalArguments: [
        `--pi-bio-api=http://127.0.0.1:${ready.port}`,
        `--pi-bio-token=${apiToken}`,
      ],
    },
  });

  const appOrigin = `http://127.0.0.1:${ready.port}`;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (URL.canParse(url) && new URL(url).protocol === "https:") {
      void shell.openExternal(url).catch((error) => {
        dialog.showErrorBox("Unable to open browser", `Copy the link and open it in your browser.\n\n${String(error)}`);
      });
    }
    return { action: "deny" };
  });
  const contents = window.webContents;
  const canWriteClipboard = (requester, permission, url, isMainFrame) =>
    requester === contents && permission === "clipboard-sanitized-write" && isMainFrame &&
    URL.canParse(url) && new URL(url).origin === appOrigin;
  contents.session.setPermissionCheckHandler((requester, permission, origin, details) =>
    canWriteClipboard(requester, permission, origin, details.isMainFrame),
  );
  contents.session.setPermissionRequestHandler((requester, permission, callback, details) => {
    callback(canWriteClipboard(requester, permission, details.requestingUrl, details.isMainFrame));
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== appOrigin) event.preventDefault();
  });
  await window.loadURL(appOrigin);
  process.stderr.write("[desktop] renderer loaded\n");
}

async function startApi() {
  apiProcess = spawn(process.execPath, [apiEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PI_BIO_API_TOKEN: apiToken,
      PI_BIO_DATA_DIR: app.getPath("userData"),
      PI_BIO_HOST: "127.0.0.1",
      PI_BIO_PORT: "0",
      PI_BIO_WEB_DIR: webDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  apiProcess.stderr.setEncoding("utf8");
  apiProcess.stderr.on("data", (chunk) => process.stderr.write(`[api] ${chunk}`));

  return await new Promise((resolveReady, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Pi Bio API startup timed out")), 30_000);
    apiProcess.stdout.setEncoding("utf8");
    apiProcess.stdout.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (message.type !== "ready" || typeof message.port !== "number") return;
        clearTimeout(timer);
        resolveReady(message);
      } catch {
        process.stderr.write(`[api] ${line}\n`);
      }
    });
    apiProcess.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Pi Bio API exited during startup (${code})`));
    });
    apiProcess.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
