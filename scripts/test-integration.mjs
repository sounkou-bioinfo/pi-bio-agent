import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const result = spawnSync(
  process.execPath,
  [join("node_modules", "vitest", "vitest.mjs"), "run", "apps/api/test/science.integration.test.ts"],
  {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, PI_BIO_INTEGRATION: "1" },
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
