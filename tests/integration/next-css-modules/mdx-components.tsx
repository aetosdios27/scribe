import { createScribeComponents, Publication, type PublicationProps, type ScribeComponents } from "@scribe-sdk/react";

import styles from "./app/article.module.css";

function HostPublication(props: PublicationProps) {
  return <Publication {...props} className={styles.articleBoundary} />;
}

export function useMDXComponents(components: ScribeComponents): ScribeComponents {
  return createScribeComponents({ components: { ...components, wrapper: HostPublication } });
}
