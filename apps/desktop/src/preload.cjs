const { contextBridge } = require("electron");

const apiBase = argument("--pi-bio-api=");
const token = argument("--pi-bio-token=");

contextBridge.exposeInMainWorld("piBio", Object.freeze({ apiBase, token }));

function argument(prefix) {
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  if (value === undefined) throw new Error(`Missing desktop argument ${prefix}`);
  return value.slice(prefix.length);
}
