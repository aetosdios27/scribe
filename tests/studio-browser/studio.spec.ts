import { expect, test } from "@playwright/test";

test("edits a draft, recompiles the real preview, and recovers from invalid MDX", async ({ page }) => {
  const issues: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") issues.push(message.text()); });
  page.on("pageerror", (error) => issues.push(error.message));

  await page.goto("/");
  const source = page.getByRole("textbox", { name: "Article source" });
  const preview = page.frameLocator("iframe[title='Scribe article preview']");
  await expect(source).toHaveValue(/Peer state transitions/u);
  await expect(preview.locator("h1#peer-state-transitions")).toBeVisible();

  await source.fill("# Live studio draft\n\nThe preview uses the production Scribe renderer.\n");
  await expect(page.locator("#status-text")).toHaveText("Unsaved draft");
  await expect(preview.locator("h1#live-studio-draft")).toBeVisible();

  await source.fill("<Callout>unfinished");
  await expect(page.locator("#status-text")).toHaveText("Compilation blocked");
  await expect(page.locator("#diagnostics")).toContainText("Expected a closing tag");
  await expect(preview.locator("h1#live-studio-draft")).toBeVisible();

  await source.fill("# Recovered draft\n");
  await expect(preview.locator("h1#recovered-draft")).toBeVisible();
  await page.getByLabel("Style").selectOption("foundation");
  await expect(page.locator("#status-text")).toHaveText("Unsaved draft");

  await page.getByRole("button", { name: "Mobile" }).click();
  await expect(page.locator("#preview")).toHaveCSS("width", "390px");
  await page.getByRole("button", { name: "Dark" }).click();
  await expect(preview.locator(".scribe[data-theme='dark']")).toBeVisible();
  expect(issues).toEqual([]);
});
