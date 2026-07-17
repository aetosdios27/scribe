import { describe, expect, it } from "vitest";

import { compileScribeMdx } from "./index.js";

describe("compileScribeMdx", () => {
  it("emits static dual-theme Shiki markup and line metadata", async () => {
    const file = await compileScribeMdx(`
# Peer state

\`\`\`ts filename="peer.ts" lineNumbers highlight="2" focus="1-2" add="2" remove="1"
const state = "choked"
console.log(state)
\`\`\`
`);
    const output = String(file);

    expect(output).toContain("shiki");
    expect(output).toContain("--shiki-dark");
    expect(output).toContain("data-scribe-filename");
    expect(output).toContain("highlighted");
    expect(output).toContain("focused");
    expect(output).toContain("added");
    expect(output).toContain("removed");
    expect(output).not.toMatch(/className: "line",\s+className:/u);
    expect(output).toContain('className: "line focused removed"');
    expect(output).not.toMatch(/from ["']shiki/);
  });

  it("warns and emits plaintext markup for an unsupported language", async () => {
    const file = await compileScribeMdx(`
\`\`\`definitely-not-a-language
opaque value
\`\`\`
`);

    expect(file.messages).toHaveLength(1);
    expect(file.messages[0]).toMatchObject({
      fatal: false,
      ruleId: "SCB1003",
      source: "scribe"
    });
    expect(String(file)).toContain("data-scribe-fallback");
  });

  it("upgrades unsupported languages to errors only in strict mode", async () => {
    await expect(
      compileScribeMdx("```definitely-not-a-language\nopaque value\n```", { strict: true })
    ).rejects.toMatchObject({ ruleId: "SCB1003", source: "scribe" });
  });
});
