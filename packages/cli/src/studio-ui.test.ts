import { expect, it } from "vitest";

import { studioClientModule, studioStyles, type StudioClientImports } from "./studio-ui.js";

it("ships the constrained Rich Text client and the Studio visual tokens", () => {
  const client = studioClientModule({} as StudioClientImports);
  expect(client).toContain("MDXEditor");
  expect(client).toContain("lucide-react");
  expect(client).toContain("Scribe Studio");
  expect(client).toContain("Rich Text");
  expect(client).toContain("format_align_left: AlignLeft");
  expect(client).toContain("format_align_center: AlignCenter");
  expect(client).toContain("format_align_right: AlignRight");
  expect(client).toContain('new EventSource("/__scribe/api/events")');
  expect(client).toContain("scribe-studio-recovery");
  expect(client).toContain("Math.max(studioRevision, body.revision)");
  expect(client).toContain("next.revision < studioRevision");
  expect(client).toContain("Your browser recovery draft remains intact");
  expect(client).not.toContain('aria-label="Markdown formatting"');

  const styles = studioStyles();
  expect(styles).toContain("#CDFF57");
  expect(styles).toContain("#0A0A0A");
});
