import { chromium, test as base } from "@playwright/test";

export { expect } from "@playwright/test";

export const test = base.extend({
  context: async ({}, use) => {
    const executablePath = process.env.SCRIBE_HELIUM_EXECUTABLE;
    if (!executablePath) throw new Error("SCRIBE_HELIUM_EXECUTABLE is required. Run `bun run test:visual:helium`.");

    // Helium Chromium 150 needs a fresh browser for every screenshot test.
    const browser = await chromium.launch({
      executablePath,
      args: ["--disable-gpu"]
    });
    const context = await browser.newContext({
      baseURL: "http://127.0.0.1:4173",
      deviceScaleFactor: 1,
      locale: "en-US",
      timezoneId: "UTC"
    });
    await use(context);
    await context.close();
    await browser.close();
  }
});
