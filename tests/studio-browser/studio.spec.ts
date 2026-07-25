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

  const source = page.getByRole("textbox", { name: "Article source" });
  const preview = page.frameLocator("iframe[title='Scribe article preview']");
  const toolbar = page.locator(".studio-toolbar");
  const statusbar = page.locator(".studio-statusbar");
  const splitter = page.getByRole("separator", { name: "Resize editor and preview" });
  const viewportControl = toolbar.getByLabel("Preview viewport");

  await expect(source).toHaveValue(/Peer state transitions/u);
  await expect(viewportControl).toContainText("Desktop");
  const savedControl = toolbar.getByRole("button", { name: /^Saved$/u });
  await expect(savedControl).toBeVisible({ timeout: 10_000 });
  await expect(savedControl).toHaveAttribute("data-save-state", "saved");
  await expect(savedControl).toHaveCSS("background-color", "rgb(39, 39, 42)");
  await expect(toolbar.getByRole("button", { name: "Switch preview to light mode" })).toBeVisible();
  await expect(toolbar.getByRole("button")).toHaveCount(2);
  await expect(page.getByText("Scribe Studio", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/detected/u)).toHaveCount(0);
  await expect(page.getByText("Production renderer", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Markdown", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Preview", { exact: true })).toHaveCount(0);
  await expect(page.locator(".source-line-number").nth(9)).toHaveText("10");
  await expect(page.locator(".source-highlight")).toBeVisible();
  await expect(page.locator(".source-token--marker").first()).toHaveCSS("color", "rgb(37, 99, 235)");
  await expect(source).toHaveAttribute("wrap", "soft");
  expect(await source.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expect(statusbar.locator(".studio-statusbar__path")).toHaveText("tests/fixtures/studio-article.mdx");
  await expect(statusbar).toContainText(/\d+ lines/u);
  await expect(statusbar).toContainText(/\d+ words/u);
  await expect(statusbar).toContainText(/(?:localhost|127\.0\.0\.1):\d+/u);
  await expect(statusbar).toContainText("1280px");
  await expect(statusbar).toContainText("Connected");
  await expect(preview.locator(".scribe-banner__title")).toHaveText("Peer wire field notes");
  await expect(page.locator(".preview-stage")).toHaveCSS("padding", "0px");
  await expect(page.locator(".preview-device")).toHaveCSS("border-top-width", "0px");
  await page.screenshot({ path: testInfo.outputPath("studio-shell-initial.png"), fullPage: true });

  const initialLeftWidth = await page.locator(".source-panel").evaluate((element) => element.getBoundingClientRect().width);
  const splitterBox = await splitter.boundingBox();
  if (!splitterBox) throw new Error("The Studio splitter was not rendered.");
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
  const resetLeftWidth = await page.locator(".source-panel").evaluate((element) => element.getBoundingClientRect().width);
  expect(Math.abs(resetLeftWidth - initialLeftWidth)).toBeLessThanOrEqual(2);

  const editedSource = "# Shell redesign proof\n\nThe preview updates through the production renderer.\n";
  await source.fill(editedSource);
  await expect(toolbar.getByRole("button", { name: /^Save$/u })).toBeVisible();
  await expect(preview.locator("h1#shell-redesign-proof")).toBeVisible();
  await expect(statusbar).toContainText("4 lines");

  await viewportControl.click();
  const mobileOption = page.getByRole("option", { name: "Mobile" });
  await expect(mobileOption).toBeVisible();
  await page.waitForTimeout(160);
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
  await expect.poll(() => readFile(fixturePath, "utf8")).toBe(editedSource);
  await page.mouse.move(640, 360);
  await expect(settledSavedControl).toHaveCSS("background-color", "rgb(39, 39, 42)");
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 6_000 });

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(await page.locator("body").innerText()).not.toContain("\\u");
  await page.screenshot({ path: testInfo.outputPath("studio-shell.png"), fullPage: true });

  await source.fill(originalFixture);
  await expect(toolbar.getByRole("button", { name: /^Save$/u })).toBeVisible();
  await toolbar.getByRole("button", { name: /^Save$/u }).click();
  await expect(toolbar.getByRole("button", { name: /^Saved$/u })).toBeVisible();
  await expect.poll(() => readFile(fixturePath, "utf8")).toBe(originalFixture);

  expect(issues).toEqual([]);
});
