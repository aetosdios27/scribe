import { expect, test } from "@playwright/test";

test("keeps Markdown canonical while constrained Rich Text edits update the mirror and production preview", async ({ page }, testInfo) => {
  const issues: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") issues.push(message.text()); });
  page.on("pageerror", (error) => issues.push(error.message));

  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => ({
    sans: document.fonts.check('13px "IBM Plex Sans"'),
    mono: document.fonts.check('13px "IBM Plex Mono"')
  }))).toEqual({ sans: true, mono: true });
  const source = page.getByRole("textbox", { name: "Article source" });
  const preview = page.frameLocator("iframe[title='Scribe article preview']");
  await expect(source).toHaveValue(/Peer state transitions/u);
  await expect(page.getByText("default detected")).toBeVisible();
  await expect(page.getByLabel("Style")).toHaveCount(0);
  await expect(page.locator(".save-contract")).toContainText("Explicit save writes to");
  await expect(page.locator(".save-contract code")).toHaveText("tests/fixtures/studio-article.mdx");
  await expect(preview.locator(".scribe-banner__title")).toHaveText("Peer wire field notes");
  await expect(page.locator("iframe#preview")).toHaveCSS("width", "1280px");
  await expect(page.locator(".preview-device__label")).toContainText("Laptop · 1280 × 800");
  await expect(preview.getByText("Banner image not found")).toBeVisible();
  await expect(preview.locator("h1#peer-state-transitions")).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "Markdown formatting" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("studio-markdown.png"), fullPage: true });

  await source.fill("# Live studio draft\n\nThe preview uses the production Scribe renderer.\n\n<Callout variant=\"note\">Protected note.</Callout>\n");
  await expect(page.locator("#status-text")).toHaveText("Unsaved draft");
  await expect(page.locator(".save-contract")).toContainText("Draft only — Save writes to");
  expect(await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);
  await expect(preview.locator("h1#live-studio-draft")).toBeVisible();

  await source.fill("<Callout>unfinished");
  await expect(page.locator("#status-text")).toHaveText("Compilation blocked");
  await expect(page.locator("#diagnostics")).toContainText("Expected a closing tag");
  await expect(page.getByRole("button", { name: "Copy diagnostics" })).toBeVisible();
  await expect(preview.locator("h1#live-studio-draft")).toBeVisible();

  await source.fill("# Recovered draft\n");
  await expect(preview.locator("h1#recovered-draft")).toBeVisible();
  await expect(page.locator("#status-text")).toHaveText("Unsaved draft");

  await source.fill("# Recovered draft\n\nEditable paragraph.\n\n<Callout variant=\"note\">Protected note.</Callout>\n");
  await page.getByRole("button", { name: "Rich Text" }).click();
  await expect(page.getByRole("toolbar", { name: "Rich Text formatting" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(".rich-content")).toHaveCSS("font-family", /IBM Plex Serif/u);
  expect(await page.evaluate(() => document.fonts.check('16px "IBM Plex Serif"'))).toBe(true);
  await expect(page.getByText("Protected source", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit protected source in Markdown" })).toBeVisible();
  await expect(page.getByTestId("markdown-mirror")).toContainText("Editable paragraph.");
  await page.screenshot({ path: testInfo.outputPath("studio-rich-text.png"), fullPage: true });

  const richParagraph = page.locator(".rich-content p").filter({ hasText: "Editable paragraph." });
  await richParagraph.click({ clickCount: 3 });
  await page.keyboard.type("Visually edited paragraph.");
  await expect(page.getByTestId("markdown-mirror")).toContainText("Visually edited paragraph.");
  await expect(page.locator("#status-text")).toHaveText("Unsaved draft");

  await page.getByRole("tab", { name: "Preview tab" }).click();
  await expect(preview.getByText("Visually edited paragraph.")).toBeVisible();
  await page.getByRole("tab", { name: "Markdown tab" }).click();
  await page.getByRole("button", { name: "Edit protected source in Markdown" }).click();
  await expect(page.getByRole("textbox", { name: "Article source" })).toHaveValue(/Protected note/u);
  await expect(page.getByRole("toolbar", { name: "Rich Text formatting" })).toHaveCount(0);

  await page.getByRole("button", { name: "Mobile" }).click();
  await expect(page.locator("iframe#preview")).toHaveCSS("width", "414px");
  await expect(page.locator(".preview-device__label")).toContainText("Mobile · 414 × 896");
  await page.getByRole("button", { name: "Dark" }).click();
  await expect(preview.locator(".scribe[data-theme='dark']")).toBeVisible();

  expect(issues).toEqual([]);
});
