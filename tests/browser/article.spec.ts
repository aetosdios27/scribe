import { expect, test as base, type Page } from "@playwright/test";

const test = base.extend<{ browserIssues: string[] }>({
  browserIssues: [async ({ page }, use) => {
    const issues: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") issues.push(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => issues.push(`pageerror: ${error.message}`));
    await use(issues);
    expect(issues).toEqual([]);
  }, { auto: true }]
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
  await page.setViewportSize(options.viewport ?? { width: 1280, height: 900 });
  const query = new URLSearchParams({
    theme: options.theme ?? "light",
    host: options.host ?? "neutral",
    hostile: String(options.hostile ?? false),
    fixture: options.fixture ?? "article"
  });
  await page.goto(`/?${query}`);
  await page.locator("img").evaluateAll(async (images: HTMLImageElement[]) => {
    await Promise.all(images.map((image) => image.decode()));
  });
  await expect(page.locator(".scribe")).toBeVisible();
}

test("renders semantic article content and preserves component overrides", async ({ page }) => {
  await openArticle(page);
  await expect(page.locator(".scribe[data-fixture-wrapper='override']")).toBeVisible();
  await expect(page.locator("h2#two-independent-questions")).toBeVisible();
  await expect(page.locator("p p")).toHaveCount(0);
  await expect(page.locator("blockquote")).toBeVisible();
  await expect(page.locator(".scribe-callout")).toHaveCount(2);
  await expect(page.locator("figure figcaption")).toContainText("four-byte length prefix");
  await expect(page.locator(".fixture-outside-proof")).toContainText("Host content outside");
});

test("resolves heading anchors without disturbing the host", async ({ page }) => {
  await openArticle(page);
  const anchor = page.locator("h2#two-independent-questions .scribe-heading-anchor");
  await expect(anchor).toHaveAttribute("href", "#two-independent-questions");
  await anchor.click({ force: true });
  await expect(page).toHaveURL(/#two-independent-questions$/u);
  await expect(page.locator("h2#two-independent-questions")).toBeVisible();
  await expect(page.locator(".fixture-outside-proof")).toBeVisible();
});

test("keeps Markdown and literal JSX tables inside the page on mobile", async ({ page }) => {
  await openArticle(page, { viewport: { width: 390, height: 844 } });
  const regions = page.getByRole("region", { name: "Scrollable article table" });
  await expect(regions).toHaveCount(2);
  await expect(regions.nth(0).locator("table")).toBeVisible();
  await expect(regions.nth(1).locator("table caption")).toContainText("Peer-wire control messages");
  expect(await regions.first().evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await regions.first().evaluate((node) => node.getBoundingClientRect().right <= node.parentElement!.getBoundingClientRect().right + 1)).toBe(true);
  await regions.first().focus();
  await expect(regions.first()).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("keeps code metadata and overflow server-rendered", async ({ page }) => {
  await openArticle(page, { viewport: { width: 390, height: 844 } });
  await expect(page.locator(".scribe-code-frame__filename")).toContainText("session_state_transitions.rs");
  await expect(page.locator(".scribe-code-frame__language")).toContainText("rust");
  await expect(page.locator(".scribe-code-frame__pre")).toHaveAttribute("data-scribe-line-numbers", "");
  const lineNumberStyle = await page.locator(".line").first().evaluate((node) => {
    const style = getComputedStyle(node);
    return { counterIncrement: style.counterIncrement, paddingInlineStart: Number.parseFloat(style.paddingInlineStart) };
  });
  expect(lineNumberStyle.counterIncrement).toContain("scribe-line");
  expect(lineNumberStyle.paddingInlineStart).toBeGreaterThan(40);
  await expect(page.locator(".line.highlighted")).not.toHaveCount(0);
  await expect(page.locator(".line.focused")).not.toHaveCount(0);
  await expect(page.locator(".line.added")).not.toHaveCount(0);
  await expect(page.locator(".line.removed")).not.toHaveCount(0);
  const pre = page.locator(".scribe-code-frame__pre");
  expect(await pre.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await pre.evaluate((node) => node.getBoundingClientRect().right <= node.parentElement!.getBoundingClientRect().right + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("renders media and image-less banners without layout breakage", async ({ page }) => {
  await openArticle(page);
  await expect(page.locator(".scribe-banner__media img")).toHaveAttribute("alt", /two peers/u);
  await expect(page.locator("figure img")).toBeVisible();
  await openArticle(page, { fixture: "banner-no-image", viewport: { width: 390, height: 844 } });
  await expect(page.locator(".scribe-banner__media")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("supports light, dark, branded, reduced-motion, and print behavior", async ({ page }) => {
  await openArticle(page, { theme: "light" });
  await expect(page.locator(".fixture-shell")).toHaveAttribute("data-theme", "light");
  await openArticle(page, { theme: "dark", host: "branded", hostile: true });
  await expect(page.locator(".fixture-shell")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".scribe-code-frame__pre")).toHaveCSS("white-space", "pre");
  await expect(page.locator(".fixture-outside-proof")).not.toHaveCSS("font-family", /Georgia/u);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const duration = await page.locator(".scribe a").first().evaluate((node) => getComputedStyle(node).transitionDuration);
  expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.00001);
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".scribe-copy-button")).toHaveCSS("display", "none");
});

for (const clipboard of ["rejected", "unavailable"] as const) {
  test(`copy fails accessibly when the clipboard is ${clipboard}`, async ({ page }) => {
    await page.addInitScript((mode) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: mode === "rejected" ? { writeText: async () => Promise.reject(new Error("denied")) } : undefined
      });
    }, clipboard);
    await openArticle(page);
    const button = page.getByRole("button", { name: /Copy .*session_state_transitions\.rs code/u });
    await button.click();
    await expect(button).toHaveAttribute("data-state", "error");
    await expect(button).toContainText("Try again");
    await expect(button.locator("[aria-live='polite']")).toHaveText("Code could not be copied.");
    await expect(page.locator(".scribe-code-frame__pre")).toBeVisible();
  });
}

test("copy announces controlled success without relying on browser permissions", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (source: string) => { (globalThis as typeof globalThis & { __copiedSource?: string }).__copiedSource = source; } }
    });
  });
  await openArticle(page);
  const button = page.getByRole("button", { name: /Copy .*session_state_transitions\.rs code/u });
  await button.click();
  await expect(button).toHaveAttribute("data-state", "copied");
  await expect(button.locator("[aria-live='polite']")).toHaveText("Code copied to clipboard.");
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { __copiedSource?: string }).__copiedSource)).toContain("pub enum PeerEvent");
});
