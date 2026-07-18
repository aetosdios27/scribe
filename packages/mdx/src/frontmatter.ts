import type { Root, RootContent, YAML } from "mdast";
import type { VFile } from "vfile";
import { parseDocument } from "yaml";

interface MdxAttribute {
  readonly type: "mdxJsxAttribute";
  readonly name: string;
  readonly value: string;
}

interface MdxBanner {
  readonly type: "mdxJsxFlowElement";
  readonly name: "Banner";
  readonly attributes: MdxAttribute[];
  readonly children: [];
  readonly position?: YAML["position"];
}

type FrontmatterRecord = Readonly<Record<string, unknown>>;

export function applyScribeFrontmatter(tree: Root, file: VFile): void {
  const index = tree.children.findIndex((node) => node.type === "yaml");
  if (index < 0) return;

  const node = tree.children[index] as YAML;
  const data = parseFrontmatter(node, file);
  file.data.scribeFrontmatter = data;

  const hasExplicitBanner = tree.children.some(isExplicitBanner);
  const banner = hasExplicitBanner ? undefined : createBanner(data, node);
  tree.children.splice(index, 1, ...(banner === undefined ? [] : [banner as RootContent]));
}

function parseFrontmatter(node: YAML, file: VFile): FrontmatterRecord {
  const document = parseDocument(node.value, { prettyErrors: false, uniqueKeys: true });
  const issue = document.errors[0];
  if (issue) fail(file, node, `Invalid YAML frontmatter: ${singleLine(issue.message)}`);

  const value = document.toJS() as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(file, node, "Invalid YAML frontmatter: expected a mapping of metadata fields.");
  }
  return value as FrontmatterRecord;
}

function createBanner(data: FrontmatterRecord, node: YAML): MdxBanner | undefined {
  const title = text(data.title);
  if (title === undefined) return undefined;

  const description = text(data.description) ?? text(data.brief);
  const eyebrow = text(data.eyebrow) ?? text(data.series) ?? text(data.project);
  const image = text(data.image);
  const imageAlt = image === undefined
    ? undefined
    : text(data.imageAlt) ?? text(data.image_alt) ?? title;
  const metadata = metadataText(data);
  const values = {
    title,
    description,
    eyebrow,
    metadata,
    accent: text(data.accent),
    image,
    imageAlt,
    imagePosition: text(data.imagePosition) ?? text(data.image_position)
  };

  return {
    type: "mdxJsxFlowElement",
    name: "Banner",
    attributes: Object.entries(values).flatMap(([name, value]) => value === undefined ? [] : [{
      type: "mdxJsxAttribute" as const,
      name,
      value
    }]),
    children: [],
    ...(node.position === undefined ? {} : { position: node.position })
  };
}

function metadataText(data: FrontmatterRecord): string | undefined {
  const date = text(data.date) ?? text(data.year);
  const tags = Array.isArray(data.tags)
    ? data.tags.flatMap((tag) => text(tag) ?? []).join(" · ")
    : text(data.tags);
  const parts = [date, tags].filter((value): value is string => value !== undefined);
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
}

function isExplicitBanner(node: RootContent): boolean {
  return (
    (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") &&
    node.name === "Banner"
  );
}

function fail(file: VFile, node: YAML, reason: string): never {
  const message = file.message(reason, {
    place: node.position,
    source: "scribe",
    ruleId: "SCB1201"
  });
  message.fatal = true;
  throw message;
}

function singleLine(value: string): string {
  return value.replace(/\s*\n\s*/gu, " ").trim();
}
