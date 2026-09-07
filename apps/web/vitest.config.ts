import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte({ hot: false })],
  resolve: { conditions: ["browser"] },
  test: { name: "web", root: import.meta.dirname, environment: "jsdom", include: ["test/**/*.test.ts"] },
});
