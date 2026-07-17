import { describe, expect, it } from "vitest";

import { parseCodeMetadata } from "./code-meta.js";

describe("parseCodeMetadata", () => {
  it("parses the explicit phase-one metadata surface", () => {
    const result = parseCodeMetadata(
      'filename="peer.rs" lineNumbers highlight="2-4,6" focus="3" add="5" remove="1"',
      6
    );

    expect(result.issues).toEqual([]);
    expect(result.value).toEqual({
      filename: "peer.rs",
      lineNumbers: true,
      highlight: [
        { start: 2, end: 4 },
        { start: 6, end: 6 }
      ],
      focus: [{ start: 3, end: 3 }],
      add: [{ start: 5, end: 5 }],
      remove: [{ start: 1, end: 1 }]
    });
  });

  it("reports unknown, duplicate, and malformed fields with stable codes", () => {
    const result = parseCodeMetadata(
      'filename="a.ts" filename="b.ts" mystery="x" highlight="4-2"',
      4
    );

    expect(result.issues.map(({ code }) => code)).toEqual([
      "SCB1001",
      "SCB1001",
      "SCB1002"
    ]);
    expect(result.issues[1]?.message).toContain(
      'Expected: filename="...", lineNumbers, highlight="1,3-5", focus="1,3-5", add="1,3-5", remove="1,3-5".'
    );
  });
});
