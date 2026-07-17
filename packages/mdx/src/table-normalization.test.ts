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

it("does not double-wrap a table that already has the Scribe overflow region", async () => {
  const file = await compileScribeMdx(`
<div className="scribe-table-scroll" role="region" tabIndex={0}>
  <table><tbody><tr><td>ready</td></tr></tbody></table>
</div>
`);

  expect(String(file).match(/scribe-table-scroll/g)).toHaveLength(1);
});
