import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/next-css-modules-browser",
  outputDir: "./test-results/playwright-next-css-modules",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:4175",
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "bun run --cwd tests/integration/next-css-modules dev -- --hostname 127.0.0.1 --port 4175",
    url: "http://127.0.0.1:4175",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  }
});
