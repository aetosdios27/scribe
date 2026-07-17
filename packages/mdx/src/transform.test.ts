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
    expect(file.messages[0]?.reason).toBe(
      'Unsupported code language "definitely-not-a-language"; falling back to plaintext. Use a Shiki bundled language or remove the language tag.'
    );
    expect(String(file)).toContain("data-scribe-fallback");
  });

  it("upgrades unsupported languages to errors only in strict mode", async () => {
    await expect(
      compileScribeMdx("```definitely-not-a-language\nopaque value\n```", { strict: true })
    ).rejects.toMatchObject({
      reason: 'Unsupported code language "definitely-not-a-language". Strict mode requires a Shiki bundled language or an unlabelled plaintext fence.',
      ruleId: "SCB1003",
      source: "scribe"
    });
  });

  it("rejects an unknown static Callout variant during compilation", async () => {
    await expect(
      compileScribeMdx('<Callout variant="warnng">Mind the typo.</Callout>')
    ).rejects.toMatchObject({
      reason: 'Unknown Callout variant "warnng". Expected one of: note, insight, warning.',
      ruleId: "SCB1101",
      source: "scribe"
    });
  });

  it("rejects a static Banner image without alternative text", async () => {
    await expect(
      compileScribeMdx('<Banner title="Peer states" image="/peer.svg" />')
    ).rejects.toMatchObject({
      reason: 'Banner image "/peer.svg" requires a non-empty imageAlt value.',
      ruleId: "SCB1102",
      source: "scribe"
    });
  });
});
