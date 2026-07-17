import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Publication, createScribeComponents } from "./index.js";

describe("the phase-one React boundary", () => {
  it("renders a semantic article with the scoped Scribe class", () => {
    const html = renderToStaticMarkup(
      <Publication className="host-article">Article body</Publication>
    );

    expect(html).toBe('<article class="scribe host-article">Article body</article>');
  });

  it("lets explicit consumer component overrides win", () => {
    const ConsumerHeading = () => <h2>Consumer heading</h2>;
    const components = createScribeComponents({ h2: ConsumerHeading });

    expect(components.wrapper).toBe(Publication);
    expect(components.h2).toBe(ConsumerHeading);
  });
});
