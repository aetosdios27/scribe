import { expect, test } from "@playwright/test";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const fixturePath = resolve("tests/fixtures/studio-article.mdx");
let originalFixture = "";

async function replaceFixture(source: string) {
  const temporaryPath = `${fixturePath}.studio-test-${process.pid}`;
  await writeFile(temporaryPath, source, "utf8");
  await rename(temporaryPath, fixturePath);
}

function fixtureLineContaining(text: string): number {
  const line = originalFixture.split("\n").findIndex((value) => value.includes(text));
  if (line < 0) throw new Error(`Studio fixture does not contain ${JSON.stringify(text)}.`);
  return line + 1;
}

test.beforeAll(async () => {
  originalFixture = await readFile(fixturePath, "utf8");
});

test.afterAll(async () => {
  if (originalFixture && await readFile(fixturePath, "utf8") !== originalFixture) {
    await replaceFixture(originalFixture);
  }
});

test("keeps the Studio shell restrained while editing, previewing, resizing, and saving", async ({ page }, testInfo) => {
  const issues: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") issues.push(message.text());
  });
  page.on("pageerror", (error) => issues.push(error.message));

  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);

  const source = page.locator(".source-monaco");
  const preview = page.frameLocator("iframe[title='Scribe article preview']");
  const toolbar = page.locator(".studio-toolbar");
  const statusbar = page.locator(".studio-statusbar");
  const splitter = page.getByRole("separator", { name: "Resize editor and preview" });
  const viewportControl = toolbar.getByLabel("Preview viewport");

  await expect(source).toBeVisible();
  await expect(viewportControl).toContainText("Fit pane");
  const savedControl = toolbar.getByRole("button", { name: /^Saved$/u });
  await expect(savedControl).toBeVisible({ timeout: 10_000 });
  await expect(savedControl).toHaveAttribute("data-save-state", "saved");
  await expect(savedControl).toHaveCSS("background-color", "rgb(28, 28, 31)");
  await expect(toolbar.getByRole("button", { name: "Switch preview to light mode" })).toBeVisible();
  await expect(toolbar.getByRole("button")).toHaveCount(2);
  await expect(page.getByText("Scribe Studio", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/detected/u)).toHaveCount(0);
  await expect(page.getByText("Production renderer", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Markdown", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Preview", { exact: true })).toHaveCount(0);
  await expect(page.locator(".source-monaco .line-numbers").filter({ hasText: /^10$/u })).toBeVisible();
  const gutterSpacing = await page.locator(".source-monaco .line-numbers").first().evaluate((element) => {
    const margin = element.closest(".margin")?.getBoundingClientRect();
    const content = element.closest(".monaco-editor")?.querySelector(".view-lines")?.getBoundingClientRect();
    const text = element.firstChild;
    if (!margin || !content || !text) throw new Error("Monaco gutter geometry is unavailable.");
    const glyph = document.createRange();
    glyph.selectNodeContents(text);
    const rect = glyph.getBoundingClientRect();
    return {
      left: rect.left - margin.left,
      right: content.left - rect.right
    };
  });
  expect(Math.abs(gutterSpacing.left - gutterSpacing.right)).toBeLessThanOrEqual(2);
  await expect(page.locator(".source-highlight, .source-textarea")).toHaveCount(0);
  await expect(page.locator(".source-monaco .monaco-scrollable-element").first()).toBeVisible();
  await expect(statusbar.locator(".studio-statusbar__path")).toHaveText("tests/fixtures/studio-article.mdx");
  await expect(statusbar).toContainText(/\d+ lines/u);
  await expect(statusbar).toContainText(/\d+ words/u);
  await expect(statusbar).toContainText(/(?:localhost|127\.0\.0\.1):\d+/u);
  await expect(statusbar).toContainText("Fit");
  await expect(statusbar).toContainText("Connected");
  await expect(preview.locator(".scribe-banner__title")).toHaveText("Peer wire field notes");
  await expect(page.locator(".preview-stage")).toHaveCSS("padding", "0px");
  await expect(page.locator(".preview-device")).toHaveCSS("border-top-width", "0px");
  await viewportControl.click();
  await page.getByRole("option", { name: "Mobile" }).click();
  const compactTable = preview.locator(".scribe-table-scroll").nth(1);
  const wideTable = preview.locator('.scribe-table-scroll[data-scribe-table-layout="wide"]');
  await expect(compactTable.locator("th")).toHaveCount(3);
  expect(await compactTable.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await wideTable.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await preview.locator("html").evaluate(
    (node) => node.scrollWidth <= node.clientWidth
  )).toBe(true);
  await viewportControl.click();
  await page.getByRole("option", { name: "Fit pane" }).click();
  await page.screenshot({ path: testInfo.outputPath("studio-shell-initial.png"), fullPage: true });

  await preview.locator(".scribe-banner__title").evaluate((element) => {
    (globalThis as typeof globalThis & { __scribeStableBannerTitle?: Element }).__scribeStableBannerTitle = element;
  });
  await source.click();
  await page.keyboard.press("Control+g");
  await page.keyboard.insertText(String(fixtureLineContaining("The local source file remains authoritative")));
  await page.keyboard.press("Enter");
  await page.keyboard.press("End");
  await page.keyboard.insertText(" — without remounting");
  await expect(preview.locator("p").filter({ hasText: "without remounting" })).toBeVisible();
  await expect(page.locator(".source-monaco .unicode-highlight")).toHaveCount(0);
  expect(await preview.locator("body").evaluate(() => (
    globalThis as typeof globalThis & { __scribeStableBannerTitle?: Element }
  ).__scribeStableBannerTitle === document.querySelector(".scribe-banner__title"))).toBe(true);

  await preview.locator("body").evaluate(() => scrollTo(0, 0));
  await source.click();
  await page.keyboard.press("Control+g");
  await page.keyboard.insertText(String(fixtureLineContaining("Choked,")));
  await page.keyboard.press("Enter");
  await page.keyboard.press("End");
  await page.keyboard.insertText(" // synced");
  const synchronizedCode = preview.locator("[data-scribe-source-line]").filter({ hasText: "Choked, // synced" });
  await expect(synchronizedCode).toContainText("synced");
  await expect.poll(() => preview.locator("body").evaluate(() => scrollY)).toBeGreaterThan(0);
  await expect(synchronizedCode).toHaveAttribute("data-scribe-reveal-active", "");
  await expect(synchronizedCode).not.toHaveAttribute("data-scribe-reveal-active", "", { timeout: 2_000 });

  const initialLeftWidth = await page.locator(".source-panel").evaluate((element) => element.getBoundingClientRect().width);
  const splitterBox = await splitter.boundingBox();
  if (!splitterBox) throw new Error("The Studio splitter was not rendered.");
  const initialSplit = await splitter.getAttribute("aria-valuenow");
  await page.mouse.move(splitterBox.x + splitterBox.width / 2 + 5, splitterBox.y + 80);
  await page.mouse.down();
  await expect(splitter).toHaveAttribute("aria-valuenow", initialSplit ?? "50");
  await page.mouse.up();
  await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + 80);
  await page.mouse.down();
  await page.mouse.move(splitterBox.x + 90, splitterBox.y + 80, { steps: 6 });
  await page.mouse.up();
  const resizedLeftWidth = await page.locator(".source-panel").evaluate((element) => element.getBoundingClientRect().width);
  expect(resizedLeftWidth).toBeGreaterThan(initialLeftWidth + 50);
  await splitter.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(splitter).toHaveAttribute("aria-valuenow", /\d+/u);
  await splitter.dblclick();
  await expect(splitter).toHaveAttribute("aria-valuenow", "50");
  await expect.poll(async () => Math.abs(
    await page.locator(".source-panel").evaluate((element) => element.getBoundingClientRect().width)
    - initialLeftWidth
  )).toBeLessThanOrEqual(2);

  const editedSource = "# Shell redesign proof\n\nThe preview updates through the production renderer.\n";
  await source.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(editedSource);
  await expect(toolbar.getByRole("button", { name: /^Save$/u })).toBeVisible();
  await expect(preview.locator("h1#shell-redesign-proof")).toBeVisible();

  await viewportControl.click();
  const tabletOption = page.getByRole("option", { name: "Tablet" });
  await expect(tabletOption).toBeVisible();
  await tabletOption.click();
  await expect(viewportControl).toContainText("Tablet");
  await expect(statusbar).toContainText("820px");
  await expect(page.locator(".preview-device")).toHaveCSS("width", "820px");
  await expect(splitter).not.toHaveAttribute("aria-valuenow", "50");

  await viewportControl.click();
  const mobileOption = page.getByRole("option", { name: "Mobile" });
  await expect(mobileOption).toBeVisible();
  await expect(mobileOption).toHaveCSS("opacity", "1");
  await page.screenshot({ path: testInfo.outputPath("studio-viewport-menu.png"), fullPage: true });
  await mobileOption.click();
  await expect(viewportControl).toContainText("Mobile");
  await expect(statusbar).toContainText("414px");
  await expect(page.locator(".preview-device")).toHaveCSS("width", "414px");
  await expect(page.locator(".preview-device")).toHaveCSS("transition-duration", "0.32s");

  await preview.locator("body").evaluate(() => {
    (window as typeof window & { __scribeThemeContinuity?: string }).__scribeThemeContinuity = "preserved";
  });
  await toolbar.getByRole("button", { name: "Switch preview to light mode" }).click();
  await expect(toolbar.getByRole("button", { name: "Switch preview to dark mode" })).toBeVisible();
  await expect(preview.locator(".scribe[data-theme='light']")).toBeVisible();
  expect(await preview.locator("body").evaluate(() => (
    window as typeof window & { __scribeThemeContinuity?: string }
  ).__scribeThemeContinuity)).toBe("preserved");

  await toolbar.getByRole("button", { name: /^Save$/u }).click();
  const settledSavedControl = toolbar.getByRole("button", { name: /^Saved$/u });
  await expect(settledSavedControl).toBeVisible();
  await expect.poll(async () => (await readFile(fixturePath, "utf8")).includes("Shell redesign proof")).toBe(true);
  const persistedSource = await readFile(fixturePath, "utf8");
  await expect(statusbar).toContainText(`${persistedSource.split("\n").length} lines`);
  await page.mouse.move(640, 360);
  await expect(settledSavedControl).toHaveCSS("background-color", "rgb(28, 28, 31)");
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 6_000 });

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await page.locator("body").innerText()).not.toContain("\\u");
  await page.screenshot({ path: testInfo.outputPath("studio-shell.png"), fullPage: true });

  expect(issues).toEqual([]);
});
