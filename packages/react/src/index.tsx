import { Banner, Callout, CodeFrame, Figure, Publication, ScribeImage } from "./components.js";
import {
  Anchor,
  Blockquote,
  Code,
  H1,
  H2,
  H3,
  H4,
  H5,
  H6,
  HorizontalRule,
  ListItem,
  OrderedList,
  Paragraph,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  UnorderedList
} from "./elements.js";

export { Banner, Callout, CodeFrame, Figure, Publication, ScribeImage } from "./components.js";
export type {
  BannerProps,
  CalloutProps,
  CalloutVariant,
  CodeFrameProps,
  FigureProps,
  PublicationProps
} from "./components.js";

/** A framework-neutral MDX component map accepted by MDX 3 renderers. */
export type ScribeComponents = Record<string, any>;

const defaults: ScribeComponents = {
  wrapper: Publication,
  h1: H1,
  h2: H2,
  h3: H3,
  h4: H4,
  h5: H5,
  h6: H6,
  p: Paragraph,
  a: Anchor,
  ul: UnorderedList,
  ol: OrderedList,
  li: ListItem,
  blockquote: Blockquote,
  code: Code,
  pre: CodeFrame,
  table: Table,
  thead: TableHead,
  tbody: TableBody,
  tr: TableRow,
  th: TableHeader,
  td: TableCell,
  img: ScribeImage,
  hr: HorizontalRule,
  Banner,
  Callout,
  Figure
};

export interface CreateScribeComponentsOptions {
  readonly components?: Readonly<Record<string, unknown>>;
}

export function createScribeComponents(
  options: CreateScribeComponentsOptions | Readonly<Record<string, unknown>> = {}
): ScribeComponents {
  const components = (
    "components" in options ? options.components ?? {} : options
  );
  return { ...defaults, ...components } as ScribeComponents;
}
