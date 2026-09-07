import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScienceRuntime } from "../dist/science/client.js";

if (process.platform === "win32" && !process.env.DUCKNNG_EXTENSION_PATH) {
  process.stderr.write(
    "[pi-bio] Windows package will omit R/NNG: pi-ducknng does not yet provide a proven native Windows artifact.\n",
  );
  process.exit(0);
}

const directory = await mkdtemp(join(tmpdir(), "pi-bio-provision-"));
const runtime = new ScienceRuntime({ databasePath: join(directory, "science.duckdb") });
try {
  await runtime.evalR("provision", "data.frame(ready = TRUE)", 1);
} finally {
  await runtime.close();
  await rm(directory, { recursive: true, force: true });
}
