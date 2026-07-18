import { createProcessor } from "@mdx-js/mdx";
import { compileScribeMdx, createScribeMdxOptions } from "@scribe-sdk/mdx";

export interface ProtectedIsland {
  readonly id: string;
  readonly kind: ProtectedIslandKind;
  readonly label: string;
  readonly start: number;
  readonly end: number;
  readonly raw: string;
}

export interface RichProjection {
  readonly canonicalMarkdown: string;
  readonly projectionMarkdown: string;
  readonly islands: readonly ProtectedIsland[];
}

export type RichCandidateResult =
  | { readonly ok: true; readonly markdown: string }
  | {
      readonly ok: false;
      readonly markdown: string;
      readonly code: RichRejectionCode;
      readonly message: string;
      readonly islandId?: string;
    };

type ProtectedIslandKind =
  | "frontmatter"
  | "mdxjsEsm"
  | "mdxFlowExpression"
  | "mdxTextExpression"
  | "mdxJsxFlowElement"
  | "mdxJsxTextElement"
  | "html"
  | "directive"
  | "codeMetadata"
  | "unsupported";

type RichRejectionCode =
  | "SCB_RICH_PLACEHOLDER_MISSING"
  | "SCB_RICH_PLACEHOLDER_DUPLICATED"
  | "SCB_RICH_PLACEHOLDER_UNKNOWN"
  | "SCB_RICH_PLACEHOLDER_REORDERED"
  | "SCB_RICH_PROTECTED_CHANGED"
  | "SCB_RICH_PARSE_FAILED"
  | "SCB_RICH_COMPILE_FAILED";

interface MdastNode {
  readonly type: string;
  readonly name?: string | null;
  readonly lang?: string | null;
  readonly meta?: string | null;
  readonly value?: string;
  readonly attributes?: readonly MdastAttribute[];
  readonly children?: readonly MdastNode[];
  readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
}

interface MdastAttribute {
  readonly type: string;
  readonly name?: string;
  readonly value?: unknown;
}

interface CandidatePlaceholder {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

const placeholderName = "ScribeStudioProtectedIsland";
const editableNodeTypes = new Set([
  "root",
  "paragraph",
  "heading",
  "text",
  "emphasis",
  "strong",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "definition",
  "list",
  "listItem",
  "blockquote",
  "thematicBreak",
  "break",
  "inlineCode",
  "code",
  "table",
  "tableRow",
  "tableCell"
]);

export async function createRichProjection(markdown: string): Promise<RichProjection> {
  const tree = parseMarkdown(markdown);
  const islands = classifyProtectedIslands(markdown, tree);
  return {
    canonicalMarkdown: markdown,
    projectionMarkdown: replaceProtectedIslands(markdown, islands),
    islands
  };
}

export async function acceptRichCandidate(
  projection: RichProjection,
  candidate: string,
  path = "scribe-rich-candidate.mdx",
  compileCandidate: typeof compileScribeMdx = compileScribeMdx
): Promise<RichCandidateResult> {
  let placeholders: readonly CandidatePlaceholder[];
  try {
    placeholders = findCandidatePlaceholders(parseMarkdown(candidate));
  } catch (error) {
    return reject(projection, "SCB_RICH_PARSE_FAILED", `Rich Text candidate could not be parsed: ${errorMessage(error)}`);
  }

  const expectedIds = projection.islands.map(({ id }) => id);
  const counts = new Map<string, number>();
  for (const placeholder of placeholders) counts.set(placeholder.id, (counts.get(placeholder.id) ?? 0) + 1);

  const unknown = placeholders.find(({ id }) => !expectedIds.includes(id));
  if (unknown) {
    return reject(projection, "SCB_RICH_PLACEHOLDER_UNKNOWN", `Rich Text candidate contains an unknown protected block "${unknown.id}".`, unknown.id);
  }
  const duplicated = expectedIds.find((id) => (counts.get(id) ?? 0) > 1);
  if (duplicated) {
    return reject(projection, "SCB_RICH_PLACEHOLDER_DUPLICATED", `Rich Text candidate duplicated protected block "${duplicated}".`, duplicated);
  }
  const missing = expectedIds.find((id) => (counts.get(id) ?? 0) === 0);
  if (missing) {
    return reject(projection, "SCB_RICH_PLACEHOLDER_MISSING", `Rich Text candidate removed protected block "${missing}".`, missing);
  }
  const actualIds = placeholders.map(({ id }) => id);
  if (actualIds.some((id, index) => id !== expectedIds[index])) {
    const firstMismatch = actualIds.find((id, index) => id !== expectedIds[index]);
    return reject(projection, "SCB_RICH_PLACEHOLDER_REORDERED", "Rich Text candidate changed the order of protected source blocks.", firstMismatch);
  }

  const rehydrated = rehydrateCandidate(candidate, placeholders, projection.islands);
  let rehydratedIslands: readonly ProtectedIsland[];
  try {
    rehydratedIslands = classifyProtectedIslands(rehydrated, parseMarkdown(rehydrated));
  } catch (error) {
    return reject(projection, "SCB_RICH_PARSE_FAILED", `Rehydrated Markdown could not be parsed: ${errorMessage(error)}`);
  }
  const changedIndex = projection.islands.findIndex((island, index) => rehydratedIslands[index]?.raw !== island.raw);
  if (changedIndex >= 0 || rehydratedIslands.length !== projection.islands.length) {
    const island = projection.islands[Math.max(0, changedIndex)];
    return reject(
      projection,
      "SCB_RICH_PROTECTED_CHANGED",
      island === undefined
        ? "Rich Text candidate changed the protected source structure."
        : `Rich Text candidate would alter protected ${island.label}.`,
      island?.id
    );
  }

  try {
    await compileCandidate({ path, value: rehydrated });
  } catch (error) {
    return reject(projection, "SCB_RICH_COMPILE_FAILED", `Rich Text candidate failed Scribe compilation: ${errorMessage(error)}`);
  }
  return { ok: true, markdown: rehydrated };
}

function parseMarkdown(markdown: string): MdastNode {
  const processor = createProcessor({ remarkPlugins: createScribeMdxOptions().remarkPlugins });
  return processor.parse(markdown) as MdastNode;
}

function classifyProtectedIslands(markdown: string, tree: MdastNode): readonly ProtectedIsland[] {
  let islandIndex = 0;
  return (tree.children ?? []).flatMap((node) => {
    const kind = protectedKind(node, markdown);
    if (kind === undefined) return [];
    const range = nodeRange(node);
    const index = 1 + islandIndex++;
    return [{
      id: `scribe-protected-${String(index).padStart(4, "0")}`,
      kind,
      label: islandLabel(kind, node),
      ...range,
      raw: markdown.slice(range.start, range.end)
    }];
  });
}

function protectedKind(node: MdastNode, markdown: string): ProtectedIslandKind | undefined {
  if (node.type === "yaml" || node.type === "toml") return "frontmatter";
  if (node.type === "code" && (node.lang != null || node.meta != null)) return "codeMetadata";
  const raw = rawNode(markdown, node).trimStart();
  if (isDirectiveNode(node) || raw.startsWith(":::")) return "directive";
  const unsafe = findUnsafeDescendant(node);
  return unsafe === undefined ? undefined : kindForNode(unsafe);
}

function findUnsafeDescendant(node: MdastNode): MdastNode | undefined {
  if (!editableNodeTypes.has(node.type)) return node;
  for (const child of node.children ?? []) {
    const unsafe = findUnsafeDescendant(child);
    if (unsafe) return unsafe;
  }
  return undefined;
}

function kindForNode(node: MdastNode): ProtectedIslandKind {
  if (node.type === "html") return "html";
  if (node.type === "yaml" || node.type === "toml") return "frontmatter";
  if (node.type === "mdxjsEsm") return "mdxjsEsm";
  if (node.type === "mdxFlowExpression") return "mdxFlowExpression";
  if (node.type === "mdxTextExpression") return "mdxTextExpression";
  if (node.type === "mdxJsxFlowElement") return "mdxJsxFlowElement";
  if (node.type === "mdxJsxTextElement") return "mdxJsxTextElement";
  if (isDirectiveNode(node)) return "directive";
  return "unsupported";
}

function isDirectiveNode(node: MdastNode): boolean {
  return node.type === "containerDirective" || node.type === "leafDirective" || node.type === "textDirective";
}

function replaceProtectedIslands(markdown: string, islands: readonly ProtectedIsland[]): string {
  let result = "";
  let cursor = 0;
  for (const island of islands) {
    result += markdown.slice(cursor, island.start);
    result += `<${placeholderName} data-scribe-id=${JSON.stringify(island.id)} data-scribe-kind=${JSON.stringify(island.kind)} />`;
    cursor = island.end;
  }
  return result + markdown.slice(cursor);
}

function findCandidatePlaceholders(tree: MdastNode): readonly CandidatePlaceholder[] {
  return (tree.children ?? []).flatMap((node) => {
    if (node.type !== "mdxJsxFlowElement" || node.name !== placeholderName) return [];
    const id = node.attributes?.find((attribute) => attribute.type === "mdxJsxAttribute" && attribute.name === "data-scribe-id")?.value;
    if (typeof id !== "string") throw new Error("Protected block placeholder is missing its data-scribe-id attribute.");
    return [{ id, ...nodeRange(node) }];
  });
}

function rehydrateCandidate(
  candidate: string,
  placeholders: readonly CandidatePlaceholder[],
  islands: readonly ProtectedIsland[]
): string {
  const byId = new Map(islands.map((island) => [island.id, island]));
  let result = "";
  let cursor = 0;
  for (const placeholder of placeholders) {
    result += candidate.slice(cursor, placeholder.start);
    result += byId.get(placeholder.id)!.raw;
    cursor = placeholder.end;
  }
  return result + candidate.slice(cursor);
}

function nodeRange(node: MdastNode): { readonly start: number; readonly end: number } {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) throw new Error(`Scribe cannot protect ${node.type} without source offsets.`);
  return { start, end };
}

function rawNode(markdown: string, node: MdastNode): string {
  const { start, end } = nodeRange(node);
  return markdown.slice(start, end);
}

function islandLabel(kind: ProtectedIslandKind, node: MdastNode): string {
  if (kind === "frontmatter") return "frontmatter";
  if (kind === "codeMetadata") return "code-fence metadata";
  if (kind === "directive") return "directive";
  if (kind === "mdxjsEsm") return "MDX import/export";
  if (kind === "mdxFlowExpression" || kind === "mdxTextExpression") return "MDX expression";
  if (kind === "mdxJsxFlowElement" || kind === "mdxJsxTextElement") {
    return node.name == null ? "MDX JSX" : `<${node.name}>`;
  }
  return kind === "html" ? "HTML" : "unsupported Markdown";
}

function reject(
  projection: RichProjection,
  code: RichRejectionCode,
  message: string,
  islandId?: string
): RichCandidateResult {
  return {
    ok: false,
    markdown: projection.canonicalMarkdown,
    code,
    message,
    ...(islandId === undefined ? {} : { islandId })
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
