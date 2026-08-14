import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  Banner,
  Callout,
  CodeFrame,
  Figure,
  Publication,
  ScribeImage,
  Video,
  createScribeComponents
} from "./index.js";

describe("the Scribe editorial React boundary", () => {
  it("renders a semantic article with the scoped Scribe class", () => {
    const html = renderToStaticMarkup(
      <Publication className="host-article">Article body</Publication>
    );

    expect(html).toBe('<article class="scribe host-article">Article body</article>');
  });

  it("does not forward the MDX component map to the article element", () => {
    const html = renderToStaticMarkup(
      <Publication {...({ components: { h1: "h1" } } as unknown as Parameters<typeof Publication>[0])}>
        Article body
      </Publication>
    );

    expect(html).toBe('<article class="scribe">Article body</article>');
  });

  it("renders an editorial banner with and without media", () => {
    const withImage = renderToStaticMarkup(
      <Banner
        eyebrow="Building Styx · Part 3"
        title="The peer wire protocol"
        description="How peers negotiate the movement of pieces."
        image="/peer-wire.svg"
        imageAlt="A peer connection diagram"
        metadata={<time dateTime="2026-07-17">July 17, 2026</time>}
      />
    );
    const withoutImage = renderToStaticMarkup(<Banner title="Protocol notes" />);

    expect(withImage).toContain("scribe-banner__media");
    expect(withImage).toContain('alt="A peer connection diagram"');
    expect(withImage).toContain("<time");
    expect(withoutImage).not.toContain("scribe-banner__media");
  });

  it("renders restrained semantic callout variants and rejects unknown variants", () => {
    const html = renderToStaticMarkup(
      <>
        <Callout variant="warning" title="Protocol edge">Peers can disappear mid-frame.</Callout>
        <Callout variant="success">Write acknowledged.</Callout>
        <Callout variant="error">Write rejected.</Callout>
      </>
    );

    expect(html).toContain('<aside class="scribe-callout" role="note"');
    expect(html).toContain('data-variant="warning"');
    expect(html).toContain('data-variant="success"');
    expect(html).toContain('data-variant="error"');
    expect(() =>
      renderToStaticMarkup(
        <Callout variant={"danger" as "note"}>Unsupported</Callout>
      )
    ).toThrow(/Unsupported Scribe callout variant/u);
  });

  it("renders the success and error callout variants", () => {
    const success = renderToStaticMarkup(<Callout variant="success">All peers verified.</Callout>);
    const error = renderToStaticMarkup(<Callout variant="error">Handshake failed.</Callout>);

    expect(success).toContain('data-variant="success"');
    expect(error).toContain('data-variant="error"');
  });

  it("preserves figure and caption semantics", () => {
    const html = renderToStaticMarkup(
      <Figure caption="Handshake bytes captured from a local peer." wide>
        <img src="/handshake.svg" alt="Handshake byte layout" />
      </Figure>
    );

    expect(html).toContain('<figure class="scribe-figure scribe-wide">');
    expect(html).toContain("<figcaption");
    expect(html).toContain('alt="Handshake byte layout"');
  });

  it("wraps static Shiki markup in a designed code frame", () => {
    const html = renderToStaticMarkup(
      <CodeFrame data-scribe-filename="peer.rs" data-scribe-language="rust">
        <code><span className="line">fn main() {'{}'}</span></code>
      </CodeFrame>
    );

    expect(html).toContain("scribe-code-frame__header");
    expect(html).toContain("peer.rs");
    expect(html).toContain("rust");
    expect(html).toContain('aria-label="Copy peer.rs code"');
  });

  it("renders a wrap toggle next to the copy button in a code frame", () => {
    const html = renderToStaticMarkup(
      <CodeFrame data-scribe-filename="peer.rs" data-scribe-language="rust">
        <code><span className="line">fn main() {'{}'}</span></code>
      </CodeFrame>
    );

    expect(html).toContain("scribe-wrap-toggle-button");
    expect(html).toContain('aria-label="Toggle wrap for peer.rs"');
  });

  it("delegates mermaid-tagged code frames to the diagram renderer instead of the copy chrome", () => {
    const html = renderToStaticMarkup(
      <CodeFrame data-scribe-mermaid="">
        <code>graph TD; A--&gt;B;</code>
      </CodeFrame>
    );

    expect(html).toContain("scribe-code-frame--mermaid");
    expect(html).not.toContain("scribe-copy-button");
    expect(html).toContain("graph TD");
  });

  it("renders a zoomable image and honors the #nozoom escape hatch", () => {
    const zoomable = renderToStaticMarkup(<ScribeImage src="/diagram.png" alt="Wire diagram" />);
    const noZoom = renderToStaticMarkup(<ScribeImage src="/diagram.png#nozoom" alt="Wire diagram" />);
    const explicitOff = renderToStaticMarkup(<ScribeImage src="/diagram.png" alt="Wire diagram" zoom={false} />);

    expect(zoomable).toContain("scribe-image-zoom-trigger");
    expect(zoomable).toContain("scribe-image-dialog");
    expect(noZoom).not.toContain("scribe-image-zoom-trigger");
    expect(noZoom).toContain('src="/diagram.png"');
    expect(explicitOff).not.toContain("scribe-image-zoom-trigger");
  });

  it("renders a video embed wrapped in figure markup", () => {
    const html = renderToStaticMarkup(
      <Video src="/demo.webm" poster="/demo-poster.jpg" caption="A local sync demo." />
    );

    expect(html).toContain('<figure class="scribe-figure">');
    expect(html).toContain("<video");
    expect(html).toContain('type="video/webm"');
    expect(html).toContain("A local sync demo.");
  });

  it("lets explicit consumer component overrides win", () => {
    const ConsumerHeading = () => <h2>Consumer heading</h2>;
    const components = createScribeComponents({ h2: ConsumerHeading });

    expect(components.wrapper).toBe(Publication);
    expect(components.h2).toBe(ConsumerHeading);
  });

  it("maps ordinary Markdown elements and Scribe primitives by default", () => {
    const components = createScribeComponents();

    expect(components).toMatchObject({
      wrapper: Publication,
      pre: CodeFrame,
      Banner,
      Callout,
      Figure,
      Video
    });
    for (const name of ["h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "ul", "ol", "li", "blockquote", "code", "table", "thead", "tbody", "tr", "th", "td", "img", "hr"]) {
      expect(components[name]).toBeTypeOf("function");
    }
  });
});
