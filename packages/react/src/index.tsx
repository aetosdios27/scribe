import type { MDXComponents } from "mdx/types";
import type { HTMLAttributes, ReactNode } from "react";

export interface PublicationProps extends HTMLAttributes<HTMLElement> {
  readonly children?: ReactNode;
}

export function Publication({ children, className, ...props }: PublicationProps) {
  const classes = className ? `scribe ${className}` : "scribe";
  return (
    <article {...props} className={classes}>
      {children}
    </article>
  );
}

export function createScribeComponents(
  components: MDXComponents = {}
): MDXComponents {
  return {
    wrapper: Publication,
    ...components
  };
}
