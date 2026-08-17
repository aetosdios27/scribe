use std::{
    io::{self, IsTerminal, Write},
    thread,
    time::{Duration, Instant},
};

use crossterm::{
    cursor::MoveToColumn,
    event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    execute,
    style::{Color as CrosstermColor, ContentStyle, Stylize},
    terminal::{Clear, ClearType, disable_raw_mode, enable_raw_mode},
};
use ratatui::{
    Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Paragraph},
};

use crate::{
    VERSION,
    logo::{ScribeLogo, logo_height, logo_width},
    protocol::{EngineEvent, OperationResult, PlanSummary},
};

// -----------------------------------------------------------------------------
// Splash animation
// -----------------------------------------------------------------------------

/// Total wall-clock duration of the logo entrance.
///
/// Phase is derived from elapsed time rather than frame count, so a slow
/// terminal drops frames instead of making the animation itself run slower.
const LOGO_ANIMATION_DURATION: Duration = Duration::from_millis(900);

/// Maximum redraw frequency.
///
/// ~30 FPS is visually smooth in a terminal without needlessly hammering the
/// backend with redraws that most terminal emulators cannot meaningfully show.
const LOGO_FRAME_INTERVAL: Duration = Duration::from_millis(33);

/// The shader's fully settled phase.
const LOGO_ANIMATION_END_PHASE: u16 = 1000;

/// Number of ordinary text rows beneath the logo before the status body.
const HEADER_ROWS: u16 = 3;

/// Blank row permanently reserved for the shell cursor after the inline TUI.
///
/// This is deliberately outside the bordered status block. The shell therefore
/// starts on a clean row instead of overwriting the final status lines.
const CURSOR_ROWS: u16 = 1;

/// Fixed label column width shared by every label/value row Scribe prints —
/// the splash, plans, and receipts all line up under the same grid.
const LABEL_WIDTH: usize = 16;

/// Column a wrapped value's continuation lines hang-indent to: the label
/// column plus the two-space separator that always follows it.
const LABEL_GUTTER: usize = LABEL_WIDTH + 2;

// -----------------------------------------------------------------------------
// Presentation
// -----------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Tone {
    Brand,
    Dim,
    Success,
    Warning,
    Error,
}

#[derive(Clone, Copy, Debug)]
pub struct Capabilities {
    pub interactive: bool,
    pub color: bool,
    pub unicode: bool,
    pub columns: u16,
}

impl Capabilities {
    pub fn detect() -> Self {
        let stdout_tty = io::stdout().is_terminal();
        let stdin_tty = io::stdin().is_terminal();

        let term = std::env::var("TERM").unwrap_or_default();

        let no_color = std::env::var_os("NO_COLOR").is_some()
            || std::env::var("FORCE_COLOR").is_ok_and(|value| value == "0");

        let columns = crossterm::terminal::size().map_or(80, |(columns, _)| columns.max(32));

        Self {
            interactive: stdin_tty && stdout_tty && !term.is_empty() && term != "dumb",

            color: stdout_tty && !no_color && term != "dumb",

            unicode: term != "dumb",

            columns,
        }
    }
}

pub struct Presenter<W: Write> {
    writer: W,
    capabilities: Capabilities,
}

impl<W: Write> Presenter<W> {
    pub const fn new(writer: W, capabilities: Capabilities) -> Self {
        Self {
            writer,
            capabilities,
        }
    }

    pub const fn capabilities(&self) -> Capabilities {
        self.capabilities
    }

    pub fn status(&mut self, title: &str, rows: &[(&str, String)]) -> io::Result<()> {
        writeln!(self.writer, "{}", self.paint(title, Tone::Brand))?;

        for (label, value) in rows {
            if self.capabilities.columns < 48 {
                writeln!(self.writer, "{}", self.paint(label, Tone::Dim))?;

                let width = usize::from(self.capabilities.columns)
                    .saturating_sub(2)
                    .max(1);

                for line in wrap_value(value, 0, width) {
                    writeln!(self.writer, "  {line}")?;
                }
            } else {
                let width = usize::from(self.capabilities.columns);

                let mut lines = wrap_value(value, LABEL_GUTTER, width).into_iter();

                let first = lines.next().unwrap_or_default();

                writeln!(self.writer, "{label:<LABEL_WIDTH$}  {first}")?;

                for line in lines {
                    writeln!(self.writer, "{line}")?;
                }
            }
        }

        writeln!(self.writer)
    }

    pub fn plan(&mut self, title: &str, plan: &PlanSummary) -> io::Result<()> {
        let mut rows = vec![("Project", plan.root.clone())];

        if let Some(mode) = &plan.mode {
            rows.push(("Mode", mode.clone()));
        }

        self.status(title, &rows)?;

        for package in &plan.packages {
            let current = package.current.as_deref().unwrap_or("not installed");

            let target = package.target.as_deref().unwrap_or("unchanged");

            let placement = package
                .placement
                .as_deref()
                .map_or_else(String::new, |value| format!("  ({value})"));

            writeln!(
                self.writer,
                "  {}  {current} -> {target}{placement}",
                package.name
            )?;
        }

        for command in &plan.commands {
            writeln!(self.writer, "  {}\n    {}", command.label, command.command)?;
        }

        for file in &plan.files {
            writeln!(self.writer, "  {:<10} {}", file.action, file.path)?;
        }

        for (label, value) in &plan.values {
            writeln!(self.writer, "  {label:<14} {}", display_json(value))?;
        }

        for warning in &plan.warnings {
            writeln!(self.writer, "{}  {warning}", self.symbol(Tone::Warning))?;
        }

        for step in &plan.manual_steps {
            writeln!(self.writer, "  Next  {step}")?;
        }

        writeln!(self.writer)
    }

    pub fn event(&mut self, event: &EngineEvent) -> io::Result<()> {
        match event.kind.as_str() {
            "task.started" => writeln!(
                self.writer,
                "{} {}{}",
                self.symbol(Tone::Brand),
                event.task.as_deref().unwrap_or("Working"),
                detail_suffix(event.detail.as_deref())
            ),

            "task.completed" => writeln!(
                self.writer,
                "{} {}{}",
                self.symbol(Tone::Success),
                event.task.as_deref().unwrap_or("Completed"),
                detail_suffix(event.detail.as_deref())
            ),

            "task.failed" => writeln!(
                self.writer,
                "{} {}{}",
                self.symbol(Tone::Error),
                event.task.as_deref().unwrap_or("Failed"),
                detail_suffix(event.detail.as_deref())
            ),

            "warning" => writeln!(
                self.writer,
                "{} {}{}",
                self.symbol(Tone::Warning),
                event.task.as_deref().unwrap_or("Warning"),
                detail_suffix(event.detail.as_deref())
            ),

            "process.output" => {
                if let Some(detail) = &event.detail {
                    let prefix = if event.stream.as_deref() == Some("stderr") {
                        "! "
                    } else {
                        "  "
                    };

                    writeln!(self.writer, "{prefix}{detail}")
                } else {
                    Ok(())
                }
            }

            _ => Ok(()),
        }
    }

    pub fn receipt(&mut self, success: bool, result: &OperationResult) -> io::Result<()> {
        let tone = if success { Tone::Success } else { Tone::Error };

        let title = result.title.as_deref().unwrap_or(if success {
            "Scribe operation completed"
        } else {
            "Scribe operation failed"
        });

        writeln!(self.writer, "{} {title}", self.symbol(tone))?;

        if let Some(message) = &result.message {
            writeln!(self.writer, "  {message}")?;
        }

        for (label, value) in &result.values {
            writeln!(self.writer, "  {label}  {}", display_json(value))?;
        }

        writeln!(self.writer)
    }

    pub fn cancelled(&mut self, title: &str) -> io::Result<()> {
        writeln!(self.writer, "{} {title}\n", self.symbol(Tone::Dim))
    }

    pub fn failure(&mut self, title: &str, recovery: &[String]) -> io::Result<()> {
        writeln!(self.writer, "{} {title}", self.symbol(Tone::Error))?;

        for step in recovery {
            writeln!(self.writer, "  Next  {step}")?;
        }

        writeln!(self.writer)
    }

    fn symbol(&self, tone: Tone) -> String {
        symbol(tone, self.capabilities)
    }

    fn paint(&self, value: &str, tone: Tone) -> String {
        paint(value, tone, self.capabilities.color)
    }
}

// -----------------------------------------------------------------------------
// Boxed panels
// -----------------------------------------------------------------------------

/// Geometry and style for one open labeled box. Cheap to copy around; the
/// box itself has no live state beyond this — callers draw the top border,
/// write framed content, then draw the bottom border explicitly, which lets
/// a single box span multiple unrelated calls (a `Presenter` for streamed
/// events, then a raw-mode prompt, then a `Presenter` again for a receipt).
#[derive(Clone, Copy)]
pub struct BoxFrame {
    interior: usize,
    unicode: bool,
    color: bool,
}

/// Boxes need real room: a narrow or piped terminal gets today's plain,
/// unboxed rendering instead.
fn should_box(capabilities: Capabilities) -> bool {
    capabilities.interactive && capabilities.columns >= 60
}

/// Opens a box frame if the terminal has room for one, sized to the
/// terminal's width and capped so it stays readable on very wide terminals.
pub fn open_frame(capabilities: Capabilities) -> Option<BoxFrame> {
    if !should_box(capabilities) {
        return None;
    }

    let interior = usize::from(capabilities.columns).saturating_sub(4).min(62);

    Some(BoxFrame {
        interior,
        unicode: capabilities.unicode,
        color: capabilities.color,
    })
}

/// A `Presenter` writing inside a box must wrap its own long values to the
/// box's interior width, not the full terminal width.
fn frame_capabilities(frame: BoxFrame, capabilities: Capabilities) -> Capabilities {
    Capabilities {
        columns: u16::try_from(frame.interior).unwrap_or(u16::MAX),
        ..capabilities
    }
}

struct BoxChars {
    tl: &'static str,
    tr: &'static str,
    bl: &'static str,
    br: &'static str,
    h: &'static str,
    v: &'static str,
}

fn box_chars(unicode: bool) -> BoxChars {
    if unicode {
        BoxChars {
            tl: "┌",
            tr: "┐",
            bl: "└",
            br: "┘",
            h: "─",
            v: "│",
        }
    } else {
        BoxChars {
            tl: "+",
            tr: "+",
            bl: "+",
            br: "+",
            h: "-",
            v: "|",
        }
    }
}

/// Counts display columns, skipping ANSI SGR escape sequences (`ESC [ ... m`)
/// so painted content still pads to the correct box width.
fn visible_width(text: &str) -> usize {
    let mut width = 0;
    let mut chars = text.chars();

    while let Some(character) = chars.next() {
        if character == '\u{1b}' {
            if chars.next() == Some('[') {
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }

        width += 1;
    }

    width
}

/// Draws a box's top border with its tag embedded: `┌─ TAG ────────┐`.
pub fn write_box_top(writer: &mut impl Write, frame: BoxFrame, tag: &str) -> io::Result<()> {
    let chars = box_chars(frame.unicode);
    let label = format!(" {tag} ");
    let label_width = label.chars().count();
    let fill = (frame.interior + 2).saturating_sub(1 + label_width);

    let border = format!(
        "{}{}{label}{}{}",
        chars.tl,
        chars.h,
        chars.h.repeat(fill),
        chars.tr
    );

    writeln!(writer, "{}", paint(&border, Tone::Brand, frame.color))
}

/// Draws a box's bottom border: `└──────────────┘`.
pub fn write_box_bottom(writer: &mut impl Write, frame: BoxFrame) -> io::Result<()> {
    let chars = box_chars(frame.unicode);
    let border = format!(
        "{}{}{}",
        chars.bl,
        chars.h.repeat(frame.interior + 2),
        chars.br
    );

    writeln!(writer, "{}", paint(&border, Tone::Brand, frame.color))
}

/// Closes `frame` if it is open. Every early return inside a boxed command
/// flow calls this so the box's bottom border is never left unclosed.
pub fn close_frame(frame: Option<BoxFrame>) -> io::Result<()> {
    match frame {
        Some(frame) => write_box_bottom(&mut io::stdout(), frame),
        None => Ok(()),
    }
}

/// Writes one line of content between a box's borders, padded to the
/// interior width. `newline` controls whether the line is committed
/// (`Presenter` output) or left for a live redraw to overwrite in place (raw
/// mode prompts).
fn write_box_content(
    writer: &mut impl Write,
    frame: BoxFrame,
    content: &str,
    newline: bool,
) -> io::Result<()> {
    let chars = box_chars(frame.unicode);
    let bar = paint(chars.v, Tone::Brand, frame.color);
    let pad = " ".repeat(frame.interior.saturating_sub(visible_width(content)));

    if newline {
        writeln!(writer, "{bar} {content}{pad} {bar}")
    } else {
        write!(writer, "{bar} {content}{pad} {bar}")
    }
}

/// A `Write` adapter that formats every line passed through it as boxed
/// content. Swapping this in for a `Presenter`'s writer is enough to box any
/// of its existing methods (`plan`, `event`, `receipt`, ...) without
/// changing their logic at all — this only ever sees already-formatted
/// lines and reflows them between borders.
pub struct BoxWriter<W: Write> {
    inner: W,
    frame: BoxFrame,
    pending: String,
}

impl<W: Write> BoxWriter<W> {
    const fn wrap(inner: W, frame: BoxFrame) -> Self {
        Self {
            inner,
            frame,
            pending: String::new(),
        }
    }
}

impl<W: Write> Write for BoxWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let text = String::from_utf8_lossy(buf);
        let mut remainder: &str = &text;

        while let Some(index) = remainder.find('\n') {
            self.pending.push_str(&remainder[..index]);
            let line = std::mem::take(&mut self.pending);
            write_box_content(&mut self.inner, self.frame, &line, true)?;
            remainder = &remainder[index + 1..];
        }

        self.pending.push_str(remainder);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Either a bare writer or one boxing its output, sharing one type so a
/// `Presenter` doesn't need to know which it got.
pub enum StageWriter<W: Write> {
    Plain(W),
    Boxed(BoxWriter<W>),
}

impl<W: Write> Write for StageWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Self::Plain(inner) => inner.write(buf),
            Self::Boxed(inner) => inner.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Plain(inner) => inner.flush(),
            Self::Boxed(inner) => inner.flush(),
        }
    }
}

/// Builds a `Presenter` that boxes its output when `frame` is set, and
/// writes plainly otherwise. The box's own top/bottom borders are the
/// caller's responsibility (`write_box_top` / `close_frame`), so this can be
/// called more than once for content that shares one open box.
pub fn stage_presenter(
    frame: Option<BoxFrame>,
    capabilities: Capabilities,
) -> Presenter<StageWriter<io::Stdout>> {
    match frame {
        Some(frame) => Presenter::new(
            StageWriter::Boxed(BoxWriter::wrap(io::stdout(), frame)),
            frame_capabilities(frame, capabilities),
        ),
        None => Presenter::new(StageWriter::Plain(io::stdout()), capabilities),
    }
}

/// Runs `body` inside a freshly opened box tagged `tag` (or plainly, on a
/// narrow/non-interactive terminal), closing the box afterward regardless of
/// whether `body` succeeded — so a failed step still leaves a clean border
/// instead of an open one. Generic over the caller's error type (rather than
/// tying this module to `EngineError`) via `to_error`, which every call site
/// simply passes an `Io`-style variant constructor for.
pub fn run_stage<T, E>(
    capabilities: Capabilities,
    tag: &str,
    to_error: impl Fn(io::Error) -> E,
    body: impl FnOnce(&mut Presenter<StageWriter<io::Stdout>>) -> Result<T, E>,
) -> Result<T, E> {
    let frame = open_frame(capabilities);
    let mut presenter = stage_presenter(frame, capabilities);

    if let Some(frame) = frame {
        write_box_top(&mut io::stdout(), frame, tag).map_err(&to_error)?;
    }

    let result = body(&mut presenter);

    close_frame(frame).map_err(&to_error)?;

    result
}

// -----------------------------------------------------------------------------
// Shared row wrapping
// -----------------------------------------------------------------------------

/// Word-wraps `value` to `width` columns. The first returned line carries no
/// indentation (the caller prepends its own label); every continuation line
/// is padded with `gutter` spaces so it lines up under the value column
/// instead of orphaning itself at column zero. A single "word" wider than
/// the budget on its own (a path or URL with no whitespace to break on,
/// most commonly) is hard-broken at the budget rather than left to overflow
/// — load-bearing once this can render inside a fixed-width box, where an
/// overlong line breaks the border instead of just looking long.
fn wrap_value(value: &str, gutter: usize, width: usize) -> Vec<String> {
    let budget = width.saturating_sub(gutter).max(1);

    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();

    for word in value.split_whitespace() {
        let mut remaining = word;

        loop {
            let remaining_len = remaining.chars().count();

            let fits = if current.is_empty() {
                remaining_len <= budget
            } else {
                current.chars().count() + 1 + remaining_len <= budget
            };

            if fits {
                if !current.is_empty() {
                    current.push(' ');
                }
                current.push_str(remaining);
                break;
            }

            if !current.is_empty() {
                lines.push(std::mem::take(&mut current));
                continue;
            }

            let split = remaining
                .char_indices()
                .nth(budget)
                .map_or(remaining.len(), |(index, _)| index);

            if split == 0 {
                lines.push(remaining.to_owned());
                break;
            }

            lines.push(remaining[..split].to_owned());
            remaining = &remaining[split..];
        }
    }

    lines.push(current);

    let pad = " ".repeat(gutter);

    lines
        .into_iter()
        .enumerate()
        .map(|(index, line)| {
            if index == 0 {
                line
            } else {
                format!("{pad}{line}")
            }
        })
        .collect()
}

// -----------------------------------------------------------------------------
// Prompts
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConfirmOutcome {
    Continue,
    Yes,
    No,
    Cancel,
}

fn apply_confirm_key(key: KeyEvent, initial: bool) -> ConfirmOutcome {
    match key.code {
        KeyCode::Enter => {
            if initial {
                ConfirmOutcome::Yes
            } else {
                ConfirmOutcome::No
            }
        }

        KeyCode::Esc => ConfirmOutcome::Cancel,

        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            ConfirmOutcome::Cancel
        }

        KeyCode::Char(character) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
            match character.to_ascii_lowercase() {
                'y' => ConfirmOutcome::Yes,
                'n' => ConfirmOutcome::No,
                _ => ConfirmOutcome::Continue,
            }
        }

        _ => ConfirmOutcome::Continue,
    }
}

/// Redraws one prompt line in place: `◆ Label [hint]  typed-value`, matching
/// the same Brand symbol and Dim label treatment every other Scribe surface
/// uses. When `frame` is set, the line is drawn inside that box's borders
/// instead of bare, so a prompt reads as part of the same panel as the
/// content around it.
fn write_prompt_line(
    stdout: &mut impl Write,
    label: &str,
    hint: Option<&str>,
    value: &str,
    capabilities: Capabilities,
    frame: Option<BoxFrame>,
) -> io::Result<()> {
    execute!(stdout, MoveToColumn(0), Clear(ClearType::CurrentLine))?;

    let marker = symbol(Tone::Brand, capabilities);
    let label = paint(label, Tone::Dim, capabilities.color);

    let content = match hint {
        Some(hint) => format!("{marker} {label} [{hint}]  {value}"),
        None => format!("{marker} {label}  {value}"),
    };

    match frame {
        Some(frame) => write_box_content(stdout, frame, &content, false)?,
        None => write!(stdout, "{content}")?,
    }

    stdout.flush()
}

fn next_key_press() -> io::Result<KeyEvent> {
    loop {
        if let Event::Key(key) = event::read()? {
            if key.kind == KeyEventKind::Press {
                return Ok(key);
            }
        }
    }
}

pub fn prompt_confirm(
    label: &str,
    initial: bool,
    frame: Option<BoxFrame>,
) -> io::Result<Option<bool>> {
    let capabilities = Capabilities::detect();
    let mut stdout = io::stdout();
    let hint = if initial { "Y/n" } else { "y/N" };

    write_prompt_line(&mut stdout, label, Some(hint), "", capabilities, frame)?;

    enable_raw_mode()?;

    let outcome = loop {
        let key = next_key_press()?;

        match apply_confirm_key(key, initial) {
            ConfirmOutcome::Continue => {}
            resolved => break resolved,
        }
    };

    disable_raw_mode()?;

    let echoed = match outcome {
        ConfirmOutcome::Yes => "y",
        ConfirmOutcome::No => "n",
        ConfirmOutcome::Cancel | ConfirmOutcome::Continue => "",
    };

    write_prompt_line(&mut stdout, label, Some(hint), echoed, capabilities, frame)?;
    writeln!(stdout)?;

    match outcome {
        ConfirmOutcome::Yes => Ok(Some(true)),
        ConfirmOutcome::No => Ok(Some(false)),
        ConfirmOutcome::Cancel => Ok(None),
        ConfirmOutcome::Continue => unreachable!("the loop only breaks on a resolved outcome"),
    }
}

// -----------------------------------------------------------------------------
// Boxed multi-field form
// -----------------------------------------------------------------------------
//
// `prompt_text`/`prompt_confirm` above are a scrollback-append trick: each
// field commits a real newline before the next field's prompt even exists,
// so a box drawn around a sequence of them only ever reveals its own shape
// one committed Enter at a time, and the terminal cursor is just wherever
// the last redraw left it — never a cursor genuinely positioned inside a
// drawn structure. That's fine for a single field. It reads as broken for
// several, because several fields is a form, and a form needs the whole box
// to exist from the first frame and its fields to be navigable, not just
// sequential.
//
// This reuses the exact `Viewport::Inline` + `Terminal::draw` mechanism
// `draw_inline_frame` already established for the splash: a fixed-height
// region redrawn atomically every frame against the terminal's *current*
// size, with the real cursor placed via `set_cursor_position`. The splash
// never edits itself, so it only ever draws once (or through a fixed
// animation); a form redraws on every keystroke and every focus change.

pub struct FormField {
    pub label: &'static str,
    pub buffer: String,
    pub placeholder: String,
}

impl FormField {
    pub fn new(label: &'static str) -> Self {
        Self {
            label,
            buffer: String::new(),
            placeholder: String::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormOutcome {
    Submitted,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FormAction {
    Type(char),
    Backspace,
    Clear,
    FocusNext,
    FocusPrev,
    Cancel,
    Continue,
}

fn form_action(key: KeyEvent) -> FormAction {
    match key.code {
        KeyCode::Esc => FormAction::Cancel,

        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => FormAction::Cancel,

        KeyCode::Up | KeyCode::BackTab => FormAction::FocusPrev,

        KeyCode::Down | KeyCode::Tab | KeyCode::Enter => FormAction::FocusNext,

        KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => FormAction::Clear,

        KeyCode::Backspace => FormAction::Backspace,

        KeyCode::Char(character) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
            FormAction::Type(character)
        }

        _ => FormAction::Continue,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FormStep {
    Edit,
    Advance(usize),
    Submit,
    Cancel,
}

/// Pure focus-transition logic: what a key's `FormAction` means given where
/// focus currently is and how many fields exist. Separated from the
/// raw-mode I/O loop so it's directly testable, the same way `LineEditor`'s
/// key handling already is.
fn form_step(action: FormAction, focused: usize, field_count: usize) -> FormStep {
    match action {
        FormAction::Cancel => FormStep::Cancel,

        FormAction::FocusPrev => FormStep::Advance(focused.saturating_sub(1)),

        FormAction::FocusNext => {
            if focused + 1 < field_count {
                FormStep::Advance(focused + 1)
            } else {
                FormStep::Submit
            }
        }

        FormAction::Type(_) | FormAction::Backspace | FormAction::Clear | FormAction::Continue => {
            FormStep::Edit
        }
    }
}

/// Runs `fields` as one inline-viewport form: every field's row is visible
/// from the first frame, arrow keys (or Tab/Shift+Tab) move focus between
/// already-reachable fields freely, and the real cursor tracks whichever
/// field is focused. `Enter`/`Tab`/`Down` on the last field submits.
///
/// `on_leave_field(index, fields)` fires exactly once per field, the first
/// time focus advances *past* it — the hook for fetching a derived default
/// for the next field (an engine round-trip, typically). Navigating back to
/// an already-left field and forward again does not re-fire it; there's no
/// silent re-derivation, the user can just retype a downstream value if an
/// earlier one changed.
///
/// Generic over the caller's error type via `to_error`, the same pattern
/// `run_stage` uses, so this stays engine-agnostic.
pub fn run_boxed_form<E>(
    tag: &str,
    fields: &mut [FormField],
    capabilities: Capabilities,
    to_error: impl Fn(io::Error) -> E,
    mut on_leave_field: impl FnMut(usize, &mut [FormField]) -> Result<(), E>,
) -> Result<FormOutcome, E> {
    if fields.is_empty() {
        return Ok(FormOutcome::Submitted);
    }

    let field_count = fields.len();
    // Borders (2) + one field row each + a dedicated blank row *below* the
    // box, reserved the same way the splash reserves `CURSOR_ROWS`: without
    // it, the real terminal cursor is left wherever the last focused field
    // was — inside the box — and whatever renders next (another form, the
    // next boxed panel) starts from there instead of a clean line below,
    // producing overlapping borders.
    let height = u16::try_from(field_count)
        .unwrap_or(u16::MAX)
        .saturating_add(2)
        .saturating_add(CURSOR_ROWS);

    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::with_options(
        backend,
        ratatui::TerminalOptions {
            viewport: ratatui::Viewport::Inline(height),
        },
    )
    .map_err(&to_error)?;

    enable_raw_mode().map_err(&to_error)?;

    let mut focused = 0usize;
    let mut frontier = 0usize;

    let outcome: Result<FormOutcome, E> = loop {
        if let Err(error) =
            draw_form_frame(&mut terminal, tag, fields, focused, capabilities, false)
        {
            break Err(to_error(error));
        }

        let key = match next_key_press() {
            Ok(key) => key,
            Err(error) => break Err(to_error(error)),
        };

        match form_step(form_action(key), focused, field_count) {
            FormStep::Cancel => break Ok(FormOutcome::Cancelled),

            FormStep::Submit => break Ok(FormOutcome::Submitted),

            FormStep::Advance(next) => {
                if next > focused && focused == frontier {
                    if let Err(error) = on_leave_field(focused, fields) {
                        break Err(error);
                    }
                    frontier = next;
                }
                focused = next;
            }

            FormStep::Edit => match form_action(key) {
                FormAction::Type(character) => fields[focused].buffer.push(character),
                FormAction::Backspace => {
                    fields[focused].buffer.pop();
                }
                FormAction::Clear => fields[focused].buffer.clear(),
                FormAction::FocusNext
                | FormAction::FocusPrev
                | FormAction::Cancel
                | FormAction::Continue => {}
            },
        }
    };

    // One last draw with the cursor moved to the reserved resting row below
    // the box, so whatever writes next starts from a clean, known line
    // instead of wherever the last focused field happened to be. Best
    // effort: `outcome` is already decided, and failing to tidy the cursor
    // shouldn't mask that result.
    let _ = draw_form_frame(&mut terminal, tag, fields, focused, capabilities, true);

    disable_raw_mode().map_err(&to_error)?;
    terminal.show_cursor().map_err(&to_error)?;

    outcome
}

fn draw_form_frame(
    terminal: &mut InlineTerminal,
    tag: &str,
    fields: &[FormField],
    focused: usize,
    capabilities: Capabilities,
    resting: bool,
) -> io::Result<()> {
    terminal
        .draw(|frame| {
            let full_area = frame.area();
            let width = full_area.width.min(66);
            let box_height = u16::try_from(fields.len())
                .unwrap_or(u16::MAX)
                .saturating_add(2);
            let area = Rect::new(full_area.x, full_area.y, width, box_height);

            let block = Block::default()
                .borders(Borders::ALL)
                .title(Span::styled(
                    format!(" {tag} "),
                    screen_style(Tone::Brand, capabilities.color),
                ))
                .border_style(screen_style(Tone::Brand, capabilities.color));

            let inner = block.inner(area);
            frame.render_widget(block, area);

            let rows = Layout::default()
                .direction(Direction::Vertical)
                .constraints(vec![Constraint::Length(1); fields.len()])
                .split(inner);

            let mut focus_cursor = None;

            for (index, field) in fields.iter().enumerate() {
                let label = format!("{:<LABEL_WIDTH$}  ", field.label);

                let (value_text, value_style) = if field.buffer.is_empty() {
                    (
                        field.placeholder.as_str(),
                        screen_style(Tone::Dim, capabilities.color),
                    )
                } else {
                    (field.buffer.as_str(), Style::default())
                };

                let line = Line::from(vec![
                    Span::styled(label.clone(), screen_style(Tone::Dim, capabilities.color)),
                    Span::styled(value_text, value_style),
                ]);

                frame.render_widget(Paragraph::new(line), rows[index]);

                if index == focused {
                    let x = rows[index].x
                        + u16::try_from(label.chars().count()).unwrap_or(0)
                        + u16::try_from(field.buffer.chars().count()).unwrap_or(0);
                    focus_cursor = Some((x, rows[index].y));
                }
            }

            let cursor = if resting {
                Some((area.x, area.y + area.height))
            } else {
                focus_cursor
            };

            if let Some((x, y)) = cursor {
                frame.set_cursor_position((x, y));
            }
        })
        .map(|_| ())
}

// -----------------------------------------------------------------------------
// Bare `scribe` inline screen
// -----------------------------------------------------------------------------

type InlineTerminal = Terminal<CrosstermBackend<io::Stdout>>;

pub fn render_inline_screen(
    title: &str,
    description: &str,
    rows: &[(&str, &str)],
) -> io::Result<()> {
    let capabilities = Capabilities::detect();

    // Ratatui's inline renderer is meant for a real terminal. When stdout is
    // redirected, emit stable plain text instead of cursor-control sequences.
    if !io::stdout().is_terminal() || terminal_is_dumb() {
        let mut stdout = io::stdout().lock();

        return write_plain_inline_screen(&mut stdout, title, description, rows);
    }

    let terminal_width =
        crossterm::terminal::size().map_or(capabilities.columns, |(width, _)| width.max(1));

    let show_logo = terminal_width >= logo_width().saturating_add(4);

    let logo_rows = if show_logo {
        logo_height().saturating_add(1)
    } else {
        0
    };

    let body_rows = inline_body_height(terminal_width, description, rows);

    let height = logo_rows
        .saturating_add(HEADER_ROWS)
        .saturating_add(body_rows)
        .saturating_add(CURSOR_ROWS);

    let backend = CrosstermBackend::new(io::stdout());

    let mut terminal = Terminal::with_options(
        backend,
        ratatui::TerminalOptions {
            viewport: ratatui::Viewport::Inline(height),
        },
    )?;

    let animate = animation_enabled(show_logo, capabilities);

    if animate {
        let animation_started = Instant::now();

        loop {
            let frame_started = Instant::now();
            let elapsed = animation_started.elapsed();

            let finished = elapsed >= LOGO_ANIMATION_DURATION;

            let phase = animation_phase(elapsed);

            draw_inline_frame(
                &mut terminal,
                show_logo,
                phase,
                finished,
                capabilities.color,
                body_rows,
                title,
                description,
                rows,
            )?;

            if finished {
                break;
            }

            // Frame pacing is capped, but animation progress itself is based
            // on elapsed wall-clock time. If rendering becomes slow, frames
            // are skipped rather than extending the animation duration.
            let render_time = frame_started.elapsed();

            let remaining = LOGO_FRAME_INTERVAL.saturating_sub(render_time);

            if !remaining.is_zero() {
                thread::sleep(remaining);
            }
        }
    } else {
        draw_inline_frame(
            &mut terminal,
            show_logo,
            LOGO_ANIMATION_END_PHASE,
            true,
            capabilities.color,
            body_rows,
            title,
            description,
            rows,
        )?;
    }

    // `set_cursor_position` on the final frame already makes it visible, but
    // explicitly restoring visibility makes the post-TUI shell handoff robust
    // across terminal backends.
    terminal.show_cursor()?;

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn draw_inline_frame(
    terminal: &mut InlineTerminal,
    show_logo: bool,
    phase: u16,
    final_frame: bool,
    color_enabled: bool,
    body_rows: u16,
    title: &str,
    description: &str,
    rows: &[(&str, &str)],
) -> io::Result<()> {
    terminal
        .draw(|frame| {
            let constraints = if show_logo {
                vec![
                    Constraint::Length(logo_height()),
                    Constraint::Length(1),
                    Constraint::Length(HEADER_ROWS),
                    Constraint::Length(body_rows),
                    Constraint::Length(CURSOR_ROWS),
                ]
            } else {
                vec![
                    Constraint::Length(HEADER_ROWS),
                    Constraint::Length(body_rows),
                    Constraint::Length(CURSOR_ROWS),
                ]
            };

            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .constraints(constraints)
                .split(frame.area());

            let (header, body, cursor_row) = if show_logo {
                frame.render_widget(ScribeLogo::new(phase), chunks[0]);

                (chunks[2], chunks[3], chunks[4])
            } else {
                (chunks[0], chunks[1], chunks[2])
            };

            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(Span::styled(
                        format!("Publishing SDK · {VERSION}"),
                        screen_style(Tone::Dim, color_enabled),
                    )),
                    Line::default(),
                    Line::from(Span::styled(
                        title,
                        Style::default().add_modifier(Modifier::BOLD),
                    )),
                ]),
                header,
            );

            // LEFT border consumes one terminal cell.
            let content_width = usize::from(body.width.saturating_sub(1).max(1));

            let mut text = vec![Line::from(description), Line::default()];

            text.extend(rows.iter().flat_map(|(label, value)| {
                let mut lines = wrap_value(value, LABEL_GUTTER, content_width).into_iter();

                let first = Line::from(vec![
                    Span::styled(
                        format!("{label:<LABEL_WIDTH$}  "),
                        screen_style(Tone::Dim, color_enabled),
                    ),
                    Span::raw(lines.next().unwrap_or_default()),
                ]);

                std::iter::once(first).chain(lines.map(Line::from))
            }));

            frame.render_widget(
                Paragraph::new(Text::from(text)).block(
                    Block::default()
                        .borders(Borders::LEFT)
                        .border_style(screen_style(Tone::Brand, color_enabled)),
                ),
                body,
            );

            // Ratatui hides the cursor when no position is requested.
            //
            // On the final frame we explicitly park it on a dedicated blank
            // row *below* the status block. The shell therefore resumes there
            // rather than at whichever logo cell happened to be diffed last.
            if final_frame {
                frame.set_cursor_position((cursor_row.x, cursor_row.y));
            }
        })
        .map(|_| ())
}

// -----------------------------------------------------------------------------
// Animation behavior
// -----------------------------------------------------------------------------

fn animation_enabled(show_logo: bool, capabilities: Capabilities) -> bool {
    show_logo && capabilities.color && !env_flag("CI") && !env_flag("SCRIBE_NO_ANIMATION")
}

fn animation_phase(elapsed: Duration) -> u16 {
    if elapsed >= LOGO_ANIMATION_DURATION {
        return LOGO_ANIMATION_END_PHASE;
    }

    let duration = LOGO_ANIMATION_DURATION.as_nanos();

    if duration == 0 {
        return LOGO_ANIMATION_END_PHASE;
    }

    let scaled = elapsed
        .as_nanos()
        .saturating_mul(u128::from(LOGO_ANIMATION_END_PHASE))
        / duration;

    u16::try_from(scaled)
        .unwrap_or(LOGO_ANIMATION_END_PHASE)
        .min(LOGO_ANIMATION_END_PHASE)
}

fn env_flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| {
        let value = value.trim().to_ascii_lowercase();

        !value.is_empty() && !matches!(value.as_str(), "0" | "false" | "no" | "off")
    })
}

// -----------------------------------------------------------------------------
// Inline sizing
// -----------------------------------------------------------------------------

fn inline_body_height(terminal_width: u16, description: &str, rows: &[(&str, &str)]) -> u16 {
    // LEFT border consumes one terminal cell.
    let content_width = terminal_width.saturating_sub(1).max(1);

    let mut height = wrapped_line_count(description, content_width).saturating_add(1); // blank line after description

    for (_, value) in rows {
        let lines = wrap_value(value, LABEL_GUTTER, usize::from(content_width));

        height = height.saturating_add(u16::try_from(lines.len()).unwrap_or(u16::MAX));
    }

    height.max(1)
}

fn wrapped_line_count(value: &str, width: u16) -> u16 {
    let width = usize::from(width.max(1));

    value
        .split('\n')
        .fold(0u16, |total, line| {
            let characters = line.chars().count();

            let lines = if characters == 0 {
                1
            } else {
                characters.div_ceil(width)
            };

            total.saturating_add(u16::try_from(lines).unwrap_or(u16::MAX))
        })
        .max(1)
}

// -----------------------------------------------------------------------------
// Plain-output fallback
// -----------------------------------------------------------------------------

fn write_plain_inline_screen<W: Write>(
    writer: &mut W,
    title: &str,
    description: &str,
    rows: &[(&str, &str)],
) -> io::Result<()> {
    writeln!(writer, "Scribe · Publishing SDK · {VERSION}")?;

    writeln!(writer)?;

    writeln!(writer, "{title}")?;

    writeln!(writer, "{description}")?;

    if !rows.is_empty() {
        writeln!(writer)?;
    }

    for (label, value) in rows {
        writeln!(writer, "{label:<LABEL_WIDTH$}  {value}")?;
    }

    Ok(())
}

fn terminal_is_dumb() -> bool {
    std::env::var("TERM").is_ok_and(|term| term == "dumb")
}

// -----------------------------------------------------------------------------
// Styling
// -----------------------------------------------------------------------------

/// The single source of truth for what color a `Tone` renders as. Both the
/// ratatui splash and the plain-text presenter/prompt paths derive their
/// colors from this one mapping instead of keeping their own copies.
fn tone_color(tone: Tone) -> CrosstermColor {
    match tone {
        Tone::Brand => CrosstermColor::Rgb {
            r: 80,
            g: 131,
            b: 230,
        },

        Tone::Dim => CrosstermColor::DarkGrey,

        Tone::Success => CrosstermColor::Green,

        Tone::Warning => CrosstermColor::Yellow,

        Tone::Error => CrosstermColor::Red,
    }
}

fn ratatui_color(color: CrosstermColor) -> Color {
    match color {
        CrosstermColor::Rgb { r, g, b } => Color::Rgb(r, g, b),
        CrosstermColor::DarkGrey => Color::DarkGray,
        CrosstermColor::Green => Color::Green,
        CrosstermColor::Yellow => Color::Yellow,
        CrosstermColor::Red => Color::Red,
        _ => Color::Reset,
    }
}

fn screen_style(tone: Tone, color_enabled: bool) -> Style {
    if !color_enabled {
        return Style::default();
    }

    Style::default().fg(ratatui_color(tone_color(tone)))
}

fn terminal_style(tone: Tone) -> ContentStyle {
    ContentStyle::new().with(tone_color(tone))
}

fn paint(value: &str, tone: Tone, color_enabled: bool) -> String {
    if !color_enabled {
        return value.to_owned();
    }

    format!("{}", terminal_style(tone).apply(value))
}

fn symbol(tone: Tone, capabilities: Capabilities) -> String {
    let raw = if capabilities.unicode {
        match tone {
            Tone::Brand => "◆",
            Tone::Success => "✓",
            Tone::Warning => "!",
            Tone::Error => "×",
            Tone::Dim => "–",
        }
    } else {
        match tone {
            Tone::Brand => "*",
            Tone::Success => "+",
            Tone::Warning => "!",
            Tone::Error => "x",
            Tone::Dim => "-",
        }
    };

    paint(raw, tone, capabilities.color)
}

// -----------------------------------------------------------------------------
// Formatting helpers
// -----------------------------------------------------------------------------

fn detail_suffix(detail: Option<&str>) -> String {
    detail.map_or_else(String::new, |detail| format!("  {detail}"))
}

fn display_json(value: &serde_json::Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), ToOwned::to_owned)
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_renderer_never_emits_control_sequences() {
        let mut output = Vec::new();

        let capabilities = Capabilities {
            interactive: false,
            color: false,
            unicode: false,
            columns: 40,
        };

        let mut presenter = Presenter::new(&mut output, capabilities);

        presenter
            .status(
                "Scribe",
                &[("Project", "/a/very/long/project/path".to_owned())],
            )
            .expect("render status");

        let shown = String::from_utf8(output).expect("utf8");

        assert!(!shown.contains('\u{1b}'));

        assert!(shown.contains("Project\n"));
    }

    #[test]
    fn piped_splash_is_plain_text() {
        let mut output = Vec::new();

        write_plain_inline_screen(
            &mut output,
            "Project status",
            "Scribe is integrated here.",
            &[("state", "integrated"), ("next", "scribe update")],
        )
        .expect("plain splash");

        let shown = String::from_utf8(output).expect("utf8");

        assert!(!shown.contains('\u{1b}'));

        assert!(shown.contains("Scribe · Publishing SDK",));

        assert!(shown.contains("Project status",));

        assert!(shown.contains("scribe update",));
    }

    #[test]
    fn animation_phase_tracks_wall_clock_time() {
        assert_eq!(animation_phase(Duration::ZERO,), 0);

        assert_eq!(
            animation_phase(LOGO_ANIMATION_DURATION / 2,),
            LOGO_ANIMATION_END_PHASE / 2
        );

        assert_eq!(
            animation_phase(LOGO_ANIMATION_DURATION,),
            LOGO_ANIMATION_END_PHASE
        );

        assert_eq!(
            animation_phase(LOGO_ANIMATION_DURATION + Duration::from_secs(10),),
            LOGO_ANIMATION_END_PHASE
        );
    }

    #[test]
    fn body_height_has_no_phantom_trailing_rows() {
        let height = inline_body_height(
            80,
            "Everything is ready.",
            &[("state", "integrated"), ("next", "scribe update")],
        );

        // description
        // blank separator
        // state
        // next
        assert_eq!(height, 4);
    }

    #[test]
    fn wrapped_lines_expand_body_height() {
        let height = inline_body_height(
            20,
            "This description is deliberately long enough to wrap.",
            &[],
        );

        assert!(height > 2);
    }

    #[test]
    fn wrapped_line_count_handles_empty_lines() {
        assert_eq!(wrapped_line_count("", 80,), 1);

        assert_eq!(wrapped_line_count("\n", 80,), 2);
    }

    #[test]
    fn body_height_accounts_for_wrapped_row_values() {
        let short = inline_body_height(80, "Ready.", &[("packages", "fine")]);

        let long = inline_body_height(
            80,
            "Ready.",
            &[(
                "packages",
                "inspection failed: Conflicting package-manager lockfiles exist in \
                 /home/aetos/dev/personal/new-portfolio: bun.lock, package-lock.json. \
                 Remove stale lockfiles before Scribe mutates dependencies.",
            )],
        );

        assert!(long > short);
    }

    #[test]
    fn wrap_value_hanging_indents_continuation_lines() {
        let lines = wrap_value("one two three four five six", 4, 12);

        assert!(lines.len() > 1);

        assert!(!lines[0].starts_with(' '));

        for line in &lines[1..] {
            assert!(line.starts_with("    "));
        }
    }

    #[test]
    fn wrap_value_keeps_short_values_on_one_line() {
        assert_eq!(wrap_value("integrated", 18, 80), vec!["integrated"]);
    }

    #[test]
    fn wrap_value_never_produces_zero_lines() {
        assert_eq!(wrap_value("", 18, 80), vec![""]);
    }

    #[test]
    fn wrap_value_hard_breaks_a_single_word_wider_than_the_budget() {
        let path = "/tmp/an/unusually/long/absolute/path/with/no/spaces/in/it/at/all";
        let lines = wrap_value(path, 4, 20);

        assert!(lines.len() > 1);

        // Every line, gutter padding included, must fit the requested
        // width — that's the whole point of hard-breaking.
        for line in &lines {
            assert!(visible_width(line) <= 20);
        }

        assert_eq!(lines.concat().replace(' ', ""), path);
    }

    fn key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    #[test]
    fn confirm_key_accepts_yes_and_no_regardless_of_case() {
        assert_eq!(
            apply_confirm_key(key(KeyCode::Char('Y'), KeyModifiers::NONE), false),
            ConfirmOutcome::Yes
        );

        assert_eq!(
            apply_confirm_key(key(KeyCode::Char('n'), KeyModifiers::NONE), true),
            ConfirmOutcome::No
        );
    }

    #[test]
    fn confirm_key_enter_uses_the_initial_default() {
        assert_eq!(
            apply_confirm_key(key(KeyCode::Enter, KeyModifiers::NONE), true),
            ConfirmOutcome::Yes
        );

        assert_eq!(
            apply_confirm_key(key(KeyCode::Enter, KeyModifiers::NONE), false),
            ConfirmOutcome::No
        );
    }

    #[test]
    fn confirm_key_ctrl_c_and_esc_both_cancel() {
        assert_eq!(
            apply_confirm_key(key(KeyCode::Esc, KeyModifiers::NONE), true),
            ConfirmOutcome::Cancel
        );

        assert_eq!(
            apply_confirm_key(key(KeyCode::Char('c'), KeyModifiers::CONTROL), true),
            ConfirmOutcome::Cancel
        );
    }

    #[test]
    fn confirm_key_ignores_unrelated_characters() {
        assert_eq!(
            apply_confirm_key(key(KeyCode::Char('q'), KeyModifiers::NONE), true),
            ConfirmOutcome::Continue
        );
    }

    #[test]
    fn form_action_maps_navigation_and_editing_keys() {
        assert_eq!(
            form_action(key(KeyCode::Char('h'), KeyModifiers::NONE)),
            FormAction::Type('h')
        );
        assert_eq!(
            form_action(key(KeyCode::Backspace, KeyModifiers::NONE)),
            FormAction::Backspace
        );
        assert_eq!(
            form_action(key(KeyCode::Char('u'), KeyModifiers::CONTROL)),
            FormAction::Clear
        );
        assert_eq!(
            form_action(key(KeyCode::Down, KeyModifiers::NONE)),
            FormAction::FocusNext
        );
        assert_eq!(
            form_action(key(KeyCode::Tab, KeyModifiers::NONE)),
            FormAction::FocusNext
        );
        assert_eq!(
            form_action(key(KeyCode::Enter, KeyModifiers::NONE)),
            FormAction::FocusNext
        );
        assert_eq!(
            form_action(key(KeyCode::Up, KeyModifiers::NONE)),
            FormAction::FocusPrev
        );
        assert_eq!(
            form_action(key(KeyCode::BackTab, KeyModifiers::NONE)),
            FormAction::FocusPrev
        );
        assert_eq!(
            form_action(key(KeyCode::Esc, KeyModifiers::NONE)),
            FormAction::Cancel
        );
        assert_eq!(
            form_action(key(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            FormAction::Cancel
        );
    }

    #[test]
    fn form_step_advances_focus_within_bounds() {
        assert_eq!(form_step(FormAction::FocusNext, 0, 3), FormStep::Advance(1));
        assert_eq!(form_step(FormAction::FocusNext, 1, 3), FormStep::Advance(2));
        assert_eq!(form_step(FormAction::FocusPrev, 1, 3), FormStep::Advance(0));
    }

    #[test]
    fn form_step_clamps_focus_prev_at_the_first_field() {
        assert_eq!(form_step(FormAction::FocusPrev, 0, 3), FormStep::Advance(0));
    }

    #[test]
    fn form_step_submits_on_focus_next_from_the_last_field() {
        assert_eq!(form_step(FormAction::FocusNext, 2, 3), FormStep::Submit);
    }

    #[test]
    fn form_step_cancels_regardless_of_focus() {
        assert_eq!(form_step(FormAction::Cancel, 1, 3), FormStep::Cancel);
    }

    #[test]
    fn form_step_treats_editing_actions_as_edit() {
        assert_eq!(form_step(FormAction::Type('x'), 0, 3), FormStep::Edit);
        assert_eq!(form_step(FormAction::Backspace, 0, 3), FormStep::Edit);
        assert_eq!(form_step(FormAction::Clear, 0, 3), FormStep::Edit);
        assert_eq!(form_step(FormAction::Continue, 0, 3), FormStep::Edit);
    }

    #[test]
    fn should_box_requires_interactive_and_wide_enough() {
        let narrow = Capabilities {
            interactive: true,
            color: true,
            unicode: true,
            columns: 59,
        };
        let wide_noninteractive = Capabilities {
            interactive: false,
            color: true,
            unicode: true,
            columns: 100,
        };
        let wide_interactive = Capabilities {
            interactive: true,
            color: true,
            unicode: true,
            columns: 60,
        };

        assert!(open_frame(narrow).is_none());
        assert!(open_frame(wide_noninteractive).is_none());
        assert!(open_frame(wide_interactive).is_some());
    }

    #[test]
    fn box_interior_width_is_capped_on_wide_terminals() {
        let capabilities = Capabilities {
            interactive: true,
            color: false,
            unicode: true,
            columns: 400,
        };

        let frame = open_frame(capabilities).expect("wide enough to box");

        assert_eq!(frame.interior, 62);
    }

    #[test]
    fn visible_width_ignores_ansi_escapes() {
        let plain = "hello";
        let painted = paint(plain, Tone::Brand, true);

        assert_ne!(plain.len(), painted.len());
        assert_eq!(visible_width(&painted), visible_width(plain));
        assert_eq!(visible_width(plain), 5);
    }

    #[test]
    fn box_top_and_bottom_borders_share_one_width() {
        let frame = BoxFrame {
            interior: 20,
            unicode: true,
            color: false,
        };

        let mut top = Vec::new();
        write_box_top(&mut top, frame, "TAG").expect("top border");

        let mut bottom = Vec::new();
        write_box_bottom(&mut bottom, frame).expect("bottom border");

        let top_line = String::from_utf8(top).expect("utf8");
        let bottom_line = String::from_utf8(bottom).expect("utf8");

        assert_eq!(
            visible_width(top_line.trim_end()),
            visible_width(bottom_line.trim_end())
        );
        assert!(top_line.contains("TAG"));
        assert!(top_line.starts_with('┌'));
        assert!(bottom_line.starts_with('└'));
    }

    #[test]
    fn box_border_falls_back_to_ascii_without_unicode() {
        let frame = BoxFrame {
            interior: 20,
            unicode: false,
            color: false,
        };

        let mut top = Vec::new();
        write_box_top(&mut top, frame, "TAG").expect("top border");

        let line = String::from_utf8(top).expect("utf8");

        assert!(line.starts_with('+'));
        assert!(
            !line
                .chars()
                .any(|character| character == '┌' || character == '─')
        );
    }

    #[test]
    fn box_content_pads_to_interior_width_and_stays_bordered() {
        let frame = BoxFrame {
            interior: 20,
            unicode: true,
            color: false,
        };

        let mut output = Vec::new();
        write_box_content(&mut output, frame, "hi", true).expect("content line");

        let line = String::from_utf8(output).expect("utf8");

        assert_eq!(visible_width(line.trim_end()), frame.interior + 4);
        assert!(line.starts_with('│'));
        assert!(line.trim_end().ends_with('│'));
    }

    #[test]
    fn box_writer_reassembles_lines_split_across_writes() {
        let frame = BoxFrame {
            interior: 20,
            unicode: true,
            color: false,
        };

        let mut boxed = BoxWriter::wrap(Vec::new(), frame);
        write!(boxed, "he").expect("first fragment");
        write!(boxed, "llo\nworld\n").expect("remaining fragments");

        let output = String::from_utf8(boxed.inner).expect("utf8");
        let lines: Vec<&str> = output.lines().collect();

        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("hello"));
        assert!(lines[1].contains("world"));
    }
}
