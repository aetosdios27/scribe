export interface StudioClientImports {
  readonly react: string;
  readonly reactDom: string;
  readonly reactDomRoot: string;
  readonly reactJsxRuntime: string;
  readonly reactJsxDevRuntime: string;
  readonly baseButton: string;
  readonly baseToggle: string;
  readonly baseToggleGroup: string;
  readonly baseTooltip: string;
  readonly cva: string;
  readonly clsx: string;
  readonly lenis: string;
  readonly lucide: string;
  readonly sonner: string;
  readonly tailwindMerge: string;
  readonly mdxEditor: string;
  readonly mdxEditorStyle: string;
}

export function studioClientModule(_paths: StudioClientImports): string {
  return String.raw`import * as React from "react";
import { createRoot } from "react-dom/client";
import { Button as BaseButton } from "@base-ui/react/button";
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import { Tooltip } from "@base-ui/react/tooltip";
import { cva } from "class-variance-authority";
import { clsx } from "clsx";
import Lenis from "lenis";
import {
  AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bold, Check, ChevronDown, Circle,
  ClipboardCopy, Code2, Copy, Edit3, ExternalLink, FileCode2, FileText,
  Image, Link, List, ListOrdered, LoaderCircle, LockKeyhole, Maximize2,
  Italic, Monitor, Moon, MoreHorizontal, Plus, Redo2, RotateCcw, Save,
  Settings, Smartphone, Sun, Table2, Tablet, TerminalSquare, Trash2,
  TriangleAlert, Undo2, X
} from "lucide-react";
import { Toaster, toast } from "sonner";
import { twMerge } from "tailwind-merge";
import {
  MDXEditor, BlockTypeSelect, BoldItalicUnderlineToggles, CodeToggle,
  CreateLink, InsertCodeBlock, InsertImage, InsertTable, ListsToggle,
  Separator as EditorSeparator, UndoRedo, codeBlockPlugin, codeMirrorPlugin,
  headingsPlugin, imagePlugin, jsxPlugin, linkDialogPlugin, linkPlugin,
  listsPlugin, quotePlugin, tablePlugin, thematicBreakPlugin, toolbarPlugin
} from "@mdxeditor/editor";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-serif/400.css";
import "@fontsource/ibm-plex-serif/400-italic.css";
import "@fontsource/ibm-plex-serif/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@mdxeditor/editor/style.css";
import "/@scribe-studio/styles.css";

const { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } = React;

function cn(...values) { return twMerge(clsx(values)); }

const buttonVariants = cva("ui-button", {
  variants: {
    variant: { default: "ui-button--default", ghost: "ui-button--ghost", outline: "ui-button--outline" },
    size: { default: "ui-button--default-size", sm: "ui-button--sm", icon: "ui-button--icon" }
  },
  defaultVariants: { variant: "outline", size: "default" }
});

function Button({ className, variant, size, ...props }) {
  return <BaseButton className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

function Hint({ label, children }) {
  return <Tooltip.Root>
    <Tooltip.Trigger render={children} />
    <Tooltip.Portal><Tooltip.Positioner sideOffset={8}><Tooltip.Popup className="ui-tooltip">{label}</Tooltip.Popup></Tooltip.Positioner></Tooltip.Portal>
  </Tooltip.Root>;
}

function IconToggle({ label, value, current, icon: Icon }) {
  return <Hint label={label}><Toggle value={value} aria-label={label} className="ui-toggle" data-active={current === value || undefined}><Icon aria-hidden="true" /></Toggle></Hint>;
}

function IconToggleGroup({ label, value, options, onChange }) {
  const selected = Math.max(0, options.findIndex((option) => option.value === value));
  return <ToggleGroup aria-label={label} className="ui-toggle-group" value={[value]} onValueChange={(next) => { if (next[0]) onChange(next[0]); }} style={{ "--toggle-index": selected, "--toggle-count": options.length }}>
    {options.map((option) => <IconToggle key={option.value} {...option} current={value} />)}
  </ToggleGroup>;
}

function formatDiagnostics(items) {
  return items.map((item) => {
    const position = item.line ? item.line + ":" + (item.column || 1) + " " : "";
    return position + "[" + item.severity + " " + item.code + "] " + item.message;
  }).join("\n");
}

async function request(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  return { response, body };
}

function Status({ state, richError }) {
  const hasErrors = richError || state.diagnostics.some((item) => item.severity === "error");
  const kind = state.conflict ? "conflict" : hasErrors ? "error" : state.dirty ? "dirty" : "ready";
  const label = state.conflict ? "External change" : richError ? "Rich edit rejected" : hasErrors ? "Compilation blocked" : state.dirty ? "Unsaved draft" : "Ready";
  return <div className="studio-status" data-status={kind} role="status"><span className="studio-status__dot" aria-hidden="true" /><span id="status-text">{label}</span></div>;
}

function PanelHeading({ icon: Icon, title, state, tabs }) {
  return <div className="panel-heading">
    <div><Icon aria-hidden="true" /><span>{title}</span></div>
    {tabs || <span className="panel-state">{state}</span>}
  </div>;
}

function MarkdownPanel({ state, source, setSource, textareaRef }) {
  const diagnostics = formatDiagnostics(state.diagnostics);
  return <section className="studio-panel source-panel" aria-label="Markdown editor">
    <PanelHeading icon={FileText} title="Markdown" state={state.conflict ? "Conflict" : state.dirty ? "Unsaved" : "Saved"} />
    <textarea ref={textareaRef} id="source" className="source-textarea" value={source} onChange={(event) => setSource(event.target.value)} spellCheck="false" aria-label="Article source" data-lenis-prevent />
    {diagnostics && <pre id="diagnostics" className="diagnostics" aria-live="polite">{diagnostics}</pre>}
  </section>;
}

const previewPresets = {
  desktop: { label: "Laptop", width: 1280, height: 800 },
  tablet: { label: "Tablet", width: 820, height: 1180 },
  mobile: { label: "Mobile", width: 414, height: 896 }
};

function PreviewPanel({ theme, viewport, previewVersion, compact = false }) {
  const src = "/preview?theme=" + theme + "&version=" + previewVersion;
  const preset = previewPresets[viewport];
  const stageRef = useRef(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => {
      const available = Math.max(1, stage.clientWidth - 36);
      setScale(Math.min(1, available / preset.width));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [preset.width]);

  const percentage = Math.round(scale * 100);
  const dimensions = {
    "--preview-width": preset.width + "px",
    "--preview-height": preset.height + "px",
    "--preview-scale": scale,
    "--preview-scaled-width": preset.width * scale + "px",
    "--preview-scaled-height": preset.height * scale + "px"
  };
  return <section className={cn("studio-panel preview-panel", compact && "preview-panel--compact")} aria-label="Production preview">
    {!compact && <PanelHeading icon={Maximize2} title="Preview" state="Production renderer" />}
    <div ref={stageRef} className="preview-stage" data-viewport={viewport}>
      <div className="preview-device" style={dimensions}>
        <span className="preview-device__label">{preset.label} · {preset.width} × {preset.height} · {percentage}%</span>
        <div className="preview-device__frame"><iframe id="preview" title="Scribe article preview" src={src} /></div>
      </div>
    </div>
  </section>;
}

const RichContext = createContext({ islands: [], editInMarkdown: () => {} });

function attributeValue(node, name) {
  const attribute = node.attributes && node.attributes.find((item) => item.type === "mdxJsxAttribute" && item.name === name);
  return typeof attribute?.value === "string" ? attribute.value : "";
}

function LockedIsland({ mdastNode }) {
  const { islands, editInMarkdown } = useContext(RichContext);
  const id = attributeValue(mdastNode, "data-scribe-id");
  const island = islands.find((item) => item.id === id);
  return <aside className="protected-island" contentEditable={false} data-protected-id={id}>
    <span className="protected-island__icon" aria-hidden="true"><LockKeyhole /></span>
    <span className="protected-island__copy"><strong>Protected source</strong><span>{island?.label || "Unsupported MDX"} remains byte-identical.</span></span>
    <Button type="button" size="sm" variant="ghost" aria-label="Edit protected source in Markdown" onMouseDown={(event) => event.preventDefault()} onClick={() => editInMarkdown(id)}><Edit3 data-icon="inline-start" aria-hidden="true" />Edit in Markdown</Button>
  </aside>;
}

const editorIconMap = {
  undo: Undo2, redo: Redo2, format_bold: Bold, format_italic: Italic,
  code: Code2, format_list_bulleted: List, format_list_numbered: ListOrdered,
  link: Link, add_photo: Image, table: Table2, arrow_drop_down: ChevronDown,
  open_in_new: ExternalLink, edit: Edit3, content_copy: Copy, more_horiz: MoreHorizontal,
  more_vert: MoreHorizontal, close: X, settings: Settings, delete_big: Trash2,
  delete_small: Trash2, add_row: Plus, add_column: Plus, insert_col_left: ArrowLeft,
  insert_row_above: ArrowUp, insert_row_below: ArrowDown, insert_col_right: ArrowRight,
  format_align_left: AlignLeft, format_align_center: AlignCenter, format_align_right: AlignRight,
  check: Check
};

function editorIcon(name) {
  const Icon = editorIconMap[name] || Circle;
  return <Icon aria-hidden="true" />;
}

function RichToolbar() {
  return <div className="rich-toolbar-contents" role="toolbar" aria-label="Rich Text formatting">
    <UndoRedo />
    <EditorSeparator />
    <BlockTypeSelect />
    <BoldItalicUnderlineToggles options={["Bold", "Italic"]} />
    <CodeToggle />
    <CreateLink />
    <ListsToggle options={["bullet", "number"]} />
    <EditorSeparator />
    <InsertCodeBlock />
    <InsertTable />
    <InsertImage />
  </div>;
}

function RichEditor({ session, state, onAccepted, onRejected, onEditInMarkdown, onPendingChange, registerFlush }) {
  const editorRef = useRef(null);
  const revisionRef = useRef(session.revision);
  const lastAcceptedRef = useRef(session.projectionMarkdown);
  const timerRef = useRef();
  const submittingRef = useRef(false);
  const pendingRef = useRef(false);

  const plugins = useMemo(() => [
    headingsPlugin({ allowedHeadingLevels: [1, 2, 3, 4] }),
    quotePlugin(), listsPlugin(), linkPlugin(), linkDialogPlugin(), tablePlugin(), thematicBreakPlugin(),
    imagePlugin({ disableImageResize: true, disableImageSettingsButton: true, allowSetImageDimensions: false }),
    codeBlockPlugin({ defaultCodeBlockLanguage: "" }),
    codeMirrorPlugin({ codeBlockLanguages: { "": "Plain text" }, autoLoadLanguageSupport: false }),
    jsxPlugin({ jsxComponentDescriptors: [{
      name: "ScribeStudioProtectedIsland",
      kind: "flow",
      props: [
        { name: "data-scribe-id", type: "string", required: true },
        { name: "data-scribe-kind", type: "string", required: true }
      ],
      hasChildren: false,
      Editor: LockedIsland
    }] }),
    toolbarPlugin({ toolbarClassName: "scribe-rich-toolbar", toolbarContents: RichToolbar })
  ], []);

  const submit = useCallback(async (candidate) => {
    clearTimeout(timerRef.current);
    submittingRef.current = true;
    try {
      const { response, body } = await request("/__scribe/api/rich-draft", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: candidate, revision: revisionRef.current })
      });
      if (response.ok) {
        revisionRef.current = body.revision;
        lastAcceptedRef.current = candidate;
        pendingRef.current = false;
        onAccepted(body, { ...session, revision: body.revision, projectionMarkdown: body.projectionMarkdown, islands: body.islands });
        return true;
      }
      editorRef.current?.setMarkdown(lastAcceptedRef.current);
      pendingRef.current = false;
      onRejected(body.error || "This Rich Text edit could not be represented safely.", body.islandId);
      return false;
    } catch (error) {
      editorRef.current?.setMarkdown(lastAcceptedRef.current);
      pendingRef.current = false;
      onRejected(error instanceof Error ? error.message : "Studio could not validate this Rich Text edit.");
      return false;
    } finally {
      submittingRef.current = false;
      onPendingChange(false);
    }
  }, [onAccepted, onPendingChange, onRejected, session]);

  useEffect(() => {
    registerFlush(async () => pendingRef.current
      ? submit(editorRef.current?.getMarkdown() || lastAcceptedRef.current)
      : true);
    return () => registerFlush(null);
  }, [registerFlush, submit]);

  useEffect(() => {
    if (state.revision === revisionRef.current || submittingRef.current) return;
    request("/__scribe/api/rich-projection").then(({ response, body }) => {
      if (!response.ok) return onRejected(body.error || "Rich Text mode could not reload.");
      revisionRef.current = body.revision;
      lastAcceptedRef.current = body.projectionMarkdown;
      pendingRef.current = false;
      onPendingChange(false);
      editorRef.current?.setMarkdown(body.projectionMarkdown);
      onAccepted(state, { ...body, tab: session.tab }, false);
    });
  }, [state.revision, onAccepted, onPendingChange, onRejected, session.tab]);

  const onChange = useCallback((candidate, initialNormalize) => {
    if (initialNormalize) return;
    pendingRef.current = true;
    onPendingChange(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => submit(candidate), 320);
  }, [onPendingChange, submit]);

  return <RichContext.Provider value={{ islands: session.islands, editInMarkdown: onEditInMarkdown }}>
    <section className="studio-panel rich-panel" aria-label="Rich Text editor">
      <PanelHeading icon={FileCode2} title="Rich Text" state="Writes Markdown" />
      <div className="rich-editor-scroll" data-lenis-prevent>
        <MDXEditor
          ref={editorRef}
          markdown={session.projectionMarkdown}
          onChange={onChange}
          onError={({ error }) => onRejected(error)}
          plugins={plugins}
          iconComponentFor={editorIcon}
          className="scribe-rich-editor dark-theme"
          contentEditableClassName="rich-content"
          spellCheck
          trim={false}
          toMarkdownOptions={{ bullet: "-", emphasis: "_", strong: "*", fence: String.fromCharCode(96), listItemIndent: "one" }}
        />
      </div>
    </section>
  </RichContext.Provider>;
}

function SecondaryPane({ tab, setTab, source, state, theme, viewport }) {
  const tabs = <div className="secondary-tabs" role="tablist" aria-label="Rich Text secondary pane">
    <button type="button" role="tab" aria-label="Markdown tab" aria-selected={tab === "markdown"} data-active={tab === "markdown" || undefined} onClick={() => setTab("markdown")}><FileText aria-hidden="true" />Markdown</button>
    <button type="button" role="tab" aria-label="Preview tab" aria-selected={tab === "preview"} data-active={tab === "preview" || undefined} onClick={() => setTab("preview")}><Maximize2 aria-hidden="true" />Preview</button>
  </div>;
  return <section className="studio-panel secondary-panel" aria-label="Rich Text secondary pane">
    <PanelHeading icon={tab === "markdown" ? FileText : Maximize2} title={tab === "markdown" ? "Markdown mirror" : "Preview"} tabs={tabs} />
    {tab === "markdown"
      ? <pre className="markdown-mirror" data-testid="markdown-mirror" aria-label="Read-only Markdown mirror" data-lenis-prevent>{source}</pre>
      : <PreviewPanel theme={theme} viewport={viewport} previewVersion={state.previewVersion} compact />}
  </section>;
}

function Workspace({ authorMode, state, source, setSource, textareaRef, theme, viewport, richSession, setRichSession, richError, setRichError, setAuthorMode, setRichPending, registerRichFlush, revealProtected }) {
  if (authorMode === "markdown") {
    return <div className="studio-workspace studio-workspace--markdown">
      <MarkdownPanel state={state} source={source} setSource={setSource} textareaRef={textareaRef} />
      <PreviewPanel theme={theme} viewport={viewport} previewVersion={state.previewVersion} />
    </div>;
  }
  return <div className="studio-workspace studio-workspace--rich">
    <RichEditor session={richSession} state={state} registerFlush={registerRichFlush} onPendingChange={setRichPending} onEditInMarkdown={revealProtected} onRejected={(message) => { setRichError(message); toast.error(message); }} onAccepted={(body, nextSession, applyState = true) => {
      setRichError("");
      setRichSession(nextSession);
      if (applyState) setAuthorMode(body);
    }} />
    <SecondaryPane tab={richSession.tab} setTab={(tab) => setRichSession((current) => ({ ...current, tab }))} source={source} state={state} theme={theme} viewport={viewport} />
  </div>;
}

function StudioApp() {
  const [state, setState] = useState(null);
  const [source, setSource] = useState("");
  const [authorMode, setAuthorModeState] = useState("markdown");
  const [richSession, setRichSession] = useState(null);
  const [richError, setRichError] = useState("");
  const [viewport, setViewport] = useState("desktop");
  const [theme, setTheme] = useState("dark");
  const [copyStatus, setCopyStatus] = useState("");
  const [richPending, setRichPending] = useState(false);
  const diskVersion = useRef("");
  const textareaRef = useRef(null);
  const updateTimer = useRef();
  const richFlushRef = useRef(null);
  const pendingSelection = useRef(null);

  const apply = useCallback((next, replaceSource = false) => {
    diskVersion.current = next.diskVersion;
    setState(next);
    if (replaceSource) setSource(next.source);
  }, []);

  const applyRichState = useCallback((body) => apply(body, true), [apply]);

  useEffect(() => {
    request("/__scribe/api/document").then(({ body }) => apply(body, true));
    const interval = setInterval(async () => {
      const { body } = await request("/__scribe/api/document");
      if (body.diskVersion !== diskVersion.current || body.conflict) apply(body, !body.dirty);
    }, 900);
    return () => clearInterval(interval);
  }, [apply]);

  useEffect(() => {
    if (authorMode !== "markdown" || !state || source === state.source) return;
    clearTimeout(updateTimer.current);
    updateTimer.current = setTimeout(async () => {
      const { body } = await request("/__scribe/api/draft", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ source }) });
      apply(body);
    }, 280);
    return () => clearTimeout(updateTimer.current);
  }, [source, state, apply, authorMode]);

  useEffect(() => {
    if (authorMode !== "markdown" || !pendingSelection.current) return;
    const range = pendingSelection.current;
    pendingSelection.current = null;
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(range.start, range.end);
    });
  }, [authorMode]);

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const lenis = new Lenis({ autoRaf: true, smoothWheel: true, gestureOrientation: "vertical", anchors: true });
    return () => lenis.destroy();
  }, []);

  const flushMarkdown = useCallback(async () => {
    clearTimeout(updateTimer.current);
    if (!state || source === state.source) return state;
    const { body } = await request("/__scribe/api/draft", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ source }) });
    apply(body, true);
    return body;
  }, [state, source, apply]);

  const enterRich = useCallback(async () => {
    const current = await flushMarkdown();
    if (!current || current.diagnostics.some((item) => item.severity === "error")) {
      toast.error("Fix Markdown diagnostics before entering Rich Text mode.");
      return;
    }
    const { response, body } = await request("/__scribe/api/rich-projection");
    if (!response.ok) {
      setRichError(body.error || "This document cannot enter Rich Text mode safely.");
      toast.error(body.error || "This document cannot enter Rich Text mode safely.");
      return;
    }
    setRichSession({ ...body, tab: "markdown" });
    setRichError("");
    setAuthorModeState("rich");
  }, [flushMarkdown]);

  const switchAuthorMode = useCallback(async (mode) => {
    if (mode === authorMode) return;
    if (mode === "rich") return enterRich();
    if (richFlushRef.current) await richFlushRef.current();
    setAuthorModeState("markdown");
  }, [authorMode, enterRich]);

  const revealProtected = useCallback(async (id) => {
    if (richFlushRef.current) await richFlushRef.current();
    const island = richSession?.islands.find((item) => item.id === id);
    if (island) pendingSelection.current = { start: island.start, end: island.end };
    setAuthorModeState("markdown");
  }, [richSession]);

  const hasUnwrittenChanges = Boolean(state && (state.dirty || source !== state.source || richPending));

  const save = useCallback(async () => {
    if (!state) return;
    if (authorMode === "rich" && richFlushRef.current) {
      const accepted = await richFlushRef.current();
      if (!accepted) return;
    } else await flushMarkdown();
    const saved = await request("/__scribe/api/save", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedDiskVersion: diskVersion.current }) });
    if (saved.response.ok) {
      apply(saved.body, true);
      toast.success("Saved to " + saved.body.sourcePath);
    } else {
      if (typeof saved.body.source === "string") apply(saved.body, true);
      toast.error(saved.body.error || "Could not save the article");
    }
  }, [state, authorMode, flushMarkdown, apply]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); save(); }
    };
    addEventListener("keydown", onKeyDown);
    return () => removeEventListener("keydown", onKeyDown);
  }, [save]);

  useEffect(() => {
    const onBeforeUnload = (event) => {
      if (!hasUnwrittenChanges) return;
      event.preventDefault();
      event.returnValue = "";
    };
    addEventListener("beforeunload", onBeforeUnload);
    return () => removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnwrittenChanges]);

  if (!state) return <main className="studio-loading"><LoaderCircle aria-hidden="true" /><span>Opening source…</span></main>;

  const lines = source.split("\n").length;
  const words = source.trim() ? source.trim().split(/\s+/).length : 0;
  const copyDiagnostics = async () => {
    const diagnostics = formatDiagnostics(state.diagnostics) || richError;
    if (!diagnostics) return;
    try { await navigator.clipboard.writeText(diagnostics); setCopyStatus("Diagnostics copied"); toast.success("Diagnostics copied"); }
    catch { setCopyStatus("Could not copy diagnostics"); toast.error("Clipboard access is unavailable"); }
  };
  const discard = async () => {
    const { body } = await request("/__scribe/api/discard", { method: "POST" });
    apply(body, true);
    setAuthorModeState("markdown");
    setRichSession(null);
    setRichError("");
    toast("Reloaded the source from disk");
  };

  return <Tooltip.Provider delay={350}><main className="studio-shell">
    <header className="studio-toolbar">
      <div className="studio-brand"><span className="studio-mark" aria-hidden="true"><TerminalSquare /></span><div><strong>Scribe Studio</strong><span>Markdown source · visual helper · production renderer</span></div></div>
      <Status state={state} richError={richError} />
      <div className="studio-actions">
        {(state.diagnostics.length > 0 || richError) && <Hint label="Copy diagnostics"><Button id="copy-diagnostics" type="button" size="icon" variant="ghost" aria-label="Copy diagnostics" onClick={copyDiagnostics}><ClipboardCopy aria-hidden="true" /></Button></Hint>}
        <Button id="save" type="button" variant="default" onClick={save}><Save data-icon="inline-start" aria-hidden="true" />Save <kbd>⌘S</kbd></Button>
      </div>
    </header>

    <div className="studio-controls">
      <IconToggleGroup label="Authoring mode" value={authorMode} onChange={switchAuthorMode} options={[{ value: "markdown", label: "Markdown", icon: FileText }, { value: "rich", label: "Rich Text", icon: FileCode2 }]} />
      <span className="control-divider" aria-hidden="true" />
      <IconToggleGroup label="Preview viewport" value={viewport} onChange={setViewport} options={[{ value: "desktop", label: "Desktop", icon: Monitor }, { value: "tablet", label: "Tablet", icon: Tablet }, { value: "mobile", label: "Mobile", icon: Smartphone }]} />
      <IconToggleGroup label="Preview appearance" value={theme} onChange={setTheme} options={[{ value: "light", label: "Light", icon: Sun }, { value: "dark", label: "Dark", icon: Moon }]} />
      <Hint label={state.modeReason}><span className="mode-badge"><Check aria-hidden="true" />{state.mode} detected</span></Hint>
      <span className="save-contract" data-dirty={hasUnwrittenChanges || undefined}><Save aria-hidden="true" /><span>{hasUnwrittenChanges ? "Draft only — Save writes to" : "Explicit save writes to"}</span><code>{state.sourcePath}</code></span>
      <span className="document-meta">{lines} lines <i /> {words} words</span>
    </div>

    <Workspace authorMode={authorMode} state={state} source={source} setSource={setSource} textareaRef={textareaRef} theme={theme} viewport={viewport} richSession={richSession} setRichSession={setRichSession} richError={richError} setRichError={setRichError} setAuthorMode={applyRichState} setRichPending={setRichPending} registerRichFlush={(flush) => { richFlushRef.current = flush; }} revealProtected={revealProtected} />

    {richError && <div className="rich-error" role="alert"><TriangleAlert aria-hidden="true" /><div><strong>Rich Text edit rejected</strong><span>{richError}</span><small>The Markdown draft was not changed.</small></div><Button type="button" size="sm" onClick={() => switchAuthorMode("markdown")}><FileText data-icon="inline-start" aria-hidden="true" />Edit in Markdown</Button></div>}
    {state.conflict && <div className="conflict-card" role="alert"><TriangleAlert aria-hidden="true" /><div><strong>Source changed outside Studio</strong><span>Your unsaved draft and the disk version are both preserved.</span></div><Button type="button" size="sm" onClick={discard}><RotateCcw data-icon="inline-start" aria-hidden="true" />Reload from disk</Button></div>}
    <span className="sr-only" aria-live="polite">Rich Text edits are serialized to Markdown. {copyStatus}</span>
    <Toaster theme="dark" position="bottom-right" richColors closeButton />
  </main></Tooltip.Provider>;
}

createRoot(document.querySelector("#scribe-studio")).render(<StudioApp />);
`;
}

export function studioStyles(): string {
  return String.raw`:root {
  color-scheme: dark;
  --studio-canvas: #000000;
  --studio-shell: #050505;
  --studio-panel: #0A0A0A;
  --studio-panel-raised: #111111;
  --studio-control: #171717;
  --studio-border: #282828;
  --studio-text: #F2F2ED;
  --studio-muted: #92928B;
  --studio-acid: #CDFF57;
  --studio-acid-strong: #BFFF36;
  --studio-danger: #ff796b;
  --studio-warning: #f5c96a;
  --studio-success: #95d798;
  --studio-radius: 0.625rem;
  --studio-font: "IBM Plex Sans", "Geist Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --studio-mono: "IBM Plex Mono", "Geist Mono", ui-monospace, "SFMono-Regular", Consolas, monospace;
  --accent-9: var(--studio-acid);
  --accent-10: var(--studio-acid-strong);
  --accent-11: var(--studio-acid);
  --accent-12: #efffc9;
  --baseBase: var(--studio-panel);
}
* { box-sizing: border-box; }
html, body, #scribe-studio { min-block-size: 100%; }
html { background: var(--studio-canvas); }
body { margin: 0; overflow: hidden; background: var(--studio-canvas); color: var(--studio-text); font: 13px/1.45 var(--studio-font); }
button, textarea, select, input { font: inherit; }
button { -webkit-tap-highlight-color: transparent; }
svg { inline-size: 1rem; block-size: 1rem; stroke-width: 1.8; }
.sr-only { position: absolute; inline-size: 1px; block-size: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.studio-shell { block-size: 100vh; min-block-size: 34rem; display: grid; grid-template-rows: 4.5rem 3.5rem minmax(0,1fr); background: var(--studio-shell); }
.studio-loading { min-block-size: 100vh; display: grid; place-content: center; justify-items: center; gap: .75rem; color: var(--studio-muted); background: var(--studio-shell); }
.studio-loading svg { animation: studio-spin .9s linear infinite; }
.studio-toolbar { min-inline-size: 0; display: grid; grid-template-columns:minmax(14rem,1fr) auto minmax(14rem,1fr); align-items:center; gap:1rem; padding-inline:1.25rem; border-block-end:1px solid var(--studio-border); background:var(--studio-panel); }
.studio-brand { display:flex; align-items:center; gap:.75rem; min-inline-size:0; }
.studio-brand > div { min-inline-size:0; }
.studio-brand strong, .studio-brand span { display:block; }
.studio-brand strong { font-size:.875rem; letter-spacing:-.015em; }
.studio-brand > div > span { margin-block-start:.1rem; color:var(--studio-muted); font-size:.6875rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.studio-mark { display:grid; place-items:center; flex:none; inline-size:2.25rem; block-size:2.25rem; border-radius:.42rem; color:#0a0a0a; background:var(--studio-acid); box-shadow:0 0 0 1px #e4ff9b2b inset,0 .4rem 1.4rem #cdff5714; }
.studio-mark svg { inline-size:1.15rem; block-size:1.15rem; }
.studio-status { display:inline-flex; align-items:center; gap:.5rem; color:var(--studio-muted); font-size:.75rem; }
.studio-status__dot { inline-size:.42rem; block-size:.42rem; border-radius:999px; background:var(--studio-muted); box-shadow:0 0 .75rem currentColor; }
.studio-status[data-status=ready] .studio-status__dot { color:var(--studio-success); background:currentColor; }
.studio-status[data-status=dirty] .studio-status__dot { color:var(--studio-warning); background:currentColor; }
.studio-status[data-status=error] .studio-status__dot,.studio-status[data-status=conflict] .studio-status__dot { color:var(--studio-danger); background:currentColor; }
.studio-actions { display:flex; justify-content:flex-end; align-items:center; gap:.5rem; }
.ui-button { display:inline-flex; align-items:center; justify-content:center; gap:.5rem; min-block-size:2.25rem; padding-inline:.8rem; border:1px solid transparent; border-radius:.5rem; color:var(--studio-text); background:transparent; font-weight:560; cursor:pointer; transition:color 140ms ease,background 140ms ease,border-color 140ms ease,transform 140ms ease; }
.ui-button:hover { background:var(--studio-control); border-color:var(--studio-border); }
.ui-button:active { transform:translateY(1px); }
.ui-button:focus-visible,.ui-toggle:focus-visible,.secondary-tabs button:focus-visible { outline:2px solid var(--studio-acid); outline-offset:2px; }
.ui-button:disabled { cursor:not-allowed; opacity:.45; }
.ui-button--default { color:#050505; background:var(--studio-acid); border-color:var(--studio-acid); }
.ui-button--default:hover { color:#050505; background:var(--studio-acid-strong); border-color:var(--studio-acid-strong); }
.ui-button--outline { border-color:var(--studio-border); background:var(--studio-control); }
.ui-button--ghost { color:var(--studio-muted); }
.ui-button--ghost:hover { color:var(--studio-text); }
.ui-button--sm { min-block-size:2rem; padding-inline:.65rem; font-size:.75rem; }
.ui-button--icon { inline-size:2.25rem; padding:0; }
.ui-button kbd { margin-inline-start:.2rem; font:600 .62rem/1 var(--studio-mono); opacity:.55; }
.studio-controls { min-inline-size:0; display:flex; align-items:center; gap:.75rem; padding-inline:1.25rem; border-block-end:1px solid var(--studio-border); background:var(--studio-panel-raised); }
.control-divider { inline-size:1px; block-size:1.4rem; background:var(--studio-border); }
.ui-toggle-group { --toggle-size:2.125rem; position:relative; display:grid; grid-template-columns:repeat(var(--toggle-count),var(--toggle-size)); padding:.18rem; border:1px solid var(--studio-border); border-radius:.6rem; background:var(--studio-control); isolation:isolate; }
.ui-toggle-group::before { content:""; position:absolute; z-index:-1; inset-block:.18rem; inset-inline-start:.18rem; inline-size:var(--toggle-size); border-radius:.42rem; background:var(--studio-acid); transform:translateX(calc(var(--toggle-index) * var(--toggle-size))); transition:transform 180ms cubic-bezier(.2,.8,.2,1); box-shadow:0 .3rem 1rem #0004; }
.ui-toggle { display:grid; place-items:center; inline-size:var(--toggle-size); block-size:var(--toggle-size); padding:0; border:0; border-radius:.42rem; color:var(--studio-muted); background:transparent; cursor:pointer; transition:color 140ms ease; }
.ui-toggle[data-active] { color:#050505; }
.mode-badge { display:inline-flex; align-items:center; gap:.36rem; padding:.34rem .55rem; border:1px solid var(--studio-border); border-radius:999px; color:var(--studio-muted); background:#0c0c0c; font:600 .625rem/1 var(--studio-mono); text-transform:uppercase; letter-spacing:.055em; cursor:help; }
.mode-badge svg { inline-size:.7rem; block-size:.7rem; color:var(--studio-acid); stroke-width:2.5; }
.save-contract { min-inline-size:0; display:inline-flex; align-items:center; gap:.38rem; color:var(--studio-muted); font-size:.66rem; white-space:nowrap; }
.save-contract > svg { flex:none; inline-size:.75rem; block-size:.75rem; }
.save-contract code { max-inline-size:16rem; overflow:hidden; color:#c8c8c1; font:500 .64rem/1 var(--studio-mono); text-overflow:ellipsis; }
.save-contract[data-dirty] { color:var(--studio-warning); }
.save-contract[data-dirty] code { color:#ffe7aa; }
.document-meta { margin-inline-start:auto; display:inline-flex; align-items:center; gap:.5rem; color:var(--studio-muted); font:.66rem/1 var(--studio-mono); }
.document-meta i { inline-size:2px; block-size:2px; border-radius:50%; background:currentColor; }
.studio-workspace { min-block-size:0; display:grid; grid-template-columns:minmax(20rem,46%) minmax(24rem,54%); overflow:hidden; background:var(--studio-canvas); }
.studio-panel { position:relative; block-size:100%; min-inline-size:0; min-block-size:0; display:grid; grid-template-rows:2.25rem minmax(0,1fr); overflow:hidden; border-inline-end:1px solid var(--studio-border); background:var(--studio-panel); }
.studio-panel:last-child { border-inline-end:0; }
.panel-heading { display:flex; align-items:center; justify-content:space-between; gap:.75rem; padding-inline:.85rem; border-block-end:1px solid var(--studio-border); color:var(--studio-muted); font:600 .625rem/1 var(--studio-mono); text-transform:uppercase; letter-spacing:.085em; }
.panel-heading > div { display:inline-flex; align-items:center; gap:.45rem; }
.panel-heading svg { inline-size:.78rem; block-size:.78rem; }
.panel-state { color:#6f6f69; font-size:.58rem; }
.source-textarea { inline-size:100%; block-size:100%; min-block-size:0; resize:none; padding:1.25rem 1.4rem 4rem; border:0; outline:0; color:#dddcd6; caret-color:var(--studio-acid); background:var(--studio-panel); font:.84rem/1.72 var(--studio-mono); tab-size:2; }
.source-panel:focus-within { box-shadow:inset 2px 0 var(--studio-acid); }
.diagnostics { position:absolute; z-index:3; inset-inline:.85rem; inset-block-end:.85rem; max-block-size:26%; overflow:auto; margin:0; padding:.7rem .8rem; border:1px solid #59322d; border-radius:.45rem; color:#ffaaa0; background:#1a0e0ddb; box-shadow:0 .8rem 2.4rem #0009; font:.68rem/1.55 var(--studio-mono); white-space:pre-wrap; backdrop-filter:blur(14px); }
.preview-stage { min-inline-size:0; min-block-size:0; display:grid; place-items:start center; overflow:auto; padding:1.1rem; background-color:#111; background-image:linear-gradient(45deg,#151515 25%,transparent 25%),linear-gradient(-45deg,#151515 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#151515 75%),linear-gradient(-45deg,transparent 75%,#151515 75%); background-size:18px 18px; background-position:0 0,0 9px,9px -9px,-9px 0; }
.preview-device { display:grid; gap:.45rem; inline-size:var(--preview-scaled-width); min-inline-size:0; }
.preview-device__label { color:#a7a79f; font:600 .6rem/1 var(--studio-mono); letter-spacing:.055em; text-align:center; text-transform:uppercase; }
.preview-device__frame { position:relative; inline-size:var(--preview-scaled-width); block-size:var(--preview-scaled-height); }
#preview { position:absolute; inset:0 auto auto 0; display:block; inline-size:var(--preview-width); block-size:var(--preview-height); border:1px solid #2e2e2e; border-radius:.42rem; background:#fff; box-shadow:0 1.2rem 4rem #000b; transform:scale(var(--preview-scale)); transform-origin:top left; }
.preview-panel--compact { border:0; }
.preview-panel--compact .preview-stage { block-size:100%; }
.secondary-tabs { display:inline-flex !important; align-items:center; gap:.2rem !important; padding:.15rem; border:1px solid var(--studio-border); border-radius:.4rem; background:var(--studio-control); }
.secondary-tabs button { display:inline-flex; align-items:center; gap:.32rem; min-block-size:1.55rem; padding-inline:.48rem; border:0; border-radius:.28rem; color:var(--studio-muted); background:transparent; font:600 .58rem/1 var(--studio-font); text-transform:none; letter-spacing:0; cursor:pointer; }
.secondary-tabs button[data-active] { color:#050505; background:var(--studio-acid); }
.markdown-mirror { min-block-size:0; overflow:auto; margin:0; padding:1.25rem 1.4rem 4rem; color:#c8c8c1; background:#080808; font:.78rem/1.68 var(--studio-mono); white-space:pre-wrap; overflow-wrap:anywhere; }
.rich-editor-scroll { min-block-size:0; overflow:auto; background:var(--studio-panel); }
.scribe-rich-editor { min-block-size:100%; color:var(--studio-text); background:var(--studio-panel); --basePageBg:var(--studio-panel); --baseBase:var(--studio-panel); --baseBgSubtle:var(--studio-panel-raised); --baseBg:var(--studio-control); --baseBgHover:#202020; --baseLine:var(--studio-border); --baseBorder:var(--studio-border); --baseSolid:#4b4b46; --baseText:var(--studio-muted); --baseTextContrast:var(--studio-text); --accentBase:var(--studio-panel); --accentBgSubtle:#14190d; --accentBg:#1b2410; --accentBgHover:#263416; --accentLine:#5b752d; --accentBorder:#78983c; --accentSolid:var(--studio-acid); --accentText:var(--studio-acid); --accentTextContrast:#efffc9; }
.scribe-rich-editor .mdxeditor { min-block-size:100%; background:transparent; }
.scribe-rich-editor [class*="_toolbarRoot"] { position:sticky; z-index:4; inset-block-start:0; min-block-size:2.7rem; padding:.38rem .55rem; border:0; border-block-end:1px solid var(--studio-border); border-radius:0; background:#0d0d0df2; backdrop-filter:blur(16px); }
.rich-toolbar-contents { display:flex; align-items:center; gap:.12rem; min-inline-size:max-content; }
.scribe-rich-editor [class*="_toolbar"] button,.scribe-rich-editor [class*="_toolbar"] [role=button] { color:var(--studio-muted); border-radius:.35rem; }
.scribe-rich-editor [class*="_toolbar"] button:hover,.scribe-rich-editor [class*="_toolbar"] button[data-state=on] { color:#050505; background:var(--studio-acid); }
.scribe-rich-editor [class*="_contentEditable"] { min-block-size:calc(100vh - 13rem); padding:clamp(1.3rem,3vw,2.5rem) clamp(1.2rem,4vw,3.5rem) 6rem; outline:0; caret-color:var(--studio-acid); }
.rich-content { max-inline-size:74ch; margin-inline:auto; color:var(--studio-text); font:1rem/1.74 "IBM Plex Serif","Source Serif 4",Iowan Old Style,Charter,Georgia,serif; }
.rich-content h1,.rich-content h2,.rich-content h3,.rich-content h4 { margin-block:1.8em .65em; color:var(--studio-text); font-family:var(--studio-font); line-height:1.12; letter-spacing:-.025em; }
.rich-content h1 { margin-block-start:.25em; font-size:2.35rem; }
.rich-content h2 { font-size:1.7rem; }
.rich-content h3 { font-size:1.3rem; }
.rich-content p { margin-block:0 1.1em; }
.rich-content a { color:var(--studio-acid); text-decoration-thickness:.08em; text-underline-offset:.16em; }
.rich-content code { padding:.12em .3em; border:1px solid var(--studio-border); border-radius:.28rem; color:#ddffc0; background:var(--studio-control); font:.86em/1.4 var(--studio-mono); }
.rich-content blockquote { margin:1.5rem 0; padding:.1rem 0 .1rem 1rem; border-inline-start:2px solid var(--studio-acid); color:#c4c4bd; }
.rich-content table { inline-size:100%; margin-block:1.8rem; border:1px solid #3a3a37; border-collapse:separate; border-spacing:0; border-radius:.5rem; overflow:hidden; font-family:var(--studio-font); font-size:.88rem; }
.rich-content table[class*="_tableEditor"]:has(> colgroup > col:nth-child(6)) { min-inline-size:42rem; }
.rich-content table[class*="_tableEditor"] > colgroup > col:first-child,.rich-content table[class*="_tableEditor"] > colgroup > col:last-child { inline-size:2rem; }
.rich-content table[class*="_tableEditor"] > tbody > tr > :is(th,td):not([data-tool-cell]):not([class*="_toolCell"]) { padding:.72rem .85rem; border:0; border-block-end:1px solid #343432; border-inline-end:1px solid #343432; vertical-align:top; }
.rich-content table[class*="_tableEditor"] > tbody > tr:last-child > :is(th,td):not([data-tool-cell]):not([class*="_toolCell"]) { border-block-end:0; }
.rich-content table[class*="_tableEditor"] > :is(thead,tfoot) > tr > th,.rich-content table[class*="_tableEditor"] > tbody > tr > [data-tool-cell],.rich-content table[class*="_tableEditor"] > tbody > tr > [class*="_toolCell"] { padding:0; border:0; color:var(--studio-muted); background:#0d0d0d; }
.rich-content table[class*="_tableEditor"] > thead > tr > :is(:first-child,:last-child),.rich-content table[class*="_tableEditor"] > tfoot > tr > :is(:first-child,:last-child),.rich-content table[class*="_tableEditor"] > tbody > tr > [class*="_toolCell"],.rich-content table[class*="_tableEditor"] > tbody > tr:first-child > [data-tool-cell]:last-child { inline-size:2rem; min-inline-size:2rem; max-inline-size:2rem; }
.rich-content table[class*="_tableEditor"] > tbody > tr > th:not([data-tool-cell]):not([class*="_toolCell"]) { color:var(--studio-text); background:#20201f; font-size:.72rem; text-transform:uppercase; letter-spacing:.055em; }
.rich-content table[class*="_tableEditor"] > tbody > tr > td:not([data-tool-cell]):not([class*="_toolCell"]) { color:#d0d0ca; background:#121212; }
.rich-content img { display:block; max-inline-size:100%; block-size:auto; margin:1.5rem auto; border:1px solid var(--studio-border); border-radius:.45rem; }
.protected-island { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:.8rem; margin-block:1rem; padding:.8rem; border:1px dashed #56632e; border-radius:.52rem; color:var(--studio-muted); background:#10130b; font-family:var(--studio-font); }
.protected-island__icon { display:grid; place-items:center; inline-size:2rem; block-size:2rem; border-radius:.38rem; color:#111; background:var(--studio-acid); }
.protected-island__copy strong,.protected-island__copy span { display:block; }
.protected-island__copy strong { color:var(--studio-text); font-size:.75rem; }
.protected-island__copy span { margin-block-start:.12rem; font: .66rem/1.4 var(--studio-mono); }
.rich-error,.conflict-card { position:fixed; z-index:20; inset-inline-end:1rem; inset-block-end:1rem; display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:.8rem; max-inline-size:38rem; padding:.8rem; border:1px solid #68443b; border-radius:.65rem; color:var(--studio-text); background:#1a1210ee; box-shadow:0 1rem 4rem #000b; backdrop-filter:blur(18px); }
.rich-error > svg,.conflict-card > svg { color:var(--studio-danger); }
.rich-error strong,.rich-error span,.rich-error small,.conflict-card strong,.conflict-card span { display:block; }
.rich-error span,.conflict-card span { margin-block-start:.15rem; color:var(--studio-muted); font-size:.72rem; }
.rich-error small { margin-block-start:.25rem; color:#ffaaa0; font-size:.64rem; }
.ui-tooltip { z-index:50; max-inline-size:18rem; padding:.38rem .55rem; border:1px solid var(--studio-border); border-radius:.4rem; color:var(--studio-text); background:#1a1a1af2; box-shadow:0 .65rem 2rem #0009; font-size:.68rem; transform-origin:var(--transform-origin); }
.ui-tooltip[data-starting-style],.ui-tooltip[data-ending-style] { opacity:0; transform:scale(.96); }
@keyframes studio-spin { to { transform:rotate(360deg); } }
@media (max-width:900px) {
  .studio-shell { min-block-size:44rem; grid-template-rows:auto auto minmax(0,1fr); }
  .studio-toolbar { grid-template-columns:1fr auto; padding:.75rem; }
  .studio-status { grid-column:1/-1; grid-row:2; }
  .studio-brand > div > span,.document-meta,.control-divider,.save-contract span { display:none; }
  .save-contract code { max-inline-size:9rem; }
  .studio-controls { gap:.45rem; padding:.55rem .75rem; overflow-x:auto; }
  .mode-badge { margin-inline-start:auto; }
  .studio-workspace { grid-template-columns:1fr; grid-template-rows:minmax(20rem,1fr) minmax(20rem,1fr); overflow:auto; }
  .studio-panel { min-block-size:20rem; border-inline-end:0; border-block-end:1px solid var(--studio-border); }
  .rich-content h1 { font-size:1.9rem; }
  .protected-island { grid-template-columns:auto 1fr; }
  .protected-island .ui-button { grid-column:1/-1; }
  .rich-error,.conflict-card { grid-template-columns:auto 1fr; }
  .rich-error .ui-button,.conflict-card .ui-button { grid-column:1/-1; }
}
@media (prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto!important; transition-duration:.001ms!important; animation-duration:.001ms!important; animation-iteration-count:1!important; } }
`;
}
