import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/studio-browser",
  outputDir: "./test-results/playwright-studio",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report/studio" }]],
  use: {
    baseURL: "http://127.0.0.1:4319",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "node packages/cli/dist/index.mjs studio tests/fixtures/studio-article.mdx --mode default --port 4319 --no-open",
    cwd: ".",
    url: "http://127.0.0.1:4319",
    reuseExistingServer: false,
    timeout: 30_000
  }
});
