import { StrictMode, type ComponentProps, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { Banner, Publication, createScribeComponents } from "@scribe-sdk/react";
import "../../../fixtures/hosts.css";

import Article from "../../content/article.mdx";

const root = document.querySelector("#root");
if (!root) throw new Error("Missing Vite fixture root element.");

const params = new URLSearchParams(window.location.search);
const styleMode = params.get("style") ?? "default";
const theme = params.get("theme") === "dark" ? "dark" : "light";
const host = params.get("host") === "branded" ? "branded" : "neutral";
const hostile = params.get("hostile") === "true";
const fixture = params.get("fixture") ?? "article";
const publicationTheme = params.get("publication-theme");

async function loadLinkedStyle(href: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => reject(new Error(`Could not load ${href}.`)), { once: true });
    document.head.append(link);
  });
}

if (styleMode === "foundation") {
  await import("@scribe-sdk/styles/foundation.css");
} else if (styleMode === "tailwind-v3" || styleMode === "tailwind-v4") {
  await loadLinkedStyle(`/generated/${styleMode}.css`);
  await import("@scribe-sdk/styles/tailwind.css");
} else {
  await import("@scribe-sdk/styles/default.css");
}

function FixturePublication(props: ComponentProps<typeof Publication>) {
  return <Publication {...props} data-theme={theme} data-fixture-wrapper="override" />;
}

const components = createScribeComponents({ components: { wrapper: FixturePublication } });

function BannerWithoutImage() {
  return (
    <Publication data-theme={theme}>
      <Banner
        eyebrow="Field notes"
        title="A quiet banner without an image"
        description="The editorial hierarchy remains intact when media is absent."
        metadata="5 min read"
      />
    </Publication>
  );
}

function ContinuityContent() {
  const shikiStyle = {
    "--shiki-light": "#24292e",
    "--shiki-dark": "#e1e4e8",
    "--shiki-light-bg": "#fff",
    "--shiki-dark-bg": "#24292e"
  } as CSSProperties;

  return (
    <>
      <p>The opening paragraph must retain the host's direct-child rhythm.</p>
      <h1>Peer protocol notes</h1>
      <p>The host owns this paragraph's typography, measure, and rhythm.</p>
      <h2 id="wire-states">Wire states <a className="scribe-heading-anchor" href="#wire-states" aria-label="Link to Wire states">#</a></h2>
      <p>Scribe adds publishing mechanics without replacing those decisions.</p>
      <div className="scribe-table-scroll" role="region" aria-label="Scrollable article table" tabIndex={0}>
        <table><tbody><tr>{["interested", "unchoked", "piece-index", "block-offset", "block-length", "download-rate", "upload-rate", "peer-identifier-with-a-long-token"].map((value) => <td key={value}>{value}</td>)}</tr></tbody></table>
      </div>
      <figure className="scribe-code-frame">
        <pre className="scribe-code-frame__pre shiki" style={shikiStyle}><code><span style={shikiStyle}>peer.set_interested(true); // a deliberately long protocol operation remains internally scrollable</span></code></pre>
      </figure>
    </>
  );
}

function ContinuityFixture() {
  const proseClass = styleMode.startsWith("tailwind") ? "prose" : "custom-prose";
  const explicitTheme = publicationTheme === "light" || publicationTheme === "dark" ? publicationTheme : undefined;
  return (
    <main className={`fixture-continuity${theme === "dark" ? " dark" : ""}`}>
      <div className="fixture-continuity__pair">
        <section className={proseClass} data-continuity="before"><ContinuityContent /></section>
        {styleMode.startsWith("tailwind") ? (
          <section className={proseClass} data-continuity="after"><Publication data-theme={explicitTheme}><ContinuityContent /></Publication></section>
        ) : (
          <Publication className={proseClass} data-continuity="after"><ContinuityContent /></Publication>
        )}
      </div>
    </main>
  );
}

createRoot(root).render(
  <StrictMode>
    {fixture === "continuity" ? <ContinuityFixture /> : (
      <main className={`fixture-shell fixture-${host}${hostile ? " fixture-hostile" : ""}`} data-theme={theme}>
        <div className="fixture-outside-proof">Host content outside the Scribe boundary</div>
        {fixture === "banner-no-image" ? <BannerWithoutImage /> : <Article components={components} />}
      </main>
    )}
  </StrictMode>
);
