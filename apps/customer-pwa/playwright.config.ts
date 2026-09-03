import { defineConfig } from "@playwright/test";

const developmentUrl = "http://127.0.0.1:5174";
const productionUrl = "http://127.0.0.1:4174";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: "line",
  outputDir: "test-results",
  preserveOutput: "failures-only",
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
  webServer: [
    {
      command: "pnpm dev:demo",
      url: developmentUrl,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "pnpm preview:demo-proof",
      url: productionUrl,
      reuseExistingServer: false,
      timeout: 120_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
  projects: [
    {
      name: "demo-desktop",
      grep: /@demo/u,
      use: {
        baseURL: developmentUrl,
        browserName: "chromium",
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "demo-mobile",
      grep: /@demo/u,
      use: {
        baseURL: developmentUrl,
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
      },
    },
    {
      name: "production-exclusion",
      grep: /@production/u,
      use: {
        baseURL: productionUrl,
        browserName: "chromium",
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
