"use client";

import { useRef, type ImgHTMLAttributes } from "react";

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export interface ScribeImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  readonly zoom?: boolean;
}

export function ScribeImage({ className, alt, src, zoom = true, ...props }: ScribeImageProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const rawSrc = typeof src === "string" ? src : "";
  const noZoomFragment = rawSrc.endsWith("#nozoom");
  const resolvedSrc = noZoomFragment ? rawSrc.slice(0, -"#nozoom".length) : rawSrc;
  const zoomable = zoom && !noZoomFragment;
  const resolvedAlt = alt ?? "";

  if (!zoomable) {
    return <img {...props} src={resolvedSrc} alt={resolvedAlt} className={classes("scribe-image", className)} />;
  }

  return (
    <>
      <button
        type="button"
        className="scribe-image-zoom-trigger"
        aria-label={resolvedAlt ? `Open larger view of ${resolvedAlt}` : "Open larger view of image"}
        onClick={() => dialogRef.current?.showModal()}
      >
        <img {...props} src={resolvedSrc} alt={resolvedAlt} className={classes("scribe-image", className)} />
      </button>
      <dialog ref={dialogRef} className="scribe-image-dialog" onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current?.close();
      }}>
        <button
          type="button"
          className="scribe-image-dialog__close"
          aria-label="Close image"
          onClick={() => dialogRef.current?.close()}
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18">
            <path d="m4.5 4.5 11 11m0-11-11 11" />
          </svg>
        </button>
        <img src={resolvedSrc} alt={resolvedAlt} className="scribe-image-dialog__image" />
        {resolvedAlt === "" ? null : <p className="scribe-image-dialog__caption">{resolvedAlt}</p>}
      </dialog>
    </>
  );
}
