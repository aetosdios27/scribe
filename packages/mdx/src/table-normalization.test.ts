import { expect, it } from "vitest";

import { compileScribeMdx } from "./index.js";

it("normalizes Markdown and literal JSX tables into one responsive wrapper each", async () => {
  const file = await compileScribeMdx(`
| State | Meaning |
| --- | --- |
| choked | Upload is paused |

<table>
  <caption>Literal peer states</caption>
  <thead><tr><th>State</th><th>Meaning</th></tr></thead>
  <tbody><tr><td>interested</td><td>Pieces are wanted</td></tr></tbody>
</table>
`);
  const output = String(file);

  expect(output.match(/scribe-table-scroll/g)).toHaveLength(2);
  expect(output.match(/Scrollable article table/g)).toHaveLength(2);
});
