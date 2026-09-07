import { copyFile, readFile } from "node:fs/promises";

const [source, rendered] = await Promise.all([
  readFile(new URL("../README.qmd", import.meta.url)),
  process.argv[2] === "check"
    ? readFile(new URL("../README.md", import.meta.url))
    : Promise.resolve(undefined),
]);

if (process.argv[2] === "check") {
  if (!source.equals(rendered)) {
    process.stderr.write("README.md is stale; run npm run readme.\n");
    process.exitCode = 1;
  }
} else if (process.argv[2] === "render") {
  await copyFile(new URL("../README.qmd", import.meta.url), new URL("../README.md", import.meta.url));
} else {
  throw new Error("Usage: node scripts/readme.mjs <check|render>");
}
