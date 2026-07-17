import type { Page } from "@playwright/test";

import { expect, test } from "./helium.fixture.js";

async function openArticle(
  page: Page,
  options: {
    theme?: "light" | "dark";
    host?: "neutral" | "branded";
    hostile?: boolean;
    fixture?: "article" | "banner-no-image";
    viewport?: { width: number; height: number };
  } = {}
) {
  await page.setViewportSize(options.viewport ?? { width: 1440, height: 1000 });
  const query = new URLSearchParams({
    theme: options.theme ?? "light",
    host: options.host ?? "neutral",
    hostile: String(options.hostile ?? false),
    fixture: options.fixture ?? "article"
  });
  await page.goto(`/?${query}`);
  await page.evaluate(() => document.fonts.ready);
  await page.locator("img").evaluateAll(async (images: HTMLImageElement[]) => {
    await Promise.all(images.map((image) => image.complete ? image.decode() : new Promise<void>((resolve, reject) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener("error", () => reject(new Error(`Image failed: ${image.src}`)), { once: true });
    })));
  });
  await expect(page.locator(".scribe")).toBeVisible();
}

test.describe("canonical Helium editorial article", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`desktop ${theme}`, async ({ page }) => {
      await openArticle(page, { theme });
      await expect(page).toHaveScreenshot(`canonical-desktop-${theme}.png`, { fullPage: true });
    });

    test(`mobile ${theme}`, async ({ page }) => {
      await openArticle(page, { theme, viewport: { width: 390, height: 844 } });
      await expect(page).toHaveScreenshot(`canonical-mobile-${theme}.png`, { fullPage: true });
    });
  }

  test("adapts to a branded host with broad host CSS", async ({ page }) => {
    await openArticle(page, { theme: "dark", host: "branded", hostile: true });
    await expect(page.locator(".fixture-outside-proof")).not.toHaveCSS("font-family", /Georgia/u);
    await expect(page.locator(".scribe-code-frame__pre")).toHaveCSS("white-space", "pre");
    await expect(page).toHaveScreenshot("hostile-branded-dark.png", { fullPage: true });
  });

  test("renders a banner without media", async ({ page }) => {
    await openArticle(page, { fixture: "banner-no-image" });
    await expect(page.locator(".scribe-banner__media")).toHaveCount(0);
    await expect(page).toHaveScreenshot("banner-without-image.png", { fullPage: true });
  });
});
