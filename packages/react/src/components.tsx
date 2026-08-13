import {
  Children,
  isValidElement,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode
} from "react";

import { CopyButton } from "./copy-button.js";
import { MermaidDiagram } from "./mermaid-diagram.js";
import { WrapToggleButton } from "./wrap-toggle-button.js";

function classes(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export interface PublicationProps extends HTMLAttributes<HTMLElement> {
  readonly children?: ReactNode;
  readonly components?: unknown;
}

export function Publication({ children, className, components: _components, ...props }: PublicationProps) {
  return (
    <article {...props} className={classes("scribe", className)}>
      {children}
    </article>
  );
}

interface BannerBaseProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly eyebrow?: ReactNode;
  readonly metadata?: ReactNode;
  readonly accent?: string;
  readonly imagePosition?: CSSProperties["objectPosition"];
}

interface BannerWithImage extends BannerBaseProps {
  readonly image: string;
  readonly imageAlt: string;
}

interface BannerWithoutImage extends BannerBaseProps {
  readonly image?: undefined;
  readonly imageAlt?: never;
}

export type BannerProps = BannerWithImage | BannerWithoutImage;

export function Banner({
  title,
  description,
  eyebrow,
  metadata,
  accent,
  image,
  imageAlt,
  imagePosition,
  className,
  style,
  children,
  ...props
}: BannerProps) {
  const bannerStyle = accent === undefined
    ? style
    : ({ ...style, "--scribe-banner-accent": accent } as CSSProperties);

  return (
    <header {...props} className={classes("scribe-banner", className)} style={bannerStyle}>
      <div className="scribe-banner__body">
        {eyebrow === undefined ? null : <p className="scribe-banner__eyebrow">{eyebrow}</p>}
        <h1 className="scribe-banner__title">{title}</h1>
        {description === undefined ? null : <p className="scribe-banner__description">{description}</p>}
        {metadata === undefined ? null : <div className="scribe-banner__metadata">{metadata}</div>}
        {children}
      </div>
      {image === undefined ? null : (
        <div className="scribe-banner__media">
          <img src={image} alt={imageAlt} style={{ objectPosition: imagePosition }} />
        </div>
      )}
    </header>
  );
}

export type CalloutVariant = "note" | "insight" | "warning" | "success" | "error";

export interface CalloutProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  readonly variant?: CalloutVariant;
  readonly title?: ReactNode;
}

const calloutVariants = new Set<CalloutVariant>(["note", "insight", "warning", "success", "error"]);

export function Callout({ variant = "note", title, className, children, ...props }: CalloutProps) {
  if (!calloutVariants.has(variant)) {
    throw new Error(`Unsupported Scribe callout variant \`${String(variant)}\`.`);
  }

  return (
    <aside {...props} className={classes("scribe-callout", className)} role="note" data-variant={variant}>
      <span className="scribe-callout__marker" aria-hidden="true" />
      <div className="scribe-callout__body">
        {title === undefined ? null : <p className="scribe-callout__title">{title}</p>}
        <div className="scribe-callout__content">{children}</div>
      </div>
    </aside>
  );
}

export interface FigureProps extends HTMLAttributes<HTMLElement> {
  readonly caption?: ReactNode;
  readonly wide?: boolean;
}

export function Figure({ caption, wide = false, className, children, ...props }: FigureProps) {
  return (
    <figure {...props} className={classes("scribe-figure", wide && "scribe-wide", className)}>
      {children}
      {caption === undefined ? null : <figcaption>{caption}</figcaption>}
    </figure>
  );
}

export interface CodeFrameProps extends HTMLAttributes<HTMLPreElement> {
  readonly "data-scribe-filename"?: string;
  readonly "data-scribe-language"?: string;
  readonly "data-scribe-line-numbers"?: string;
  readonly "data-scribe-wrap"?: string;
  readonly "data-scribe-mermaid"?: string;
}

export function CodeFrame({ children, className, ...props }: CodeFrameProps) {
  const filename = props["data-scribe-filename"];
  const language = props["data-scribe-language"];
  const source = textContent(children);
  const copyTarget = filename ?? language ?? "code block";
  const defaultWrapped = props["data-scribe-wrap"] !== undefined;

  if (props["data-scribe-mermaid"] !== undefined) {
    return (
      <div className="scribe-code-frame scribe-code-frame--mermaid">
        {filename === undefined ? null : (
          <div className="scribe-code-frame__header">
            <div className="scribe-code-frame__identity">
              <span className="scribe-code-frame__filename" title={filename}>{filename}</span>
            </div>
          </div>
        )}
        <MermaidDiagram source={source} />
      </div>
    );
  }

  return (
    <div className="scribe-code-frame">
      <div className="scribe-code-frame__header">
        <div className="scribe-code-frame__identity">
          {filename === undefined ? null : <span className="scribe-code-frame__filename" title={filename}>{filename}</span>}
          {language === undefined ? null : <span className="scribe-code-frame__language">{language}</span>}
        </div>
        <WrapToggleButton label={`Toggle wrap for ${copyTarget}`} defaultWrapped={defaultWrapped} />
        <CopyButton label={`Copy ${copyTarget} code`} source={source} />
      </div>
      <pre {...props} className={classes("scribe-code-frame__pre", className)}>{children}</pre>
    </div>
  );
}

function textContent(node: ReactNode): string {
  let text = "";
  Children.forEach(node, (child) => {
    if (typeof child === "string" || typeof child === "number" || typeof child === "bigint") {
      text += String(child);
    } else if (isValidElement<{ children?: ReactNode }>(child)) {
      text += textContent(child.props.children);
    }
  });
  return text;
}

export { ScribeImage, type ScribeImageProps } from "./zoomable-image.js";

export interface VideoProps extends HTMLAttributes<HTMLElement> {
  readonly src: string;
  readonly poster?: string;
  readonly caption?: ReactNode;
  readonly wide?: boolean;
}

function videoMimeType(src: string): string {
  return src.endsWith(".webm") ? "video/webm" : "video/mp4";
}

export function Video({ src, poster, caption, wide = false, className, ...props }: VideoProps) {
  return (
    <Figure caption={caption} wide={wide} className={className}>
      <video {...props} controls poster={poster} playsInline>
        <source src={src} type={videoMimeType(src)} />
        <p>Your browser does not support embedded video. <a href={src}>Download the video</a> instead.</p>
      </video>
    </Figure>
  );
}
