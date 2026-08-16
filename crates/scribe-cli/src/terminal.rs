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
    layout::{Constraint, Direction, Layout},
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
// Shared row wrapping
// -----------------------------------------------------------------------------

/// Word-wraps `value` to `width` columns. The first returned line carries no
/// indentation (the caller prepends its own label); every continuation line
/// is padded with `gutter` spaces so it lines up under the value column
/// instead of orphaning itself at column zero.
fn wrap_value(value: &str, gutter: usize, width: usize) -> Vec<String> {
    let budget = width.saturating_sub(gutter).max(1);

    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();

    for word in value.split_whitespace() {
        let candidate_len = if current.is_empty() {
            word.chars().count()
        } else {
            current.chars().count() + 1 + word.chars().count()
        };

        if !current.is_empty() && candidate_len > budget {
            lines.push(current);
            current = String::new();
        }

        if !current.is_empty() {
            current.push(' ');
        }

        current.push_str(word);
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
enum EditOutcome {
    Continue,
    Submit,
    Cancel,
}

/// A single-line, append/backspace-at-end text buffer. Deliberately does not
/// support mid-line cursor movement — kept as a small, fully testable state
/// machine separate from the raw-mode I/O loop that drives it.
#[derive(Debug, Default)]
struct LineEditor {
    buffer: String,
}

impl LineEditor {
    fn apply_key(&mut self, key: KeyEvent) -> EditOutcome {
        match key.code {
            KeyCode::Enter => EditOutcome::Submit,

            KeyCode::Esc => EditOutcome::Cancel,

            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                EditOutcome::Cancel
            }

            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.buffer.clear();
                EditOutcome::Continue
            }

            KeyCode::Backspace => {
                self.buffer.pop();
                EditOutcome::Continue
            }

            KeyCode::Char(character) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.buffer.push(character);
                EditOutcome::Continue
            }

            _ => EditOutcome::Continue,
        }
    }
}

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
/// uses.
fn write_prompt_line(
    stdout: &mut impl Write,
    label: &str,
    hint: Option<&str>,
    value: &str,
    capabilities: Capabilities,
) -> io::Result<()> {
    execute!(stdout, MoveToColumn(0), Clear(ClearType::CurrentLine))?;

    let marker = symbol(Tone::Brand, capabilities);
    let label = paint(label, Tone::Dim, capabilities.color);

    match hint {
        Some(hint) => write!(stdout, "{marker} {label} [{hint}]  {value}")?,
        None => write!(stdout, "{marker} {label}  {value}")?,
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

pub fn prompt_text(label: &str, initial: Option<&str>) -> io::Result<Option<String>> {
    let capabilities = Capabilities::detect();
    let mut stdout = io::stdout();
    let mut editor = LineEditor::default();

    write_prompt_line(&mut stdout, label, initial, "", capabilities)?;

    enable_raw_mode()?;

    let outcome = loop {
        let key = next_key_press()?;

        let outcome = editor.apply_key(key);

        write_prompt_line(&mut stdout, label, initial, &editor.buffer, capabilities)?;

        if outcome != EditOutcome::Continue {
            break outcome;
        }
    };

    disable_raw_mode()?;
    writeln!(stdout)?;

    match outcome {
        EditOutcome::Cancel => Ok(None),
        EditOutcome::Submit if editor.buffer.is_empty() => Ok(initial.map(ToOwned::to_owned)),
        EditOutcome::Submit => Ok(Some(editor.buffer)),
        EditOutcome::Continue => unreachable!("the loop only breaks on Submit or Cancel"),
    }
}

pub fn prompt_confirm(label: &str, initial: bool) -> io::Result<Option<bool>> {
    let capabilities = Capabilities::detect();
    let mut stdout = io::stdout();
    let hint = if initial { "Y/n" } else { "y/N" };

    write_prompt_line(&mut stdout, label, Some(hint), "", capabilities)?;

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

    write_prompt_line(&mut stdout, label, Some(hint), echoed, capabilities)?;
    writeln!(stdout)?;

    match outcome {
        ConfirmOutcome::Yes => Ok(Some(true)),
        ConfirmOutcome::No => Ok(Some(false)),
        ConfirmOutcome::Cancel => Ok(None),
        ConfirmOutcome::Continue => unreachable!("the loop only breaks on a resolved outcome"),
    }
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

    fn key(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, modifiers)
    }

    #[test]
    fn line_editor_appends_and_submits() {
        let mut editor = LineEditor::default();

        assert_eq!(
            editor.apply_key(key(KeyCode::Char('h'), KeyModifiers::NONE)),
            EditOutcome::Continue
        );

        assert_eq!(
            editor.apply_key(key(KeyCode::Char('i'), KeyModifiers::NONE)),
            EditOutcome::Continue
        );

        assert_eq!(editor.buffer, "hi");

        assert_eq!(
            editor.apply_key(key(KeyCode::Enter, KeyModifiers::NONE)),
            EditOutcome::Submit
        );
    }

    #[test]
    fn line_editor_backspace_removes_the_last_character() {
        let mut editor = LineEditor::default();

        editor.apply_key(key(KeyCode::Char('h'), KeyModifiers::NONE));
        editor.apply_key(key(KeyCode::Char('i'), KeyModifiers::NONE));
        editor.apply_key(key(KeyCode::Backspace, KeyModifiers::NONE));

        assert_eq!(editor.buffer, "h");
    }

    #[test]
    fn line_editor_ctrl_c_and_esc_both_cancel() {
        let mut esc = LineEditor::default();

        assert_eq!(
            esc.apply_key(key(KeyCode::Esc, KeyModifiers::NONE)),
            EditOutcome::Cancel
        );

        let mut ctrl_c = LineEditor::default();

        assert_eq!(
            ctrl_c.apply_key(key(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            EditOutcome::Cancel
        );
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
}
