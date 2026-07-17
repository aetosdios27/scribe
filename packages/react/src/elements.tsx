import {
  createElement,
  type AnchorHTMLAttributes,
  type BlockquoteHTMLAttributes,
  type HTMLAttributes,
  type LiHTMLAttributes,
  type OlHTMLAttributes
} from "react";

function heading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const tag = `h${level}` as const;
  return function ScribeHeading({ id, children, className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
    return createElement(tag, { ...props, id, className }, children, id === undefined ? null : (
      <a className="scribe-heading-anchor" href={`#${id}`} aria-label={`Link to ${plainText(children)}`}>
        <span aria-hidden="true">#</span>
      </a>
    ));
  };
}

function plainText(value: unknown): string {
  return typeof value === "string" ? value : "this section";
}

export const H1 = heading(1);
export const H2 = heading(2);
export const H3 = heading(3);
export const H4 = heading(4);
export const H5 = heading(5);
export const H6 = heading(6);

export function Paragraph(props: HTMLAttributes<HTMLParagraphElement>) { return <p {...props} />; }
export function Anchor(props: AnchorHTMLAttributes<HTMLAnchorElement>) { return <a {...props} />; }
export function UnorderedList(props: HTMLAttributes<HTMLUListElement>) { return <ul {...props} />; }
export function OrderedList(props: OlHTMLAttributes<HTMLOListElement>) { return <ol {...props} />; }
export function ListItem(props: LiHTMLAttributes<HTMLLIElement>) { return <li {...props} />; }
export function Blockquote(props: BlockquoteHTMLAttributes<HTMLQuoteElement>) { return <blockquote {...props} />; }
export function Code(props: HTMLAttributes<HTMLElement>) { return <code {...props} />; }
export function Table(props: HTMLAttributes<HTMLTableElement>) { return <table {...props} />; }
export function TableHead(props: HTMLAttributes<HTMLTableSectionElement>) { return <thead {...props} />; }
export function TableBody(props: HTMLAttributes<HTMLTableSectionElement>) { return <tbody {...props} />; }
export function TableRow(props: HTMLAttributes<HTMLTableRowElement>) { return <tr {...props} />; }
export function TableHeader(props: HTMLAttributes<HTMLTableCellElement>) { return <th {...props} />; }
export function TableCell(props: HTMLAttributes<HTMLTableCellElement>) { return <td {...props} />; }
export function HorizontalRule(props: HTMLAttributes<HTMLHRElement>) { return <hr {...props} />; }
