import type { Element, Root } from "hast";
import { toString } from "hast-util-to-string";
import rehypeSlug from "rehype-slug";
import {
  bundledLanguages,
  bundledLanguagesAlias,
  codeToHast,
  type BundledLanguage
} from "shiki";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import type { VFile } from "vfile";

import { parseCodeMetadata, type LineRange, type ScribeCodeMetadata } from "./code-meta.js";
import type { ScribeMdxOptions } from "./types.js";

interface CodeTarget {
  readonly pre: Element;
  readonly code: Element;
  readonly parent: ParentNode;
  readonly index: number;
}

interface ParentNode {
  children: unknown[];
}

const specialLanguages = new Set(["text", "txt", "plain", "plaintext", "ansi"]);

const rehypeScribe: Plugin<[ScribeMdxOptions?]> = function rehypeScribe(options = {}) {
  const slug = rehypeSlug.call(this);

  return async (tree, file) => {
    const root = tree as Root;
    validateScribeComponents(root, file);
    normalizeTables(root);
    const targets = collectCodeTargets(root);
    for (const target of targets) {
      await highlightTarget(target, file, options);
    }
    if (slug) await slug(root);
  };
};

export default rehypeScribe;

const calloutVariants = ["note", "insight", "warning"] as const;

function validateScribeComponents(tree: Root, file: VFile): void {
  visit(tree, (node) => {
    if (!isMdxComponent(node)) return;

    if (node.name === "Callout") {
      const variant = staticAttribute(node, "variant");
      if (variant.kind === "string" && !calloutVariants.includes(variant.value as typeof calloutVariants[number])) {
        fail(
          file,
          node,
          "SCB1101",
          `Unknown Callout variant "${variant.value}". Expected one of: ${calloutVariants.join(", ")}.`
        );
      }
    }

    if (node.name === "Banner") {
      const image = staticAttribute(node, "image");
      const imageAlt = staticAttribute(node, "imageAlt");
      if (image.kind === "string" && image.value.length > 0 && imageAlt.kind !== "expression" && (imageAlt.kind !== "string" || imageAlt.value.trim().length === 0)) {
        fail(
          file,
          node,
          "SCB1102",
          `Banner image "${image.value}" requires a non-empty imageAlt value.`
        );
      }
    }
  });
}

interface MdxComponentNode {
  readonly type: "mdxJsxFlowElement" | "mdxJsxTextElement";
  readonly name: string | null;
  readonly attributes: ReadonlyArray<{
    readonly type?: string;
    readonly name?: string;
    readonly value?: unknown;
  }>;
  readonly position?: Element["position"];
}

type StaticAttribute =
  | { readonly kind: "absent" }
  | { readonly kind: "boolean" }
  | { readonly kind: "expression" }
  | { readonly kind: "string"; readonly value: string };

function isMdxComponent(node: unknown): node is MdxComponentNode {
  if (!node || typeof node !== "object") return false;
  const candidate = node as Partial<MdxComponentNode>;
  return (
    (candidate.type === "mdxJsxFlowElement" || candidate.type === "mdxJsxTextElement") &&
    typeof candidate.name === "string" &&
    Array.isArray(candidate.attributes)
  );
}

function staticAttribute(node: MdxComponentNode, name: string): StaticAttribute {
  const attribute = node.attributes.find(
    (candidate) => candidate.type === "mdxJsxAttribute" && candidate.name === name
  );
  if (!attribute) return { kind: "absent" };
  if (attribute.value === null || attribute.value === undefined) return { kind: "boolean" };
  if (typeof attribute.value === "string") return { kind: "string", value: attribute.value };
  return { kind: "expression" };
}

function fail(
  file: VFile,
  node: Pick<MdxComponentNode, "position">,
  ruleId: "SCB1101" | "SCB1102",
  reason: string
): never {
  const message = file.message(reason, {
    place: node.position,
    source: "scribe",
    ruleId
  });
  message.fatal = true;
  throw message;
}

interface TableTarget {
  readonly node: unknown;
  readonly parent: ParentNode;
  readonly index: number;
}

function normalizeTables(tree: Root): void {
  const targets: TableTarget[] = [];
  visit(tree, (node, index, parent) => {
    if (index === undefined || !parent || !isTableNode(node) || isTableWrapper(parent)) return;
    targets.push({
      node,
      parent: parent as unknown as ParentNode,
      index
    });
  });

  for (const { node, parent, index } of targets) {
    const wrapper: Element = {
      type: "element",
      tagName: "div",
      properties: {
        className: ["scribe-table-scroll"],
        role: "region",
        ariaLabel: "Scrollable article table",
        tabIndex: 0
      },
      children: [node as Element["children"][number]]
    };
    parent.children[index] = wrapper;
  }
}

function isTableWrapper(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const candidate = node as {
    type?: string;
    tagName?: string;
    name?: string | null;
    properties?: { className?: unknown; class?: unknown };
    attributes?: Array<{ type?: string; name?: string; value?: unknown }>;
  };
  const isDiv =
    (candidate.type === "element" && candidate.tagName === "div") ||
    ((candidate.type === "mdxJsxFlowElement" || candidate.type === "mdxJsxTextElement") &&
      candidate.name === "div");
  if (!isDiv) return false;

  const propertyClass = candidate.properties?.className ?? candidate.properties?.class;
  if (classListContains(propertyClass, "scribe-table-scroll")) return true;
  return candidate.attributes?.some(
    (attribute) =>
      attribute.type === "mdxJsxAttribute" &&
      (attribute.name === "className" || attribute.name === "class") &&
      classListContains(attribute.value, "scribe-table-scroll")
  ) === true;
}

function classListContains(value: unknown, expected: string): boolean {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\s+/u) : [];
  return values.includes(expected);
}

function isTableNode(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const candidate = node as { type?: string; tagName?: string; name?: string | null };
  return (
    (candidate.type === "element" && candidate.tagName === "table") ||
    ((candidate.type === "mdxJsxFlowElement" || candidate.type === "mdxJsxTextElement") &&
      candidate.name === "table")
  );
}

function collectCodeTargets(tree: Root): CodeTarget[] {
  const targets: CodeTarget[] = [];
  visit(tree, "element", (node, index, parent) => {
    if (
      node.tagName !== "pre" ||
      index === undefined ||
      !parent ||
      node.children.length !== 1
    ) {
      return;
    }
    const code = node.children[0];
    if (code?.type !== "element" || code.tagName !== "code") return;
    targets.push({ pre: node, code, parent: parent as unknown as ParentNode, index });
  });
  return targets;
}

async function highlightTarget(
  target: CodeTarget,
  file: VFile,
  options: ScribeMdxOptions
): Promise<void> {
  const rawSource = toString(target.code);
  const source = rawSource.endsWith("\n") ? rawSource.slice(0, -1) : rawSource;
  const declaredLanguage = readLanguage(target.code);
  const metadata = readMetadata(target.code, source, file);
  const supported = isSupportedLanguage(declaredLanguage);

  if (!supported) {
    const reason = options.strict === true
      ? `Unsupported code language "${declaredLanguage}". Strict mode requires a Shiki bundled language or an unlabelled plaintext fence.`
      : `Unsupported code language "${declaredLanguage}"; falling back to plaintext. Use a Shiki bundled language or remove the language tag.`;
    const message = file.message(
      reason,
      {
        place: target.code.position,
        source: "scribe",
        ruleId: "SCB1003"
      }
    );
    message.fatal = options.strict === true;
    if (message.fatal) throw message;
  }

  const highlighted = await codeToHast(source, {
    lang: (supported ? declaredLanguage : "text") as BundledLanguage,
    themes: {
      light: "github-light",
      dark: "github-dark"
    },
    defaultColor: false,
    transformers: [lineStateTransformer(metadata)]
  });
  const generatedPre = highlighted.children.find(
    (node): node is Element => node.type === "element" && node.tagName === "pre"
  );
  if (!generatedPre) throw new Error("Shiki did not return a pre element.");

  generatedPre.position = target.pre.position;
  generatedPre.properties.dataScribeLanguage = declaredLanguage;
  if (!supported) generatedPre.properties.dataScribeFallback = "plaintext";
  if (metadata.filename) generatedPre.properties.dataScribeFilename = metadata.filename;
  if (metadata.lineNumbers) generatedPre.properties.dataScribeLineNumbers = "";

  const generatedCode = generatedPre.children.find(
    (node): node is Element => node.type === "element" && node.tagName === "code"
  );
  if (generatedCode) generatedCode.position = target.code.position;
  target.parent.children[target.index] = generatedPre;
}

function readMetadata(code: Element, source: string, file: VFile): ScribeCodeMetadata {
  const meta = typeof code.data?.meta === "string" ? code.data.meta : undefined;
  const parsed = parseCodeMetadata(meta, Math.max(1, source.split("\n").length));
  const firstIssue = parsed.issues[0];
  if (firstIssue) {
    const message = file.message(firstIssue.message, {
      place: code.position,
      source: "scribe",
      ruleId: firstIssue.code
    });
    message.fatal = true;
    throw message;
  }
  return parsed.value;
}

function readLanguage(code: Element): string {
  const classes = Array.isArray(code.properties.className) ? code.properties.className : [];
  const languageClass = classes.find(
    (value): value is string => typeof value === "string" && value.startsWith("language-")
  );
  return languageClass?.slice("language-".length).toLowerCase() || "text";
}

function isSupportedLanguage(language: string): boolean {
  return (
    specialLanguages.has(language) ||
    Object.hasOwn(bundledLanguages, language) ||
    Object.hasOwn(bundledLanguagesAlias, language)
  );
}

function lineStateTransformer(metadata: ScribeCodeMetadata) {
  return {
    name: "scribe:line-state",
    line(node: Element, line: number) {
      if (containsLine(metadata.highlight, line)) addClass(node, "highlighted");
      if (containsLine(metadata.focus, line)) addClass(node, "focused");
      if (containsLine(metadata.add, line)) addClass(node, "added");
      if (containsLine(metadata.remove, line)) addClass(node, "removed");
    }
  };
}

function containsLine(ranges: readonly LineRange[], line: number): boolean {
  return ranges.some(({ start, end }) => line >= start && line <= end);
}

function addClass(node: Element, className: string): void {
  const current = node.properties.className ?? node.properties.class;
  const classes = Array.isArray(current)
    ? current
    : typeof current === "string"
      ? current.split(/\s+/u).filter(Boolean)
      : [];
  delete node.properties.class;
  node.properties.className = [...classes, className];
}
