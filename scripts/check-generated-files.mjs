import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";

const separator = process.argv.indexOf("--");
const files = process.argv.slice(2, separator);
const command = process.argv[separator + 1];
const args = process.argv.slice(separator + 2);

if (separator < 3 || !command || files.length === 0) {
  throw new Error("usage: check-generated-files <file...> -- <command> [args...]");
}

const before = new Map(await Promise.all(files.map(async (file) => [file, await fs.readFile(file)])));
const child = spawn(command, args, { cwd: process.cwd(), stdio: "inherit" });
const status = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
if (status.code !== 0) {
  throw new Error(`${command} failed with ${status.signal ?? `status ${status.code}`}`);
}

const changed = [];
for (const file of files) {
  const after = await fs.readFile(file);
  if (!after.equals(before.get(file))) changed.push(file);
}
if (changed.length > 0) {
  await Promise.all(changed.map((file) => fs.writeFile(file, before.get(file))));
  throw new Error(`generated files are stale: ${changed.join(", ")}`);
}

console.log(`generated files are current (${files.length})`);
