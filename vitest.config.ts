import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "api", include: ["apps/api/test/**/*.test.ts", "packages/protocol/test/**/*.test.ts"] } },
      "apps/web/vitest.config.ts",
    ],
  },
});
