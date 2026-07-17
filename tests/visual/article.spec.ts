import { chromium, expect, test as base, type Page } from "@playwright/test";

const test = base.extend({
  context: async ({}, use) => {
    const browser = await chromium.launch({
      executablePath: "/usr/bin/helium",
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

test.describe("canonical editorial article", () => {
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

test.describe("article behavior", () => {
  test("keeps both table forms semantic and keyboard-scrollable on mobile", async ({ page }) => {
    await openArticle(page, { viewport: { width: 390, height: 844 } });
    const regions = page.getByRole("region", { name: "Scrollable article table" });
    await expect(regions).toHaveCount(2);
    await expect(regions.first().locator("table")).toBeVisible();
    expect(await regions.first().evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await regions.first().focus();
    await expect(regions.first()).toBeFocused();
  });

  test("copies static code and announces feedback", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openArticle(page);
    const button = page.getByRole("button", { name: /Copy .*session_state_transitions\.rs code/u });
    await button.click();
    await expect(button).toHaveAttribute("data-state", "copied");
    await expect(button).toContainText("Copied");
    await expect(button.locator("[aria-live='polite']")).toHaveText("Code copied to clipboard.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("pub enum PeerEvent");
  });

  test("preserves heading anchors, line states, banner media, and figure semantics", async ({ page }) => {
    await openArticle(page);
    await expect(page.locator("h2#two-independent-questions .scribe-heading-anchor")).toHaveAttribute("href", "#two-independent-questions");
    await expect(page.locator(".scribe-code-frame__filename")).toContainText("session_state_transitions.rs");
    await expect(page.locator(".line.highlighted")).not.toHaveCount(0);
    await expect(page.locator(".line.focused")).not.toHaveCount(0);
    await expect(page.locator(".line.added")).not.toHaveCount(0);
    await expect(page.locator(".line.removed")).not.toHaveCount(0);
    await expect(page.locator(".scribe-banner__media img")).toHaveAttribute("alt", /two peers/u);
    await expect(page.locator("figure figcaption")).toContainText("four-byte length prefix");
  });

  test("honors reduced motion and basic print behavior", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openArticle(page);
    const duration = await page.locator(".scribe a").first().evaluate((node) => getComputedStyle(node).transitionDuration);
    expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.00001);
    await page.emulateMedia({ media: "print" });
    await expect(page.locator(".scribe-copy-button")).toHaveCSS("display", "none");
  });
});
