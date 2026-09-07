import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScienceRuntime } from "../src/science/client.js";

const enabled = process.env.PI_BIO_INTEGRATION === "1";
const runtimes: ScienceRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(!enabled)("science worker", () => {
  it("keeps DuckDB state across calls", async () => {
    const runtime = await createRuntime();
    await runtime.sql("CREATE TABLE measurements AS SELECT 41 AS value");
    const result = await runtime.sql("SELECT value + 1 AS answer FROM measurements");
    expect(result).toMatchObject({ previewRowCount: 1, rows: [{ answer: 42 }] });
    const bounded = await runtime.sql("SELECT * FROM range(5000)", 10);
    expect(bounded).toMatchObject({ previewRowCount: 10, truncated: true });
  });

  it("keeps R state through nanonext/NNG", async () => {
    const runtime = await createRuntime();
    await runtime.evalR("session-a", "x <- 41L; data.frame(stored = x)");
    const result = await runtime.evalR("session-a", "data.frame(answer = x + 1L)");
    expect(result).toMatchObject({ rowCount: 1, rows: [{ answer: 42 }] });
    expect(runtime.status().r).toBe("ready");
    const isolated = await runtime.evalR(
      "session-b",
      "data.frame(has_x = exists('x', inherits = FALSE))",
    );
    expect(isolated).toMatchObject({ rows: [{ has_x: false }] });
  }, 60_000);
});

async function createRuntime(): Promise<ScienceRuntime> {
  const directory = await mkdtemp(join(tmpdir(), "pi-bio-science-"));
  directories.push(directory);
  const runtime = new ScienceRuntime({
    databasePath: join(directory, "science.duckdb"),
    workerUrl: new URL("../dist/science/worker.js", import.meta.url),
  });
  runtimes.push(runtime);
  return runtime;
}
