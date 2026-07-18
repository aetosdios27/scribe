import { expect, test } from "@playwright/test";

type StyleSnapshot = {
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
  marginBlockStart: string;
  marginBlockEnd: string;
  width: number;
};

type ContinuityReport = {
  article: StyleSnapshot;
  paragraph: StyleSnapshot;
  h1: StyleSnapshot;
  h2: StyleSnapshot;
  codeFontFamily: string;
  table: { clientWidth: number; scrollWidth: number; containerWidth: number };
};

async function snapshot(locator: import("@playwright/test").Locator): Promise<StyleSnapshot> {
  return locator.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      marginBlockStart: style.marginBlockStart,
      marginBlockEnd: style.marginBlockEnd,
      width: node.getBoundingClientRect().width
    };
  });
}

async function continuityReport(locator: import("@playwright/test").Locator): Promise<ContinuityReport> {
  const [article, paragraph, h1, h2] = await Promise.all([
    snapshot(locator),
    snapshot(locator.locator("p").first()),
    snapshot(locator.locator("h1").first()),
    snapshot(locator.locator("h2").first())
  ]);
  const codeFontFamily = await locator.locator("code").first().evaluate((node) => getComputedStyle(node).fontFamily);
  const table = await locator.locator(".scribe-table-scroll").evaluate((node) => {
    const table = node.querySelector("table");
    if (!table) throw new Error("Missing continuity table.");
    return {
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      containerWidth: node.getBoundingClientRect().width
    };
  });
  return { article, paragraph, h1, h2, codeFontFamily, table };
}

for (const mode of ["foundation", "tailwind-v3", "tailwind-v4"] as const) {
  for (const viewport of [
    { name: "desktop", width: 1100, height: 800 },
    { name: "mobile", width: 390, height: 844 }
  ] as const) test(`${mode} preserves host-owned typography and density on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/?fixture=continuity&style=${mode}`);

    const before = page.locator("[data-continuity='before']");
    const after = page.locator("[data-continuity='after']");
    await expect(after).toBeVisible();

    const baselineReport = await continuityReport(before);
    const integratedReport = await continuityReport(after);

    for (const selector of ["p", "h1", "h2"] as const) {
      const baseline = await snapshot(before.locator(selector).first());
      const integrated = await snapshot(after.locator(selector).first());
      expect(integrated.fontFamily).toBe(baseline.fontFamily);
      expect(integrated.fontSize).toBe(baseline.fontSize);
      expect(integrated.lineHeight).toBe(baseline.lineHeight);
      expect(integrated.marginBlockStart).toBe(baseline.marginBlockStart);
      expect(integrated.marginBlockEnd).toBe(baseline.marginBlockEnd);
      expect(Math.abs(integrated.width - baseline.width)).toBeLessThanOrEqual(1);
    }

    expect(integratedReport.codeFontFamily).toBe(baselineReport.codeFontFamily);
    expect(Math.abs(integratedReport.article.width - baselineReport.article.width)).toBeLessThanOrEqual(1);
    expect(integratedReport.table.containerWidth).toBeLessThanOrEqual(integratedReport.article.width + 1);
    expect(integratedReport.table.scrollWidth).toBeGreaterThanOrEqual(integratedReport.table.clientWidth);
    expect(await after.evaluate((node) => Number(node.matches(".scribe")) + node.querySelectorAll(".scribe").length)).toBe(1);
    await expect(after.locator(".scribe-heading-anchor")).toHaveAttribute("href", "#wire-states");

    if (mode.startsWith("tailwind")) {
      const beforePre = before.locator(".scribe-code-frame__pre");
      const afterPre = after.locator(".scribe-code-frame__pre");
      await expect(afterPre).toHaveCSS("color", await beforePre.evaluate((node) => getComputedStyle(node).color));
      await expect(afterPre).toHaveCSS("background-color", await beforePre.evaluate((node) => getComputedStyle(node).backgroundColor));
    }

    await expect(after.locator(".scribe-table-scroll")).toHaveCSS("overflow-x", "auto");
    await expect(after.locator(".scribe-code-frame__pre")).toHaveCSS("overflow-x", "auto");
    const overflow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      offenders: [...document.querySelectorAll("*")]
        .filter((node) => node.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
        .map((node) => ({ className: node.className, right: node.getBoundingClientRect().right }))
        .slice(0, 5)
    }));
    expect(overflow, JSON.stringify(overflow)).toMatchObject({ scrollWidth: overflow.clientWidth });
  });
}

test("default mode supplies a complete editorial scale for an otherwise raw article", async ({ page }) => {
  await page.goto("/?fixture=continuity&style=default");
  const article = page.locator("[data-continuity='after']");
  await expect(article).toBeVisible();
  expect(Number.parseFloat(await article.locator("p").first().evaluate((node) => getComputedStyle(node).lineHeight))).toBeGreaterThan(24);
  expect(Number.parseFloat(await article.locator("h1").evaluate((node) => getComputedStyle(node).fontSize))).toBeGreaterThan(36);
  await expect(article.locator(".scribe-table-scroll")).toHaveCSS("overflow-x", "auto");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("reports the visual-ownership boundary for established hosts", async ({ page }, testInfo) => {
  const modes = ["foundation", "tailwind-v3", "tailwind-v4"] as const;
  const report: Record<string, { before: ContinuityReport; after: ContinuityReport; nestedPublication: boolean; prosePreserved: boolean }> = {};

  for (const mode of modes) {
    await page.goto(`/?fixture=continuity&style=${mode}`);
    const before = page.locator("[data-continuity='before']");
    const after = page.locator("[data-continuity='after']");
    const beforeReport = await continuityReport(before);
    const afterReport = await continuityReport(after);
    report[mode] = {
      before: beforeReport,
      after: afterReport,
      nestedPublication: await after.evaluate((node) => Number(node.matches(".scribe")) + node.querySelectorAll(".scribe").length > 1),
      prosePreserved: mode === "foundation" || await after.evaluate((node) => node.classList.contains("prose"))
    };
  }

  await testInfo.attach("visual-continuity-report.json", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json"
  });
  console.log(`SCRIBE_CONTINUITY_REPORT ${JSON.stringify(report)}`);
});
