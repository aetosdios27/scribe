import { StrictMode, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { Banner, Publication, createScribeComponents } from "@scribe/react";
import "@scribe/styles/default.css";
import "../../../fixtures/hosts.css";

import Article from "../../content/article.mdx";

const root = document.querySelector("#root");
if (!root) throw new Error("Missing Vite fixture root element.");

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
const host = params.get("host") === "branded" ? "branded" : "neutral";
const hostile = params.get("hostile") === "true";
const fixture = params.get("fixture") ?? "article";

function FixturePublication(props: ComponentProps<typeof Publication>) {
  return <Publication {...props} data-theme={theme} />;
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

createRoot(root).render(
  <StrictMode>
    <main className={`fixture-shell fixture-${host}${hostile ? " fixture-hostile" : ""}`} data-theme={theme}>
      <div className="fixture-outside-proof">Host content outside the Scribe boundary</div>
      {fixture === "banner-no-image" ? <BannerWithoutImage /> : <Article components={components} />}
    </main>
  </StrictMode>
);
