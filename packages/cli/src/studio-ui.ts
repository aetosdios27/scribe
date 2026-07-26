export interface StudioClientImports {
  readonly react: string;
  readonly reactDom: string;
  readonly reactDomRoot: string;
  readonly reactJsxRuntime: string;
  readonly reactJsxDevRuntime: string;
  readonly kumo: string;
  readonly kumoStyle: string;
  readonly lenis: string;
  readonly lucide: string;
  readonly sonner: string;
  readonly mdxEditor: string;
  readonly mdxEditorStyle: string;
  readonly monaco: string;
  readonly monacoMarkdown: string;
  readonly monacoWorker: string;
}

export function studioClientModule(_paths: StudioClientImports): string {
  return String.raw`import * as React from "react";
import { createRoot } from "react-dom/client";
	import { Button, Select, Tooltip, TooltipProvider } from "@cloudflare/kumo";
import Lenis from "lenis";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import {
  AlignCenter, AlignLeft, AlignRight, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bold, Check, ChevronDown, Circle,
  Code2, Copy, Edit3, ExternalLink, FileCode2, FileText,
  Image, Link, List, ListOrdered, LoaderCircle, LockKeyhole, Maximize2,
  Italic, Moon, MoreHorizontal, Plus, Redo2, RotateCcw, Save,
  Settings, Sun, Table2, Trash2,
  TriangleAlert, Undo2, X
} from "lucide-react";
import { Toaster, toast } from "sonner";
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
	import "@cloudflare/kumo/styles/standalone";
	import "@mdxeditor/editor/style.css";
import "/@scribe-studio/styles.css";

const { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } = React;

globalThis.MonacoEnvironment = {
  getWorker() {
    return new EditorWorker();
  }
};

monaco.editor.defineTheme("scribe-studio", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "D4D4D8" },
    { token: "keyword", foreground: "60A5FA", fontStyle: "bold" },
    { token: "keyword.md", foreground: "60A5FA", fontStyle: "bold" },
    { token: "keyword.table.header", foreground: "A5B4FC", fontStyle: "bold" },
    { token: "comment", foreground: "8B8B94", fontStyle: "italic" },
    { token: "comment.content", foreground: "8B8B94", fontStyle: "italic" },
    { token: "string", foreground: "A8B2C1" },
    { token: "string.link", foreground: "60A5FA" },
    { token: "string.target", foreground: "93C5FD" },
    { token: "variable", foreground: "E4E4E7" },
    { token: "variable.source", foreground: "D4D4D8" },
    { token: "strong", foreground: "F4F4F5", fontStyle: "bold" },
    { token: "emphasis", foreground: "D4D4D8", fontStyle: "italic" },
    { token: "tag", foreground: "7DD3FC" },
    { token: "attribute.name.html", foreground: "A5B4FC" },
    { token: "string.html", foreground: "A8B2C1" }
  ],
  colors: {
    "editor.background": "#111113",
    "editor.foreground": "#D4D4D8",
    "editorCursor.foreground": "#2563EB",
    "editor.selectionBackground": "#2563EB52",
    "editor.inactiveSelectionBackground": "#2563EB29",
    "editor.selectionHighlightBackground": "#2563EB1F",
    "editor.lineHighlightBackground": "#FFFFFF06",
    "editor.lineHighlightBorder": "#00000000",
    "editorLineNumber.foreground": "#62626B",
    "editorLineNumber.activeForeground": "#2563EB",
    "editorGutter.background": "#111113",
    "editorIndentGuide.background1": "#28282B",
    "editorIndentGuide.activeBackground1": "#3F3F46",
    "editorWhitespace.foreground": "#3F3F46",
    "editor.findMatchBackground": "#2563EB66",
    "editor.findMatchHighlightBackground": "#2563EB2B",
    "editorWidget.background": "#1C1C1F",
    "editorWidget.border": "#29292D",
    "scrollbar.shadow": "#00000000",
    "scrollbarSlider.background": "#52525B66",
    "scrollbarSlider.hoverBackground": "#71717A80",
    "scrollbarSlider.activeBackground": "#2563EB80",
    "focusBorder": "#2563EB"
  }
});

	function Hint({ label, children }) {
	  return <Tooltip content={label} delay={350} render={children} />;
}

const viewportOptions = [
  { value: "fit", label: "Fit pane" },
  { value: "desktop", label: "Desktop" },
  { value: "tablet", label: "Tablet" },
  { value: "mobile", label: "Mobile" }
];

	function ViewportSelect({ value, onChange }) {
	  return <Select
	    aria-label="Preview viewport"
	    className="viewport-select"
	    size="sm"
	    value={value}
	    renderValue={(selected) => viewportOptions.find((option) => option.value === selected)?.label ?? selected}
	    onValueChange={(next) => { if (typeof next === "string") onChange(next); }}
	  >
	    {viewportOptions.map((option) => <Select.Option key={option.value} value={option.value}>{option.label}</Select.Option>)}
	  </Select>;
	}

function formatDiagnostics(items) {
  return items.map((item) => {
    const position = item.line ? item.line + ":" + (item.column || 1) + " " : "";
    return position + "[" + item.severity + " " + item.code + "] " + item.message;
  }).join("\n");
}

const studioSessionToken = document.querySelector('meta[name="scribe-studio-session"]')?.content || "";
const studioClientId = crypto.randomUUID();
let studioRevision = 0;
let studioOperation = 0;
let studioMutationTail = Promise.resolve();

async function performRequest(path, options = {}) {
  try {
    const response = await fetch(path, options);
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { error: "Studio received an invalid response from its local server." };
    }
    if (Number.isSafeInteger(body.revision)) studioRevision = Math.max(studioRevision, body.revision);
    return { response, body };
  } catch {
    return {
      response: new Response(null, { status: 503, statusText: "Studio server unavailable" }),
      body: { error: "Studio could not reach its local server. Your browser recovery draft remains intact." }
    };
  }
}

function request(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  if (method !== "PUT" && method !== "POST") return performRequest(path, options);
  if (path === "/__scribe/api/lease") {
    return performRequest(path, {
      ...options,
      headers: {
        ...options.headers,
        "content-type": "application/json",
        "x-scribe-studio-session": studioSessionToken
      },
      body: JSON.stringify({ clientId: studioClientId })
    });
  }

  const execute = async () => {
    const supplied = options.body ? JSON.parse(options.body) : {};
    const body = JSON.stringify({
      ...supplied,
      clientId: studioClientId,
      operationId: studioClientId + "-" + (++studioOperation),
      baseRevision: studioRevision
    });
    return performRequest(path, {
      ...options,
      headers: {
        ...options.headers,
        "content-type": "application/json",
        "x-scribe-studio-session": studioSessionToken
      },
      body
    });
  };
  const result = studioMutationTail.then(execute, execute);
  studioMutationTail = result.then(() => undefined, () => undefined);
  return result;
}

const recoveryDatabaseName = "scribe-studio-recovery";
const recoveryStoreName = "drafts";
let recoveryDatabasePromise;

async function recoveryDatabase() {
  recoveryDatabasePromise ??= new Promise((resolve, reject) => {
    const opening = indexedDB.open(recoveryDatabaseName, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(recoveryStoreName);
    opening.onsuccess = () => {
      opening.result.onversionchange = () => {
        opening.result.close();
        recoveryDatabasePromise = undefined;
      };
      resolve(opening.result);
    };
    opening.onerror = () => {
      recoveryDatabasePromise = undefined;
      reject(opening.error);
    };
  });
  return recoveryDatabasePromise;
}

async function readBrowserRecovery(key) {
  const database = await recoveryDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(recoveryStoreName, "readonly");
    const request = transaction.objectStore(recoveryStoreName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function writeBrowserRecovery(key, value) {
  const database = await recoveryDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(recoveryStoreName, "readwrite");
    transaction.objectStore(recoveryStoreName).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function clearBrowserRecovery(key) {
  const database = await recoveryDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(recoveryStoreName, "readwrite");
    transaction.objectStore(recoveryStoreName).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function PanelHeading({ icon: Icon, title, state, tabs }) {
  return <div className="panel-heading">
    <div><Icon aria-hidden="true" /><span>{title}</span></div>
    {tabs || <span className="panel-state">{state}</span>}
  </div>;
}

function frontmatterEditorDecorations(model) {
  if (model.getLineCount() < 2 || model.getLineContent(1).trim() !== "---") return [];
  let closingLine = 0;
  for (let line = 2; line <= model.getLineCount(); line += 1) {
    if (model.getLineContent(line).trim() === "---") {
      closingLine = line;
      break;
    }
  }
  if (!closingLine) return [];
  const decorations = [1, closingLine].map((line) => ({
    range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
    options: { inlineClassName: "source-frontmatter-delimiter" }
  }));
  for (let line = 2; line < closingLine; line += 1) {
    const content = model.getLineContent(line);
    const match = /^(\s*)([A-Za-z_][\w-]*)(\s*:)(.*)$/.exec(content);
    if (!match) continue;
    const keyStart = match[1].length + 1;
    const keyEnd = keyStart + match[2].length;
    const delimiterEnd = keyEnd + match[3].length;
    decorations.push({
      range: new monaco.Range(line, keyStart, line, keyEnd),
      options: { inlineClassName: "source-frontmatter-key" }
    });
    decorations.push({
      range: new monaco.Range(line, keyEnd, line, delimiterEnd),
      options: { inlineClassName: "source-frontmatter-punctuation" }
    });
    if (match[4]) {
      decorations.push({
        range: new monaco.Range(line, delimiterEnd, line, model.getLineMaxColumn(line)),
        options: { inlineClassName: "source-frontmatter-value" }
      });
    }
  }
  return decorations;
}

function MonacoMarkdownEditor({ value, onChange, onSustainedEdit, editorRef, readOnly }) {
  const hostRef = useRef(null);
  const modelRef = useRef(null);
  const monacoRef = useRef(null);
  const changeRef = useRef(onChange);
  const revealRef = useRef(onSustainedEdit);
  const revealTimer = useRef();
  const applyingExternalValue = useRef(false);

  useEffect(() => {
    changeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    revealRef.current = onSustainedEdit;
  }, [onSustainedEdit]);

  useEffect(() => {
    if (!hostRef.current) return;
    const uri = monaco.Uri.parse("inmemory://scribe/" + studioClientId + "/article.mdx");
    const model = monaco.editor.createModel(value, "markdown", uri);
    const editor = monaco.editor.create(hostRef.current, {
      model,
      theme: "scribe-studio",
      ariaLabel: readOnly ? "Article source (read-only in this tab)" : "Article source",
      readOnly,
      domReadOnly: readOnly,
      automaticLayout: true,
      fontFamily: '"IBM Plex Mono", "Geist Mono", ui-monospace, "SFMono-Regular", Consolas, monospace',
      fontSize: 14,
      lineHeight: 24,
      letterSpacing: 0.1,
      fontWeight: "400",
      fontLigatures: false,
      lineNumbers: "on",
      lineNumbersMinChars: 3,
      lineDecorationsWidth: 22,
      glyphMargin: true,
      folding: false,
      minimap: { enabled: false },
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      renderLineHighlight: "all",
      renderLineHighlightOnlyWhenFocus: true,
      renderWhitespace: "selection",
      roundedSelection: false,
      cursorBlinking: "smooth",
      cursorSmoothCaretAnimation: "on",
      cursorWidth: 2,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      wordWrap: "on",
      wrappingIndent: "same",
      wrappingStrategy: "advanced",
      tabSize: 2,
      insertSpaces: true,
      stickyScroll: { enabled: false },
      guides: { indentation: false, bracketPairs: false },
      bracketPairColorization: { enabled: false },
      unicodeHighlight: {
        nonBasicASCII: false,
        ambiguousCharacters: false,
        invisibleCharacters: true
      },
      padding: { top: 20, bottom: 72 },
      scrollbar: {
        verticalScrollbarSize: 9,
        horizontalScrollbarSize: 9,
        useShadows: false
      }
    });
    const frontmatterDecorations = editor.createDecorationsCollection(frontmatterEditorDecorations(model));
    const subscription = model.onDidChangeContent(() => {
      frontmatterDecorations.set(frontmatterEditorDecorations(model));
      if (!applyingExternalValue.current) {
        changeRef.current(model.getValue());
        clearTimeout(revealTimer.current);
        revealTimer.current = setTimeout(() => {
          revealRef.current?.(editor.getPosition()?.lineNumber ?? 1);
        }, 520);
      }
    });
    modelRef.current = model;
    monacoRef.current = editor;
    editorRef.current = {
      focus() {
        editor.focus();
      },
      setSelectionRange(start, end) {
        const startPosition = model.getPositionAt(start);
        const endPosition = model.getPositionAt(end);
        const range = new monaco.Range(
          startPosition.lineNumber,
          startPosition.column,
          endPosition.lineNumber,
          endPosition.column
        );
        editor.setSelection(range);
        editor.revealRangeInCenterIfOutsideViewport(range);
      }
    };
    return () => {
      clearTimeout(revealTimer.current);
      subscription.dispose();
      frontmatterDecorations.clear();
      editorRef.current = null;
      monacoRef.current = null;
      modelRef.current = null;
      editor.dispose();
      model.dispose();
    };
  }, []);

  useEffect(() => {
    const editor = monacoRef.current;
    if (!editor) return;
    editor.updateOptions({
      ariaLabel: readOnly ? "Article source (read-only in this tab)" : "Article source",
      readOnly,
      domReadOnly: readOnly
    });
  }, [readOnly]);

  useEffect(() => {
    const model = modelRef.current;
    if (!model || model.getValue() === value) return;
    applyingExternalValue.current = true;
    model.setValue(value);
    applyingExternalValue.current = false;
  }, [value]);

  return <div ref={hostRef} className="source-monaco" data-lenis-prevent />;
}

	function MarkdownPanel({ state, source, setSource, revealSourceLine, editorRef, writer }) {
	  const diagnostics = formatDiagnostics(state.diagnostics);
	  return <section className="studio-panel source-panel" aria-label="Markdown editor">
	    <div className="source-editor">
	      <div className="source-code">
	        <MonacoMarkdownEditor value={source} onChange={setSource} onSustainedEdit={revealSourceLine} editorRef={editorRef} readOnly={writer === false} />
	      </div>
	    </div>
    {diagnostics && <pre id="diagnostics" className="diagnostics" aria-live="polite">{diagnostics}</pre>}
  </section>;
}

	const previewPresets = {
	  fit: { label: "Fit pane", width: null },
	  desktop: { label: "Desktop", width: 1280 },
	  tablet: { label: "Tablet", width: 820 },
	  mobile: { label: "Mobile", width: 414 }
	};

	function PreviewPanel({ theme, viewport, previewVersion, revealRequest, compact = false }) {
	  const iframeRef = useRef(null);
	  const preset = previewPresets[viewport];
	  const dimensions = { "--preview-width": preset.width === null ? "100%" : preset.width + "px" };
	  const syncTheme = useCallback(() => {
	    iframeRef.current?.contentWindow?.postMessage({ type: "scribe:theme", theme }, location.origin);
	  }, [theme]);
	  useEffect(syncTheme, [syncTheme]);
	  useEffect(() => {
	    if (!revealRequest) return;
	    iframeRef.current?.contentWindow?.postMessage({
	      type: "scribe:reveal-source",
	      line: revealRequest.line
	    }, location.origin);
	  }, [previewVersion, revealRequest]);
	  return <section className={"studio-panel preview-panel" + (compact ? " preview-panel--compact" : "")} aria-label="Production preview">
	    <div className="preview-stage" data-viewport={viewport}>
	      <div className="preview-device" style={dimensions} data-preview-version={previewVersion}>
	        <iframe ref={iframeRef} id="preview" title="Scribe article preview" src="/preview" onLoad={syncTheme} />
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

function RichEditor({ session, state, onAccepted, onRejected, onEditInMarkdown, onPendingChange, onRecoveryCandidate, registerFlush }) {
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
        body: JSON.stringify({
          source: candidate,
          baseSource: session.baseSource,
          baseDiskVersion: session.baseDiskVersion
        })
      });
      if (response.ok) {
        revisionRef.current = body.revision;
        lastAcceptedRef.current = candidate;
        pendingRef.current = false;
        onAccepted(body, {
          ...session,
          revision: body.revision,
          projectionMarkdown: body.projectionMarkdown,
          islands: body.islands,
          baseSource: body.source
        });
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
    onRecoveryCandidate(candidate, session);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => submit(candidate), 320);
  }, [onPendingChange, onRecoveryCandidate, session, submit]);

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

function Workspace({ state, source, setSource, revealSourceLine, revealRequest, editorRef, theme, viewport, writer }) {
  const workspaceRef = useRef(null);
  const dragging = useRef(false);
  const dragOffset = useRef(0);
  const [split, setSplit] = useState(50);

  const fitSelectedViewport = useCallback(() => {
    if (viewport === "fit") {
      setSplit(50);
      return;
    }
    const bounds = workspaceRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width < 1) return;
    const minimumPane = Math.min(42, 320 / bounds.width * 100);
    const target = (bounds.width - previewPresets[viewport].width - 1) / bounds.width * 100;
    setSplit(Math.min(100 - minimumPane, Math.max(minimumPane, target)));
  }, [viewport]);

  useEffect(() => {
    fitSelectedViewport();
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const observer = new ResizeObserver(fitSelectedViewport);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [fitSelectedViewport]);

  const updateSplit = useCallback((clientX) => {
    const bounds = workspaceRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width < 1) return;
    const minimum = Math.min(42, 320 / bounds.width * 100);
    setSplit(Math.min(100 - minimum, Math.max(minimum, (clientX - bounds.left) / bounds.width * 100)));
  }, []);

  const finishDrag = useCallback((event) => {
    if (!dragging.current) return;
    dragging.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    document.body.classList.remove("is-resizing-studio");
  }, []);

  return <div ref={workspaceRef} className="studio-workspace studio-workspace--markdown" style={{ "--studio-split": split + "%" }}>
    <MarkdownPanel state={state} source={source} setSource={setSource} revealSourceLine={revealSourceLine} editorRef={editorRef} writer={writer} />
    <div
      className="studio-splitter"
      role="separator"
      aria-label="Resize editor and preview"
      aria-orientation="vertical"
      aria-valuemin="25"
      aria-valuemax="75"
      aria-valuenow={Math.round(split)}
      tabIndex="0"
      onPointerDown={(event) => {
        dragging.current = true;
        const divider = event.currentTarget.getBoundingClientRect();
        dragOffset.current = event.clientX - (divider.left + divider.width / 2);
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.classList.add("is-resizing-studio");
      }}
	      onPointerMove={(event) => { if (dragging.current) updateSplit(event.clientX - dragOffset.current); }}
	      onPointerUp={finishDrag}
	      onPointerCancel={finishDrag}
	      onDoubleClick={() => setSplit(50)}
	      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        setSplit((current) => Math.min(75, Math.max(25, current + (event.key === "ArrowLeft" ? -2 : 2))));
      }}
    />
    <PreviewPanel theme={theme} viewport={viewport} previewVersion={state.previewVersion} revealRequest={revealRequest} />
  </div>;
}

function StudioApp() {
  const [state, setState] = useState(null);
  const [source, setSource] = useState("");
  const [authorMode, setAuthorModeState] = useState("markdown");
  const [richSession, setRichSession] = useState(null);
  const [richError, setRichError] = useState("");
  const [viewport, setViewport] = useState("fit");
  const [theme, setTheme] = useState("dark");
  const [savePhase, setSavePhase] = useState("idle");
  const [richPending, setRichPending] = useState(false);
  const [writer, setWriter] = useState(null);
  const [connected, setConnected] = useState(true);
  const [previewReveal, setPreviewReveal] = useState(null);
  const previewRevealSequence = useRef(0);
  const diskVersion = useRef("");
  const draftBaseDiskVersion = useRef("");
  const sourceEditorRef = useRef(null);
  const updateTimer = useRef();
  const richFlushRef = useRef(null);
  const pendingSelection = useRef(null);
  const sourceRef = useRef("");
  const serverSourceRef = useRef("");
  const browserRecoveryReady = useRef(false);
  const browserRecoveryConflict = useRef(false);
  const browserRecoveryWarningShown = useRef(false);
  const richPendingRef = useRef(false);

  const apply = useCallback((next, replaceSource = false) => {
    if (Number.isSafeInteger(next.revision) && next.revision < studioRevision) return false;
    diskVersion.current = next.diskVersion;
    if (!draftBaseDiskVersion.current || !next.dirty) draftBaseDiskVersion.current = next.diskVersion;
    serverSourceRef.current = next.source;
    setState(next);
    if (replaceSource) {
      sourceRef.current = next.source;
      setSource(next.source);
    }
    return true;
  }, []);

  const updateSource = useCallback((next) => {
    sourceRef.current = next;
    setSource(next);
    setSavePhase("idle");
  }, []);

  const revealSourceLine = useCallback((line) => {
    previewRevealSequence.current += 1;
    setPreviewReveal({ line, sequence: previewRevealSequence.current });
  }, []);

  const applyRichState = useCallback((body) => apply(body, true), [apply]);

  useEffect(() => {
    let active = true;
    let events;
    const openDocument = async () => {
      const { response, body } = await request("/__scribe/api/document");
      if (!response.ok || typeof body.source !== "string") {
        if (active) {
          setConnected(false);
          toast.error(body.error || "Studio could not load the local document.");
        }
        return false;
      }
      apply(body, true);
      try {
        const recovered = await readBrowserRecovery(body.recoveryKey);
        if (
          recovered?.kind === "rich"
          && typeof recovered.candidate === "string"
          && typeof recovered.baseSource === "string"
          && typeof recovered.diskVersion === "string"
        ) {
          draftBaseDiskVersion.current = recovered.diskVersion;
          const restored = await request("/__scribe/api/rich-draft", {
            method: "PUT",
            body: JSON.stringify({
              source: recovered.candidate,
              baseSource: recovered.baseSource,
              baseDiskVersion: recovered.diskVersion
            })
          });
          if (restored.response.ok && typeof restored.body.source === "string") {
            apply(restored.body, true);
            await clearBrowserRecovery(body.recoveryKey);
            toast.warning("Recovered Rich Text typing that had not reached the Studio server.");
          } else {
            toast.error(restored.body.error || "Studio preserved a Rich Text recovery candidate but could not restore it safely.");
          }
        } else
        if (
          recovered
          && typeof recovered.source === "string"
          && recovered.source !== body.source
        ) {
          draftBaseDiskVersion.current = recovered.diskVersion;
          sourceRef.current = recovered.source;
          setSource(recovered.source);
          browserRecoveryConflict.current = recovered.diskVersion !== body.diskVersion;
          toast.warning(recovered.diskVersion === body.diskVersion
            ? "Recovered typing that had not reached the Studio server."
            : "Recovered local typing, but the source also changed on disk. Saving is blocked until you reconcile.");
        }
      } catch {
        if (!browserRecoveryWarningShown.current) {
          browserRecoveryWarningShown.current = true;
          toast.warning("Instant browser crash recovery is unavailable. Drafts are still protected after they reach the local Studio server.");
        }
      } finally {
        browserRecoveryReady.current = true;
      }
      if (body.recovered) {
        toast.warning(body.recoveryConflict
          ? "Recovered an unsaved draft, but the source also changed on disk. Reconcile before saving."
          : "Recovered your unsaved Studio draft.");
      }
      return true;
    };
    const refresh = async () => {
      const { response, body } = await request("/__scribe/api/document");
      if (!response.ok || typeof body.source !== "string") {
        if (active) setConnected(false);
        return;
      }
      if (richPendingRef.current) return;
      if (body.diskVersion !== diskVersion.current) {
        const localPending = sourceRef.current !== serverSourceRef.current;
        if (localPending) {
          const preserved = await request("/__scribe/api/draft", {
            method: "PUT",
            body: JSON.stringify({
              source: sourceRef.current,
              externalConflict: true,
              baseDiskVersion: draftBaseDiskVersion.current
            })
          });
          if (typeof preserved.body.source === "string") apply(preserved.body, false);
          return;
        }
        apply(body, !body.dirty);
      } else if (body.conflict) {
        apply(body, !body.dirty);
      }
    };
    void openDocument().then((opened) => {
      if (!active || !opened) return;
      events = new EventSource("/__scribe/api/events");
      events.onopen = () => setConnected(true);
      events.onerror = () => setConnected(false);
      events.onmessage = () => void refresh();
    });
    return () => {
      active = false;
      events?.close();
    };
  }, [apply]);

  useEffect(() => {
    if (!state?.recoveryKey || !browserRecoveryReady.current) return;
    if (!state.dirty && source === state.source) {
      void clearBrowserRecovery(state.recoveryKey).catch(() => undefined);
      return;
    }
    void writeBrowserRecovery(state.recoveryKey, {
      kind: "markdown",
      source,
      diskVersion: draftBaseDiskVersion.current || diskVersion.current,
      writtenAt: new Date().toISOString()
    }).catch(() => {
      if (!browserRecoveryWarningShown.current) {
        browserRecoveryWarningShown.current = true;
        toast.warning("Instant browser crash recovery is unavailable. Drafts are still protected after they reach the local Studio server.");
      }
    });
  }, [source, state?.dirty, state?.source, state?.recoveryKey]);

  useEffect(() => {
    let active = true;
    const renew = async () => {
      try {
        const { response } = await request("/__scribe/api/lease", { method: "POST", body: "{}" });
        if (active) setWriter(response.ok);
      } catch {
        if (active) setWriter(false);
      }
    };
    void renew();
    const interval = setInterval(renew, 3_000);
    const release = () => {
      void fetch("/__scribe/api/lease/release", {
        method: "POST",
        keepalive: true,
        headers: {
          "content-type": "application/json",
          "x-scribe-studio-session": studioSessionToken
        },
        body: JSON.stringify({ clientId: studioClientId })
      });
    };
    addEventListener("pagehide", release);
    return () => {
      active = false;
      clearInterval(interval);
      removeEventListener("pagehide", release);
      release();
    };
  }, []);

  useEffect(() => {
    if (authorMode !== "markdown" || !state || source === state.source) return;
    clearTimeout(updateTimer.current);
    updateTimer.current = setTimeout(async () => {
      const { response, body } = await request("/__scribe/api/draft", {
        method: "PUT",
        body: JSON.stringify({
          source,
          externalConflict: browserRecoveryConflict.current,
          baseDiskVersion: draftBaseDiskVersion.current
        })
      });
      if (response.ok) browserRecoveryConflict.current = false;
      if (typeof body.source === "string") apply(body);
      if (!response.ok) toast.error(body.error || "Studio could not preserve this draft.");
    }, 280);
    return () => clearTimeout(updateTimer.current);
  }, [source, state, apply, authorMode]);

  useEffect(() => {
    if (authorMode !== "markdown" || !pendingSelection.current) return;
    const range = pendingSelection.current;
    pendingSelection.current = null;
    requestAnimationFrame(() => {
      sourceEditorRef.current?.focus();
      sourceEditorRef.current?.setSelectionRange(range.start, range.end);
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
    const { response, body } = await request("/__scribe/api/draft", {
      method: "PUT",
      body: JSON.stringify({
        source,
        externalConflict: browserRecoveryConflict.current,
        baseDiskVersion: draftBaseDiskVersion.current
      })
    });
    if (response.ok) browserRecoveryConflict.current = false;
    if (!response.ok || typeof body.source !== "string") {
      toast.error(body.error || "Studio could not preserve this draft.");
      return state;
    }
    apply(body, true);
    return body;
  }, [state, source, apply]);

  const enterRich = useCallback(async () => {
    if (writer === false) {
      toast.error("Another Studio tab currently owns this draft.");
      return;
    }
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
    setRichSession({
      ...body,
      tab: "markdown",
      baseSource: current.source,
      baseDiskVersion: draftBaseDiskVersion.current || current.diskVersion
    });
    setRichError("");
    setAuthorModeState("rich");
  }, [flushMarkdown, writer]);

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

  const setRichPendingState = useCallback((pending) => {
    richPendingRef.current = pending;
    setRichPending(pending);
  }, []);

  const preserveRichCandidate = useCallback((candidate, session) => {
    if (!state?.recoveryKey) return;
    void writeBrowserRecovery(state.recoveryKey, {
      kind: "rich",
      candidate,
      baseSource: session.baseSource,
      diskVersion: session.baseDiskVersion,
      writtenAt: new Date().toISOString()
    }).catch(() => {
      if (!browserRecoveryWarningShown.current) {
        browserRecoveryWarningShown.current = true;
        toast.warning("Instant browser crash recovery is unavailable. Drafts are still protected after they reach the local Studio server.");
      }
    });
  }, [state?.recoveryKey]);

  const save = useCallback(async () => {
    if (!state || writer === false) {
      toast.error("This tab is read-only while another Studio tab owns the draft.");
      return;
    }
    setSavePhase("saving");
    if (authorMode === "rich" && richFlushRef.current) {
      const accepted = await richFlushRef.current();
      if (!accepted) {
        setSavePhase("error");
        return;
      }
    } else await flushMarkdown();
    const saved = await request("/__scribe/api/save", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedDiskVersion: diskVersion.current }) });
    if (saved.response.ok) {
      apply(saved.body, true);
      setSavePhase("idle");
      void clearBrowserRecovery(saved.body.recoveryKey).catch(() => undefined);
      toast.success("Saved to " + saved.body.sourcePath);
    } else {
      if (typeof saved.body.source === "string") apply(saved.body, true);
      setSavePhase("error");
      toast.error(saved.body.error || "Could not save the article");
    }
  }, [state, authorMode, flushMarkdown, apply, writer]);

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
  const saveStatus = writer === false
    ? "readonly"
    : state.conflict
      ? "conflict"
    : savePhase === "saving"
      ? "saving"
      : savePhase === "error"
        ? "error"
        : hasUnwrittenChanges
          ? "save"
          : "saved";
  const saveLabel = { conflict: "Resolve conflict", readonly: "Read-only", saving: "Saving…", error: "Error", save: "Save", saved: "Saved" }[saveStatus];
  const SaveIcon = saveStatus === "saving"
    ? LoaderCircle
    : saveStatus === "saved"
      ? Check
      : saveStatus === "readonly"
        ? LockKeyhole
        : saveStatus === "conflict" || saveStatus === "error"
          ? TriangleAlert
          : Save;
  const saveHint = saveStatus === "conflict"
    ? "The source changed on disk. Review the conflict before saving."
    : saveStatus === "readonly"
      ? "Another Studio tab currently owns this draft."
      : "Save changes to " + state.sourcePath;
  const ThemeIcon = theme === "dark" ? Sun : Moon;
  const themeLabel = theme === "dark" ? "Switch preview to light mode" : "Switch preview to dark mode";
  const connectionLabel = !connected ? "Reconnecting" : writer === false ? "Read-only" : state.conflict ? "Conflict" : "Connected";
  const connectionStatus = !connected ? "error" : writer === false ? "readonly" : state.conflict ? "conflict" : "connected";
  const revealConflict = () => {
    document.querySelector("#studio-conflict-card button")?.focus();
  };
  const recoverDiscard = async () => {
    const { response, body } = await request("/__scribe/api/recover-discard", { method: "POST", body: "{}" });
    if (!response.ok) return toast.error(body.error || "The discarded draft could not be recovered.");
    apply(body, true);
    void clearBrowserRecovery(body.recoveryKey).catch(() => undefined);
    toast.success("Recovered the discarded draft");
  };
  const discard = async () => {
    const { response, body } = await request("/__scribe/api/discard", { method: "POST", body: "{}" });
    if (!response.ok || typeof body.source !== "string") {
      toast.error(body.error || "The source could not be reloaded from disk.");
      return;
    }
    apply(body, true);
    setAuthorModeState("markdown");
    setRichSession(null);
    setRichError("");
    toast("Reloaded the source from disk", body.discardRecoveryAvailable
      ? { action: { label: "Undo", onClick: recoverDiscard } }
      : undefined);
  };

	  return <TooltipProvider><main className="studio-shell" data-mode="dark">
    <header className="studio-toolbar">
      <div className="studio-toolbar__left">
        <ViewportSelect value={viewport} onChange={setViewport} />
        <Hint label={saveHint}>
	          <Button id="save" type="button" className="save-control" size="sm" variant="secondary" data-save-state={saveStatus} aria-controls={saveStatus === "conflict" ? "studio-conflict-card" : undefined} onClick={saveStatus === "conflict" ? revealConflict : save} disabled={writer === false || savePhase === "saving"}>
            <SaveIcon data-icon="inline-start" aria-hidden="true" />{saveLabel}
          </Button>
        </Hint>
      </div>
      <Hint label={themeLabel}>
	        <Button type="button" className="theme-control" shape="square" size="sm" variant="ghost" aria-label={themeLabel} onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}><ThemeIcon aria-hidden="true" /></Button>
      </Hint>
    </header>

    <Workspace state={state} source={source} setSource={updateSource} revealSourceLine={revealSourceLine} revealRequest={previewReveal} editorRef={sourceEditorRef} theme={theme} viewport={viewport} writer={writer} />

    <footer className="studio-statusbar">
      <span className="studio-statusbar__path" title={state.sourcePath}>{state.sourcePath}</span>
      <span className="studio-statusbar__meta">
        <span>{lines.toLocaleString()} lines</span><i aria-hidden="true">·</i>
        <span>{words.toLocaleString()} words</span><i aria-hidden="true">·</i>
        <span>{location.host}</span><i aria-hidden="true">·</i>
        <span>{previewPresets[viewport].width === null ? "Fit" : previewPresets[viewport].width + "px"}</span><i aria-hidden="true">·</i>
        <span className="connection-status" data-status={connectionStatus}><b aria-hidden="true" />{connectionLabel}</span>
      </span>
    </footer>

    {richError && <div className="rich-error" role="alert"><TriangleAlert aria-hidden="true" /><div><strong>Rich Text edit rejected</strong><span>{richError}</span><small>The Markdown draft was not changed.</small></div><Button type="button" size="sm" onClick={() => switchAuthorMode("markdown")}><FileText data-icon="inline-start" aria-hidden="true" />Edit in Markdown</Button></div>}
    {state.conflict && <div id="studio-conflict-card" className="conflict-card" role="alert"><TriangleAlert aria-hidden="true" /><div><strong>Source changed outside Studio</strong><span>Your unsaved draft and the disk version are both preserved.</span></div><Button type="button" size="sm" onClick={discard}><RotateCcw data-icon="inline-start" aria-hidden="true" />Reload from disk</Button></div>}
    <span className="sr-only" aria-live="polite">{saveLabel}. {connectionLabel}.</span>
    <Toaster className="studio-toaster" theme="dark" position="bottom-right" offset={{ right: 12, bottom: 42 }} closeButton />
	  </main></TooltipProvider>;
}

createRoot(document.querySelector("#scribe-studio")).render(<StudioApp />);
`;
}

export function studioStyles(): string {
  return String.raw`:root {
  color-scheme: dark;
  --studio-canvas: #0d0d0f;
  --studio-shell: #161618;
  --studio-panel: #111113;
  --studio-panel-raised: #18181b;
  --studio-control: #1c1c1f;
  --studio-control-hover: #232327;
  --studio-border: #29292d;
  --studio-border-strong: #3a3a40;
  --studio-text: #f2f2f3;
  --studio-muted: #8e8e96;
  --studio-accent: #2563eb;
  --studio-accent-strong: #2563eb;
  --studio-danger: #ef6a68;
  --studio-warning: #d6a84b;
  --studio-radius: 0.375rem;
  --studio-font: "IBM Plex Sans", "Geist Sans", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --studio-mono: "IBM Plex Mono", "Geist Mono", ui-monospace, "SFMono-Regular", Consolas, monospace;
  --font-sans: var(--studio-font);
  --font-mono: var(--studio-mono);
  --color-kumo-canvas: var(--studio-canvas);
  --color-kumo-elevated: var(--studio-panel-raised);
  --color-kumo-recessed: var(--studio-canvas);
  --color-kumo-base: var(--studio-panel);
  --color-kumo-tint: var(--studio-control-hover);
  --color-kumo-overlay: var(--studio-panel-raised);
  --color-kumo-control: var(--studio-control);
  --color-kumo-interact: var(--studio-border-strong);
  --color-kumo-fill: var(--studio-border);
  --color-kumo-fill-hover: var(--studio-control-hover);
  --color-kumo-brand: var(--studio-accent);
  --color-kumo-brand-hover: var(--studio-accent);
  --color-kumo-line: var(--studio-border);
  --color-kumo-hairline: var(--studio-border);
  --color-kumo-focus: var(--studio-accent);
  --text-color-kumo-default: var(--studio-text);
  --text-color-kumo-strong: #fff;
  --text-color-kumo-subtle: var(--studio-muted);
  --text-color-kumo-brand: var(--studio-accent);
  --text-color-kumo-link: var(--studio-accent);
  --kumo-button-emphasis-bg: var(--studio-accent);
  --kumo-button-emphasis-ring: color-mix(in srgb,var(--studio-accent) 70%,#fff);
}
* { box-sizing: border-box; }
html, body, #scribe-studio { block-size: 100%; min-block-size: 100%; }
html { background: var(--studio-canvas); }
body { margin: 0; overflow: hidden; background: var(--studio-canvas); color: var(--studio-text); font: 13px/1.4 var(--studio-font); }
button, textarea, select, input { font: inherit; }
button { -webkit-tap-highlight-color: transparent; }
* { scrollbar-color:#3f3f46 transparent; scrollbar-width:thin; }
*::-webkit-scrollbar { inline-size:.625rem; block-size:.625rem; }
*::-webkit-scrollbar-thumb { border:3px solid transparent; border-radius:999px; background:#3f3f46; background-clip:padding-box; }
*::-webkit-scrollbar-thumb:hover { background:#52525b; background-clip:padding-box; }
svg { inline-size: 1rem; block-size: 1rem; stroke-width: 1.8; }
.sr-only { position: absolute; inline-size: 1px; block-size: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.studio-shell { block-size:100vh; min-inline-size:40rem; display:grid; grid-template-rows:2.875rem minmax(0,1fr) 1.75rem; overflow:hidden; background:var(--studio-shell); }
.studio-loading { min-block-size:100vh; display:grid; place-content:center; justify-items:center; gap:.5rem; color:var(--studio-muted); background:var(--studio-shell); }
.studio-loading svg { animation: studio-spin .9s linear infinite; }
.studio-toolbar { min-inline-size:0; display:flex; align-items:center; justify-content:space-between; gap:.5rem; padding-inline:.625rem; border-block-end:1px solid var(--studio-border); background:var(--studio-shell); }
.studio-toolbar__left { display:flex; align-items:center; gap:.25rem; min-inline-size:0; }
.viewport-select { min-inline-size:7.25rem; color:var(--studio-text)!important; background:var(--studio-control)!important; font:500 .75rem/1 var(--studio-font)!important; box-shadow:inset 0 0 0 1px var(--studio-border)!important; transition:background-color 140ms ease,box-shadow 140ms ease!important; }
.viewport-select:hover,.viewport-select[data-popup-open] { background:var(--studio-control-hover)!important; box-shadow:inset 0 0 0 1px var(--studio-border-strong)!important; }
.viewport-select:focus-visible { box-shadow:inset 0 0 0 1px var(--studio-accent),0 0 0 2px color-mix(in srgb,var(--studio-accent) 28%,transparent)!important; }
.save-control { min-inline-size:4.875rem; color:var(--studio-text)!important; background:var(--studio-control)!important; box-shadow:inset 0 0 0 1px var(--studio-border)!important; transition:color 140ms ease,background-color 140ms ease,box-shadow 140ms ease!important; }
.save-control:hover { color:#fff!important; background:var(--studio-control-hover)!important; box-shadow:inset 0 0 0 1px var(--studio-border-strong)!important; }
.save-control[data-save-state=save],.save-control[data-save-state=saving] { color:#fff!important; background:var(--studio-accent)!important; box-shadow:inset 0 0 0 1px var(--studio-accent)!important; }
.save-control[data-save-state=saving] svg { animation:studio-spin .7s linear infinite; }
.save-control[data-save-state=saved] { color:var(--studio-accent)!important; }
.save-control[data-save-state=readonly] { color:var(--studio-muted)!important; }
.save-control[data-save-state=conflict] { min-inline-size:7.75rem; color:#f2c66d!important; background:color-mix(in srgb,var(--studio-warning) 10%,var(--studio-control))!important; box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--studio-warning) 52%,var(--studio-border))!important; }
.save-control[data-save-state=error] { color:var(--studio-danger)!important; box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--studio-danger) 46%,transparent)!important; }
.theme-control { color:var(--studio-muted)!important; }
.theme-control:hover { color:var(--studio-text)!important; background:var(--studio-control)!important; }
.save-control:focus-visible,.theme-control:focus-visible,.secondary-tabs button:focus-visible { outline:2px solid var(--studio-accent); outline-offset:2px; }
.studio-workspace { --studio-split:50%; min-block-size:0; display:grid; grid-template-columns:minmax(20rem,var(--studio-split)) 1px minmax(20rem,1fr); overflow:hidden; background:var(--studio-canvas); transition:grid-template-columns 320ms cubic-bezier(.22,1,.36,1); }
.studio-splitter { position:relative; z-index:5; min-block-size:0; cursor:col-resize; outline:0; background:var(--studio-border); touch-action:none; }
.studio-splitter::after { content:""; position:absolute; inset-block:0; inset-inline:-.375rem; }
.studio-splitter:hover,.studio-splitter:focus-visible { background:var(--studio-accent-strong); }
.is-resizing-studio,.is-resizing-studio * { cursor:col-resize!important; user-select:none!important; }
.is-resizing-studio .studio-workspace { transition:none; }
.studio-panel { position:relative; block-size:100%; min-inline-size:0; min-block-size:0; display:grid; grid-template-rows:minmax(0,1fr); overflow:hidden; background:var(--studio-panel); }
.panel-heading { display:flex; align-items:center; justify-content:space-between; gap:.75rem; padding-inline:.85rem; border-block-end:1px solid var(--studio-border); color:var(--studio-muted); font:600 .625rem/1 var(--studio-mono); text-transform:uppercase; letter-spacing:.085em; }
.panel-heading > div { display:inline-flex; align-items:center; gap:.45rem; }
.panel-heading svg { inline-size:.78rem; block-size:.78rem; }
.panel-state { color:var(--studio-muted); font-size:.58rem; }
.source-editor,.source-code,.source-monaco { position:relative; inline-size:100%; block-size:100%; min-inline-size:0; min-block-size:0; overflow:hidden; background:var(--studio-panel); }
.source-monaco .monaco-editor,.source-monaco .overflow-guard { inline-size:100%!important; block-size:100%!important; }
.source-monaco .monaco-editor,.source-monaco .monaco-editor-background { background:var(--studio-panel)!important; }
.source-monaco .monaco-editor.focused { outline:0; }
.source-monaco .monaco-editor .margin { background:var(--studio-panel)!important; }
.source-monaco .line-numbers { font-variant-numeric:tabular-nums; text-align:center!important; transition:color 120ms ease; }
.source-monaco .line-numbers.active-line-number { color:var(--studio-accent)!important; font-weight:600; }
.source-monaco .source-frontmatter-delimiter { color:#2563eb!important; font-weight:600; }
.source-monaco .source-frontmatter-key { color:#60a5fa!important; font-weight:500; }
.source-monaco .source-frontmatter-punctuation { color:#71717a!important; }
.source-monaco .source-frontmatter-value { color:#d4d4d8!important; }
.source-monaco .monaco-scrollable-element > .scrollbar > .slider { border-radius:999px; }
.diagnostics { position:absolute; z-index:3; inset-inline:.75rem; inset-block-end:.75rem; max-block-size:26%; overflow:auto; margin:0; padding:.625rem .75rem; border:1px solid #633a3d; border-radius:var(--studio-radius); color:#ffb4b0; background:#211416; font:.68rem/1.55 var(--studio-mono); white-space:pre-wrap; }
.preview-stage { min-inline-size:0; min-block-size:0; display:grid; place-items:stretch center; overflow:hidden; padding:0; background:var(--studio-panel); }
.preview-device { inline-size:min(100%,var(--preview-width)); block-size:100%; min-inline-size:0; overflow:hidden; border:0; border-radius:0; background:#fff; transition:inline-size 320ms cubic-bezier(.22,1,.36,1); }
#preview { display:block; inline-size:100%; block-size:100%; border:0; background:#fff; }
.preview-panel--compact { border:0; }
.preview-panel--compact .preview-stage { block-size:100%; }
.secondary-tabs { display:inline-flex !important; align-items:center; gap:.2rem !important; padding:.15rem; border:1px solid var(--studio-border); border-radius:.4rem; background:var(--studio-control); }
.secondary-tabs button { display:inline-flex; align-items:center; gap:.32rem; min-block-size:1.55rem; padding-inline:.48rem; border:0; border-radius:.28rem; color:var(--studio-muted); background:transparent; font:600 .58rem/1 var(--studio-font); text-transform:none; letter-spacing:0; cursor:pointer; }
.secondary-tabs button[data-active] { color:#fff; background:var(--studio-accent); }
.markdown-mirror { min-block-size:0; overflow:auto; margin:0; padding:1.25rem 1.4rem 4rem; color:#cfd4dc; background:var(--studio-panel); font:.78rem/1.68 var(--studio-mono); white-space:pre-wrap; overflow-wrap:anywhere; }
.rich-editor-scroll { min-block-size:0; overflow:auto; background:var(--studio-panel); }
.scribe-rich-editor { min-block-size:100%; color:var(--studio-text); background:var(--studio-panel); --basePageBg:var(--studio-panel); --baseBase:var(--studio-panel); --baseBgSubtle:var(--studio-panel-raised); --baseBg:var(--studio-control); --baseBgHover:var(--studio-control-hover); --baseLine:var(--studio-border); --baseBorder:var(--studio-border); --baseSolid:#52525b; --baseText:var(--studio-muted); --baseTextContrast:var(--studio-text); --accentBase:var(--studio-panel); --accentBgSubtle:color-mix(in srgb,var(--studio-accent) 8%,var(--studio-panel)); --accentBg:color-mix(in srgb,var(--studio-accent) 16%,var(--studio-panel)); --accentBgHover:color-mix(in srgb,var(--studio-accent) 24%,var(--studio-panel)); --accentLine:color-mix(in srgb,var(--studio-accent) 42%,var(--studio-border)); --accentBorder:color-mix(in srgb,var(--studio-accent) 62%,var(--studio-border)); --accentSolid:var(--studio-accent); --accentText:color-mix(in srgb,var(--studio-accent) 72%,#fff); --accentTextContrast:#fff; }
.scribe-rich-editor .mdxeditor { min-block-size:100%; background:transparent; }
.scribe-rich-editor [class*="_toolbarRoot"] { position:sticky; z-index:4; inset-block-start:0; min-block-size:2.7rem; padding:.38rem .55rem; border:0; border-block-end:1px solid var(--studio-border); border-radius:0; background:var(--studio-panel-raised); }
.rich-toolbar-contents { display:flex; align-items:center; gap:.12rem; min-inline-size:max-content; }
.scribe-rich-editor [class*="_toolbar"] button,.scribe-rich-editor [class*="_toolbar"] [role=button] { color:var(--studio-muted); border-radius:.35rem; }
.scribe-rich-editor [class*="_toolbar"] button:hover,.scribe-rich-editor [class*="_toolbar"] button[data-state=on] { color:#fff; background:var(--studio-accent); }
.scribe-rich-editor [class*="_contentEditable"] { min-block-size:calc(100vh - 6rem); padding:clamp(1.3rem,3vw,2.5rem) clamp(1.2rem,4vw,3.5rem) 6rem; outline:0; caret-color:var(--studio-accent); }
.rich-content { max-inline-size:74ch; margin-inline:auto; color:var(--studio-text); font:1rem/1.74 "IBM Plex Serif","Source Serif 4",Iowan Old Style,Charter,Georgia,serif; }
.rich-content h1,.rich-content h2,.rich-content h3,.rich-content h4 { margin-block:1.8em .65em; color:var(--studio-text); font-family:var(--studio-font); line-height:1.12; letter-spacing:-.025em; }
.rich-content h1 { margin-block-start:.25em; font-size:2.35rem; }
.rich-content h2 { font-size:1.7rem; }
.rich-content h3 { font-size:1.3rem; }
.rich-content p { margin-block:0 1.1em; }
.rich-content a { color:var(--studio-accent); text-decoration-thickness:.08em; text-underline-offset:.16em; }
.rich-content code { padding:.12em .3em; border:1px solid var(--studio-border); border-radius:.2rem; color:color-mix(in srgb,var(--studio-accent) 58%,#fff); background:var(--studio-control); font:.86em/1.4 var(--studio-mono); }
.rich-content blockquote { margin:1.5rem 0; padding:.1rem 0 .1rem 1rem; border-inline-start:2px solid var(--studio-accent); color:#c4cad4; }
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
.protected-island { display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:.8rem; margin-block:1rem; padding:.8rem; border:1px dashed color-mix(in srgb,var(--studio-accent) 64%,var(--studio-border)); border-radius:var(--studio-radius); color:var(--studio-muted); background:color-mix(in srgb,var(--studio-accent) 7%,var(--studio-panel)); font-family:var(--studio-font); }
.protected-island__icon { display:grid; place-items:center; inline-size:2rem; block-size:2rem; border-radius:var(--studio-radius); color:#fff; background:var(--studio-accent); }
.protected-island__copy strong,.protected-island__copy span { display:block; }
.protected-island__copy strong { color:var(--studio-text); font-size:.75rem; }
.protected-island__copy span { margin-block-start:.12rem; font: .66rem/1.4 var(--studio-mono); }
.rich-error,.conflict-card { position:fixed; z-index:20; inset-inline-end:.75rem; inset-block-end:2.5rem; display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:.8rem; max-inline-size:38rem; padding:.75rem; border:1px solid; border-radius:var(--studio-radius); color:var(--studio-text); }
.rich-error { border-color:#68443b; background:#211416; }
.conflict-card { border-color:color-mix(in srgb,var(--studio-warning) 52%,var(--studio-border)); background:color-mix(in srgb,var(--studio-warning) 8%,var(--studio-panel-raised)); }
.rich-error > svg { color:var(--studio-danger); }
.conflict-card > svg { color:var(--studio-warning); }
.rich-error strong,.rich-error span,.rich-error small,.conflict-card strong,.conflict-card span { display:block; }
.rich-error span,.conflict-card span { margin-block-start:.15rem; color:var(--studio-muted); font-size:.72rem; }
.rich-error small { margin-block-start:.25rem; color:#ffaaa0; font-size:.64rem; }
.studio-statusbar { min-inline-size:0; display:flex; align-items:center; justify-content:space-between; gap:1rem; padding-inline:.625rem; border-block-start:1px solid var(--studio-border); color:#71717a; background:var(--studio-shell); font:.6875rem/1 var(--studio-mono); }
.studio-statusbar__path { min-inline-size:0; overflow:hidden; color:#a1a1aa; text-overflow:ellipsis; white-space:nowrap; }
.studio-statusbar__meta { flex:none; display:flex; align-items:center; gap:.375rem; white-space:nowrap; }
.studio-statusbar__meta i { color:#52525b; font-style:normal; }
.connection-status { display:inline-flex; align-items:center; gap:.3rem; }
.connection-status b { inline-size:.375rem; block-size:.375rem; border-radius:50%; background:var(--studio-muted); }
.connection-status[data-status=connected] { color:var(--studio-accent); }
.connection-status[data-status=connected] b { background:var(--studio-accent-strong); }
.connection-status[data-status=readonly] { color:var(--studio-muted); }
.connection-status[data-status=readonly] b { background:#71717a; }
.connection-status[data-status=conflict] { color:#d6a84b; }
.connection-status[data-status=conflict] b { background:var(--studio-warning); }
.connection-status[data-status=error] { color:var(--studio-danger); }
.connection-status[data-status=error] b { background:var(--studio-danger); }
.studio-toaster { font-family:var(--studio-font)!important; }
.studio-toaster [data-sonner-toast][data-styled=true] { border-color:var(--studio-border-strong); border-radius:var(--studio-radius); color:var(--studio-text); background:var(--studio-panel-raised); box-shadow:0 .5rem 1.5rem rgb(0 0 0/.28); }
.studio-toaster [data-sonner-toast] [data-icon] { color:var(--studio-accent); }
@keyframes studio-spin { to { transform:rotate(360deg); } }
@media (max-width:720px) {
  .studio-shell { min-inline-size:0; }
  .studio-workspace { grid-template-columns:1fr; grid-template-rows:minmax(15rem,1fr) minmax(15rem,1fr); }
  .studio-splitter { display:none; }
  .source-panel { border-block-end:1px solid var(--studio-border); }
  .studio-statusbar__meta > :nth-child(5),.studio-statusbar__meta > :nth-child(6),.studio-statusbar__meta > :nth-child(7),.studio-statusbar__meta > :nth-child(8) { display:none; }
  .rich-content h1 { font-size:1.9rem; }
  .protected-island { grid-template-columns:auto 1fr; }
  .protected-island button { grid-column:1/-1; }
  .rich-error,.conflict-card { grid-template-columns:auto 1fr; }
  .rich-error button,.conflict-card button { grid-column:1/-1; }
}
@media (prefers-reduced-motion:reduce) { *,*::before,*::after { scroll-behavior:auto!important; transition-duration:.001ms!important; animation-duration:.001ms!important; animation-iteration-count:1!important; } }
`;
}
