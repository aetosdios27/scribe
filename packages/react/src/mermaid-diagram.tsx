"use client";

import { useEffect, useId, useRef, useState } from "react";

export interface MermaidDiagramProps {
  readonly source: string;
}

export function MermaidDiagram({ source }: MermaidDiagramProps) {
  const [svg, setSvg] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const id = `scribe-mermaid-${useId().replace(/[^a-zA-Z0-9]/gu, "")}`;

  useEffect(() => {
    let cancelled = false;

    import("mermaid")
      .then(async (mod) => {
        const mermaid = mod.default ?? mod;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
        const { svg: rendered } = await mermaid.render(id, source);
        if (!cancelled) setSvg(rendered);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [id, source]);

  if (failed) {
    return (
      <pre className="scribe-mermaid-fallback">
        <code>{source}</code>
      </pre>
    );
  }

  if (svg === undefined) {
    return (
      <div className="scribe-mermaid-loading" role="status" aria-live="polite">
        <pre className="scribe-mermaid-fallback">
          <code>{source}</code>
        </pre>
      </div>
    );
  }

  return <div ref={containerRef} className="scribe-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}
