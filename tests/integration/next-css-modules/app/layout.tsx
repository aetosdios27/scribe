import type { ReactNode } from "react";

import "@scribe-sdk/styles/foundation.css";
import styles from "./article.module.css";

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en"><body className={styles.hostShell}>{children}</body></html>;
}
