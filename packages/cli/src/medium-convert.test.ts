import { readFile } from "node:fs/promises";

import { compileScribeMdx } from "@scribe-sdk/mdx";
import { expect, it } from "vitest";

import type { MediumArchivePost } from "./medium-archive.js";
import { convertMediumPost } from "./medium-convert.js";

async function publishedPost(): Promise<MediumArchivePost> {
  return {
    entryPath: "medium-export/posts/2026-07-30_two-computers-meet.html",
    html: await readFile(new URL("./fixtures/medium-export/published-story.html", import.meta.url), "utf8"),
    status: "published"
  };
}

it("converts Medium metadata and semantic article content into deterministic MDX", async () => {
  const converted = await convertMediumPost(await publishedPost());

  expect(converted.slug).toBe("two-computers-meet");
  expect(converted.markdown).toMatch(/^---\ntitle: "Two computers meet"\ndescription: "Building a peer protocol from scratch\."\ndate: "2026-07-30"\ntags: \["rust","networking"\]\ncanonical: "https:\/\/example\.medium\.com\/two-computers-meet-1234abcd"\n---\n/u);
  expect(converted.markdown.match(/Two computers meet/gu)).toHaveLength(1);
  expect(converted.markdown).not.toContain("## Building a peer protocol from scratch.");
  expect(converted.markdown).toContain("Peers exchange **bytes**, not JSON.");
  expect(converted.markdown).toContain("## The handshake");
  expect(converted.markdown).toContain("`read_exact`");
  expect(converted.markdown).toContain("- Read the length.");
  expect(converted.markdown).toContain("1. Connect.");
  expect(converted.markdown).toContain("> A protocol is a sequence of promises.");
  expect(converted.markdown).toContain("```rust");
  expect(converted.markdown).toContain("| state");
  expect(converted.markdown).toContain("![Peer wire exchange](https://cdn-images-1.medium.com/max/1200/peer-wire.png)");
  expect(converted.markdown).toContain("Peer messages crossing one connection.");

  await expect(compileScribeMdx({
    path: `${converted.slug}.mdx`,
    value: converted.markdown
  })).resolves.toEqual(expect.objectContaining({ messages: [] }));
});

it("drops executable chrome and tracking pixels while preserving unsupported embeds as links", async () => {
  const converted = await convertMediumPost(await publishedPost());

  for (const unsafe of [
    "Medium navigation",
    "Medium membership",
    "globalThis.stolen",
    "onclick",
    "onerror",
    "post.clientViewed",
    "<script",
    "<style"
  ]) expect(converted.markdown).not.toContain(unsafe);
  expect(converted.markdown).toContain("[Peer wire demo](https://www.youtube.com/watch?v=peer-wire)");
  expect(converted.markdown).toContain("[GitHub Gist](https://gist.github.com/aetos/abc123)");
  expect(converted.warnings).toEqual([
    expect.objectContaining({
      code: "medium-unsupported-embed",
      source: "https://www.youtube.com/watch?v=peer-wire"
    }),
    expect.objectContaining({
      code: "medium-unsupported-embed",
      source: "https://gist.github.com/aetos/abc123"
    })
  ]);
});

it("returns remote image references for the asset stage without changing the article URL", async () => {
  const converted = await convertMediumPost(await publishedPost());

  expect(converted.assets).toEqual([
    {
      alt: "Peer wire exchange",
      articleReference: "https://cdn-images-1.medium.com/max/1200/peer-wire.png",
      originalUrl: new URL("https://cdn-images-1.medium.com/max/1200/peer-wire.png")
    }
  ]);
});

it("removes Medium's draft and date prefixes from generated slugs", async () => {
  const converted = await convertMediumPost({
    entryPath: "medium-export/posts/Draft_2026-07-31_protocol-notes-a1b2c3d4e5f6.html",
    html: "<article><h1>Protocol notes</h1><p>Unpublished notes.</p></article>",
    status: "draft"
  });

  expect(converted.slug).toBe("protocol-notes");
});

it("reads metadata and removes duplicate title copy from Medium's exported HTML shape", async () => {
  const converted = await convertMediumPost({
    entryPath: "medium-export/posts/2026-07-30_peer-wire.html",
    html: `<!doctype html><html><head><title>Peer wire</title></head><body>
      <article class="h-entry">
        <header><h1 class="p-name">Peer wire</h1></header>
        <section data-field="subtitle" class="p-summary">A protocol from scratch.</section>
        <section data-field="body" class="e-content">
          <section><div><div class="section-divider"><hr class="section-divider"></div>
          <h4 class="graf graf--h4 graf--kicker">Protocol field notes</h4>
          <h3 class="graf graf--title">Peer&nbsp;wire</h3>
          <h4 class="graf graf--subtitle">A protocol from scratch.</h4>
          <p>A protocol from scratch.</p><p>Peers exchange bytes.</p>
          <h3 class="graf graf--h3">Decoding frames</h3></div></section>
        </section>
        <footer>
          <time class="dt-published" datetime="2026-07-30T12:00:00.000Z">July 30, 2026</time>
          <a class="p-canonical" href="https://writer.medium.com/peer-wire-1234abcd">Canonical link</a>
        </footer>
      </article>
    </body></html>`,
    status: "published"
  });

  expect(converted.markdown).toContain('description: "A protocol from scratch."');
  expect(converted.markdown).toContain('date: "2026-07-30"');
  expect(converted.markdown).toContain('canonical: "https://writer.medium.com/peer-wire-1234abcd"');
  expect(converted.markdown).toContain("Peers exchange bytes.");
  expect(converted.markdown).toContain("### Protocol field notes");
  expect(converted.markdown).toContain("## Decoding frames");
  expect(converted.markdown).not.toContain("### Peer wire");
  expect(converted.markdown.match(/A protocol from scratch\./gu)).toHaveLength(1);
  expect(converted.markdown.split("---\n\n")[1]).not.toMatch(/^---/u);
});

it("marks Medium's title-only response export shape as a response candidate", async () => {
  const converted = await convertMediumPost({
    entryPath: "medium-export/posts/2026-05-16_learnt-a-lot-47493d3ffa16.html",
    html: `<!doctype html><html><head><title>learnt a lot</title></head><body>
      <article class="h-entry">
        <header><h1 class="p-name">learnt a lot</h1></header>
        <section data-field="body" class="e-content">
          <section><div class="section-divider"><hr class="section-divider"></div>
          <div><p class="graf graf--p">learnt a lot</p></div></section>
        </section>
      </article>
    </body></html>`,
    status: "published"
  });

  expect(converted.kind).toBe("response-candidate");
});

it("keeps a short post with distinct title and body classified as a story", async () => {
  const converted = await convertMediumPost({
    entryPath: "medium-export/posts/2026-05-16_release-note-47493d3ffa16.html",
    html: `<!doctype html><html><head><title>Release note</title></head><body>
      <article class="h-entry">
        <header><h1 class="p-name">Release note</h1></header>
        <section data-field="body" class="e-content"><p>Version two is live.</p></section>
      </article>
    </body></html>`,
    status: "published"
  });

  expect(converted.kind).toBe("story");
});

it("normalizes Medium's decorative invisible spacing without flattening punctuation", async () => {
  const converted = await convertMediumPost({
    entryPath: "medium-export/posts/2026-05-16_spacing.html",
    html: `<!doctype html><html><head><title>Spacing</title></head><body>
      <article><p>Behavior&nbsp;System and metrics — stability.</p></article>
    </body></html>`,
    status: "published"
  });

  expect(converted.markdown).toContain("Behavior System and metrics — stability.");
  expect(converted.markdown).not.toMatch(/[\u00a0\u200a]/u);
});

it("drops malformed exported dates with an actionable warning", async () => {
  const converted = await convertMediumPost({
    entryPath: "medium-export/posts/malformed-date.html",
    html: `<!doctype html><html><head>
      <title>Malformed date</title>
      <meta property="article:published_time" content="July 31, 2026">
    </head><body><article><p>Still import the article.</p></article></body></html>`,
    status: "published"
  });

  expect(converted.markdown).not.toContain("date:");
  expect(converted.warnings).toEqual([
    expect.objectContaining({
      code: "medium-invalid-date",
      source: "July 31, 2026"
    })
  ]);
});

it("escapes literal MDX punctuation in imported prose", async () => {
  const converted = await convertMediumPost({
    entryPath: "medium-export/posts/literal-mdx.html",
    html: "<article><h1>Literal MDX</h1><p>Use {value} when 3 &lt; 5.</p></article>",
    status: "published"
  });

  expect(converted.markdown).toContain("Use \\{value} when 3 \\< 5.");
  await expect(compileScribeMdx({
    path: `${converted.slug}.mdx`,
    value: converted.markdown
  })).resolves.toEqual(expect.objectContaining({ messages: [] }));
});
