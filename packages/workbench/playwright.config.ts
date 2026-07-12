import { defineConfig, devices } from "@playwright/test";

const port = 8791;

export default defineConfig({
  testDir: "./test-browser",
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "node dist-test/test/vep-fixture.js 8792",
      url: "http://127.0.0.1:8792/healthz",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `PI_BIO_VEP_URL=http://127.0.0.1:8792/vep PI_BIO_VEP_SOURCE_ID=fixture:vep PI_BIO_VEP_SOURCE_VERSION=fixture-1 node dist/server.js examples/clinical-genomics ${port}`,
      url: `http://127.0.0.1:${port}/healthz`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
