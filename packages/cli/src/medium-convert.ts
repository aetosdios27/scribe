import { basename } from "node:path";

import type { Element, ElementContent, Properties, Root, RootContent } from "hast";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";

import type { MediumArchivePost } from "./medium-archive.js";

export type MediumAssetReference = {
  originalUrl: URL;
  alt: string;
  articleReference: string;
};

export type ImportWarning = {
  code: string;
  message: string;
  source?: string;
};

export type ConvertedMediumPost = {
  slug: string;
  kind: "story" | "response-candidate";
  markdown: string;
  assets: MediumAssetReference[];
  warnings: ImportWarning[];
};

const FORBIDDEN_ELEMENTS = new Set([
  "button",
  "canvas",
  "footer",
  "form",
  "header",
  "input",
  "nav",
  "noscript",
  "object",
  "option",
  "script",
  "select",
  "source",
  "style",
  "svg",
  "template",
  "textarea"
]);
const EMBED_ELEMENTS = new Set(["audio", "embed", "iframe", "video"]);
const SEMANTIC_ELEMENTS = new Set([
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul"
]);

function elements(node: Root | RootContent, tagName?: string): Element[] {
  const found: Element[] = [];
  if (node.type === "element") {
    if (tagName === undefined || node.tagName === tagName) found.push(node);
    for (const child of node.children) found.push(...elements(child, tagName));
  } else if ("children" in node) {
    for (const child of node.children) found.push(...elements(child, tagName));
  }
  return found;
}

function property(properties: Properties, name: string): string | undefined {
  const value = properties[name];
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(String).join(" ");
  return undefined;
}

function hasClass(node: Element, className: string): boolean {
  return (property(node.properties, "className")?.split(/\s+/u) ?? []).includes(className);
}

function text(node: Root | RootContent): string {
  if (node.type === "text") return node.value;
  if ("children" in node) return node.children.map((child) => text(child)).join("");
  return "";
}

function normalizedText(node: Root | RootContent): string {
  return text(node).replace(/\s+/gu, " ").trim();
}

function normalizeMediumSpacing(value: string): string {
  return value
    .replace(/[\u200b\ufeff]/gu, "")
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu, " ");
}

function metaValues(root: Root, key: string): string[] {
  return elements(root, "meta").flatMap((node) => {
    const name = property(node.properties, "name") ?? property(node.properties, "property");
    const content = property(node.properties, "content");
    return name?.toLowerCase() === key.toLowerCase() && content ? [content.trim()] : [];
  });
}

function canonicalUrl(root: Root): string | undefined {
  for (const node of elements(root, "link")) {
    const rel = property(node.properties, "rel")?.toLowerCase().split(/\s+/u) ?? [];
    const href = property(node.properties, "href");
    if (rel.includes("canonical") && href && safeRemoteUrl(href)) return href;
  }
  for (const node of elements(root, "a")) {
    const classes = property(node.properties, "className")?.toLowerCase().split(/\s+/u) ?? [];
    const href = property(node.properties, "href");
    if (classes.includes("p-canonical") && href && safeRemoteUrl(href)) return href;
  }
  return undefined;
}

function safeRemoteUrl(value: string): URL | undefined {
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function safeLink(value: string): string | undefined {
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("#")) return value;
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function isTrackingImage(node: Element): boolean {
  const width = Number(property(node.properties, "width"));
  const height = Number(property(node.properties, "height"));
  const source = property(node.properties, "src")?.toLowerCase() ?? "";
  return (
    (Number.isFinite(width) && width <= 1)
    || (Number.isFinite(height) && height <= 1)
    || source.includes("medium.com/_/stat")
  );
}

function embedFallback(node: Element, warnings: ImportWarning[]): ElementContent[] {
  const source = property(node.properties, "src");
  const url = source === undefined ? undefined : safeRemoteUrl(source);
  if (!url) {
    warnings.push({
      code: "medium-unsupported-embed",
      message: `Removed an unsupported <${node.tagName}> embed without a safe source URL.`
    });
    return [];
  }
  const label = property(node.properties, "title")?.trim() || `${node.tagName} embed`;
  warnings.push({
    code: "medium-unsupported-embed",
    message: `Converted an unsupported <${node.tagName}> embed into a link.`,
    source: url.href
  });
  return [{
    type: "element",
    tagName: "p",
    properties: {},
    children: [{
      type: "element",
      tagName: "a",
      properties: { href: url.href },
      children: [{ type: "text", value: label }]
    }]
  }];
}

function scriptEmbedFallback(node: Element, warnings: ImportWarning[]): ElementContent[] {
  const source = property(node.properties, "src");
  const url = source === undefined ? undefined : safeRemoteUrl(source);
  if (!url) return [];
  const isGitHubGist = url.hostname === "gist.github.com";
  const href = isGitHubGist ? url.href.replace(/\.js$/u, "") : url.href;
  const label = isGitHubGist ? "GitHub Gist" : "Embedded script";
  warnings.push({
    code: "medium-unsupported-embed",
    message: `Converted an unsupported script embed into a link.`,
    source: href
  });
  return [{
    type: "element",
    tagName: "p",
    properties: {},
    children: [{
      type: "element",
      tagName: "a",
      properties: { href },
      children: [{ type: "text", value: label }]
    }]
  }];
}

function safeProperties(node: Element): Properties {
  if (node.tagName === "a") {
    const href = property(node.properties, "href");
    const title = property(node.properties, "title");
    return {
      ...(href === undefined || safeLink(href) === undefined ? {} : { href: safeLink(href) }),
      ...(title === undefined ? {} : { title })
    };
  }
  if (node.tagName === "img") {
    const source = property(node.properties, "src");
    const title = property(node.properties, "title");
    const alt = property(node.properties, "alt") ?? "";
    const safeSource = source === undefined ? undefined : safeLink(source);
    return {
      ...(safeSource === undefined ? {} : { src: safeSource }),
      alt,
      ...(title === undefined ? {} : { title })
    };
  }
  if (node.tagName === "code") {
    const classes = node.properties.className;
    const safeClasses = Array.isArray(classes)
      ? classes.map(String).filter((value) => /^language-[a-z0-9_+-]+$/iu.test(value))
      : [];
    return safeClasses.length === 0 ? {} : { className: safeClasses };
  }
  if (node.tagName === "ol") {
    const start = node.properties.start;
    return typeof start === "number" && Number.isSafeInteger(start) ? { start } : {};
  }
  if (node.tagName === "th" || node.tagName === "td") {
    const align = property(node.properties, "align");
    return align !== undefined && ["left", "center", "right"].includes(align) ? { align } : {};
  }
  return {};
}

function sanitizeChildren(
  children: readonly ElementContent[],
  warnings: ImportWarning[],
  assets: MediumAssetReference[]
): ElementContent[];
function sanitizeChildren(
  children: readonly RootContent[],
  warnings: ImportWarning[],
  assets: MediumAssetReference[]
): RootContent[];
function sanitizeChildren(
  children: readonly RootContent[] | readonly ElementContent[],
  warnings: ImportWarning[],
  assets: MediumAssetReference[]
): RootContent[] {
  return children.flatMap((child): RootContent[] => {
    if (child.type === "comment" || child.type === "doctype") return [];
    if (child.type === "text") return [{ ...child, value: normalizeMediumSpacing(child.value) }];
    if (child.type !== "element") return [child];
    if (child.tagName === "script") return scriptEmbedFallback(child, warnings);
    if (FORBIDDEN_ELEMENTS.has(child.tagName)) return [];
    if (EMBED_ELEMENTS.has(child.tagName)) return embedFallback(child, warnings);
    if (hasClass(child, "graf--title") || hasClass(child, "graf--subtitle")) return [];
    if (child.tagName === "hr" && hasClass(child, "section-divider")) return [];
    if (child.tagName === "img" && isTrackingImage(child)) return [];

    const sanitizedChildren = sanitizeChildren(child.children, warnings, assets);
    if (!SEMANTIC_ELEMENTS.has(child.tagName)) return sanitizedChildren;
    const tagName = child.tagName === "h3" && hasClass(child, "graf--h3")
      ? "h2"
      : child.tagName === "h4" && hasClass(child, "graf--h4")
        ? "h3"
        : child.tagName;
    const properties = safeProperties(child);
    if (child.tagName === "img") {
      const source = property(properties, "src");
      if (source === undefined) return [];
      const remote = safeRemoteUrl(source);
      if (remote) {
        assets.push({
          originalUrl: remote,
          alt: property(properties, "alt") ?? "",
          articleReference: source
        });
      }
    }
    return [{ ...child, tagName, properties, children: sanitizedChildren }];
  });
}

function contentRoot(root: Root): Root {
  const bodyField = elements(root).find((node) => property(node.properties, "dataField") === "body");
  const article = elements(root, "article")[0];
  const body = elements(root, "body")[0];
  return {
    type: "root",
    children: [...(bodyField ?? article ?? body ?? root).children]
  };
}

function removeLeadingMetadataDuplicates(root: Root, title: string, description?: string): void {
  root.children = root.children.filter((node) => node.type !== "text" || node.value.trim() !== "");
  for (const value of [title, description]) {
    if (value === undefined) continue;
    const duplicateIndex = root.children.slice(0, 8).findIndex((node) => (
      node.type === "element"
      && ["h1", "h2", "h3", "p"].includes(node.tagName)
      && normalizedText(node) === value
    ));
    if (duplicateIndex >= 0) root.children.splice(duplicateIndex, 1);
  }
}

function mediumEntryKind(root: Root, title: string, description?: string): ConvertedMediumPost["kind"] {
  if (description !== undefined) return "story";
  const content = root.children.filter((node) => node.type !== "text" || node.value.trim() !== "");
  return content.length === 1
    && content[0]?.type === "element"
    && content[0].tagName === "p"
    && normalizedText(content[0]) === title
    ? "response-candidate"
    : "story";
}

function slugFromEntry(post: MediumArchivePost, title: string): string {
  const filename = basename(post.entryPath, ".html")
    .replace(/^draft[_-]+/iu, "")
    .replace(/^\d{4}-\d{2}-\d{2}[_-]+/u, "")
    .replace(/[-_]+[a-f0-9]{12}$/iu, "");
  const candidate = filename || title;
  const slug = candidate
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96)
    .replace(/-+$/u, "");
  return slug || "medium-story";
}

function frontmatter(values: {
  title: string;
  description?: string;
  date?: string;
  tags: string[];
  canonical?: string;
}): string {
  const lines = [
    `title: ${JSON.stringify(values.title)}`,
    ...(values.description === undefined ? [] : [`description: ${JSON.stringify(values.description)}`]),
    ...(values.date === undefined ? [] : [`date: ${JSON.stringify(values.date)}`]),
    ...(values.tags.length === 0 ? [] : [`tags: ${JSON.stringify(values.tags)}`]),
    ...(values.canonical === undefined ? [] : [`canonical: ${JSON.stringify(values.canonical)}`])
  ];
  return `---\n${lines.join("\n")}\n---`;
}

export async function convertMediumPost(post: MediumArchivePost): Promise<ConvertedMediumPost> {
  const parser = unified().use(rehypeParse);
  const parsed = parser.parse(post.html) as Root;
  const title = metaValues(parsed, "og:title")[0]
    ?? elements(parsed, "title").map(normalizedText).find(Boolean)
    ?? elements(parsed, "h1").map(normalizedText).find(Boolean)
    ?? "Untitled Medium story";
  const subtitle = elements(parsed).find((node) => property(node.properties, "dataField") === "subtitle");
  const description = metaValues(parsed, "description")[0]
    ?? metaValues(parsed, "og:description")[0]
    ?? (subtitle === undefined ? undefined : normalizedText(subtitle) || undefined);
  const exportedDate = metaValues(parsed, "article:published_time")[0]
    ?? elements(parsed, "time").map((node) => property(node.properties, "dateTime")).find(Boolean);
  const date = exportedDate?.match(/^\d{4}-\d{2}-\d{2}/u)?.[0] ?? exportedDate;
  const tags = [
    ...metaValues(parsed, "article:tag"),
    ...metaValues(parsed, "keywords").flatMap((value) => value.split(",").map((tag) => tag.trim()).filter(Boolean))
  ].filter((tag, index, all) => all.indexOf(tag) === index);
  const canonical = canonicalUrl(parsed);
  const warnings: ImportWarning[] = [];
  const assets: MediumAssetReference[] = [];
  const article = contentRoot(parsed);
  article.children = sanitizeChildren(article.children, warnings, assets);
  const kind = mediumEntryKind(article, title, description);
  removeLeadingMetadataDuplicates(article, title, description);

  const serializer = unified()
    .use(rehypeRemark)
    .use(remarkGfm)
    .use(remarkStringify, {
      bullet: "-",
      emphasis: "*",
      strong: "*",
      fences: true,
      fence: "`",
      listItemIndent: "one",
      rule: "-"
    });
  const markdownTree = await serializer.run(article);
  const body = serializer.stringify(markdownTree).trim();
  const slug = slugFromEntry(post, title);
  return {
    slug,
    kind,
    markdown: `${frontmatter({
      title,
      tags,
      ...(description === undefined ? {} : { description }),
      ...(date === undefined ? {} : { date }),
      ...(canonical === undefined ? {} : { canonical })
    })}\n\n${body}\n`,
    assets,
    warnings
  };
}
