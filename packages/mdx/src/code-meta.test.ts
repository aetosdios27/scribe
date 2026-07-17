import { describe, expect, it } from "vitest";

import { parseCodeMetadata } from "./code-meta.js";

describe("parseCodeMetadata", () => {
  it("parses the explicit phase-one metadata surface", () => {
    const result = parseCodeMetadata(
      'filename="peer.rs" lineNumbers highlight="2-4,6" focus="3"',
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
      focus: [{ start: 3, end: 3 }]
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
  });
});

