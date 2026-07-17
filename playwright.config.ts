import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/visual",
  outputDir: "./test-results/playwright",
  snapshotPathTemplate: "{testDir}/screenshots/{arg}-{projectName}{ext}",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  expect: {
    timeout: 5_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      scale: "css",
      maxDiffPixelRatio: 0.002
    }
  },
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    launchOptions: {
      executablePath: "/usr/bin/helium",
      args: ["--keep-alive-for-test", "--disable-gpu"]
    },
    trace: "retain-on-failure"
  },
  projects: [{ name: "helium-chromium-150" }],
  webServer: {
    command: "bun run dev -- --host 127.0.0.1 --port 4173",
    cwd: "./tests/integration/vite",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 30_000
  }
});
