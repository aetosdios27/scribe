import { expect, test } from "@playwright/test";

test("Foundation preserves inherited CSS Module identity and explicit element bridges", async ({ page }) => {
  const browserIssues: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserIssues.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserIssues.push(`pageerror: ${error.message}`));

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto("/");
    const article = page.locator("article.scribe");
    await expect(article).toBeVisible();
    await expect(article).toHaveClass(/articleBoundary/u);

    const report = await article.evaluate((node) => {
      const style = getComputedStyle(node);
      const heading = getComputedStyle(node.querySelector("h2")!);
      const paragraph = getComputedStyle(node.querySelector("p")!);
      const code = getComputedStyle(node.querySelector("code")!);
      const table = getComputedStyle(node.querySelector("table")!);
      const quote = getComputedStyle(node.querySelector("blockquote")!);
      return {
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        color: style.color,
        width: node.getBoundingClientRect().width,
        headingFont: heading.fontFamily,
        headingMargin: heading.marginBlockStart,
        paragraphMargin: paragraph.marginBlockEnd,
        codeBackground: code.backgroundColor,
        tableBorder: table.borderTopStyle,
        quoteBorder: quote.borderInlineStartStyle,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    });

    expect(report.fontFamily).toContain("Georgia");
    expect(report).toMatchObject({
      fontSize: "18px",
      lineHeight: "31.5px",
      headingFont: "Arial, sans-serif",
      headingMargin: "48px",
      paragraphMargin: "22px",
      tableBorder: "solid",
      quoteBorder: "solid",
      pageOverflow: false
    });
    expect(report.width).toBeGreaterThan(700);
    expect(report.width).toBeLessThanOrEqual(736);
    expect(report.codeBackground).not.toBe("rgba(0, 0, 0, 0)");
    expect(report.color).toBe(colorScheme === "dark" ? "rgb(238, 239, 232)" : "rgb(32, 35, 38)");
  }

  expect(browserIssues).toEqual([]);
});
